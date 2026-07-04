// Stage F — Tiers: lowkey / popular / trending, Corner's vocabulary for events.
//
// Three different AXES, not one popularity scale:
//   popular  = magnitude  — total engagement across every post about the event
//   trending = velocity   — recency-decayed engagement rate, or ≥2 accounts
//                           posting the same event within 72h
//   lowkey   = hidden gem — low reach BUT punching above its account's baseline
//                           (a flop must not masquerade as a gem)
//
// Two rules so tiers don't lie:
//   1. normalize by the account's own baseline (median engagement of its
//      scraped posts) so big accounts don't win everything — zero extra API calls
//   2. time-decay so tiers recompute over an event's life on every cron tick

import type { Db } from '../db';

interface PostAgg {
  event_id: string;
  owner_username: string;
  likes: number;
  comments: number;
  posted_at: string;
  baseline: number | null;
  authority: number | null;
  fanout: number; // how many events this post links to (roundups > 1)
}

/** The one engagement formula — tiers AND the UI's "top source post" ranking
 *  use this, so the pin's tier reason and its tap-through link can't diverge. */
export const engagement = (likes: number, comments: number) => likes + 3 * comments;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function recomputeTiers(db: Db): Promise<void> {
  // 1. Refresh per-account baselines from ALL scraped posts (event or not).
  await db.query(`
    UPDATE sources s SET baseline_engagement = sub.med FROM (
      SELECT owner_username,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY likes + 3*comments) AS med
      FROM posts GROUP BY owner_username
    ) sub WHERE sub.owner_username = s.username
  `);

  // 2. Pull per-event source posts with baselines + authority.
  const rows = await db.query<PostAgg>(`
    SELECT es.event_id, p.owner_username, p.likes, p.comments, p.posted_at::text AS posted_at,
           s.baseline_engagement AS baseline, s.authority,
           (SELECT count(*)::int FROM event_sources es2 WHERE es2.post_id = p.id) AS fanout
    FROM event_sources es
    JOIN posts p ON p.id = es.post_id
    LEFT JOIN sources s ON s.username = p.owner_username
  `);

  const now = Date.now();
  const byEvent = new Map<string, PostAgg[]>();
  for (const r of rows) {
    const list = byEvent.get(r.event_id) ?? [];
    list.push(r);
    byEvent.set(r.event_id, list);
  }

  interface Score {
    eventId: string;
    popular: number;
    heat: number;
    maxRate: number;
    accounts72h: number;
    topAuthority: number;
  }
  const scores: Score[] = [];

  for (const [eventId, posts] of byEvent) {
    let popular = 0;
    let heat = 0;
    let maxRate = 0;
    let topAuthority = 0;
    const accounts72h = new Set<string>();
    for (const p of posts) {
      // A roundup's engagement is split across the N events it mentions —
      // one viral "10 things this weekend" post must not make all 10 "popular".
      const fanout = Math.max(1, p.fanout ?? 1);
      const e = engagement(p.likes, p.comments) / fanout;
      const baseline = Math.max(1, p.baseline ?? 200); // unknown accounts get a conservative default
      const rate = e / baseline;
      const ageH = Math.max(0, (now - new Date(p.posted_at).getTime()) / 3600_000);
      popular += e;
      heat += rate * Math.exp(-ageH / 72); // 72h half-life-ish decay
      maxRate = Math.max(maxRate, rate);
      topAuthority = Math.max(topAuthority, p.authority ?? 0.5);
      if (ageH <= 72) accounts72h.add(p.owner_username);
    }
    scores.push({ eventId, popular, heat, maxRate, accounts72h: accounts72h.size, topAuthority });
  }

  // 3. Percentile thresholds across the CURRENT event set (small-data-friendly).
  const popSorted = scores.map((s) => s.popular).sort((a, b) => a - b);
  const heatSorted = scores.map((s) => s.heat).sort((a, b) => a - b);
  const popP70 = percentile(popSorted, 70);
  const popP45 = percentile(popSorted, 45);
  const heatP70 = percentile(heatSorted, 70);

  // 4. Assign tiers. Priority: trending > popular > lowkey (an event can qualify
  //    for several; the most time-sensitive label wins — Corner's angle is ephemeral).
  const assignments = scores.map((s) => {
    let tier: string | null = null;
    let reason: string | null = null;

    if (s.accounts72h >= 2) {
      tier = 'trending';
      reason = `${s.accounts72h} accounts posted this in the last 72h`;
    } else if (s.heat >= heatP70 && s.heat > 0 && scores.length >= 4) {
      tier = 'trending';
      reason = 'engagement accelerating right now';
    } else if (s.popular >= popP70 && s.popular > 0 && scores.length >= 4) {
      tier = 'popular';
      reason = `${Math.round(s.popular).toLocaleString()} engagement across sources`;
    } else if (s.popular <= popP45 && (s.maxRate >= 1.2 || s.topAuthority >= 0.85)) {
      // lowkey requires a POSITIVE signal — punching above baseline or a trusted
      // curator — never just "low numbers".
      tier = 'lowkey';
      reason =
        s.maxRate >= 1.2
          ? `${s.maxRate.toFixed(1)}× its account's usual engagement`
          : 'from a trusted curator, still under the radar';
    }
    return { id: s.eventId, tier, reason, popular: s.popular, heat: s.heat };
  });

  // 5. One bulk UPDATE instead of N round-trips (matters at cron scale).
  if (assignments.length > 0) {
    const params: unknown[] = [];
    const values = assignments
      .map((a, i) => {
        const b = i * 5;
        params.push(a.id, a.tier, a.reason, a.popular, a.heat);
        return `($${b + 1}::text, $${b + 2}::text, $${b + 3}::text, $${b + 4}::float8, $${b + 5}::float8)`;
      })
      .join(',');
    await db.query(
      `UPDATE events e SET tier = v.tier, tier_reason = v.reason,
              popular_score = v.pop, heat_score = v.heat, updated_at = now()
       FROM (VALUES ${values}) AS v(id, tier, reason, pop, heat)
       WHERE e.id = v.id`,
      params,
    );
  }
}
