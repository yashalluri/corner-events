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
   7 CURATED NYC ACCOUNTS (locked list) + 2 GOLDEN POST URLS
        │
        ▼  autonomous: Vercel Cron (daily) / GitHub Action (6h) / manual ↻ in-app
┌────────────────────────────────────────────────────────────────────────┐
│ A  SCRAPE        Apify instagram-scraper · onlyPostsNewerThan 3mo      │
│                  watermark filter (only new posts per account)          │
│                  scrape failure ≠ run failure: stored unprocessed       │
│                  posts RE-ENTER from the DB (re-extract w/o re-scrape)  │
│                                                                        │
│ A2 SIGNALS       per post type, gathered BEFORE the LLM sees it:       │
│     image   →    cover image                                           │
│     carousel→    cover + every slide (roundups: 1 event per slide)     │
│     reel    →    cover + gpt-4o-transcribe AUDIO (cached on the row)   │
│                  + ffmpeg interior FRAMES (local; cron degrades)       │
│                                                                        │
│ B  GATE          gpt-4o-mini — "is this an event?" (sees transcript    │
│                  too, so emoji-caption reels survive; dated roundups   │
│                  pass, place-listicles don't)                          │
│                                                                        │
│ C  EXTRACT       gpt-4o, ONE call, ALL signals → 1..N EVENTS per post  │
│                  (roundup carousels/reels split; cap 12). Per field:   │
│                  {value, confidence, evidence}; null-beats-a-guess;    │
│                  per-event coverSlideIndex picks its own slide cover   │
│                                                                        │
│ D  VALIDATE +    deterministic: date sanity (now→12mo, tz-resolved     │
│    RESOLVE       vs post timestamp) · implausible venue/price/age/     │
│                  capacity nulled · Google Places ladder                │
│                  (name+addr → name → BARE ADDRESS) → place_id,         │
│                  lat/lng, neighborhood, venue PHOTO (cover fallback)   │
│                                                                        │
│ E  IDENTITY      atomic upsert: PK = surrogate UUID; identity =        │
│                  signature (venue place_id × local-day × title-sim).   │
│                  Re-posts & roundup mentions ATTACH as sources         │
│                  (+confidence) — never duplicate                       │
│                                                                        │
│ F  ENRICH agent  the one true agent: unverified/venue-less upcoming    │
│                  events → SPECIFIC web search (Responses web_search)   │
│                  → corroborate-only verdict. Fill nulls only; promote  │
│                  to verified ONLY on independent same-day source; web  │
│                  can supply the missing venue → Places → pinned        │
│                                                                        │
│ G  TIERS         lowkey / popular / trending — engagement normalized   │
│                  by account baseline, 72h decay, multi-account         │
│                  velocity, ÷fanout so viral roundups don't inflate     │
└────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  Supabase Postgres (embedded PGlite fallback for keyless demo)
  sources · posts (raw + transcripts + slides) · venues (+photos) ·
  events · event_sources (M:N — the attach/corroboration backbone)
        │
        ▼
  /api/events  — lifecycle at query time (upcoming/live shown, past
  auto-hidden, no-venue/no-date HELD off-map; low-confidence SHOWN
  with an "unverified" badge) · IG covers via same-origin /api/img proxy
        │
        ▼
  Corner-clone UI — MapLibre map, tier + category filter chips,
  neighborhood-grouped "events nearby" sheet, tap-through to the
  source Instagram post, Directions, "confirmed on the web" link
```

**Where the intelligence lives (and where it deliberately doesn't):** two LLM
judgment points (gate, extract) + one bounded agent (web corroboration);
everything else — dedup, tiers, lifecycle, validators — is deterministic code.
Yash's original Agent 1/2/3 sketch maps to: Agent 1 → stages A–D; Agents 2+3 →
merged into stage E's atomic upsert (they raced as separate agents).

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
- **Address-only reels still pin:** venue resolution ladders name+address → name →
  **bare address**, so "125 1st Ave, Friday" becomes a real named place. Each venue
  also captures a **Google Places photo** used as the event cover when the IG post
  has no usable image, and the detail card links **Directions** to Google Maps.
- **A web-corroboration agent closes the loop on unverified events:** the one true
  *agent* in the system. Low-confidence/venue-less upcoming events get a **specific**
  web search (OpenAI Responses `web_search`); results are used corroborate-only —
  fill only null fields, never overwrite IG data, and **promote to verified only when
  an independent source confirms the same event in the same local-day window** (the
  web can even supply the missing venue, which Places then resolves to a pin).
  Capped per tick, idempotent via `enriched_at`, runs autonomously in the cron.
  Verified live: a venue-less "Macy's 4th of July Fireworks" was found on the web,
  date-matched, venue-attached (Brooklyn Bridge Pedestrian Walkway), and promoted.
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

## Current state (live data, as of 2026-07-03)

| Metric | Value |
|---|---|
| Posts ingested (3-month window, 6 accounts + collabs) | 204 (all processed) |
| — of which reels (transcribed + framed) | 62 |
| — of which split into multiple events | 19 posts |
| Events extracted | **161** |
| Upcoming/live on the map | **55** (6 badged unverified, 2 web-confirmed) |
| Golden acceptance posts | both ingested & pinned (Nudibranch pop-up; Zwirner archive sale) |

**Measured accuracy** (`npm run eval`, frozen labeled set, live models):
event-gate **F1 100%** · date extraction **100%** · venue match **89%** ·
multi-event split **100%**. Trust stance: we don't claim 100% extraction —
we publish only what's trustworthy (deterministic holds + unverified badge +
web corroboration) and measure the rest.

### Operations notes
- **@thirstygallerina** is 21+ age-gated by Instagram — unscrapeable without a
  logged-in session (API returns `"You must be 21 years old or over"`). Her
  website (thirstygallerina.com) is the roadmap source. **@wtfdwg**'s real
  handle is `wherethefuckdowego` (fixed in config).
- **Apify free credit is exhausted** (deep backfills). The app + dataset work
  fully; the cron discovers *new* posts again once credit is added
  (console.apify.com/billing). A funding lapse is graceful: the run logs the
  402 and continues with stored posts.
- Known limitation: adjacent-place duplicates ("Brooklyn Bridge" vs "Brooklyn
  Bridge Pedestrian Walkway") don't merge — dedup is venue-id-keyed; proximity
  merge is the fix if it matters.
- Re-extraction migrations: wipe `events`+`event_sources` only (keep `posts` —
  cached transcripts/slides — and `venues` — photos), reset
  `posts.processed=false` AND `sources.last_post_ts=NULL`, run `npm run ingest`.

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
