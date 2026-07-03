'use client';

import { useState } from 'react';
import { catEmoji, coverGradient } from '@/lib/ui';

/** Event cover: real IG image when available (live mode), otherwise a
 *  deterministic gradient + category emoji. IG CDN URLs are signed and expire
 *  after days — onError swaps to the gradient so the demo never shows a broken
 *  image; no-referrer avoids IG's referrer-based 403s. */
export default function CoverArt({
  title,
  category,
  coverUrl,
}: {
  title: string;
  category: string;
  coverUrl: string | null;
}) {
  const [broken, setBroken] = useState(false);

  if (coverUrl && !broken) {
    // The query layer hands us a presentation-ready URL (IG CDN links arrive
    // already rewritten through /api/img) — just render it.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={coverUrl}
        alt={title}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  const [c1, c2] = coverGradient(title);
  const gid = `g${Math.abs(title.length * 7 + title.charCodeAt(0))}`;
  return (
    <svg viewBox="0 0 148 148" role="img" aria-label={title}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={c1} />
          <stop offset="100%" stopColor={c2} />
        </linearGradient>
      </defs>
      <rect width="148" height="148" fill={`url(#${gid})`} />
      <text x="74" y="86" textAnchor="middle" fontSize="44">
        {catEmoji(category)}
      </text>
    </svg>
  );
}
