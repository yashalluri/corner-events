// Stages B + C — Event-gate (gpt-4o-mini) and Extraction (gpt-4o).
//
// Model tiering is the cost-control story: the cheap model runs on EVERY post,
// the expensive model only on posts that pass the gate. Without an API key both
// stages fall back deterministically (fixture `_mock`, then keyword heuristics)
// so the pipeline still runs end-to-end.

import OpenAI from 'openai';
import { CATEGORIES, CITY, EXTRACT_MODEL, GATE_MODEL, MAX_EVENTS_PER_POST, env } from '../config';
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

export async function eventGate(post: RawPost, transcript?: string | null): Promise<boolean> {
  if (!env.openai()) {
    if (post._mock) return post._mock.isEvent;
    return gateHeuristic(post) || Boolean(transcript && EVENT_HINTS.test(transcript));
  }
  // For a reel, the caption is often just an emoji — judge on the spoken audio too.
  const audio = transcript ? `\n\nSPOKEN AUDIO (video):\n"""${transcript.slice(0, 1500)}"""` : '';
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
          `Roundups/guides listing multiple DATED events ("10 things to do this weekend") ARE events — they get split into individual events downstream. ` +
          `NOT events: memes, listicles of PLACES with no dates ("best bagels in nyc"), permanent-place recommendations, generic menu promos with no time bound, giveaways, recaps of past events with no upcoming date. When genuinely ambiguous, lean is_event=true — a later stage validates dates and can drop it.\n\n` +
          `Caption (posted ${post.timestamp} by @${post.ownerUsername}):\n"""${post.caption.slice(0, 1500)}"""${audio}`,
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

const EVENT_SCHEMA = {
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
    // Which provided image best represents THIS event (0 = cover, 1..N = slides
    // in order). Lets each roundup event carry its own slide as its card cover.
    coverSlideIndex: { type: ['number', 'null'] },
  },
  required: [
    'title', 'venueName', 'address', 'description', 'startDatetime', 'endDatetime',
    'rsvpDeadline', 'capacity', 'ageLimit', 'cost', 'category', 'externalLink', 'coverSlideIndex',
  ],
  additionalProperties: false,
} as const;

// A post may contain MULTIPLE events (roundup carousels, "top 5" reels) — the
// schema is an array; singles come back as a one-element list.
const MULTI_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: { events: { type: 'array', items: EVENT_SCHEMA } },
  required: ['events'],
  additionalProperties: false,
} as const;

export interface ExtractSignals {
  transcript?: string | null; // reel spoken audio
  frames?: string[] | null; // reel interior frames (data URLs)
}

/** Extract 1..N events from a post (roundup carousels and "top 5" reels yield
 *  several; ordinary posts yield one). */
export async function extract(post: RawPost, signals: ExtractSignals = {}): Promise<Extraction[]> {
  if (!env.openai()) {
    // Fixture mode: only fixture posts carry mock extractions. A non-fixture
    // post without a key is held rather than guessed at.
    if (post._mock?.extractions) return post._mock.extractions;
    return post._mock?.extraction ? [post._mock.extraction] : [];
  }

  const isVideo = Boolean(post.videoUrl);
  const slides = post.slideUrls ?? [];
  const sources = isVideo
    ? 'A reel/video: the written caption, the cover + interior video FRAMES (read on-screen/flyer text), and the SPOKEN AUDIO transcript. Different reels put the details in different places — cross-reference all of them.'
    : slides.length
      ? `A carousel with ${slides.length + 1} slides: the caption plus every slide image (roundups often put one event per slide).`
      : 'A post: the written caption and the flyer/cover image.';
  const audio = signals.transcript
    ? `\n\nSPOKEN AUDIO TRANSCRIPT (narration of the video):\n"""${signals.transcript.slice(0, 3000)}"""`
    : '';

  const prompt =
    `Extract structured event data from this Instagram ${isVideo ? 'reel' : 'post'}. ${sources}\n\n` +
    `A post may contain MULTIPLE distinct events (roundup carousels, "top N this weekend" reels). Return one entry per distinct dated event — do NOT merge different events into one, and do NOT pad a single event into a list.\n\n` +
    `RULES — read carefully:\n` +
    `• Per field, return {value, confidence (0-1), evidence}. evidence = the exact caption span, slide text, or spoken line the value came from.\n` +
    `• null beats a guess. If a field is not stated anywhere, value=null, confidence=0. NEVER invent capacity, price, or age limits.\n` +
    `• Resolve relative dates ("tonight", "this Friday") against the post's publish time: ${post.timestamp}, timezone ${CITY.timezone}. Return ISO 8601 with offset.\n` +
    `• category ∈ food | music | art | nightlife | market | fitness | comedy | other.\n` +
    `• venueName: the place hosting THAT event${post.locationName ? ` (post location tag: "${post.locationName}")` : ''}.\n` +
    `• coverSlideIndex: which provided image best represents THAT event — 0 = the cover image, 1..${slides.length} = carousel slides in order. Video frames (if any, provided after the slides) are NOT selectable — use null for them.\n\n` +
    `Caption by @${post.ownerUsername}:\n"""${post.caption.slice(0, 3000)}"""${audio}`;

  const call = async (withImages: boolean) => {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [];
    if (withImages) {
      if (post.displayUrl?.startsWith('https://')) {
        content.push({ type: 'image_url', image_url: { url: post.displayUrl, detail: 'low' } });
      }
      for (const slide of slides) {
        if (slide.startsWith('https://')) content.push({ type: 'image_url', image_url: { url: slide, detail: 'low' } });
      }
      for (const frame of signals.frames ?? []) {
        content.push({ type: 'image_url', image_url: { url: frame, detail: 'low' } });
      }
    }
    content.push({ type: 'text', text: prompt });
    return openai().chat.completions.create({
      model: EXTRACT_MODEL,
      max_tokens: 6000, // roundups can carry 10+ events
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'event_extraction', strict: true, schema: MULTI_EXTRACTION_SCHEMA },
      },
      messages: [{ role: 'user', content }],
    });
  };

  let res: OpenAI.Chat.ChatCompletion;
  try {
    res = await call(true);
  } catch (e) {
    // IG CDN URLs are signed and expire; if OpenAI can't fetch an image
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
  if (!text) return [];
  const parsed = JSON.parse(text) as { events: Extraction[] };
  return (parsed.events ?? []).slice(0, MAX_EVENTS_PER_POST).map(sanitizeExtraction);
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

/** Publish-trustworthiness = do we trust WHERE and WHEN. Title is excluded on
 *  purpose — it's synthesized when missing (dedup.ts), so an uncertain title
 *  must not hold an event whose venue and date are solid. */
export function overallConfidence(x: Extraction): number {
  const critical: FieldValue<unknown>[] = [x.venueName, x.startDatetime];
  return Math.min(...critical.map((f) => (f.value != null ? f.confidence : 0)));
}
