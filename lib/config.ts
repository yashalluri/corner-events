// NYC-only scope, locked per product decision.

export const CITY = {
  name: 'New York',
  timezone: 'America/New_York',
  // Lower Manhattan / north Brooklyn — where the seed accounts post.
  center: { lat: 40.7215, lng: -73.9875 },
  // Places API location bias (rough NYC bounding box)
  bounds: { south: 40.55, west: -74.15, north: 40.85, east: -73.75 },
};

/**
 * LOCKED curated account list — product decision (2026-07-03): these 7 and
 * ONLY these. No auto-discovery, no expansion unless a new account matches
 * this bar for quality + accuracy. Doubles as the source-authority prior.
 */
export const SEED_ACCOUNTS: { username: string; authority: number }[] = [
  { username: 'wherethefuckdowego', authority: 0.9 }, // "wtfdwg" is the abbreviation, not the handle
  { username: 'newyorklocals', authority: 0.7 },
  { username: 'secret_nyc', authority: 0.7 },
  { username: 'nybucketlist', authority: 0.6 },
  { username: 'thirstygallerina', authority: 0.9 },
  { username: 'new_york_underground', authority: 0.85 },
  { username: 'rub_ulad', authority: 0.8 },
];

/** The interviewer's golden acceptance-test posts. Must ingest + pin correctly. */
export const GOLDEN_POST_URLS = [
  'https://www.instagram.com/p/DaN_n5NmBER/',
  'https://www.instagram.com/p/DZ-UjDXEZNC/',
];

// ── Coverage / recall (cost is no object — bias toward not missing events) ──
export const POSTS_PER_ACCOUNT = 50; // grid depth per account (was 12)
export const SCRAPE_SINCE = '3 months'; // pull everything posted in this window
// Per-tick safety ceiling. Env-tunable so a deploy can keep the serverless cron
// small (watermarks make steady-state ticks tiny anyway); local backfill goes deep.
export const MAX_POSTS_PER_TICK = Number(process.env.INGEST_MAX_POSTS) || 500;
export const MAX_LLM_CALLS_PER_TICK = 2000; // real bound is MAX_POSTS_PER_TICK

// ── Models (tiered by stage — see PRD §5). Provider: OpenAI (product decision) ──
export const GATE_MODEL = 'gpt-4o-mini'; // cheap binary classifier, runs on everything
export const EXTRACT_MODEL = 'gpt-4o'; // vision+structured extraction, runs on gated posts
export const TRANSCRIBE_MODEL = 'gpt-4o-transcribe'; // reel audio → text (accuracy over cost)

// ── Reels / video ──
export const FRAME_COUNT = 4; // interior frames sampled per reel (ffmpeg, local)
export const MAX_VIDEO_BYTES = 24 * 1024 * 1024; // skip transcription above Whisper's ~25MB cap

// ── Trust: at/above this venue+date confidence an event reads as verified;
//    below it, it still SHOWS on the map but wears an "unverified" badge. ──
export const PUBLISH_CONFIDENCE = 0.6;

// ── Web-enrichment agent: unverified upcoming events per tick that get a
//    specific web search to corroborate + fill gaps (corroborate-only). ──
export const MAX_ENRICH_PER_TICK = 25;

/** Canonical event-category vocabulary — single source of truth for the
 *  extraction schema, the normalizer, and the UI emoji map. */
export const CATEGORIES = ['food', 'music', 'art', 'nightlife', 'market', 'fitness', 'comedy', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

/** IG/FB CDN hostnames (hostname-anchored) — shared by the image-proxy
 *  allowlist and the "does this cover need proxying?" rewrite. */
export const IG_CDN_HOST_RE = /(^|\.)cdninstagram\.com$|(^|\.)fbcdn\.net$/i;
export function isIgCdnUrl(url: string): boolean {
  try {
    return IG_CDN_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ── Dedup thresholds ──
export const TITLE_SIMILARITY_THRESHOLD = 0.55;
export const DATE_BUCKET_HOURS = 24; // events at same venue within same local day are merge candidates

export const env = {
  openai: () => process.env.OPENAI_API_KEY || null,
  apify: () => process.env.APIFY_TOKEN || null,
  places: () => process.env.GOOGLE_PLACES_API_KEY || null,
  databaseUrl: () => process.env.DATABASE_URL || null,
  cronSecret: () => process.env.CRON_SECRET || null,
  /** True when ANY paid/live stage is configured — the guard for anything that
   *  must never auto-run billable work (e.g. page-view hydration). */
  anyLive: () =>
    Boolean(process.env.APIFY_TOKEN || process.env.OPENAI_API_KEY || process.env.GOOGLE_PLACES_API_KEY),
};
