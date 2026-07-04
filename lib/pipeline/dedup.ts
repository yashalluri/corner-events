// Stage E — Identity. The answer to Jake's sticky note, implemented.
//
// Primary key = surrogate UUID (unique by construction). Identity is decided by
// a DERIVED dedup signature:  venue_id + same-local-day date bucket + title
// similarity ≥ threshold.  Re-posts ATTACH to the existing event (event_sources)
// and enrich it — they never create a duplicate. The whole check-and-write runs
// inside one processing pass per batch (no Agent2/Agent3 race).

import { randomUUID } from 'crypto';
import { CITY, TITLE_SIMILARITY_THRESHOLD } from '../config';
import type { Db } from '../db';
import type { EventRow, Extraction, RawPost, Venue } from '../types';
import { overallConfidence } from './llm';

// ─── Title similarity: token Jaccard with a Levenshtein assist ──────────────

const STOP = new Set(['the', 'a', 'an', 'at', 'in', 'on', 'and', 'x', 'with', 'b2b', 'night', 'nyc']);
const tokens = (s: string) =>
  new Set(
    s.toLowerCase().replace(/[^a-z0-9äëïöüáéíóú ]/gi, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t)),
  );

export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  // Assist: containment (short title inside long one) counts.
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment * 0.85);
}

/** Local-day bucket in the city timezone — "same night" for dedup purposes. */
export function dateBucket(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: CITY.timezone });
}

// ─── Atomic upsert ──────────────────────────────────────────────────────────

export interface UpsertResult {
  action: 'inserted' | 'merged' | 'skipped';
  eventId: string;
}

export async function upsertEvent(
  db: Db,
  post: RawPost,
  x: Extraction,
  venue: Venue | null,
  /** Final display title, resolved by the orchestrator. Also feeds the dedup
   *  signature, so it's a parameter — not synthesized here — to keep this
   *  module pure compare-and-write. */
  title: string,
): Promise<UpsertResult> {
  const startAt = x.startDatetime.value;

  // 1. Ensure venue row exists.
  if (venue) {
    await db.query(
      `INSERT INTO venues (id, name, address, lat, lng, neighborhood)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [venue.id, venue.name, venue.address, venue.lat, venue.lng, venue.neighborhood],
    );
  }

  // 2. Find merge candidates: same venue, same local day.
  let match: EventRow | null = null;
  if (venue && startAt) {
    const candidates = await db.query<EventRow>(
      `SELECT * FROM events WHERE venue_id = $1 AND start_at IS NOT NULL
         AND start_at BETWEEN $2::timestamptz - interval '36 hours' AND $2::timestamptz + interval '36 hours'`,
      [venue.id, startAt],
    );
    const bucket = dateBucket(startAt);
    match =
      candidates.find(
        (c) =>
          dateBucket(String(c.start_at)) === bucket &&
          titleSimilarity(c.title, title) >= TITLE_SIMILARITY_THRESHOLD,
      ) ?? null;
  }

  if (match) {
    // 3a. ATTACH + enrich: source row links the post; null fields get filled.
    const attach = await db.query<{ event_id: string }>(
      `INSERT INTO event_sources (event_id, post_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [match.id, post.id],
    );
    // Cross-source agreement: a match already means two independent posts agree
    // on venue + local-day + title (that's the signature). Independent
    // corroboration → a confidence bonus, which can lift a borderline event
    // over the publish threshold. Only on a genuinely new source.
    const isNewSource = attach.length > 0;
    const conf = Math.min(1, overallConfidence(x) + (isNewSource ? 0.15 : 0));
    await db.query(
      `UPDATE events SET
         description   = COALESCE(description, $2),
         end_at        = COALESCE(end_at, $3::timestamptz),
         cost          = COALESCE(cost, $4),
         age_limit     = COALESCE(age_limit, $5),
         capacity      = COALESCE(capacity, $6),
         external_link = COALESCE(external_link, $7),
         cover_url     = COALESCE(cover_url, $8),
         confidence    = LEAST(1, GREATEST(confidence, $9) + $10),
         updated_at    = now()
       WHERE id = $1`,
      [
        match.id,
        x.description.value,
        x.endDatetime.value,
        x.cost.value,
        x.ageLimit.value,
        x.capacity.value,
        x.externalLink.value,
        post.displayUrl || null,
        conf,
        isNewSource ? 0.1 : 0, // extra corroboration bump on the stored score
      ],
    );
    return { action: isNewSource ? 'merged' : 'skipped', eventId: match.id };
  }

  // 3b. New event: mint surrogate id.
  const id = randomUUID();
  await db.query(
    `INSERT INTO events (id, title, description, venue_id, start_at, end_at, cost, age_limit,
                         capacity, category, external_link, cover_url, confidence)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      title,
      x.description.value,
      venue?.id ?? null,
      startAt,
      x.endDatetime.value,
      x.cost.value,
      x.ageLimit.value,
      x.capacity.value,
      x.category.value ?? 'other',
      x.externalLink.value,
      post.displayUrl || null,
      overallConfidence(x),
    ],
  );
  await db.query(`INSERT INTO event_sources (event_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, post.id]);
  return { action: 'inserted', eventId: id };
}
