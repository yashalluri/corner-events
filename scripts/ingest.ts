// CLI entry: `npm run ingest`. Same pipeline the cron runs.
// Load .env.local first — Next.js does this automatically, tsx does not.
import { existsSync, readFileSync } from 'fs';
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

import { runPipeline } from '../lib/pipeline/run';

runPipeline()
  .then((stats) => {
    console.log('\n── pipeline run complete ──');
    console.log(JSON.stringify(stats, null, 2));
    process.exit(stats.errors.length > 3 ? 1 : 0);
  })
  .catch((e) => {
    console.error('pipeline failed:', e);
    process.exit(1);
  });
