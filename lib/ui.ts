// Small presentation helpers shared by map pins, cards, and the detail view.

import type { Category } from './config';
import type { EventTier } from './types';

// `satisfies` ties this to the canonical CATEGORIES vocabulary — adding a 9th
// category without an emoji is a type error, not a silent 🎟️ fallback.
export const CATEGORY_EMOJI = {
  food: '🍜',
  music: '🎧',
  art: '🎨',
  nightlife: '🪩',
  market: '🛍️',
  fitness: '🏃',
  comedy: '🎤',
  other: '🎟️',
} satisfies Record<Category, string>;

export const TIER_EMOJI: Record<NonNullable<EventTier>, string> = {
  trending: '🔥',
  popular: '💙',
  lowkey: '🌱',
};

export function catEmoji(category: string): string {
  return (CATEGORY_EMOJI as Record<string, string>)[category] ?? CATEGORY_EMOJI.other;
}

/** "Tonight · 7:30 PM", "Tomorrow · 10 PM", "Fri · 12 PM" — Corner-style. */
export function formatWhen(startIso: string | null): string {
  if (!startIso) return 'TBA';
  const d = new Date(startIso);
  const now = new Date();
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
    .toLowerCase()
    .replace(' ', '');
  const dayDiff = Math.floor(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) /
      86400_000,
  );
  if (dayDiff === 0) return `Tonight, ${time}`;
  if (dayDiff === 1) return `Tomorrow, ${time}`;
  if (dayDiff < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${time}`;
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

export function formatCost(cost: string | null): string {
  if (!cost) return '';
  return /^free$/i.test(cost) ? 'Free' : cost;
}

// Deterministic gradient cover per event (works offline; IG images swap in
// automatically in live mode via cover_url).
const PALETTES: [string, string][] = [
  ['#ffb199', '#ff0844'],
  ['#a1c4fd', '#c2e9fb'],
  ['#fbc2eb', '#a6c1ee'],
  ['#fddb92', '#d1fdff'],
  ['#96e6a1', '#d4fc79'],
  ['#f6d365', '#fda085'],
  ['#c471f5', '#fa71cd'],
  ['#48c6ef', '#6f86d6'],
];

export function coverGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}
