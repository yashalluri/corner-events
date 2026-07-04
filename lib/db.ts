// Data layer. One tiny query interface, two backends speaking the same SQL:
//   • DATABASE_URL set  → real Postgres (Neon for the hosted deploy)
//   • unset             → embedded PGlite (zero-setup local dev + demo)
// Both are Postgres dialect, so there is exactly one schema and one set of queries.

import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { env } from './config';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  username TEXT PRIMARY KEY,
  authority REAL NOT NULL DEFAULT 0.5,
  baseline_engagement REAL,           -- median(likes + 3*comments) of this account's scraped posts
  last_post_ts TIMESTAMPTZ            -- watermark: newest post timestamp already processed
);

CREATE TABLE IF NOT EXISTS posts (               -- raw scrape payloads (re-extract without re-scraping)
  id TEXT PRIMARY KEY,
  short_code TEXT,
  url TEXT NOT NULL,
  owner_username TEXT NOT NULL,
  caption TEXT,
  display_url TEXT,
  video_url TEXT,                     -- reels: mp4 CDN url
  transcript TEXT,                    -- cached audio transcription (re-runs don't re-transcribe)
  posted_at TIMESTAMPTZ NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  is_event BOOLEAN,                   -- event-gate verdict (NULL = not yet gated)
  processed BOOLEAN NOT NULL DEFAULT FALSE
);
-- Older DBs created before reels support: add columns if missing.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS slide_urls TEXT;  -- JSON array (carousels)
-- Web-enrichment bookkeeping (corroboration agent).
ALTER TABLE events ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS corroboration_url TEXT;

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,                -- google place_id (or fixture:slug)
  name TEXT NOT NULL,
  address TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  neighborhood TEXT,
  photo_url TEXT                      -- Places photo → event-cover fallback
);
ALTER TABLE venues ADD COLUMN IF NOT EXISTS photo_url TEXT;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,                -- surrogate key (answer to Jake's question)
  title TEXT NOT NULL,
  description TEXT,
  venue_id TEXT REFERENCES venues(id),
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  cost TEXT,
  age_limit TEXT,
  capacity INTEGER,
  category TEXT NOT NULL DEFAULT 'other',
  external_link TEXT,
  cover_url TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  tier TEXT,                          -- lowkey | popular | trending | NULL
  tier_reason TEXT,
  popular_score REAL NOT NULL DEFAULT 0,
  heat_score REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_sources (       -- reposts ATTACH, they don't duplicate
  event_id TEXT NOT NULL REFERENCES events(id),
  post_id TEXT NOT NULL REFERENCES posts(id),
  PRIMARY KEY (event_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_events_venue_start ON events(venue_id, start_at);
CREATE INDEX IF NOT EXISTS idx_posts_owner ON posts(owner_username, posted_at);
`;

let dbPromise: Promise<Db> | null = null;

async function makePg(url: string): Promise<Db> {
  const { Pool } = await import('pg');
  // Supabase (and most hosted Postgres) requires TLS; its pooler uses a cert
  // chain node won't verify out of the box.
  const needsSsl = /supabase\.(co|com)|pooler\.|sslmode=require/i.test(url);
  const pool: Pool = new Pool({
    connectionString: url,
    max: 3,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  const db: Db = {
    async query(sql, params = []) {
      const res = await pool.query(sql, params as unknown[]);
      return res.rows;
    },
  };
  await db.query(SCHEMA);
  return db;
}

async function makePglite(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  // Persist locally so ingest results survive dev-server restarts; in
  // serverless (/tmp) it's per-instance — the demo re-hydrates from fixtures.
  const dataDir = process.env.VERCEL ? undefined : `${process.cwd()}/.pgdata`;
  const pg: PGlite = dataDir ? new PGlite(dataDir) : new PGlite();
  const db: Db = {
    async query(sql, params = []) {
      const res = await pg.query(sql, params as unknown[]);
      return res.rows as never[];
    },
  };
  await pg.exec(SCHEMA);
  return db;
}

export function getDb(): Promise<Db> {
  if (!dbPromise) {
    const url = env.databaseUrl();
    dbPromise = url ? makePg(url) : makePglite();
  }
  return dbPromise;
}

/** True when the events table is empty (used to auto-hydrate the demo on cold start). */
export async function isEmpty(): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM events');
  return Number(rows[0]?.n ?? 0) === 0;
}
