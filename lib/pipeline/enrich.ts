// Web-search corroboration agent — the automated version of the human review
// queue, and the one place a genuine agent belongs in this system.
//
// For UNVERIFIED upcoming events (low venue+date confidence), run a SPECIFIC
// web search (venue sites, RA, Eventbrite, Dice...) and use what comes back
// CORROBORATE-ONLY:
//   • fill only fields that are currently null — never overwrite IG-derived data
//   • promote unverified → verified ONLY when an independent source confirms
//     the same event in the same local-day window (the guard against the web
//     confidently finding the WRONG event)
//   • contradictions never promote; they're logged and the badge stays
//
// Idempotent via events.enriched_at; capped per tick; skips in fixture mode.

import OpenAI from 'openai';
import { EXTRACT_MODEL, MAX_ENRICH_PER_TICK, PUBLISH_CONFIDENCE, env } from '../config';
import type { Db } from '../db';
import { fv, nul } from '../fixtures';
import type { Extraction } from '../types';
import { dateBucket } from './dedup';
import { resolveVenue } from './resolve';

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

interface EnrichRow {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  cost: string | null;
  external_link: string | null;
  confidence: number;
  venue_id: string | null;
  venue_name: string | null;
  venue_address: string | null;
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    corroborated: { type: 'boolean' },
    source_url: { type: ['string', 'null'] },
    web_date: { type: ['string', 'null'] }, // ISO start datetime found on the web
    fills: {
      type: 'object',
      properties: {
        venueName: { type: ['string', 'null'] }, // where the web says it happens (for venue-less events)
        endDatetime: { type: ['string', 'null'] },
        cost: { type: ['string', 'null'] },
        externalLink: { type: ['string', 'null'] },
        description: { type: ['string', 'null'] },
      },
      required: ['venueName', 'endDatetime', 'cost', 'externalLink', 'description'],
      additionalProperties: false,
    },
  },
  required: ['corroborated', 'source_url', 'web_date', 'fills'],
  additionalProperties: false,
} as const;

async function searchWeb(e: EnrichRow): Promise<string | null> {
  const when = new Date(e.start_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const query = `"${e.title}" ${e.venue_name ? `"${e.venue_name}"` : e.venue_address ?? ''} NYC ${when}`;
  const instructions =
    `Find THIS exact event: "${e.title}" at ${e.venue_name ?? e.venue_address ?? 'an NYC venue'} around ${new Date(e.start_at).toDateString()}. ` +
    `Search specifically (venue website, Resident Advisor, Eventbrite, Dice, press). Report: the event's exact date/time, ` +
    `price, ticket/RSVP link, and the URL of each independent source that describes the SAME event at the SAME venue in the same date window. ` +
    `If you cannot find this specific event (only similar ones), say so plainly. Do not guess.`;

  const call = (toolType: 'web_search' | 'web_search_preview') =>
    openai().responses.create({
      model: EXTRACT_MODEL,
      tools: [{ type: toolType } as never],
      input: `${instructions}\n\nSearch query suggestion: ${query}`,
    });

  try {
    let res;
    try {
      res = await call('web_search');
    } catch {
      res = await call('web_search_preview');
    }
    return res.output_text?.trim() || null;
  } catch {
    return null;
  }
}

async function verdict(e: EnrichRow, findings: string) {
  const res = await openai().chat.completions.create({
    model: EXTRACT_MODEL,
    max_tokens: 800,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'enrichment_verdict', strict: true, schema: VERDICT_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content:
          `We auto-detected an event from Instagram and searched the web to verify it.\n\n` +
          `EVENT AS DETECTED:\ntitle: ${e.title}\nvenue: ${e.venue_name ?? '∅'} (${e.venue_address ?? 'no address'})\n` +
          `start: ${e.start_at}\ncost: ${e.cost ?? '∅'}\nlink: ${e.external_link ?? '∅'}\n\n` +
          `WEB FINDINGS:\n"""${findings.slice(0, 6000)}"""\n\n` +
          `Rules:\n` +
          `• corroborated=true ONLY if an independent source clearly describes the SAME event in the same date window` +
          (e.venue_name
            ? ` at the SAME venue (${e.venue_name}). Similar-but-different events do NOT count.\n`
            : `. Our venue is unknown — match on title + date, and report WHERE the web says it happens in fills.venueName.\n`) +
          `• source_url = the best corroborating URL (null if not corroborated).\n` +
          `• web_date = the start datetime the web states (ISO, with offset), null if unstated.\n` +
          `• fills: values the web provides for fields we lack — null anything the web doesn't clearly state. Never invent.`,
      },
    ],
  });
  const text = res.choices[0]?.message?.content;
  if (!text) return null;
  return JSON.parse(text) as {
    corroborated: boolean;
    source_url: string | null;
    web_date: string | null;
    fills: {
      venueName: string | null;
      endDatetime: string | null;
      cost: string | null;
      externalLink: string | null;
      description: string | null;
    };
  };
}

export async function enrichUnverified(
  db: Db,
  log: (id: string, msg: string) => void,
): Promise<{ enriched: number; promoted: number }> {
  if (!env.openai()) return { enriched: 0, promoted: 0 }; // fixture mode: skip

  const candidates = await db.query<EnrichRow>(
    `SELECT e.id, e.title, e.description, e.start_at::text AS start_at, e.end_at::text AS end_at,
            e.cost, e.external_link, e.confidence, e.venue_id,
            v.name AS venue_name, v.address AS venue_address
     FROM events e LEFT JOIN venues v ON v.id = e.venue_id
     WHERE e.enriched_at IS NULL
       AND (e.confidence < $1 OR e.venue_id IS NULL)
       AND e.start_at IS NOT NULL
       AND COALESCE(e.end_at, e.start_at + interval '4 hours') > now()
     ORDER BY e.start_at ASC
     LIMIT $2`,
    [PUBLISH_CONFIDENCE, MAX_ENRICH_PER_TICK],
  );

  let enriched = 0;
  let promoted = 0;
  for (const e of candidates) {
    try {
      const findings = await searchWeb(e);
      // Mark attempted regardless — no per-tick re-spend on the same event.
      await db.query(`UPDATE events SET enriched_at = now() WHERE id = $1`, [e.id]);
      enriched++;
      if (!findings) {
        log(e.id, `enrich:– web search returned nothing "${e.title.slice(0, 32)}"`);
        continue;
      }
      const v = await verdict(e, findings);
      if (!v) continue;

      // Deterministic corroborate-only rules (in code, not the prompt):
      const sameDay = v.web_date ? dateBucket(v.web_date) === dateBucket(e.start_at) : false;
      const promote = v.corroborated && sameDay && Boolean(v.source_url);

      // Venue-less event + web names the venue + corroborated → resolve it via
      // Places and ATTACH. This is what turns a held event into a pinned one.
      let attachedVenue = '';
      if (promote && !e.venue_id && v.fills.venueName) {
        const venue = await resolveVenue({
          venueName: fv(v.fills.venueName, 0.9),
          address: nul(),
        } as unknown as Extraction);
        if (venue) {
          await db.query(
            `INSERT INTO venues (id, name, address, lat, lng, neighborhood, photo_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO UPDATE SET photo_url = COALESCE(venues.photo_url, EXCLUDED.photo_url)`,
            [venue.id, venue.name, venue.address, venue.lat, venue.lng, venue.neighborhood, venue.photoUrl ?? null],
          );
          await db.query(`UPDATE events SET venue_id = $2 WHERE id = $1`, [e.id, venue.id]);
          attachedVenue = ` +venue ${venue.name}`;
        }
      }

      await db.query(
        `UPDATE events SET
           end_at        = COALESCE(end_at, $2::timestamptz),
           cost          = COALESCE(cost, $3),
           external_link = COALESCE(external_link, $4),
           description   = COALESCE(description, $5),
           corroboration_url = CASE WHEN $6 THEN $7 ELSE corroboration_url END,
           confidence    = CASE WHEN $6 THEN GREATEST(confidence, 0.75) ELSE confidence END,
           updated_at    = now()
         WHERE id = $1`,
        [e.id, v.fills.endDatetime, v.fills.cost, v.fills.externalLink, v.fills.description, promote, v.source_url],
      );

      if (promote) {
        promoted++;
        log(e.id, `enrich:✓ PROMOTED${attachedVenue} "${e.title.slice(0, 32)}" via ${v.source_url?.slice(0, 50)}`);
      } else if (v.corroborated && !sameDay) {
        log(e.id, `enrich:⚠ web date conflicts (${v.web_date}) — stays unverified "${e.title.slice(0, 32)}"`);
      } else {
        log(e.id, `enrich:– no corroboration "${e.title.slice(0, 32)}"`);
      }
    } catch (err) {
      log(e.id, `enrich ERROR: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    }
  }
  return { enriched, promoted };
}
