# Corner Events — PRD & Implementation Plan
**Instagram → the best ephemeral events in a city**

_Author: Yash · For: Corner (Eliza Wu, Jake Xia) · Phase 1 deliverable (scoping + plan)_

---

## 0. Thesis in one paragraph

The hard part of this project is **not** scraping Instagram — Apify already does that. The hard part is turning a noisy, human, meme-filled feed into a **clean, deduplicated, trustworthy set of *events* pinned to real *places* on a map, and keeping them fresh as they change.** Everything below optimizes for three things the founders actually care about: (1) clean data out of messy IG, (2) identity/dedup/freshness, and (3) a defensible point of view on what "best" means. The MVP's acceptance test is concrete: **ingest the two reference IG posts and place them correctly on the Corner map.**

---

## 1. Problem & goal

Corner surfaces places friends love. Events are the missing, most *time-sensitive* layer — pop-ups, dinners, shows, drops — and the good ones live in Instagram captions, flyers, and reels, not on Eventbrite. Goal: **an ingestion pipeline that continuously converts NYC Instagram content into structured, deduped, map-ready events**, ranked so the *best* rise to the top.

**Non-goals (Phase 1):** ticketing/RSVP, user-generated event submission, cities beyond NYC, real-time push. Design for them; don't build them.

---

## 2. What "best" means (product POV)

The brief says surface *the best* events — that's a ranking stance, not just ingestion. My opinion, as a score:

| Signal | Why it means "best" |
|---|---|
| **Source authority** | Curated by an account with a track record (a trusted local vs. a random repost) |
| **Scarcity / ephemerality** | One-night pop-up > standing weekly. Corner's whole angle is *ephemeral*. |
| **Engagement** | Likes/saves/comments on the post as a demand proxy |
| **Proximity & timing** | Near the user, happening soon (tonight/this week) |
| **Extraction confidence** | We only rank high what we're sure we understood |

Ranking is a first-class output, not an afterthought — it's the product judgment layer.

**Surfacing it — event tiers, the way Corner tiers places.** Corner already speaks in vibe tiers; events get the same language, computed from **engagement (likes · comments · shares) aggregated across every post about an event** — which the dedup model enables, since many posts resolve to one `event_id`. The three tiers are three *different axes*, not one popularity scale:

- **Lowkey** — *hidden gem / quality*: low reach **but** a positive signal (trusted curator, or high engagement-rate for a small account). Guard: must mean "under-the-radar gem," not "nobody cared" — a flop can't masquerade as a gem.
- **Popular** — *magnitude*: high total engagement across all observed posts.
- **Trending** — *velocity*: engagement accelerating now, and/or several accounts posting it in a short window. Pairs directly with ephemerality.

Two rules so tiers don't lie: (1) normalize on **engagement rate** (interactions ÷ the account's own baseline) so big accounts don't win everything; (2) apply **time-decay** so tiers recompute over an event's life — an event can move lowkey → trending → popular. The freshness job (§6) that expires events also recomputes tiers.

---

## 3. The core hard problem — identity & dedup (answering Jake's sticky note)

> _"How do we make sure our 'primary keys' are accurate and unique?"_ — Jake

**Short answer: you don't key on natural fields.** `(place, event desc, time)` as a primary key is too noisy to ever be unique — descriptions are free text, times are written as "this Fri," and the same event gets reposted five different ways.

**The model:**

1. **Surrogate key.** Every event gets a `event_id` UUID. That's the real primary key — stable, unique by construction.
2. **Derived dedup signature** (how we decide two extractions are the *same* event):
   `dedup_sig = venue_place_id  +  normalized_start_datetime (bucketed)  +  title/embedding similarity ≥ threshold`
   - `venue_place_id` comes from **Google Places** (canonical, not free-text) → also gives us geo coords for the map.
   - `normalized_start_datetime` requires resolving relative dates first (§5) — this is the linchpin; you can't dedup on a date you haven't normalized.
   - title match is fuzzy + embedding cosine similarity, so "Devin Shaffer b2b" and "Devin Shaffer live" collapse.
3. **Re-posts attach, they don't duplicate.** A second post about the same event creates a new `source` row linked to the existing `event_id` via the `event_sources` join — never a new event. This is also how we *increase confidence* (two independent sources agree) and *enrich* (one post has the price, another the lineup).

**The failure modes a naive dedup breaks on — and how we handle each:**

| Failure mode | Naive result | Our handling |
|---|---|---|
| Same event, **two venues** (a tour / crawl) | Merged into one wrong event | Signature is per (venue × time); a multi-venue event is modeled as linked instances |
| **Two different events, one venue, same night** | Wrongly merged | Title/embedding similarity threshold keeps them apart |
| **Recurring series** ("every Thursday") vs one-off | Either explodes into dupes or collapses distinct nights | `recurrence_rule` on the event; each dated instance is its own occurrence |

This is the section to lead with in the interview — it's the one explicit question a founder wrote down.

---

## 4. Architecture — reframing your Agent 1/2/3 as a pipeline

Your three agents are the right decomposition. I'm **keeping them** and expanding Agent 1 into named stages, because that's where the data quality is won or lost.

```
SOURCES ──▶ [Orchestrator/Scheduler]
   IG accounts, hashtags, location tags
        │
        ▼   ── AGENT 1: ingest & structure ──────────────────────────────
   A. Scrape (Apify)      posts · reels · stories
   B. Event-gate          "is this even an event?"  ← NEW, drops non-events
   C. Extract (LLM)       vision + caption → fields, per-field confidence + evidence
   D. Resolve             relative-date normalization  +  Google Places venue match
        │  structured JSON
        ▼   ── AGENT 2: identity (new events) ────────────────────────────
   E. Dedup signature  ─▶ new? mint event_id + ingest
                          duplicate? ─────────────────┐
        ▼   ── AGENT 3: updates ─────────────────────┘──────────────────
   F. Merge  overlapping info → enrich existing event / attach source
        │
        ▼
   STORE  (venues · events · sources · event_sources)
        │
        ▼
   RANK / CURATE ("best")  ──▶  Corner map (client)

   low-confidence extractions ──▶ review queue (post-MVP)
```

**Two stages you don't have yet, and why they matter most:**

- **B. Event-gate (biggest gap).** `@newyorklocals` posts memes and café recs, not just events. Your Agent 1 assumes every recent post is an event and pays for vision extraction on all of them. A cheap classifier ("is this an event? y/n") *before* extraction saves cost and, more importantly, protects precision — a meme shown as an event is worse than a missed event when the brief says surface *the best*.
- **D. Date resolution.** Captions say "tonight," "this Friday," "opening next week." Resolve against the **post's timestamp + timezone**. Without this you can neither rank by "happening soon" nor dedup by date. It's small but load-bearing.

---

## 5. Extraction — messy IG → clean structured events

**Fields** (yours, kept): cover image, venue name, address, description, start/end datetime, signup/RSVP deadline, capacity, age limit, cost, category, external link. Plus: `source_url`, `source_account`, `confidence` per field, `evidence_span`.

**Reels:** don't run vision on every frame — sample keyframes + transcribe audio (Whisper) + read the caption. Most event info is in the caption and the flyer frame; escalate to dense vision only when those are thin.

**Anti-hallucination (this is where vision LLMs fabricate):** fields like `capacity: 50`, `cost: $27`, `21+` pulled off a flyer are the #1 hallucination risk. Rules: (a) **per-field confidence**, (b) require an **evidence span** — the caption text or image region the value came from, (c) **`null` beats a guess** — a missing field is fine; a confident wrong price is a support ticket. Low-confidence fields route to the review queue rather than the map.

**Venue accuracy (your Google Places step, kept & sharpened):** feed extracted `<name> + <address/neighborhood>` to Places, take the top match above a score threshold, store `place_id + lat/lng`. If no confident match → hold, don't drop (it may be a brand-new venue). This is what makes an event *map-able*.

---

## 6. Freshness & lifecycle (ephemerality)

Events aren't static rows — they have a life. Model a status: `upcoming → live → past → archived`, plus `cancelled`. A scheduled job flips status by time and **auto-hides past events from the map** (the screenshots show live "events nearby" — stale events erode trust fast). Stories (24h TTL) are the *most* ephemeral and often the richest event source — worth scraping on a faster cadence than posts.

---

## 7. Sourcing strategy (Instagram reality)

- **Seed:** a hand-picked set of NYC curator accounts + event hashtags + location tags. Start narrow, NYC-only. Working seed list: `@wtfdwg`, `@newyorklocals`, `@secret_nyc`, `@nybucketlist`, `@thirstygallerina`, `@new_york_underground`, `@rub_ulad` (+ venue accounts). These double as the `source_authority` prior for the lowkey/popular/trending tiers.
- **Tooling:** Apify Instagram Scraper (proven, 150M+ runs). Respect rate limits; cache; be mindful of IG ToS — this is an aggregation prototype, keep it read-only and attributed.
- **Discovery loop:** accounts that reliably post good events get a higher `source_authority`; mine reposts/tags to discover new curator accounts over time.

---

## 8. Deltas to your design (what I'd change and why)

| Your design | Recommendation | Why |
|---|---|---|
| PK = (place, desc, time) | Surrogate `event_id` + derived dedup signature | Natural fields are never unique; answers Jake directly |
| Agent 1 scrapes → extracts every post | Insert **event-gate** before extraction | Precision + cost; not every post is an event |
| "time and date" as a field | **Relative-date resolver** using post timestamp | Can't rank/dedup on unresolved "this Friday" |
| Google Places for name accuracy | Same, + **store place_id & lat/lng**; hold-don't-drop on no match | It's the map-ability step, not just spell-check |
| Extract all fields | **Per-field confidence + evidence + null>guess** | Vision LLMs fabricate capacity/price/age |
| Ingest / not-ingest | Add **review queue** for low confidence (post-MVP) | Human catches what the model isn't sure about |
| (implicit) events are permanent | **Lifecycle + TTL + auto-expire** | Corner's angle is *ephemeral*; stale = untrust |
| (missing) ranking | **"Best" score → lowkey / popular / trending** tiers | Brief says *best*, not *all*; mirrors how Corner tiers places |

---

## 9. MVP scope + the golden test

**Ship in the hackathon (hosted):**
1. Scrape ~5 seed NYC accounts.
2. Event-gate → extract → resolve date → resolve venue (Places) → structured JSON.
3. Dedup + store (Postgres + pgvector for embedding similarity).
4. **A hosted webapp UI that is a faithful clone of the Corner app** (see UI parity below), showing ingested events with source attribution.

**UI parity (this is a presentation requirement, not polish).** The demo must *feel like Corner* so it reads as "ships in the app tomorrow," not "a pipeline with a rough demo." Match, from the reference screenshots:
- **Map-first, full-screen** — light minimalist map, green parks, circular avatar/emoji pins with place name + one-line descriptor.
- **Category chips** at the bottom (`top picks · eat · cafes · bars · events · go out`) with the `everyone ▾` + `open now` toggles; **`events` selected by default** for the demo.
- **"Events nearby" list** — venue headers with horizontal event cards (cover image, title, date, price), matching the second screenshot.
- **Bottom nav** (friends · map · search · profile · +) and the top location/search bar.
- The **lowkey / popular / trending** tiers render as **filter chips**, exactly like Corner's own vibe filters — so the feature reads as native.
- Events appear **both** as map pins and in the events-nearby list, driven off the same `events` table.

**UI tech:** React + **MapLibre GL** (free, no token) or Mapbox GL with a custom light style; event pins as custom HTML markers; everything else plain CSS. Reuse Corner's exact vocabulary, chip layout, pin style, and typography.

**Golden acceptance test:** the two reference IG posts the interviewer handed over must be **demonstrably ingested and correctly pinned** — right venue, right date, deduped if related. Those URLs are the implicit test; treat passing them as done-definition.

**Cut for MVP:** review-queue UI, multi-city, stories cadence, discovery loop, ranking beyond a simple score. Design for them, stub them.

---

## 10. Phased build sequence (for Phase 2)

1. **Skeleton** — repo, Postgres schema (venues/events/sources/event_sources), env for Apify + Places + LLM keys.
2. **Ingest one post** — hardcode the two reference URLs → Apify → raw JSON in DB. Prove the pipe end-to-end before scaling.
3. **Extract** — event-gate + LLM field extraction with confidence + evidence on those two posts.
4. **Resolve** — date normalization + Google Places → lat/lng.
5. **Dedup + store** — signature, mint/attach, event_sources.
6. **Scale sources** — point at 5 seed accounts, batch.
7. **UI (Corner clone)** — React + MapLibre GL map with event pins, category chips (`events` default), "events nearby" list, bottom nav, and lowkey/popular/trending filter chips; source attribution + simple "best" sort. Pixel-match the reference screenshots.
8. **Demo** — the two golden posts live on the Corner-style map + a batch from real accounts.

---

## 11. Risks, metrics, open questions

**Risks:** IG scraping fragility/ToS; vision hallucination on flyers; venue mismatch for brand-new/unlisted spots; dedup threshold tuning (too tight = dupes, too loose = merged distinct events).

**Metrics:** extraction precision/recall on a hand-labeled set; dedup false-merge & false-split rate; % events with confident venue match; freshness (median lag from post → live on map); "best"-ranking human agreement.

**Open questions for the founders:** How much human curation is acceptable vs. fully automated? Is user-submitted content in scope later? What's the tolerance for a wrong event on the map (precision vs. recall bias)?
