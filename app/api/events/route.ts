import { NextResponse } from 'next/server';
import { listEvents } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includePast = url.searchParams.get('all') === '1';
  const events = await listEvents({ includePast });
  return NextResponse.json({ events, count: events.length });
}
