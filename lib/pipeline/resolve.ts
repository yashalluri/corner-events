// Stage D — Resolve: deterministic date validation + venue → place_id + lat/lng.
// Venue resolution is what makes an event MAP-ABLE. Hold-don't-drop: an event
// whose venue can't be resolved is kept (venue_id NULL → needs_review), never lost.

import { CITY, env } from '../config';
import { FIXTURE_VENUES } from '../fixtures';
import { neighborhoodFor } from '../neighborhoods';
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

/** Deterministic field sanity — structural catches for confident-but-wrong
 *  LLM values. Mutates a field to null when its format is implausible so a
 *  hallucinated "$99999" or "500+" age never reaches the UI. */
export function scrubImplausibleFields(x: Extraction): void {
  // Venue: a real place name is short. Sentence-like / ad-copy strings ("New
  // Years in NYC?! Luxury stay...") are on-screen-text the model mistook for a
  // venue — null them so the event is held, not resolved to a bogus pin.
  if (x.venueName.value) {
    const v = x.venueName.value.trim();
    if (v.length > 45 || /[?!]/.test(v) || v.split(/\s+/).length > 7) {
      x.venueName = { value: null, confidence: 0, evidence: null };
    }
  }
  // Price: keep "free" or something containing a $-amount under ~$100k.
  if (x.cost.value) {
    const v = x.cost.value;
    const amount = Number(v.replace(/[^0-9.]/g, ''));
    if (!/free/i.test(v) && (!/\d/.test(v) || amount > 100000)) {
      x.cost = { value: null, confidence: 0, evidence: null };
    }
  }
  // Age: plausible IG age gates only.
  if (x.ageLimit.value && !/^(all ages|18\+|19\+|21\+|18 and over|21 and over)$/i.test(x.ageLimit.value.trim())) {
    const n = Number(x.ageLimit.value.replace(/[^0-9]/g, ''));
    x.ageLimit = n >= 15 && n <= 25 ? { ...x.ageLimit, value: `${n}+` } : { value: null, confidence: 0, evidence: null };
  }
  // Capacity: a real room, not a hallucinated crowd.
  if (x.capacity.value != null && (x.capacity.value <= 0 || x.capacity.value > 100000)) {
    x.capacity = { value: null, confidence: 0, evidence: null };
  }
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
    // Derive once at write time (Places doesn't return neighborhoods) so the
    // read path never recomputes it per request.
    neighborhood: neighborhoodFor(lat, lng),
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
