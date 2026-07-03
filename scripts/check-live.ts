// Live-integration smoke test: Supabase, Google Places, Apify (tiny probe).
// Usage: npx tsx scripts/check-live.ts [--apify]

import { readFileSync } from 'fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { getDb } from '../lib/db';
import { resolveVenue } from '../lib/pipeline/resolve';
import { GOLDEN_POST_URLS, env } from '../lib/config';
import type { Extraction } from '../lib/types';

const fv = (v: string) => ({ value: v, confidence: 0.95, evidence: v });
const nul = () => ({ value: null, confidence: 0, evidence: null });

async function main() {
  // ── 1. Supabase ──
  try {
    const db = await getDb();
    const tables = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    console.log('SUPABASE  ✓ connected · tables:', tables.map((t) => t.tablename).join(', '));
  } catch (e) {
    console.log('SUPABASE  ✗', e instanceof Error ? e.message : e);
  }

  // ── 2. Google Places ──
  try {
    const venue = await resolveVenue({ venueName: fv('Public Records Brooklyn'), address: nul() } as unknown as Extraction);
    console.log(
      'PLACES    ',
      venue && !venue.id.startsWith('fixture:')
        ? `✓ live: ${venue.name} → ${venue.id.slice(0, 24)}… (${venue.lat.toFixed(4)}, ${venue.lng.toFixed(4)})`
        : venue
          ? `⚠ fell back to fixture directory (${venue.id}) — live lookup failed`
          : '✗ no result',
    );
  } catch (e) {
    console.log('PLACES    ✗', e instanceof Error ? e.message : e);
  }

  // ── 3. Apify tiny probe (only with --apify; costs ~$0.01) ──
  if (process.argv.includes('--apify')) {
    try {
      const res = await fetch(
        `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${env.apify()}&timeout=180`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            directUrls: [...GOLDEN_POST_URLS, 'https://www.instagram.com/wtfdwg/'],
            resultsType: 'posts',
            resultsLimit: 3,
            addParentData: false,
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const items = (await res.json()) as Record<string, unknown>[];
      console.log(`APIFY     ✓ ${items.length} items returned`);
      for (const it of items.slice(0, 6)) {
        console.log(
          `   · ${String(it.url ?? '?').slice(0, 60)} | owner=${it.ownerUsername ?? '∅'} | ts=${it.timestamp ?? '∅'} | likes=${it.likesCount ?? '∅'} | type=${it.type ?? '∅'} | caption=${String(it.caption ?? '').slice(0, 60).replace(/\n/g, ' ')}`,
        );
      }
      console.log('   field sample keys:', Object.keys(items[0] ?? {}).slice(0, 25).join(','));
    } catch (e) {
      console.log('APIFY     ✗', e instanceof Error ? e.message : e);
    }
  } else {
    console.log('APIFY     (skipped — pass --apify to run the ~$0.01 probe)');
  }
  process.exit(0);
}

main();
