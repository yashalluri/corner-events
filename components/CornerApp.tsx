'use client';

// The Corner clone. Chrome layout mirrors the reference screenshots:
// full-screen map, white pill chips, category circles (events selected),
// an "EVENTS NEARBY" bottom sheet grouped by venue, and a bottom dock.
// The lowkey/popular/trending tiers render as native-feeling filter chips.

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EventTier, EventWithVenue } from '@/lib/types';
import { CATEGORY_EMOJI, formatCost, formatWhen } from '@/lib/ui';
import CoverArt from './CoverArt';

const MapView = dynamic(() => import('./MapView'), { ssr: false });

const CATEGORIES = [
  { key: 'top', label: 'top picks', emoji: '⭐' },
  { key: 'eat', label: 'eat', emoji: '🍜' },
  { key: 'cafes', label: 'cafes', emoji: '☕' },
  { key: 'bars', label: 'bars', emoji: '🍸' },
  { key: 'events', label: 'events', emoji: '🎟️' },
  { key: 'goout', label: 'go out', emoji: '🪩' },
];

const TIERS: { key: EventTier | 'all'; label: string; emoji?: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'lowkey', label: 'lowkey', emoji: '🌱' },
  { key: 'popular', label: 'popular', emoji: '💙' },
  { key: 'trending', label: 'trending', emoji: '🔥' },
];

export default function CornerApp() {
  const [events, setEvents] = useState<EventWithVenue[] | null>(null);
  const [category, setCategory] = useState('events');
  const [tier, setTier] = useState<EventTier | 'all'>('all');
  const [eventCat, setEventCat] = useState<string | null>(null); // food/music/art/… filter
  const [soon, setSoon] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/events');
    const data = (await res.json()) as { events: EventWithVenue[] };
    setEvents(data.events);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Manual fire of the autonomous ingest (same route the cron hits). */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/cron/ingest', { method: 'POST' });
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const visible = useMemo(() => {
    if (!events) return [];
    let list = events.filter((e) => e.venue); // needs_review stays off the surface
    if (tier !== 'all') list = list.filter((e) => e.tier === tier);
    if (eventCat) list = list.filter((e) => e.category === eventCat);
    if (soon) {
      const cutoff = Date.now() + 48 * 3600_000;
      list = list.filter((e) => e.start_at && new Date(e.start_at).getTime() <= cutoff);
    }
    return list;
  }, [events, tier, eventCat, soon]);

  // Area-first: the sheet groups by NEIGHBORHOOD (how people actually plan a
  // night out), soonest-happening area on top, events within sorted by time.
  const byArea = useMemo(() => {
    const groups = new Map<string, { hood: string; items: EventWithVenue[] }>();
    for (const e of visible) {
      const hood = e.venue!.neighborhood ?? 'Around NYC';
      const g = groups.get(hood) ?? { hood, items: [] };
      g.items.push(e);
      groups.set(hood, g);
    }
    const soonest = (g: { items: EventWithVenue[] }) =>
      Math.min(...g.items.map((e) => (e.start_at ? new Date(e.start_at).getTime() : Infinity)));
    return [...groups.values()]
      .map((g) => ({ ...g, items: [...g.items].sort((a, b) => String(a.start_at).localeCompare(String(b.start_at))) }))
      .sort((a, b) => soonest(a) - soonest(b));
  }, [visible]);

  const selected = selectedId ? visible.find((e) => e.id === selectedId) ?? null : null;

  // Tap-through target: the highest-engagement source post (matters for
  // trending events that have several). This link IS the attribution now.
  const igUrl = (e: EventWithVenue) =>
    [...e.sources].sort(
      (a, b) => b.likes + 3 * b.comments - (a.likes + 3 * a.comments),
    )[0]?.url ?? '#';

  return (
    <div className="stage">
      <div className="phone">
        {events === null && (
          <div className="loading">
            <div className="logo">corner</div>
            <div>finding what&apos;s on…</div>
          </div>
        )}

        <MapView events={visible} onSelect={setSelectedId} selectedId={selectedId} />

        {/* ── top bar ── */}
        <div className="topbar">
          <button className="round-btn" aria-label="Add friends">👤</button>
          <div className="topbar-right">
            {/* Reads as a normal map-refresh control; actually fires the same
                ingest route the cron hits — the live-demo trigger. */}
            <button
              className={`round-btn${refreshing ? ' spinning' : ''}`}
              onClick={refresh}
              disabled={refreshing}
              aria-label="Refresh"
            >
              ↻
            </button>
            <button className="round-btn" aria-label="Notifications">🔔</button>
          </div>
        </div>

        {/* ── event detail card (pin tap) — whole card opens the IG source ── */}
        {selected && (
          <div className="detail-wrap">
            <a
              className="detail"
              href={igUrl(selected)}
              target="_blank"
              rel="noreferrer"
              aria-label={`${selected.title} — open on Instagram`}
            >
              <button
                className="detail-close"
                onClick={(e) => {
                  e.preventDefault();
                  setSelectedId(null);
                }}
                aria-label="Close"
              >
                ✕
              </button>
              <div className="detail-cover">
                <CoverArt title={selected.title} category={selected.category} coverUrl={selected.cover_url} />
              </div>
              <div className="detail-body">
                <div className="detail-title">{selected.title}</div>
                <div className="detail-venue">
                  {selected.venue!.name}
                  {selected.venue!.neighborhood ? ` · ${selected.venue!.neighborhood}` : ''}
                </div>
                <div className="detail-meta">
                  {formatWhen(selected.start_at)}
                  {selected.cost ? ` · ${formatCost(selected.cost)}` : ''}
                  {selected.age_limit ? ` · ${selected.age_limit}` : ''}
                </div>
                {selected.tier && selected.tier_reason && (
                  <div className={`detail-reason t-${selected.tier}`}>
                    {selected.tier === 'trending' ? '🔥' : selected.tier === 'popular' ? '💙' : '🌱'}{' '}
                    {selected.tier_reason}
                  </div>
                )}
                <div className="detail-ig">Instagram ↗</div>
              </div>
            </a>
          </div>
        )}

        {/* ── events nearby sheet ── */}
        <div className={`sheet ${sheetOpen ? 'open' : 'closed'}`}>
          <div
            className="sheet-handle-row"
            onClick={() => setSheetOpen((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setSheetOpen((v) => !v)}
          >
            <div className="sheet-handle" />
            <div className="sheet-title">EVENTS NEARBY</div>
            <div className="sheet-sub">{visible.length} this week</div>
          </div>
          <div className="sheet-body">
            {byArea.map((g) => (
              <div className="venue-group" key={g.hood}>
                <div className="venue-head">
                  <div className="venue-name">{g.hood}</div>
                  <div className="venue-desc">
                    {g.items.length} event{g.items.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="card-row">
                  {g.items.map((e) => (
                    <a className="ecard" key={e.id} href={igUrl(e)} target="_blank" rel="noreferrer">
                      <div className="ecard-cover">
                        <CoverArt title={e.title} category={e.category} coverUrl={e.cover_url} />
                        {e.tier && <span className={`ecard-tier t-${e.tier}`}>{e.tier}</span>}
                        <span className="ecard-ig" aria-hidden>↗</span>
                      </div>
                      <div className="ecard-title">{e.title}</div>
                      <div className="ecard-meta">
                        {e.venue!.name} · {formatWhen(e.start_at)}
                      </div>
                      {e.cost && <div className="ecard-price">{formatCost(e.cost)}</div>}
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── bottom chrome ── */}
        <div className={`bottom${sheetOpen ? ' hidden' : ''}`}>
          <div className="chip-row">
            <button className="chip">everyone ▾</button>
            <button className={`chip${soon ? ' selected' : ''}`} onClick={() => setSoon((v) => !v)}>
              ⏱ happening soon
            </button>
            {TIERS.map((t) => (
              <button
                key={String(t.key)}
                className={`chip${tier === t.key ? ' selected' : ''}`}
                onClick={() => setTier(t.key)}
              >
                {t.emoji ? `${t.emoji} ` : ''}
                {t.label}
                {t.key !== 'all' && events && (
                  <span className="cnt">{events.filter((e) => e.tier === t.key && e.venue).length}</span>
                )}
              </button>
            ))}
            {/* event-category filters — only categories that have events show */}
            {events &&
              Object.entries(CATEGORY_EMOJI)
                .filter(([cat]) => events.some((e) => e.venue && e.category === cat))
                .map(([cat, emoji]) => (
                  <button
                    key={cat}
                    className={`chip${eventCat === cat ? ' selected' : ''}`}
                    onClick={() => setEventCat(eventCat === cat ? null : cat)}
                  >
                    {emoji} {cat}
                    <span className="cnt">{events.filter((e) => e.venue && e.category === cat).length}</span>
                  </button>
                ))}
          </div>

          <div className="cats">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                className={`cat${category === c.key ? ' selected' : ''}`}
                onClick={() => setCategory(c.key)}
              >
                <div className="cat-circle">{c.emoji}</div>
                <div className="cat-label">{c.label}</div>
              </button>
            ))}
          </div>

        </div>

        {/* ── floating nav dock (always visible, over the sheet) ── */}
        <div className="dock-wrap">
          <div className="dock">
            <button aria-label="Friends">👥</button>
            <button className="active" aria-label="Map" onClick={() => setSheetOpen(false)}>🗺️</button>
            <button aria-label="Search">🔍</button>
            <button aria-label="Profile"><span className="avatar">y</span></button>
            <button className="plus" aria-label="Add">+</button>
          </div>
        </div>
      </div>
    </div>
  );
}
