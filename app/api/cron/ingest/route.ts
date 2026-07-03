// The autonomous trigger. Vercel Cron fires this every 3h (vercel.json);
// it can also be hit manually as the demo "refresh" button.
//
// Auth: Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when
// CRON_SECRET is set. Locally / demo mode (no secret configured) it's open.
// The pipeline is idempotent, so a double-fire or a curious visitor re-running
// it costs one watermark-filtered pass, not a re-ingestion.

import { NextResponse } from 'next/server';
import { env } from '@/lib/config';
import { runPipeline } from '@/lib/pipeline/run';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // scrape + LLM calls need room

async function handle(req: Request) {
  const secret = env.cronSecret();
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const started = Date.now();
  const stats = await runPipeline();
  return NextResponse.json({ ok: true, took_ms: Date.now() - started, stats });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
