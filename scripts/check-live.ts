// Live-integration smoke test: Supabase, Google Places, Apify (tiny probe).
// Usage: npx tsx scripts/check-live.ts [--apify]

import './load-env';
import { getDb } from '../lib/db';
import { fv, nul } from '../lib/fixtures';
import { resolveVenue } from '../lib/pipeline/resolve';
import { apifyInput, apifyRunUrl } from '../lib/pipeline/scrape';
import { GOLDEN_POST_URLS, env } from '../lib/config';
import type { Extraction } from '../lib/types';

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
    const venue = await resolveVenue({
      venueName: fv('Public Records Brooklyn', 0.95),
      address: nul(),
    } as unknown as Extraction);
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
  // Uses the SAME run URL + input builder as the real pipeline, so this probe
  // and production can't drift apart.
  if (process.argv.includes('--apify')) {
    try {
      const res = await fetch(apifyRunUrl(env.apify()!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(apifyInput([...GOLDEN_POST_URLS, 'https://www.instagram.com/wherethefuckdowego/'], 3)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const items = (await res.json()) as Record<string, unknown>[];
      console.log(`APIFY     ✓ ${items.length} items returned`);
      for (const it of items.slice(0, 6)) {
        console.log(
          `   · ${String(it.url ?? '?').slice(0, 60)} | owner=${it.ownerUsername ?? '∅'} | ts=${it.timestamp ?? '∅'} | likes=${it.likesCount ?? '∅'} | caption=${String(it.caption ?? '').slice(0, 60).replace(/\n/g, ' ')}`,
        );
      }
    } catch (e) {
      console.log('APIFY     ✗', e instanceof Error ? e.message : e);
    }
  } else {
    console.log('APIFY     (skipped — pass --apify to run the ~$0.01 probe)');
  }
  process.exit(0);
}

main();
