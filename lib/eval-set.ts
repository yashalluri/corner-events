// Frozen, hand-labeled ground-truth set — the accuracy yardstick. Captions are
// real (paraphrased where long) from the seed accounts; reels carry a snapshot
// transcript. `scripts/eval.ts` runs the live gate+extract over these and
// scores precision/recall so "accuracy" is a measured number, not a vibe.
//
// Labels: isEvent (gate truth); for events, venueHint (substring the resolved
// venue should contain) and hasDate (a real datetime should be extractable).

export interface EvalCase {
  id: string;
  caption: string;
  transcript?: string; // reel audio snapshot (tests the video path)
  postedAt: string; // ISO — anchors relative-date resolution
  expect: { isEvent: boolean; venueHint?: string; hasDate?: boolean };
}

// Anchor relative dates to a fixed Monday so the frozen set is reproducible.
const T = '2026-07-06T15:00:00-04:00';

export const EVAL_SET: EvalCase[] = [
  // ── events ──
  {
    id: 'golden-slushy',
    caption: 'She’s back! The return of our summer slushy naengmyeon pop up at Nudibranch. This Saturday, 12pm til we sell out.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Nudibranch', hasDate: true },
  },
  {
    id: 'golden-zwirner',
    caption: 'NEW YORK: Our archive sale returns to the bookstore at 525 W 19th St. This week only, Wed–Sun 11–6.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Zwirner', hasDate: true },
  },
  {
    id: 'macys-fireworks',
    caption: 'The 50th annual Macy’s 4th of July fireworks light up the East River this Friday at 9pm. Best views from the FDR.',
    postedAt: T,
    expect: { isEvent: true, hasDate: true },
  },
  {
    id: 'public-records-set',
    caption: 'Raär b2b Joe Delon in the sound room at Public Records. Friday, doors 10pm. $27 adv, 21+.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Public Records', hasDate: true },
  },
  {
    id: 'supper-club',
    caption: 'Supper club round 6 at Clandestino. Five courses, natural wine. This Friday 7:30pm, 24 seats, link in bio. $85.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Clandestino', hasDate: true },
  },
  {
    id: 'reel-thin-caption',
    caption: '🎨🍷 sunday. who’s coming 👀',
    transcript:
      "Okay so this Sunday we're doing open studios at Canal Street Market — twelve artists, natural wine, starts at 3pm, totally free, just pull up.",
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Canal', hasDate: true },
  },
  {
    id: 'reel-run-club',
    caption: 'sunrise crew ☀️🏃',
    transcript:
      'Run club is back — we meet at Tompkins Square Park, Sunday 8am, easy 5k loop then coffee. Free, bring a friend.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Tompkins', hasDate: true },
  },
  {
    id: 'sample-sale',
    caption: 'Archive sample sale at Canal Street Market — 12 downtown labels, up to 80% off. Thurs–Sun 11–7.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Canal', hasDate: true },
  },
  {
    id: 'night-market',
    caption: 'LES Night Market returns to Essex Market — 30 vendors, late-night eats, live sets. Saturday 6pm–midnight, free entry.',
    postedAt: T,
    expect: { isEvent: true, venueHint: 'Essex', hasDate: true },
  },
  {
    id: 'gallery-opening',
    caption: 'Opening night: group show “Soft Machines” at 99 Canal. Tonight 6–9, natural wine while it lasts.',
    postedAt: T,
    expect: { isEvent: true, venueHint: '99 Canal', hasDate: true },
  },
  // ── NOT events ──
  {
    id: 'meme-ltrain',
    caption: 'when the L train says 2 min and means 20 💀 tag someone who waited',
    postedAt: T,
    expect: { isEvent: false },
  },
  {
    id: 'listicle-bagels',
    caption: 'the 10 best bagels in nyc, ranked. number 4 will start a fight. full list on the blog 🥯',
    postedAt: T,
    expect: { isEvent: false },
  },
  {
    id: 'place-rec',
    caption: 'our favorite little natural wine bar in the west village. cozy, candlelit, always worth it.',
    postedAt: T,
    expect: { isEvent: false },
  },
  {
    id: 'recap-past',
    caption: 'last night at the warehouse was unreal. thank you to everyone who came out 🖤 till next time',
    postedAt: T,
    expect: { isEvent: false },
  },
  {
    id: 'giveaway',
    caption: 'GIVEAWAY 🎉 follow + tag 3 friends to win a $100 gift card. winner announced friday!',
    postedAt: T,
    expect: { isEvent: false },
  },
];
