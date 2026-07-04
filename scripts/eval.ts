// Accuracy harness: `npm run eval`. Runs the live gate + extract over the
// frozen labeled set and reports precision/recall/F1 for the event-gate plus
// extraction quality (valid date, venue-hint match). Requires OPENAI_API_KEY;
// falls back to fixture heuristics without it (weaker, but still runs).

import './load-env';
import { EVAL_SET, type EvalCase } from '../lib/eval-set';
import { eventGate, extract, llmMode } from '../lib/pipeline/llm';
import { validateDates, scrubImplausibleFields } from '../lib/pipeline/resolve';
import type { RawPost } from '../lib/types';

function toPost(c: EvalCase): RawPost {
  return {
    id: c.id,
    shortCode: c.id,
    url: `https://www.instagram.com/p/${c.id}/`,
    caption: c.caption,
    displayUrl: '',
    timestamp: c.postedAt,
    ownerUsername: 'eval',
    likesCount: 100,
    commentsCount: 10,
    type: c.transcript ? 'Video' : 'Image',
    videoUrl: c.transcript ? 'https://fixture.local/eval.mp4' : undefined,
  };
}

async function main() {
  console.log(`\n── eval (llm: ${llmMode()}) · ${EVAL_SET.length} cases ──\n`);
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let dateOk = 0, dateTotal = 0, venueOk = 0, venueTotal = 0;
  const misses: string[] = [];

  for (const c of EVAL_SET) {
    const post = toPost(c);
    const gated = await eventGate(post, c.transcript ?? null);

    if (c.expect.isEvent && gated) tp++;
    else if (!c.expect.isEvent && gated) { fp++; misses.push(`GATE FP  ${c.id}: classified event, isn't`); }
    else if (c.expect.isEvent && !gated) { fn++; misses.push(`GATE FN  ${c.id}: missed a real event`); }
    else tn++;

    // Extraction quality — only for true events the gate let through.
    if (c.expect.isEvent && gated) {
      const x = await extract(post, { transcript: c.transcript ?? null });
      if (x) {
        scrubImplausibleFields(x);
        if (c.expect.hasDate) {
          dateTotal++;
          if (validateDates(x).ok) dateOk++;
          else misses.push(`DATE     ${c.id}: expected a date, got none/invalid`);
        }
        if (c.expect.venueHint) {
          venueTotal++;
          const v = (x.venueName.value ?? '').toLowerCase();
          if (v.includes(c.expect.venueHint.toLowerCase())) venueOk++;
          else misses.push(`VENUE    ${c.id}: expected ~"${c.expect.venueHint}", got "${x.venueName.value ?? '∅'}"`);
        }
      } else {
        misses.push(`EXTRACT  ${c.id}: no extraction`);
      }
    }
  }

  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(0)}% (${n}/${d})` : 'n/a');

  console.log('EVENT-GATE');
  console.log(`  precision ${(100 * precision).toFixed(0)}%  recall ${(100 * recall).toFixed(0)}%  F1 ${(100 * f1).toFixed(0)}%   (tp:${tp} fp:${fp} fn:${fn} tn:${tn})`);
  console.log('EXTRACTION (on gated-in events)');
  console.log(`  valid date:   ${pct(dateOk, dateTotal)}`);
  console.log(`  venue match:  ${pct(venueOk, venueTotal)}`);
  if (misses.length) {
    console.log('\nMISSES');
    for (const m of misses) console.log('  ' + m);
  } else {
    console.log('\n✓ clean sweep');
  }
  process.exit(0);
}

main();
