// Stages B + C — Event-gate (gpt-4o-mini) and Extraction (gpt-4o).
//
// Model tiering is the cost-control story: the cheap model runs on EVERY post,
// the expensive model only on posts that pass the gate. Without an API key both
// stages fall back deterministically (fixture `_mock`, then keyword heuristics)
// so the pipeline still runs end-to-end.

import OpenAI from 'openai';
import { CATEGORIES, CITY, EXTRACT_MODEL, GATE_MODEL, env } from '../config';
import type { Extraction, FieldValue, RawPost } from '../types';

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export function llmMode(): 'live' | 'fixture' {
  return env.openai() ? 'live' : 'fixture';
}

// ─── Stage B: event-gate ────────────────────────────────────────────────────

const EVENT_HINTS =
  /\b(tonight|tomorrow|this (mon|tue|wed|thu|fri|sat|sun)|friday|saturday|sunday|monday|tuesday|wednesday|thursday|doors|rsvp|tickets?|link in bio|pop[- ]?up|supper club|opening night|\d{1,2}(:\d{2})?\s?(am|pm)|free entry|at the door|one night only|market|sample sale)\b/i;

function gateHeuristic(post: RawPost): boolean {
  return EVENT_HINTS.test(post.caption);
}

export async function eventGate(post: RawPost): Promise<boolean> {
  if (!env.openai()) {
    if (post._mock) return post._mock.isEvent;
    return gateHeuristic(post);
  }
  const res = await openai().chat.completions.create({
    model: GATE_MODEL,
    max_tokens: 200,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'event_gate',
        strict: true,
        schema: {
          type: 'object',
          properties: { is_event: { type: 'boolean' }, reason: { type: 'string' } },
          required: ['is_event', 'reason'],
          additionalProperties: false,
        },
      },
    },
    messages: [
      {
        role: 'user',
        content:
          `You classify Instagram posts. An EVENT is a specific real-world happening people can attend: pop-up, dinner, show, party, market, class, gallery opening — AND time-bounded commercial happenings like sample sales, archive sales, limited-run collabs, or "X returns to Y" announcements. A relative or implied timeframe ("this weekend", "returns", "one week only", "now through Sunday") counts as a date. ` +
          `NOT events: memes, listicles ("best bagels"), permanent-place recommendations, generic menu promos with no time bound, giveaways, recaps of past events with no upcoming date. When genuinely ambiguous, lean is_event=true — a later stage validates dates and can drop it.\n\n` +
          `Caption (posted ${post.timestamp} by @${post.ownerUsername}):\n"""${post.caption.slice(0, 1500)}"""`,
      },
    ],
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{"is_event":false}');
  return Boolean(parsed.is_event);
}

// ─── Stage C: extraction ────────────────────────────────────────────────────

const FIELD_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    evidence: { type: ['string', 'null'] },
  },
  required: ['value', 'confidence', 'evidence'],
  additionalProperties: false,
} as const;

const NUM_FIELD_SCHEMA = {
  ...FIELD_SCHEMA,
  properties: { ...FIELD_SCHEMA.properties, value: { type: ['number', 'null'] } },
} as const;

// Category is schema-ENFORCED, not just prompted — 'attractions' etc. can't leak.
const CATEGORY_FIELD_SCHEMA = {
  ...FIELD_SCHEMA,
  properties: {
    ...FIELD_SCHEMA.properties,
    value: { type: ['string', 'null'], enum: [...CATEGORIES, null] },
  },
} as const;

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: FIELD_SCHEMA,
    venueName: FIELD_SCHEMA,
    address: FIELD_SCHEMA,
    description: FIELD_SCHEMA,
    startDatetime: FIELD_SCHEMA,
    endDatetime: FIELD_SCHEMA,
    rsvpDeadline: FIELD_SCHEMA,
    capacity: NUM_FIELD_SCHEMA,
    ageLimit: FIELD_SCHEMA,
    cost: FIELD_SCHEMA,
    category: CATEGORY_FIELD_SCHEMA,
    externalLink: FIELD_SCHEMA,
  },
  required: [
    'title', 'venueName', 'address', 'description', 'startDatetime', 'endDatetime',
    'rsvpDeadline', 'capacity', 'ageLimit', 'cost', 'category', 'externalLink',
  ],
  additionalProperties: false,
} as const;

export async function extract(post: RawPost): Promise<Extraction | null> {
  if (!env.openai()) {
    // Fixture mode: only fixture posts carry a mock extraction. A non-fixture
    // post without a key is held rather than guessed at.
    return post._mock?.extraction ?? null;
  }

  const prompt =
    `Extract structured event data from this Instagram post (caption + flyer image if attached).\n\n` +
    `RULES — read carefully:\n` +
    `• Per field, return {value, confidence (0-1), evidence}. evidence = the exact caption span or flyer text the value came from.\n` +
    `• null beats a guess. If a field is not stated, value=null, confidence=0. NEVER invent capacity, price, or age limits.\n` +
    `• Resolve relative dates ("tonight", "this Friday") against the post's publish time: ${post.timestamp}, timezone ${CITY.timezone}. Return ISO 8601 with offset.\n` +
    `• category ∈ food | music | art | nightlife | market | fitness | comedy | other.\n` +
    `• venueName: the place hosting it${post.locationName ? ` (post location tag: "${post.locationName}")` : ''}.\n\n` +
    `Caption by @${post.ownerUsername}:\n"""${post.caption.slice(0, 3000)}"""`;

  const call = async (withImage: boolean) => {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    if (withImage && post.displayUrl?.startsWith('https://')) {
      content.push({ type: 'image_url', image_url: { url: post.displayUrl, detail: 'low' } });
    }
    content.push({ type: 'text', text: prompt });
    return openai().chat.completions.create({
      model: EXTRACT_MODEL,
      max_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'event_extraction', strict: true, schema: EXTRACTION_SCHEMA },
      },
      messages: [{ role: 'user', content }],
    });
  };

  let res: OpenAI.Chat.ChatCompletion;
  try {
    res = await call(true);
  } catch (e) {
    // IG CDN URLs are signed and expire; if OpenAI can't fetch the image
    // ("Error while downloading" / invalid_image_url), retry text-only rather
    // than losing the extraction.
    const msg = e instanceof Error ? e.message : String(e);
    if (/image|url|download/i.test(msg)) {
      res = await call(false);
    } else {
      throw e;
    }
  }
  const text = res.choices[0]?.message?.content;
  if (!text) return null;
  return sanitizeExtraction(JSON.parse(text) as Extraction);
}

/** Real-world model output quirks: literal "null"/"" strings instead of JSON
 *  null, whitespace padding. Normalize every field so downstream code and SQL
 *  only ever see real nulls. */
const CATEGORY_SYNONYMS: Record<string, string> = {
  attraction: 'other', attractions: 'other', festival: 'other', community: 'other',
  party: 'nightlife', club: 'nightlife', dj: 'nightlife', rave: 'nightlife',
  concert: 'music', show: 'music', performance: 'music',
  dining: 'food', dinner: 'food', popup: 'food', drinks: 'food',
  gallery: 'art', exhibition: 'art', exhibit: 'art', film: 'art', theater: 'art',
  sale: 'market', shopping: 'market', flea: 'market', fair: 'market',
  sports: 'fitness', wellness: 'fitness', run: 'fitness',
  standup: 'comedy',
};

export function normalizeCategory(raw: string | null): string {
  const v = (raw ?? '').toLowerCase().trim();
  if ((CATEGORIES as readonly string[]).includes(v)) return v;
  return CATEGORY_SYNONYMS[v] ?? 'other';
}

function sanitizeExtraction(x: Extraction): Extraction {
  const out = { ...x };
  for (const key of Object.keys(out) as (keyof Extraction)[]) {
    const f = out[key] as FieldValue<unknown>;
    if (typeof f?.value === 'string') {
      const v = f.value.trim();
      if (v === '' || /^(null|none|n\/a|unknown|tbd)$/i.test(v)) {
        (out[key] as FieldValue<unknown>) = { ...f, value: null, confidence: 0 };
      } else if (v !== f.value) {
        (out[key] as FieldValue<unknown>) = { ...f, value: v };
      }
    }
  }
  // Belt-and-suspenders even with the schema enum (fixture posts, older data paths).
  out.category = { ...out.category, value: normalizeCategory(out.category.value) };
  return out;
}

/** Overall event confidence = min of the load-bearing fields. */
export function overallConfidence(x: Extraction): number {
  const loadBearing: FieldValue<unknown>[] = [x.title, x.venueName, x.startDatetime];
  return Math.min(...loadBearing.map((f) => (f.value != null ? f.confidence : 0)));
}
