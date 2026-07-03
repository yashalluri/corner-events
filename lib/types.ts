// ─── Raw scrape layer ───────────────────────────────────────────────────────
// Shape mirrors apify/instagram-scraper output. Fixtures use the SAME shape,
// so the pipeline is oblivious to whether a post came from Apify or a fixture.

export interface RawPost {
  id: string; // IG media id or shortcode-derived
  shortCode: string;
  url: string;
  caption: string;
  displayUrl: string; // cover image URL ('' in fixtures → placeholder cover)
  timestamp: string; // ISO — when the post was published
  ownerUsername: string;
  likesCount: number;
  commentsCount: number;
  videoViewCount?: number;
  locationName?: string;
  type: 'Image' | 'Video' | 'Sidecar';
  /** Fixture-only: deterministic extraction used when no OPENAI_API_KEY. */
  _mock?: { isEvent: boolean; extraction?: Extraction };
}

// ─── Extraction layer ───────────────────────────────────────────────────────

export interface FieldValue<T> {
  value: T | null;
  confidence: number; // 0–1
  evidence: string | null; // caption span / image region the value came from
}

export interface Extraction {
  title: FieldValue<string>;
  venueName: FieldValue<string>;
  address: FieldValue<string>;
  description: FieldValue<string>;
  startDatetime: FieldValue<string>; // ISO, America/New_York, resolved vs post timestamp
  endDatetime: FieldValue<string>;
  rsvpDeadline: FieldValue<string>;
  capacity: FieldValue<number>;
  ageLimit: FieldValue<string>;
  cost: FieldValue<string>; // "$27", "free", "from $50"
  category: FieldValue<string>; // food | music | art | nightlife | market | fitness | comedy | other
  externalLink: FieldValue<string>;
}

// ─── Store layer ────────────────────────────────────────────────────────────

export interface Venue {
  id: string; // google place_id (or fixture:slug)
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  neighborhood: string | null;
}

export type EventTier = 'lowkey' | 'popular' | 'trending' | null;
export type EventStatus = 'upcoming' | 'live' | 'past' | 'needs_review';

export interface EventRow {
  id: string;
  title: string;
  description: string | null;
  venue_id: string | null;
  start_at: string | null; // ISO
  end_at: string | null;
  cost: string | null;
  age_limit: string | null;
  capacity: number | null;
  category: string;
  external_link: string | null;
  cover_url: string | null;
  confidence: number; // min of load-bearing field confidences
  tier: EventTier;
  tier_reason: string | null;
  popular_score: number;
  heat_score: number;
  created_at: string;
  updated_at: string;
}

export interface EventWithVenue extends EventRow {
  venue: Venue | null;
  status: EventStatus;
  sources: { username: string; url: string; likes: number; comments: number; postedAt: string }[];
}

export interface PipelineStats {
  scraped: number;
  gated_out: number;
  extracted: number;
  venue_unresolved: number;
  inserted: number;
  merged: number;
  skipped_duplicates: number;
  errors: string[];
  mode: { scrape: 'live' | 'fixture'; llm: 'live' | 'fixture'; places: 'live' | 'fixture' };
}
