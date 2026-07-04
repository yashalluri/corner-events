# corner · events

**Instagram → the best ephemeral events in NYC**, surfaced on a Corner-style map.

An autonomous ingestion pipeline that converts NYC Instagram content (pop-ups, dinners,
shows, drops) into structured, deduplicated, map-ready events — presented in a webapp
that looks and feels like the Corner app. Built for the Corner technical project.
Full product thinking in [`PRD.md`](./PRD.md).

## Quick start

```bash
npm install
npm run ingest   # run the pipeline once (fixture mode — no keys needed)
npm run dev      # open http://localhost:3000
```

That's it. **Every external dependency has a deterministic fallback**, so the whole
system runs end-to-end with zero keys. Drop keys into `.env.local` (see `.env.example`)
and the corresponding stage switches live — no code changes:

| Key | Unlocks |
|---|---|
| `APIFY_TOKEN` | Live Instagram scraping of the 7 curated accounts + the 2 golden posts |
| `OPENAI_API_KEY` | Live event-gate (gpt-4o-mini) + vision extraction (gpt-4o) |
| `GOOGLE_PLACES_API_KEY` | Live venue resolution → `place_id` + lat/lng |
| `DATABASE_URL` | Supabase Postgres (transaction pooler URI) instead of embedded PGlite |
| `CRON_SECRET` | Locks the autonomous trigger route |

**Live bring-up order** (once keys are in `.env.local`): run the heavy first
backfill locally with `npm run ingest` (not in a serverless timeout), inspect
the per-post logs, verify the two golden posts landed, then deploy. Cloud cron
ticks stay small because watermarks only admit new posts.

## Architecture

```
     SEED ACCOUNTS (7 NYC curators) + GOLDEN POST URLS
        │
        ▼  every 3h (Vercel Cron → /api/cron/ingest) — or npm run ingest
┌──────────────────────────────────────────────────────────────┐
│  A  SCRAPE      Apify instagram-scraper (fixture fallback)    │
│     ↓           watermark filter: only posts newer than the   │
│                 last processed timestamp per account          │
│  B  GATE        gpt-4o-mini — "is this even an event?"        │
│                 drops memes/listicles BEFORE paying for vision│
│  C  EXTRACT     gpt-4o — caption+flyer → fields, per-field    │
│                 confidence + evidence, null-beats-a-guess.    │
│                 REELS: + gpt-4o-transcribe audio + ffmpeg     │
│                 frames → spoken/on-screen details are read    │
│  D  RESOLVE     deterministic date + field validators, then   │
│                 Google Places → lat/lng + neighborhood.       │
│                 hold-don't-drop: unresolved venue = kept,     │
│                 off-map (needs_review)                        │
│  E  IDENTITY    atomic upsert: surrogate event_id (UUID) +    │
│                 dedup signature (venue × local-day × title    │
│                 similarity). Re-posts ATTACH + enrich; they   │
│                 never duplicate.                              │
│  F  TIERS       lowkey / popular / trending — recomputed      │
│                 every tick (engagement rate normalized by     │
│                 account baseline, 72h decay, multi-account    │
│                 velocity)                                     │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
   Supabase Postgres / embedded PGlite   →   /api/events   →   Corner-clone UI
   lifecycle computed at query time: past events simply stop being served
```

### Design decisions worth knowing

- **Identity (the "primary keys" question):** natural fields are never unique. The PK is
  a surrogate UUID; *identity* is a derived signature — `venue place_id` + same-local-day
  bucket + title similarity ≥ 0.55. Handles the three failure modes: multi-venue events
  (per-venue signature), two events same venue same night (title similarity keeps them
  apart), recurring series (each dated occurrence is its own row).
- **Model tiering is the cost story:** the cheap model (gpt-4o-mini) runs on every post; the
  expensive model (gpt-4o) only on posts that pass the gate. ~$0.001/post gated vs ~$0.02
  extracted.
- **Autonomy = idempotency:** watermarks (skip old posts), raw post storage (re-extract
  without re-scraping), dedup (re-ingestion is a no-op). A double-fired cron is harmless —
  verified: a full re-run inserts 0 rows.
- **No pgvector for MVP:** deterministic fuzzy matching is free and sufficient at this
  scale; embeddings (pgvector) are the documented scale path.
- **Ephemerality:** event status (upcoming/live/past) is computed at query time — there's
  no status column to drift and nothing for the cron to flip. Past events just stop
  being returned.
- **Reels are multimodal, not just cover images:** a reel's event info often lives in the
  voiceover or on a flyer frame, so every video gets caption + cover + `gpt-4o-transcribe`
  audio + ffmpeg-sampled frames, all fed to one extraction call. The gate also sees the
  transcript, so an emoji-caption reel isn't wrongly dropped. Frames are local-only
  (`brew install ffmpeg`); the serverless cron degrades to caption+cover+audio.
- **Trust > extraction rate:** we don't claim 100% extraction — we publish only what's
  trustworthy. A **publish-gate** holds any event below `PUBLISH_CONFIDENCE` (or with no
  resolved venue/date) off the map; **deterministic validators** null out implausible
  venue/price/age/capacity (an ad-copy "venue" or a `$99999` price); **cross-source
  agreement** bumps confidence when independent posts corroborate. Measured on a frozen
  labeled set (`npm run eval`): gate **F1 95%**, date extraction **100%**, venue **89%**.

### The golden acceptance test

The two reference posts from the brief are first-class citizens of the pipeline
(`GOLDEN_POST_URLS` in `lib/config.ts`) — always scraped regardless of watermarks. In
fixture mode they carry placeholder captions under their **real URLs**; with an
`APIFY_TOKEN` the real content flows through the identical path. Verify:
`curl localhost:3000/api/events | grep DaN_n5NmBER`.

### Demo beats baked into the fixtures

1. **Dedup attach:** the same Public Records night posted by `@new_york_underground`
   *and* `@rub_ulad` → one event, two sources → **trending** ("2 accounts posted this
   in the last 72h").
2. **No false merge:** two different events at Clandestino on the same Friday stay separate.
3. **Hold-don't-drop:** "Secret Loft Show" (address on RSVP) can't resolve a venue →
   kept as `needs_review`, off the map.
4. **The gate works:** an L-train meme (21k likes!) and a bagel listicle are dropped
   before costing an extraction call.
5. **Lifecycle:** last week's Mercury Lounge show is stored but never served.
6. **Lowkey is a positive signal:** small-account events tier as lowkey only when they
   punch above the account's own baseline or come from a trusted curator — a flop can't
   masquerade as a hidden gem.

## Deploy (hosted submission)

```bash
npx vercel                                   # deploy
npx vercel env add DATABASE_URL              # Supabase transaction-pooler URI
npx vercel env add CRON_SECRET               # any random string
# + APIFY_TOKEN / OPENAI_API_KEY / GOOGLE_PLACES_API_KEY to go live
```

`vercel.json` registers a **daily** cron (`/api/cron/ingest`) — Vercel Hobby's
max frequency. For a faster cadence, enable `.github/workflows/ingest.yml`
(every 6h, free — set `INGEST_URL` + `CRON_SECRET` repo secrets), and the
in-app "auto-ingest" pill triggers a run on demand. Without `DATABASE_URL` the
deployed demo self-hydrates from fixtures on cold start (never blank, can't
break on stage).

## Repo map

```
lib/config.ts          seeds, golden URLs, model tiering, cost caps
lib/db.ts              PGlite ↔ Postgres behind one query interface
lib/fixtures.ts        Apify-shaped fixtures, dates relative to NOW
lib/pipeline/          scrape → llm (gate+extract) → resolve → dedup → tiers → run
lib/queries.ts         read side; lifecycle at query time
app/api/events         UI data
app/api/cron/ingest    the autonomous trigger (Vercel Cron / manual refresh)
components/            Corner-clone UI (MapLibre + CARTO Positron)
scripts/ingest.ts      CLI: npm run ingest
```
