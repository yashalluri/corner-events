// Image proxy for Instagram CDN covers.
//
// IG's CDN serves images fine server-to-server but sets Cross-Origin-Resource-
// Policy headers that make browsers refuse hotlinked <img> renders. Fetching
// here and streaming same-origin sidesteps that. Allowlisted to IG/FB CDNs only
// so this can't be used as an open proxy.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_HOSTS = /(^|\.)cdninstagram\.com$|(^|\.)fbcdn\.net$/i;

export async function GET(req: Request) {
  const src = new URL(req.url).searchParams.get('src');
  if (!src) return NextResponse.json({ error: 'missing src' }, { status: 400 });

  let target: URL;
  try {
    target = new URL(src);
  } catch {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.test(target.hostname)) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 403 });
  }

  const upstream = await fetch(target.toString(), {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; corner-events/1.0)' },
  });
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/jpeg',
      // Signed IG URLs expire in days anyway — cache aggressively for that window.
      'cache-control': 'public, max-age=86400, s-maxage=86400, immutable',
    },
  });
}
