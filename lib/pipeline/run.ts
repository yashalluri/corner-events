// The pipeline orchestrator — one idempotent pass, safe to auto-trigger.
//
//   scrape → watermark filter → store raw → gate → extract → validate dates
//   → resolve venue → atomic upsert → recompute tiers → advance watermarks
//
// Idempotency comes from three places: watermarks (don't reprocess old posts),
// raw post storage (re-extract without re-scraping), and the dedup signature
// (re-ingesting the same content is a no-op). A double-fired cron is harmless.

import { GOLDEN_POST_URLS, MAX_LLM_CALLS_PER_TICK, MAX_POSTS_PER_TICK, SEED_ACCOUNTS } from '../config';
import { getDb } from '../db';
import type { PipelineStats, RawPost } from '../types';
import { applyWatermarks, scrape } from './scrape';
import { eventGate, extract, llmMode } from './llm';
import { placesMode, resolveVenue, scrubImplausibleFields, validateDates } from './resolve';
import { upsertEvent } from './dedup';
import { recomputeTiers } from './tiers';
import { transcribeVideo } from './transcribe';
import { sampleFrames } from './frames';
import { enrichUnverified } from './enrich';

export async function runPipeline(): Promise<PipelineStats> {
  const db = await getDb();
  const stats: PipelineStats = {
    scraped: 0, gated_out: 0, extracted: 0, venue_unresolved: 0,
    inserted: 0, merged: 0, skipped_duplicates: 0, enriched: 0, promoted: 0, errors: [],
    mode: { scrape: 'fixture', llm: llmMode(), places: placesMode() },
  };

  // 0. Seed source rows (authority priors).
  for (const a of SEED_ACCOUNTS) {
    await db.query(
      `INSERT INTO sources (username, authority) VALUES ($1,$2)
       ON CONFLICT (username) DO UPDATE SET authority = EXCLUDED.authority`,
      [a.username, a.authority],
    );
  }

  // 1. Scrape (live or fixture — same shape). A scrape failure (Apify quota,
  // IG throttling, network) must NOT kill the run — stored unprocessed posts
  // still re-enter from the DB in step 3.5, and enrichment still runs.
  let allPosts: RawPost[] = [];
  try {
    const scraped = await scrape({ goldenUrls: GOLDEN_POST_URLS });
    allPosts = scraped.posts;
    stats.mode.scrape = scraped.mode;
  } catch (e) {
    stats.errors.push(`scrape failed (continuing with stored posts): ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    stats.mode.scrape = 'live';
  }

  // 2. Watermark filter + per-tick cap (cost guard #1).
  const wmRows = await db.query<{ username: string; last_post_ts: string | null }>(
    `SELECT username, last_post_ts::text AS last_post_ts FROM sources`,
  );
  const watermarks = new Map(wmRows.filter((r) => r.last_post_ts).map((r) => [r.username, r.last_post_ts!]));
  const goldenIds = new Set(allPosts.filter((p) => GOLDEN_POST_URLS.includes(p.url)).map((p) => p.id));
  const fresh = applyWatermarks(allPosts, watermarks, goldenIds).slice(0, MAX_POSTS_PER_TICK);
  stats.scraped = fresh.length;

  // 3. Store raw posts (idempotent; enables re-extraction without re-scraping).
  for (const p of fresh) {
    await db.query(
      `INSERT INTO posts (id, short_code, url, owner_username, caption, display_url, video_url, slide_urls, posted_at, likes, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         likes = EXCLUDED.likes,
         comments = EXCLUDED.comments,
         video_url = COALESCE(posts.video_url, EXCLUDED.video_url),
         slide_urls = COALESCE(posts.slide_urls, EXCLUDED.slide_urls)`,
      [
        p.id, p.shortCode, p.url, p.ownerUsername, p.caption, p.displayUrl || null,
        p.videoUrl || null, p.slideUrls?.length ? JSON.stringify(p.slideUrls) : null,
        p.timestamp, p.likesCount, p.commentsCount,
      ],
    );
    // Unknown accounts (e.g. golden-post authors) still need a sources row for baselines.
    await db.query(`INSERT INTO sources (username, authority) VALUES ($1, 0.5) ON CONFLICT DO NOTHING`, [p.ownerUsername]);
  }

  // 3.5 Re-extract WITHOUT re-scraping: stored posts that are still unprocessed
  // (deferred by a past cap, stranded by a partial scrape, or reset for a
  // re-extraction migration) re-enter the pipeline from the DB. This is the
  // whole reason raw posts are persisted.
  const freshIds = new Set(fresh.map((p) => p.id));
  const pendingRows = await db.query<{
    id: string; short_code: string; url: string; owner_username: string; caption: string | null;
    display_url: string | null; video_url: string | null; transcript: string | null; slide_urls: string | null;
    posted_at: string; likes: number; comments: number;
  }>(
    `SELECT id, short_code, url, owner_username, caption, display_url, video_url, transcript, slide_urls,
            posted_at::text AS posted_at, likes, comments
     FROM posts WHERE NOT processed ORDER BY posted_at DESC LIMIT $1`,
    [MAX_POSTS_PER_TICK],
  );
  const pending: RawPost[] = pendingRows
    .filter((r) => !freshIds.has(r.id))
    .map((r) => ({
      id: r.id,
      shortCode: r.short_code,
      url: r.url,
      caption: r.caption ?? '',
      displayUrl: r.display_url ?? '',
      timestamp: r.posted_at,
      ownerUsername: r.owner_username,
      likesCount: r.likes,
      commentsCount: r.comments,
      type: r.video_url ? ('Video' as const) : ('Image' as const),
      videoUrl: r.video_url ?? undefined,
      slideUrls: r.slide_urls ? (JSON.parse(r.slide_urls) as string[]) : undefined,
    }));
  const toProcess = [...fresh, ...pending].slice(0, MAX_POSTS_PER_TICK);
  if (pending.length > 0) console.log(`  (+${pending.length} stored unprocessed posts re-entering from DB)`);

  // 4. Gate → extract → resolve → upsert, with an LLM-call budget (cost guard #2).
  // One compact log line per post so the first live run is debuggable.
  const log = (post: { id: string; ownerUsername: string }, msg: string) =>
    console.log(`  [${post.ownerUsername.padEnd(20)}] ${post.id.slice(0, 24).padEnd(24)} ${msg}`);
  let llmCalls = 0;
  for (const post of toProcess) {
    try {
      const already = await db.query<{ processed: boolean }>(`SELECT processed FROM posts WHERE id=$1`, [post.id]);
      if (already[0]?.processed) { stats.skipped_duplicates++; log(post, 'already processed → skip'); continue; }

      if (llmCalls >= MAX_LLM_CALLS_PER_TICK) { stats.errors.push('LLM budget reached — remaining posts deferred to next tick'); break; }

      // Videos: gather the full signal set BEFORE gating (a reel's caption is
      // often just an emoji — its real content is spoken or on-screen).
      let transcript: string | null = null;
      let frames: string[] | null = null;
      let videoTag = '';
      if (post.videoUrl) {
        const cached = await db.query<{ transcript: string | null }>(`SELECT transcript FROM posts WHERE id=$1`, [post.id]);
        transcript = cached[0]?.transcript ?? (await transcribeVideo(post.videoUrl));
        if (transcript && !cached[0]?.transcript) {
          await db.query(`UPDATE posts SET transcript=$2 WHERE id=$1`, [post.id, transcript]);
        }
        frames = await sampleFrames(post.videoUrl);
        videoTag = ` transcript:${transcript ? '✓' : '✗'} frames:${frames?.length ?? 0}`;
      }

      llmCalls++;
      const isEvent = await eventGate(post, transcript);
      await db.query(`UPDATE posts SET is_event=$2 WHERE id=$1`, [post.id, isEvent]);
      if (!isEvent) {
        stats.gated_out++;
        await db.query(`UPDATE posts SET processed=true WHERE id=$1`, [post.id]);
        log(post, `gate:✗ not an event${videoTag}`);
        continue;
      }

      llmCalls++;
      const extractions = await extract(post, { transcript, frames });
      if (extractions.length === 0) {
        stats.errors.push(`${post.id}: no extraction available`);
        log(post, `gate:✓ extract:✗${videoTag}`);
        continue;
      }
      const multiTag = extractions.length > 1 ? ` multi:${extractions.length}` : '';

      // One post can carry several events (roundup carousels, "top 5" reels) —
      // each runs the full resolve→upsert path independently.
      for (const [i, extraction] of extractions.entries()) {
        scrubImplausibleFields(extraction); // deterministic anti-hallucination on cost/age/capacity

        const dates = validateDates(extraction);
        if (!dates.ok) {
          stats.errors.push(`${post.id}[${i}]: ${dates.reason}`);
          log(post, `gate:✓ extract:✓${videoTag}${multiTag} [${i + 1}/${extractions.length}] dates:✗ (${dates.reason})`);
          continue;
        }
        stats.extracted++;

        const venue = await resolveVenue(extraction);
        if (!venue) stats.venue_unresolved++; // hold-don't-drop: event still stored, off-map

        // Resolve the display title here (needs venue + category context); real
        // captions sometimes yield none — synthesize a readable fallback.
        const cat = extraction.category.value ?? 'event';
        const catLabel = cat[0].toUpperCase() + cat.slice(1);
        const title =
          extraction.title.value?.trim() ||
          (venue ? `${catLabel} at ${venue.name}` : `${catLabel} (details in post)`);

        // Per-event cover: the model picked which image represents THIS event
        // (0 = post cover, 1..N = carousel slides). Out-of-range/null → cover.
        const idx = extraction.coverSlideIndex;
        const cover =
          idx != null && idx >= 1 && idx <= (post.slideUrls?.length ?? 0)
            ? post.slideUrls![idx - 1]
            : post.displayUrl || null;

        const result = await upsertEvent(db, post, extraction, venue, title, cover);
        if (result.action === 'inserted') stats.inserted++;
        else if (result.action === 'merged') stats.merged++;
        else stats.skipped_duplicates++;

        log(post, `gate:✓ extract:✓${videoTag}${multiTag} [${i + 1}/${extractions.length}] venue:${venue ? '✓ ' + venue.name : '✗ needs_review'} → ${result.action} "${title.slice(0, 40)}"`);
      }

      await db.query(`UPDATE posts SET processed=true WHERE id=$1`, [post.id]);
    } catch (e) {
      stats.errors.push(`${post.id}: ${e instanceof Error ? e.message : String(e)}`);
      log(post, `ERROR: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
    }
  }

  // 5. Web-corroboration agent: try to verify + fill the unverified bucket
  //    (specific searches, corroborate-only, capped, idempotent via enriched_at).
  const enrichResult = await enrichUnverified(db, (id, msg) =>
    console.log(`  [enrich              ] ${id.slice(0, 24).padEnd(24)} ${msg}`),
  );
  stats.enriched = enrichResult.enriched;
  stats.promoted = enrichResult.promoted;

  // 6. Tiers recompute over the whole set (decay means these shift every tick).
  await recomputeTiers(db);

  // 6. Advance watermarks to the newest processed post per account.
  await db.query(`
    UPDATE sources s SET last_post_ts = sub.newest FROM (
      SELECT owner_username, max(posted_at) AS newest FROM posts WHERE processed GROUP BY owner_username
    ) sub WHERE sub.owner_username = s.username
  `);

  return stats;
}
