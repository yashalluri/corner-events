// CLI entry: `npm run ingest`. Same pipeline the cron runs.
import './load-env';
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
