// Stage A — Scrape. Live: Apify instagram-scraper. Fixture: lib/fixtures.
// Watermarks make autonomous re-runs cheap: we only keep posts newer than the
// last processed timestamp per account (golden posts are always kept).

import { env, POSTS_PER_ACCOUNT, SEED_ACCOUNTS } from '../config';
import { getFixturePosts } from '../fixtures';
import type { RawPost } from '../types';

const APIFY_ACTOR = 'apify~instagram-scraper';

/** Run URL + input body for the scraper — shared with scripts/check-live.ts so
 *  the health probe and the real pipeline can't drift apart. */
export const apifyRunUrl = (token: string) =>
  `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${token}&timeout=300`;
export const apifyInput = (directUrls: string[], resultsLimit: number) => ({
  directUrls,
  resultsType: 'posts' as const,
  resultsLimit,
  addParentData: false,
});

interface ApifyItem {
  id?: string;
  shortCode?: string;
  url?: string;
  caption?: string;
  displayUrl?: string;
  timestamp?: string;
  ownerUsername?: string;
  likesCount?: number;
  commentsCount?: number;
  locationName?: string;
  type?: string;
}

function normalize(item: ApifyItem): RawPost | null {
  if (!item.url || !item.timestamp) return null;
  // Real-world Apify quirks: hidden like counts come back as -1; video posts
  // sometimes carry no caption; owner can be absent on shared/direct posts.
  const likes = item.likesCount != null && item.likesCount >= 0 ? item.likesCount : 0;
  const comments = item.commentsCount != null && item.commentsCount >= 0 ? item.commentsCount : 0;
  const ownerFromUrl = item.url.match(/instagram\.com\/([^/]+)\/(?:p|reel)\//)?.[1];
  return {
    id: item.id ?? item.shortCode ?? item.url,
    shortCode: item.shortCode ?? '',
    url: item.url,
    caption: item.caption ?? '',
    displayUrl: item.displayUrl ?? '',
    timestamp: item.timestamp,
    ownerUsername: item.ownerUsername ?? ownerFromUrl ?? 'unknown',
    likesCount: likes,
    commentsCount: comments,
    locationName: item.locationName,
    type: (item.type as RawPost['type']) ?? 'Image',
  };
}

async function scrapeLive(extraUrls: string[]): Promise<RawPost[]> {
  const token = env.apify();
  const directUrls = [
    ...SEED_ACCOUNTS.map((a) => `https://www.instagram.com/${a.username}/`),
    ...extraUrls,
  ];
  const res = await fetch(apifyRunUrl(token!), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(apifyInput(directUrls, POSTS_PER_ACCOUNT)),
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = (await res.json()) as ApifyItem[];
  return items.map(normalize).filter((p): p is RawPost => p !== null);
}

export async function scrape(opts: { goldenUrls: string[] }): Promise<{ posts: RawPost[]; mode: 'live' | 'fixture' }> {
  if (env.apify()) {
    return { posts: await scrapeLive(opts.goldenUrls), mode: 'live' };
  }
  return { posts: getFixturePosts(), mode: 'fixture' };
}

/** Keep only posts newer than each account's watermark. Golden posts always pass. */
export function applyWatermarks(
  posts: RawPost[],
  watermarks: Map<string, string>, // username → ISO of newest processed post
  goldenIds: Set<string>,
): RawPost[] {
  return posts.filter((p) => {
    if (goldenIds.has(p.id)) return true;
    const wm = watermarks.get(p.ownerUsername);
    return !wm || p.timestamp > wm;
  });
}
