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

// ── Cost guards for the autonomous trigger ──
export const MAX_POSTS_PER_TICK = 60; // hard cap on posts entering the pipeline per cron run
export const MAX_LLM_CALLS_PER_TICK = 100; // gate + extract combined
export const POSTS_PER_ACCOUNT = 12; // recent posts pulled per seed account

// ── Models (tiered by stage — see PRD §5). Provider: OpenAI (product decision) ──
export const GATE_MODEL = 'gpt-4o-mini'; // cheap binary classifier, runs on everything
export const EXTRACT_MODEL = 'gpt-4o'; // vision+structured extraction, runs on gated posts

// ── Dedup thresholds ──
export const TITLE_SIMILARITY_THRESHOLD = 0.55;
export const DATE_BUCKET_HOURS = 24; // events at same venue within same local day are merge candidates

export const env = {
  openai: () => process.env.OPENAI_API_KEY || null,
  apify: () => process.env.APIFY_TOKEN || null,
  places: () => process.env.GOOGLE_PLACES_API_KEY || null,
  databaseUrl: () => process.env.DATABASE_URL || null,
  cronSecret: () => process.env.CRON_SECRET || null,
};
