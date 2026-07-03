// Stage D — Resolve: deterministic date validation + venue → place_id + lat/lng.
// Venue resolution is what makes an event MAP-ABLE. Hold-don't-drop: an event
// whose venue can't be resolved is kept (venue_id NULL → needs_review), never lost.

import { CITY, env } from '../config';
import { FIXTURE_VENUES } from '../fixtures';
import type { Extraction, Venue } from '../types';

// ─── Date validation (deterministic — the LLM resolved, we verify) ─────────

export function validateDates(x: Extraction): { ok: boolean; reason?: string } {
  const start = x.startDatetime.value ? new Date(x.startDatetime.value) : null;
  if (!start || isNaN(start.getTime())) return { ok: false, reason: 'no valid start date' };
  const now = Date.now();
  const sixMonths = 183 * 24 * 3600_000;
  if (start.getTime() > now + sixMonths) return { ok: false, reason: 'start >6 months out — likely misresolved' };
  // Past events are valid data (lifecycle hides them); only reject absurdly old.
  if (start.getTime() < now - 90 * 24 * 3600_000) return { ok: false, reason: 'start >90 days past' };
  return { ok: true };
}

// ─── Venue resolution ───────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function resolveFixture(name: string): Venue | null {
  const n = norm(name);
  if (!n) return null;
  const hit = FIXTURE_VENUES.find(
    (v) => norm(v.name) === n || norm(v.name).includes(n) || n.includes(norm(v.name)),
  );
  return hit ?? null;
}

interface PlacesResult {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
}

async function resolveLive(name: string, address: string | null): Promise<Venue | null> {
  const key = env.places();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key!,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify({
      textQuery: address ? `${name}, ${address}` : `${name}, New York`,
      locationBias: {
        rectangle: {
          low: { latitude: CITY.bounds.south, longitude: CITY.bounds.west },
          high: { latitude: CITY.bounds.north, longitude: CITY.bounds.east },
        },
      },
      maxResultCount: 1,
    }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { places?: PlacesResult[] };
  const p = data.places?.[0];
  if (!p?.location) return null;
  // Sanity: must actually be in NYC (Places can wander).
  const { latitude: lat, longitude: lng } = p.location;
  if (lat < CITY.bounds.south || lat > CITY.bounds.north || lng < CITY.bounds.west || lng > CITY.bounds.east) {
    return null;
  }
  return {
    id: p.id,
    name: p.displayName?.text ?? name,
    address: p.formattedAddress ?? null,
    lat,
    lng,
    neighborhood: null,
  };
}

export function placesMode(): 'live' | 'fixture' {
  return env.places() ? 'live' : 'fixture';
}

export async function resolveVenue(x: Extraction): Promise<Venue | null> {
  const name = x.venueName.value;
  if (!name || x.venueName.confidence < 0.5) return null;
  if (env.places()) {
    try {
      const live = await resolveLive(name, x.address.value);
      if (live) return live;
    } catch {
      // fall through to fixture directory
    }
  }
  return resolveFixture(name);
}
