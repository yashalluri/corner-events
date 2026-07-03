'use client';

// MapLibre GL + CARTO Positron (free, tokenless, light-minimal — the closest
// open basemap to Corner's look). Pins are custom HTML markers: white circle,
// category emoji, tier ring, name + descriptor label with a white halo.

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CITY } from '@/lib/config';
import { kmBetween } from '@/lib/neighborhoods';
import type { EventWithVenue } from '@/lib/types';
import { TIER_EMOJI, catEmoji } from '@/lib/ui';

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

export default function MapView({
  events,
  onSelect,
  selectedId,
}: {
  events: EventWithVenue[];
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Keyed registry so filter changes DIFF markers instead of rebuilding all of
  // them — most taps touch a handful of pins, not the whole set.
  const markersRef = useRef<Map<string, { marker: maplibregl.Marker; sig: string }>>(new Map());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Init once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: STYLE_URL,
        center: [CITY.center.lng, CITY.center.lat],
        zoom: 12.6,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      // Environments without WebGL (some headless/CI browsers) shouldn't take
      // the whole app down — the sheet still works as a list view.
      containerRef.current.innerHTML =
        '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#98989e;font-size:13px;font-weight:600">map needs WebGL — events list below ↓</div>';
      return;
    }
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
    map.on('click', () => onSelectRef.current(null));
    mapRef.current = map;
    return () => {
      map.remove(); // removes attached markers too
      markersRef.current.clear();
      mapRef.current = null;
    };
  }, []);

  // Sync markers with events (diff by event id + content signature).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const registry = markersRef.current;
    const mappable = events.filter((e) => e.venue);
    const nextIds = new Set(mappable.map((e) => e.id));

    // Remove markers whose events left the visible set.
    for (const [id, entry] of registry) {
      if (!nextIds.has(id)) {
        entry.marker.remove();
        registry.delete(id);
      }
    }

    for (const e of mappable) {
      const sig = `${e.tier}|${e.title}|${e.venue!.id}`;
      const existing = registry.get(e.id);
      if (existing?.sig === sig) continue; // unchanged — keep the live marker
      existing?.marker.remove();

      const el = document.createElement('div');
      el.className = 'pin';
      const tierClass = e.tier ? ` t-${e.tier}` : '';
      const tierDot =
        e.tier === 'trending'
          ? `<span class="pin-dot" style="background:var(--trending)">${TIER_EMOJI.trending}</span>`
          : '';
      el.innerHTML = `
        <div class="pin-inner">
          <div class="pin-circle${tierClass}">${catEmoji(e.category)}${tierDot}</div>
          <div class="pin-label">
            <div class="pin-name">${e.venue!.name}</div>
            <div class="pin-desc">${e.title.length > 26 ? e.title.slice(0, 25) + '…' : e.title}</div>
          </div>
        </div>`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onSelectRef.current(e.id);
      });
      const marker = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-20, 0] })
        .setLngLat([e.venue!.lng, e.venue!.lat])
        .addTo(map);
      registry.set(e.id, { marker, sig });
    }

    if (mappable.length > 0) {
      // Fit to the CORE cluster (within ~4.5km of the median center) so one
      // far-flung venue doesn't zoom the whole city out — outliers stay pinned,
      // just off the initial view. Corner opens on a neighborhood, not a region.
      const lats = mappable.map((e) => e.venue!.lat).sort((a, c) => a - c);
      const lngs = mappable.map((e) => e.venue!.lng).sort((a, c) => a - c);
      const medLat = lats[Math.floor(lats.length / 2)];
      const medLng = lngs[Math.floor(lngs.length / 2)];
      let core = mappable.filter((e) => kmBetween(medLat, medLng, e.venue!.lat, e.venue!.lng) <= 4.5);
      if (core.length < 2) core = mappable;
      const b = new maplibregl.LngLatBounds();
      core.forEach((e) => b.extend([e.venue!.lng, e.venue!.lat]));
      // cameraForBounds returns undefined when padding can't fit the canvas —
      // degrade the padding progressively instead of silently doing nothing.
      const paddings = [
        { top: 90, bottom: 260, left: 40, right: 60 },
        { top: 70, bottom: 200, left: 25, right: 30 },
        { top: 40, bottom: 120, left: 15, right: 15 },
      ];
      for (const padding of paddings) {
        const cam = map.cameraForBounds(b, { padding, maxZoom: 13.6 });
        if (cam) {
          map.easeTo({ ...cam, duration: 600 });
          break;
        }
      }
    }
  }, [events]);

  // Fly to selection.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedId) return;
    const e = events.find((x) => x.id === selectedId);
    if (e?.venue) {
      map.flyTo({ center: [e.venue.lng, e.venue.lat], zoom: Math.max(map.getZoom(), 13.8), duration: 500, offset: [0, -60] });
    }
  }, [selectedId, events]);

  // Wrapper owns absolute positioning; the map container needs explicit
  // dimensions because maplibre overrides its position with `.maplibregl-map`.
  return (
    <div className="map-shell">
      <div ref={containerRef} className="map-root" aria-label="Map of events" />
    </div>
  );
}
