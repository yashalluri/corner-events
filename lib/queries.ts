// Read side. Lifecycle (upcoming/live/past) is computed AT QUERY TIME — no
// status column to drift, nothing for the cron to flip. Ephemerality = past
// events simply stop being returned.

import { PUBLISH_CONFIDENCE, env, isIgCdnUrl } from './config';
import { getDb, isEmpty } from './db';
import { neighborhoodFor } from './neighborhoods';
import { runPipeline } from './pipeline/run';
import type { EventStatus, EventWithVenue } from './types';

let hydrating: Promise<void> | null = null;

/** Demo self-healing: on a cold empty store, run the pipeline once so the app
 *  is never blank — but ONLY in full fixture mode. If ANY live key is set
 *  (scrape, LLM, or Places), a page view must never trigger billable work;
 *  live data arrives via `npm run ingest` or the cron. */
async function ensureHydrated(): Promise<void> {
  if (env.anyLive()) return; // any paid stage configured: cron/CLI owns ingestion
  if (!hydrating) {
    hydrating = (async () => {
      if (await isEmpty()) await runPipeline();
    })();
  }
  return hydrating;
}

function statusOf(
  startAt: string | null,
  endAt: string | null,
  venueId: string | null,
  confidence: number,
): EventStatus {
  // Publish-gate: anything unresolved OR low-confidence is HELD off the map.
  // This is what makes "everything published is trustworthy" literally true.
  if (!venueId || !startAt || confidence < PUBLISH_CONFIDENCE) return 'needs_review';
  const now = Date.now();
  const start = new Date(startAt).getTime();
  const end = endAt ? new Date(endAt).getTime() : start + 4 * 3600_000; // default 4h duration
  if (now < start) return 'upcoming';
  if (now <= end) return 'live';
  return 'past';
}

interface EventQueryRow {
  id: string; title: string; description: string | null; venue_id: string | null;
  start_at: string | null; end_at: string | null; cost: string | null; age_limit: string | null;
  capacity: number | null; category: string; external_link: string | null; cover_url: string | null;
  confidence: number; tier: string | null; tier_reason: string | null;
  popular_score: number; heat_score: number; created_at: string; updated_at: string;
  v_name: string | null; v_address: string | null; v_lat: number | null; v_lng: number | null; v_hood: string | null;
}

export async function listEvents(opts?: { includePast?: boolean }): Promise<EventWithVenue[]> {
  await ensureHydrated();
  const db = await getDb();
  // Independent queries — run them concurrently (saves a network round-trip
  // on the hosted Postgres path; PGlite serializes them harmlessly).
  const [rows, sourceRows] = await Promise.all([
    db.query<EventQueryRow>(`
      SELECT e.*, e.start_at::text AS start_at, e.end_at::text AS end_at,
             e.created_at::text AS created_at, e.updated_at::text AS updated_at,
             v.name AS v_name, v.address AS v_address, v.lat AS v_lat, v.lng AS v_lng, v.neighborhood AS v_hood
      FROM events e LEFT JOIN venues v ON v.id = e.venue_id
      ORDER BY e.start_at ASC NULLS LAST
    `),
    db.query<{
      event_id: string; owner_username: string; url: string; likes: number; comments: number; posted_at: string;
    }>(`
      SELECT es.event_id, p.owner_username, p.url, p.likes, p.comments, p.posted_at::text AS posted_at
      FROM event_sources es JOIN posts p ON p.id = es.post_id
    `),
  ]);
  const sourcesByEvent = new Map<string, typeof sourceRows>();
  for (const s of sourceRows) {
    const list = sourcesByEvent.get(s.event_id) ?? [];
    list.push(s);
    sourcesByEvent.set(s.event_id, list);
  }

  const events: EventWithVenue[] = rows.map((r) => ({
    id: r.id, title: r.title, description: r.description, venue_id: r.venue_id,
    start_at: r.start_at, end_at: r.end_at, cost: r.cost, age_limit: r.age_limit,
    capacity: r.capacity, category: r.category, external_link: r.external_link,
    // Presentation-ready cover: IG CDN URLs must go through our same-origin
    // proxy (browser CORP blocking) — decided here once, not in components.
    cover_url:
      r.cover_url && isIgCdnUrl(r.cover_url)
        ? `/api/img?src=${encodeURIComponent(r.cover_url)}`
        : r.cover_url,
    confidence: r.confidence,
    tier: (r.tier as EventWithVenue['tier']) ?? null, tier_reason: r.tier_reason,
    popular_score: r.popular_score, heat_score: r.heat_score,
    created_at: r.created_at, updated_at: r.updated_at,
    status: statusOf(r.start_at, r.end_at, r.venue_id, r.confidence),
    venue: r.v_lat != null && r.v_lng != null
      ? {
          id: r.venue_id!,
          name: r.v_name!,
          address: r.v_address,
          lat: r.v_lat,
          lng: r.v_lng,
          // Fallback for venues ingested before write-time derivation.
          neighborhood: r.v_hood ?? neighborhoodFor(r.v_lat, r.v_lng),
        }
      : null,
    sources: (sourcesByEvent.get(r.id) ?? []).map((s) => ({
      username: s.owner_username, url: s.url, likes: s.likes, comments: s.comments, postedAt: s.posted_at,
    })),
  }));

  // Ephemerality: past + unresolved events are hidden from the product surface.
  if (opts?.includePast) return events;
  return events.filter((e) => e.status === 'upcoming' || e.status === 'live');
}
