// Fixture layer — used whenever a live key is missing, and as the demo seed.
//
// Shape is IDENTICAL to apify/instagram-scraper output, so the pipeline cannot
// tell fixtures from a live scrape. Dates are generated RELATIVE TO NOW so the
// demo always shows "Tonight / This Friday" events regardless of presentation day.
//
// The set deliberately exercises every hard case from the architecture review:
//   • the 2 GOLDEN posts (interviewer's acceptance test — placeholder content
//     until Apify fetches the real captions; URLs are the real ones)
//   • same event posted by 2 accounts  → dedup must ATTACH, then trend
//   • two different events, same venue, same night → must NOT merge
//   • a venue that can't be resolved → hold-don't-drop (needs_review)
//   • two non-event posts (meme, listicle) → event-gate must drop them
//   • a past event → lifecycle must hide it

import type { Extraction, FieldValue, RawPost, Venue } from './types';

const H = 3600_000;
const now = () => Date.now();

/** Next occurrence of a weekday (0=Sun..6=Sat) at local hour. */
function nextDay(dow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  let delta = (dow - d.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() < now()) delta = 7;
  d.setDate(d.getDate() + delta);
  return d;
}
function tonight(hour: number, minute = 0): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() < now()) d.setDate(d.getDate() + 1); // already passed → tomorrow
  return d;
}
function daysFromNow(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}
const iso = (d: Date) => d.toISOString();
const ago = (hours: number) => new Date(now() - hours * H).toISOString();

function fv<T>(value: T | null, confidence = 0.92, evidence: string | null = null): FieldValue<T> {
  return { value, confidence, evidence };
}
const nul = <T,>(): FieldValue<T> => ({ value: null, confidence: 0, evidence: null });

function extraction(p: {
  title: string;
  venue: string;
  start: Date;
  end?: Date;
  desc: string;
  cost?: string;
  age?: string;
  category: string;
  address?: string;
  link?: string;
  capacity?: number;
}): Extraction {
  return {
    title: fv(p.title, 0.95, p.title),
    venueName: fv(p.venue, 0.93, p.venue),
    address: p.address ? fv(p.address, 0.9, p.address) : nul(),
    description: fv(p.desc, 0.9),
    startDatetime: fv(iso(p.start), 0.9),
    endDatetime: p.end ? fv(iso(p.end), 0.85) : nul(),
    rsvpDeadline: nul(),
    capacity: p.capacity != null ? fv(p.capacity, 0.8) : nul(),
    ageLimit: p.age ? fv(p.age, 0.9, p.age) : nul(),
    cost: p.cost ? fv(p.cost, 0.9, p.cost) : nul(),
    category: fv(p.category, 0.95),
    externalLink: p.link ? fv(p.link, 0.95, p.link) : nul(),
  };
}

// ─── Fixture venue directory (Places-API fallback) ─────────────────────────
// Real NYC venues with real coordinates. Live mode replaces this with the
// Google Places Text Search — same output shape.

export const FIXTURE_VENUES: Venue[] = [
  { id: 'fixture:public-records', name: 'Public Records', address: '233 Butler St, Brooklyn', lat: 40.6795, lng: -73.9852, neighborhood: 'Gowanus' },
  { id: 'fixture:clandestino', name: 'Clandestino', address: '35 Canal St, New York', lat: 40.7145, lng: -73.9915, neighborhood: 'Dimes Square' },
  { id: 'fixture:99-canal', name: '99 Canal', address: '99 Canal St, New York', lat: 40.7146, lng: -73.993, neighborhood: 'Chinatown' },
  { id: 'fixture:ff-pizzeria', name: 'F&F Pizzeria', address: '459 Court St, Brooklyn', lat: 40.6772, lng: -73.9986, neighborhood: 'Carroll Gardens' },
  { id: 'fixture:essex-market', name: 'Essex Market', address: '88 Essex St, New York', lat: 40.7185, lng: -73.988, neighborhood: 'Lower East Side' },
  { id: 'fixture:sour-mouse', name: 'Sour Mouse', address: '110 Delancey St, New York', lat: 40.7183, lng: -73.9877, neighborhood: 'Lower East Side' },
  { id: 'fixture:flower-shop', name: 'The Flower Shop', address: '107 Eldridge St, New York', lat: 40.718, lng: -73.9911, neighborhood: 'Lower East Side' },
  { id: 'fixture:tompkins', name: 'Tompkins Square Park', address: 'E 9th St & Avenue A, New York', lat: 40.7265, lng: -73.9817, neighborhood: 'East Village' },
  { id: 'fixture:elsewhere', name: 'Elsewhere', address: '599 Johnson Ave, Brooklyn', lat: 40.7108, lng: -73.9235, neighborhood: 'Bushwick' },
  { id: 'fixture:canal-market', name: 'Canal Street Market', address: '265 Canal St, New York', lat: 40.7191, lng: -74.0012, neighborhood: 'Chinatown' },
  { id: 'fixture:sing-sing', name: 'Sing Sing Ave A', address: '81 Avenue A, New York', lat: 40.7266, lng: -73.9838, neighborhood: 'East Village' },
  { id: 'fixture:mercury-lounge', name: 'Mercury Lounge', address: '217 E Houston St, New York', lat: 40.7222, lng: -73.9868, neighborhood: 'Lower East Side' },
];

// ─── Fixture posts ──────────────────────────────────────────────────────────

export function getFixturePosts(): RawPost[] {
  const friNight = nextDay(5, 22);
  const friDinner = nextDay(5, 19, 30);
  const satAfternoon = nextDay(6, 12);
  const sunMorning = nextDay(0, 10);

  const posts: RawPost[] = [
    // ── GOLDEN POST 1 ── real URL from the brief; caption is a plausible
    // placeholder until Apify pulls the real content (fixture mode only).
    {
      id: 'golden-DaN_n5NmBER',
      shortCode: 'DaN_n5NmBER',
      url: 'https://www.instagram.com/p/DaN_n5NmBER/',
      caption:
        'SUPPER CLUB, round 6 🍝 one long table, five courses, natural wine pairings at Clandestino. This Friday 7:30pm. 24 seats only — link in bio. $85.',
      displayUrl: '',
      timestamp: ago(20),
      ownerUsername: 'wtfdwg',
      likesCount: 412,
      commentsCount: 58,
      locationName: 'Clandestino',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Supper Club: Five Courses & Natural Wine',
          venue: 'Clandestino',
          start: friDinner,
          desc: 'One long table, five courses, natural wine pairings. 24 seats only.',
          cost: '$85',
          category: 'food',
          capacity: 24,
        }),
      },
    },
    // ── GOLDEN POST 2 ── real URL from the brief; placeholder caption.
    {
      id: 'golden-DZ-UjDXEZNC',
      shortCode: 'DZ-UjDXEZNC',
      url: 'https://www.instagram.com/p/DZ-UjDXEZNC/',
      caption:
        'RAÄR b2b JOE DELON. all night long in the sound room at Public Records. Friday. doors 10pm. $27 adv, 21+.',
      displayUrl: '',
      timestamp: ago(30),
      ownerUsername: 'new_york_underground',
      likesCount: 1350,
      commentsCount: 96,
      locationName: 'Public Records',
      type: 'Video',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Raär b2b Joe Delon',
          venue: 'Public Records',
          start: friNight,
          desc: 'All night long in the sound room.',
          cost: '$27',
          age: '21+',
          category: 'music',
        }),
      },
    },
    // ── Same Public Records night, DIFFERENT account → must ATTACH not duplicate,
    // and the 2-accounts-in-72h signal should mark it TRENDING.
    {
      id: 'pr-raar-repost',
      shortCode: 'CrossPost1',
      url: 'https://www.instagram.com/p/CrossPost1/',
      caption: 'friday: Raär & Joe Delon all-nighter at Public Records. the sound room. do not miss. 🔊',
      displayUrl: '',
      timestamp: ago(9),
      ownerUsername: 'rub_ulad',
      likesCount: 640,
      commentsCount: 41,
      locationName: 'Public Records',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Raär & Joe Delon all-nighter',
          venue: 'Public Records',
          start: friNight,
          desc: 'All-nighter in the sound room.',
          cost: '$27',
          age: '21+',
          category: 'music',
        }),
      },
    },
    // ── DIFFERENT event at the SAME venue on the SAME night → must NOT merge.
    {
      id: 'clandestino-latenight',
      shortCode: 'Clan2',
      url: 'https://www.instagram.com/p/Clan2/',
      caption: 'after the dinner crowd clears: DJ Lychee spins city pop + disco edits at Clandestino, Friday 11pm. free.',
      displayUrl: '',
      timestamp: ago(14),
      ownerUsername: 'wtfdwg',
      likesCount: 210,
      commentsCount: 12,
      locationName: 'Clandestino',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'DJ Lychee: City Pop + Disco Edits',
          venue: 'Clandestino',
          start: nextDay(5, 23),
          desc: 'City pop and disco edits after the dinner crowd clears.',
          cost: 'free',
          category: 'nightlife',
        }),
      },
    },
    // ── LOWKEY demo: small account punching above its baseline.
    {
      id: 'gallerina-99canal',
      shortCode: 'Gal99',
      url: 'https://www.instagram.com/p/Gal99/',
      caption:
        'opening night 🍷 group show "SOFT MACHINES" at 99 Canal — painting, textile, one very cursed sculpture. natural wine while it lasts. tonight 6–9.',
      displayUrl: '',
      timestamp: ago(5),
      ownerUsername: 'thirstygallerina',
      likesCount: 310,
      commentsCount: 44,
      locationName: '99 Canal',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Soft Machines — Opening Night',
          venue: '99 Canal',
          start: tonight(18),
          end: tonight(21),
          desc: 'Group show: painting, textile, one very cursed sculpture. Natural wine while it lasts.',
          cost: 'free',
          category: 'art',
        }),
      },
    },
    // ── POPULAR demo: big account, big absolute engagement.
    {
      id: 'secretnyc-pizzafest',
      shortCode: 'Pza1',
      url: 'https://www.instagram.com/p/Pza1/',
      caption:
        'NYC PIZZA FEST 🍕 F&F Pizzeria hosts 8 guest pizzaiolos — one weekend only. Saturday from 12pm, slices from $5. bring cash.',
      displayUrl: '',
      timestamp: ago(26),
      ownerUsername: 'secret_nyc',
      likesCount: 8900,
      commentsCount: 430,
      locationName: 'F&F Pizzeria',
      type: 'Sidecar',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'NYC Pizza Fest',
          venue: 'F&F Pizzeria',
          start: satAfternoon,
          desc: '8 guest pizzaiolos, one weekend only. Slices from $5, bring cash.',
          cost: 'from $5',
          category: 'food',
        }),
      },
    },
    // ── Night market.
    {
      id: 'bucketlist-nightmarket',
      shortCode: 'Mkt1',
      url: 'https://www.instagram.com/p/Mkt1/',
      caption: 'LES NIGHT MARKET is back at Essex Market — 30 vendors, late-night eats, live sets. Saturday 6pm–midnight. free entry.',
      displayUrl: '',
      timestamp: ago(40),
      ownerUsername: 'nybucketlist',
      likesCount: 4100,
      commentsCount: 190,
      locationName: 'Essex Market',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'LES Night Market',
          venue: 'Essex Market',
          start: nextDay(6, 18),
          end: nextDay(6, 23, 59),
          desc: '30 vendors, late-night eats, live sets.',
          cost: 'free',
          category: 'market',
        }),
      },
    },
    // ── Listening bar (quiet, untiered/lowkey candidate).
    {
      id: 'wtfdwg-sourmouse',
      shortCode: 'Sm1',
      url: 'https://www.instagram.com/p/Sm1/',
      caption: 'tuesday listening bar: rare Brazilian pressings all night at Sour Mouse. 8pm. no cover, no phones on the floor.',
      displayUrl: '',
      timestamp: ago(50),
      ownerUsername: 'wtfdwg',
      likesCount: 150,
      commentsCount: 9,
      locationName: 'Sour Mouse',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Listening Bar: Rare Brazilian Pressings',
          venue: 'Sour Mouse',
          start: nextDay(2, 20),
          desc: 'Rare Brazilian pressings all night. No phones on the floor.',
          cost: 'free',
          category: 'music',
        }),
      },
    },
    // ── HOLD-DON'T-DROP demo: venue can't be resolved → needs_review, kept off map.
    {
      id: 'underground-loft',
      shortCode: 'Loft1',
      url: 'https://www.instagram.com/p/Loft1/',
      caption: 'secret loft show saturday. 3 bands, byob. address on rsvp only — dm for the form. $15 at the door.',
      displayUrl: '',
      timestamp: ago(16),
      ownerUsername: 'new_york_underground',
      likesCount: 720,
      commentsCount: 63,
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Secret Loft Show',
          venue: 'address on RSVP',
          start: nextDay(6, 20),
          desc: '3 bands, BYOB. Address on RSVP only.',
          cost: '$15',
          category: 'music',
        }),
      },
    },
    // ── Figure drawing.
    {
      id: 'gallerina-figure',
      shortCode: 'Fig1',
      url: 'https://www.instagram.com/p/Fig1/',
      caption: 'figure drawing + wine upstairs at The Flower Shop, Sunday 10am. materials included, all levels. $20, 15 spots.',
      displayUrl: '',
      timestamp: ago(60),
      ownerUsername: 'thirstygallerina',
      likesCount: 190,
      commentsCount: 21,
      locationName: 'The Flower Shop',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Figure Drawing + Wine',
          venue: 'The Flower Shop',
          start: sunMorning,
          desc: 'Materials included, all levels welcome.',
          cost: '$20',
          category: 'art',
          capacity: 15,
        }),
      },
    },
    // ── Run club (free, fitness).
    {
      id: 'bucketlist-runclub',
      shortCode: 'Run1',
      url: 'https://www.instagram.com/p/Run1/',
      caption: 'sunrise run club ☀️ 5k loop from Tompkins Square Park, Sunday 8am. coffee after. free, just show up.',
      displayUrl: '',
      timestamp: ago(70),
      ownerUsername: 'nybucketlist',
      likesCount: 2100,
      commentsCount: 85,
      locationName: 'Tompkins Square Park',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Sunrise Run Club — 5K Loop',
          venue: 'Tompkins Square Park',
          start: nextDay(0, 8),
          desc: '5K loop, coffee after. Just show up.',
          cost: 'free',
          category: 'fitness',
        }),
      },
    },
    // ── Vinyl market.
    {
      id: 'rubulad-vinyl',
      shortCode: 'Vin1',
      url: 'https://www.instagram.com/p/Vin1/',
      caption: 'rooftop vinyl market at Elsewhere — 25 sellers, dollar bins, DJs digging live. Saturday 12–6. $5.',
      displayUrl: '',
      timestamp: ago(34),
      ownerUsername: 'rub_ulad',
      likesCount: 530,
      commentsCount: 28,
      locationName: 'Elsewhere',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Rooftop Vinyl Market',
          venue: 'Elsewhere',
          start: nextDay(6, 12),
          end: nextDay(6, 18),
          desc: '25 sellers, dollar bins, DJs digging live.',
          cost: '$5',
          category: 'market',
        }),
      },
    },
    // ── Sample sale.
    {
      id: 'locals-samplesale',
      shortCode: 'Smp1',
      url: 'https://www.instagram.com/p/Smp1/',
      caption: 'archive sample sale at Canal Street Market — 12 downtown labels, up to 80% off. thurs–sun 11–7.',
      displayUrl: '',
      timestamp: ago(45),
      ownerUsername: 'newyorklocals',
      likesCount: 3300,
      commentsCount: 240,
      locationName: 'Canal Street Market',
      type: 'Sidecar',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Archive Sample Sale',
          venue: 'Canal Street Market',
          start: nextDay(4, 11),
          end: nextDay(0, 19),
          desc: '12 downtown labels, up to 80% off.',
          category: 'market',
          cost: 'free',
        }),
      },
    },
    // ── Karaoke.
    {
      id: 'wtfdwg-karaoke',
      shortCode: 'Kar1',
      url: 'https://www.instagram.com/p/Kar1/',
      caption: 'wednesday: private-room karaoke takeover at Sing Sing Ave A. 9pm til late. $10 gets you in + one well drink.',
      displayUrl: '',
      timestamp: ago(38),
      ownerUsername: 'wtfdwg',
      likesCount: 260,
      commentsCount: 17,
      locationName: 'Sing Sing Ave A',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Karaoke Takeover',
          venue: 'Sing Sing Ave A',
          start: nextDay(3, 21),
          desc: 'Private-room takeover, til late. $10 gets you in + one well drink.',
          cost: '$10',
          age: '21+',
          category: 'nightlife',
        }),
      },
    },
    // ── PAST event → lifecycle must hide it from the map/list.
    {
      id: 'mercury-pastshow',
      shortCode: 'Pst1',
      url: 'https://www.instagram.com/p/Pst1/',
      caption: 'last night at Mercury Lounge was unreal. till next time 🖤',
      displayUrl: '',
      timestamp: ago(100),
      ownerUsername: 'new_york_underground',
      likesCount: 480,
      commentsCount: 22,
      locationName: 'Mercury Lounge',
      type: 'Image',
      _mock: {
        isEvent: true,
        extraction: extraction({
          title: 'Basement Show at Mercury Lounge',
          venue: 'Mercury Lounge',
          start: daysFromNow(-6, 20),
          desc: 'Three-band basement bill.',
          cost: '$18',
          category: 'music',
        }),
      },
    },
    // ── NON-EVENTS: the gate must drop both.
    {
      id: 'locals-meme',
      shortCode: 'Meme1',
      url: 'https://www.instagram.com/p/Meme1/',
      caption: 'when the L train says 2 min and it means 20 💀💀 tag someone who waited',
      displayUrl: '',
      timestamp: ago(6),
      ownerUsername: 'newyorklocals',
      likesCount: 21000,
      commentsCount: 800,
      type: 'Image',
      _mock: { isEvent: false },
    },
    {
      id: 'secretnyc-bagels',
      shortCode: 'Bgl1',
      url: 'https://www.instagram.com/p/Bgl1/',
      caption: 'the 10 best bagels in nyc, ranked. number 4 will start a fight. full list on the blog 🥯',
      displayUrl: '',
      timestamp: ago(12),
      ownerUsername: 'secret_nyc',
      likesCount: 15200,
      commentsCount: 1200,
      type: 'Sidecar',
      _mock: { isEvent: false },
    },
  ];

  return posts;
}
