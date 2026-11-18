// ============================================================
// TOURIST PLACES (pure) — where a Map Tourist ride can start
// ============================================================
//
// Pete, 2026-11-17: a dozen scenic places to pick from, so nobody has to type an address (on a TV
// with a controller, typing is the hard part); typed places limited, to keep the Google bill small and
// known; and the limit made plain to the player.
//
// Three kinds of start, and what each costs us at Google (docs/tourist-mode.md has the sums):
//   scenic   picked from the list below. Its position and ground height are stored here, so it needs
//            no lookup at all.
//   yours    a place this player has ridden before, kept on this device with its position and height:
//            no lookup either.
//   new      an address typed in. One geocoding lookup and one elevation lookup, each a paid request.
//            These are what the weekly limit counts.
// The 3D tiles themselves are one paid "session" per run of the game (js/tourist-tiles-session.js),
// whichever kind of place is ridden.
//
// Nothing here touches the network, the DOM or three, so all of it is tested.

import { planRoute, planExplore, isValidPoint, formatDistance } from './tourist-route.js';

/**
 * New typed places a player may look up, and over how long. Scenic places and places already ridden
 * never count. One number to change: 6 a week means at most 312 lookups a year per player, about $3 at
 * Google's prices if every one were used, against 1,095 a year for 3 a day.
 */
export const NEW_PLACE_LIMIT = Object.freeze({ count: 6, days: 7 });

/** How many of the player's own places are remembered (the oldest drops off). */
export const MAX_YOUR_PLACES = 8;

/**
 * The scenic rides. `height` is the anchor height three's tiles are placed at: metres above the WGS84
 * ellipsoid, about 150 m over the real ground there (measured by riding each one, 2026-11-17). With a
 * `to`, the ride goes from one landmark to the other in a straight line; without, it is an open ride
 * around the place. Every one of these was ridden in the desktop build before it was listed.
 * @type {ReadonlyArray<{id: string, icon: string, name: string, where: string, from: {lat: number, lon: number, label: string}, to?: {lat: number, lon: number, label: string}, height: number}>}
 */
export const SCENIC_PLACES = Object.freeze([
  { id: 'paris', icon: '🗼', name: 'Champs-Élysées', where: 'Paris', from: { lat: 48.86629, lon: 2.31914, label: 'Place de la Concorde, Paris' }, to: { lat: 48.87335, lon: 2.2964, label: 'Arc de Triomphe' }, height: 228,
    // (the ride ends on the avenue a little short of the arch: the camera stands back down the avenue, looking at it)
    view: { bearing: 115, radius: 170, height: 70, look: 30 } },
  { id: 'goldengate', icon: '🌉', name: 'Golden Gate Bridge', where: 'San Francisco', from: { lat: 37.815, lon: -122.478064, label: 'Golden Gate Bridge, San Francisco' }, to: { lat: 37.824403, lon: -122.479016, label: 'the north tower' }, height: 194,
    // (the usual rise ends in among the suspender cables: this one stands off to the east, over the bay)
    view: { bearing: 110, radius: 260, height: 70, look: 40 } },
  { id: 'dcmall', icon: '🏛️', name: 'National Mall', where: 'Washington, DC', from: { lat: 38.8899, lon: -77.0105, label: 'US Capitol, Washington' }, to: { lat: 38.8893, lon: -77.0482, label: 'Lincoln Memorial' }, height: 128 },
  { id: 'nyc5th', icon: '🗽', name: 'Fifth Avenue', where: 'New York', from: { lat: 40.7312, lon: -73.9971, label: 'Washington Square Arch, New York' }, to: { lat: 40.74845, lon: -73.98455, label: 'Empire State Building' }, height: 127 },
  { id: 'london', icon: '👑', name: 'The Mall', where: 'London', from: { lat: 51.5063, lon: -0.12966, label: 'Admiralty Arch, London' }, to: { lat: 51.5022, lon: -0.1396, label: 'Buckingham Palace' }, height: 204 },
  { id: 'rome', icon: '🏟️', name: 'Via dei Fori Imperiali', where: 'Rome', from: { lat: 41.891, lon: 12.4903, label: 'Colosseum, Rome' }, to: { lat: 41.8958, lon: 12.4826, label: 'Piazza Venezia' }, height: 229 },
  { id: 'vegas', icon: '🎰', name: 'The Strip', where: 'Las Vegas', from: { lat: 36.0826, lon: -115.1728, label: 'Welcome to Las Vegas sign' }, to: { lat: 36.1126, lon: -115.1728, label: 'Bellagio Fountains' }, height: 784 },
  { id: 'sydney', icon: '🎭', name: 'Sydney Opera House', where: 'Sydney', from: { lat: -33.859, lon: 151.2138, label: 'Sydney Opera House' }, height: 185 },
  { id: 'tokyo', icon: '🏙️', name: 'Shibuya Crossing', where: 'Tokyo', from: { lat: 35.6595, lon: 139.7005, label: 'Shibuya Crossing, Tokyo' }, height: 202 },
  { id: 'columbus', icon: '🌳', name: 'Scioto Mile', where: 'Columbus, Ohio', from: { lat: 39.9575, lon: -83.004, label: 'Scioto Mile, Columbus' }, height: 333 },
  { id: 'chicago', icon: '🫘', name: 'Cloud Gate', where: 'Chicago', from: { lat: 41.88235, lon: -87.6233, label: 'Cloud Gate, Chicago' }, height: 303 },
  { id: 'everest', icon: '🏔️', name: 'Mount Everest', where: 'The Himalaya', from: { lat: 27.9881, lon: 86.925, label: 'Mount Everest summit' }, height: 8857 },
]);

/** A scenic place by id, or null. */
export function scenicPlace(id) {
  return SCENIC_PLACES.find((p) => p.id === id) || null;
}

/** "2.1 km ride" for a route, "Open ride" for a place to explore. */
export function rideKind(place) {
  if (!place || !place.to) return 'Open ride';
  const plan = planRoute(place.from, place.to);
  return `${formatDistance(plan.route.ridableM)} ride`;
}

/**
 * The ride plan for a scenic place or one of the player's own (same shape as planRoute / planExplore,
 * plus the stored anchor so nothing is looked up, and what kind of ride it is for the wording).
 * @param {{from: object, to?: object|null, height?: number, name?: string, id?: string}} place
 * @param {'scenic'|'yours'} kind
 */
export function planForPlace(place, kind = 'scenic') {
  const plan = place.to ? planRoute(place.from, place.to) : planExplore(place.from);
  if (Number.isFinite(place.height)) plan.anchor = { height: place.height, anchored: true };
  if (place.to && Number.isFinite(place.toHeight)) plan.toAnchor = { height: place.toHeight, anchored: true };
  // a landmark that cannot be ridden into (an arch, a fountain behind railings) is reached from further off
  if (place.to && Number.isFinite(place.arriveM)) plan.arriveM = place.arriveM;
  // where the arrival's camera ends, for a place whose usual view is a poor one (js/tourist-arrival.js)
  if (place.to && place.view) plan.view = place.view;
  plan.kind = kind;
  if (kind === 'scenic') {
    plan.title = place.name;
    plan.headline = place.to ? `${place.name} · ${formatDistance(plan.route.ridableM)}` : place.name;
  }
  return plan;
}

// ── the player's own places, and the weekly limit ──────────────────────────────

/** What is kept on the device: { places: [...], week: 'YYYY-MM-DD', used: n }. */
export function emptyStore() {
  return { places: [], week: '', used: 0 };
}

/** Read a stored value back into shape (anything odd becomes empty). */
export function readStore(raw) {
  let v = null;
  try { v = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { v = null; }
  const out = emptyStore();
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v.places)) {
    out.places = v.places.filter((p) => p && isValidPoint(p.from) && (p.to == null || isValidPoint(p.to))).slice(0, MAX_YOUR_PLACES);
  }
  if (typeof v.week === 'string') out.week = v.week;
  if (Number.isFinite(v.used) && v.used > 0) out.used = Math.floor(v.used);
  return out;
}

/**
 * The start of the limit's current period, as a local date 'YYYY-MM-DD'. A 7-day limit runs Monday to
 * Sunday on the player's own calendar, so "more on Monday" is true wherever they are.
 */
export function periodStart(now = Date.now(), days = NEW_PLACE_LIMIT.days) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (days === 7) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));        // back to Monday
  else if (days >= 28) d.setDate(1);                                       // a month: its first day
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** When the current period ends (ms): next Monday 00:00 local for a week. */
export function periodEnd(now = Date.now(), days = NEW_PLACE_LIMIT.days) {
  const [y, m, d] = periodStart(now, days).split('-').map(Number);
  const start = new Date(y, m - 1, d);
  if (days >= 28) return new Date(y, m, 1).getTime();
  if (days === 7) return new Date(y, m - 1, d + 7).getTime();
  return start.getTime() + days * 86400000;
}

/**
 * Where the player stands against the limit.
 * @returns {{limit: number, used: number, left: number, allowed: boolean, resetsAt: number}}
 */
export function newPlaceGate(store, now = Date.now(), limit = NEW_PLACE_LIMIT) {
  const s = store || emptyStore();
  const used = s.week === periodStart(now, limit.days) ? Math.min(limit.count, s.used || 0) : 0;
  const left = Math.max(0, limit.count - used);
  return { limit: limit.count, used, left, allowed: left > 0, resetsAt: periodEnd(now, limit.days) };
}

/** Count `n` new lookups against the limit. → the new store */
export function countNewPlaces(store, n = 1, now = Date.now(), limit = NEW_PLACE_LIMIT) {
  const s = { ...(store || emptyStore()) };
  const week = periodStart(now, limit.days);
  if (s.week !== week) { s.week = week; s.used = 0; }
  s.used = Math.min(limit.count, (s.used || 0) + Math.max(0, n));
  return s;
}

/** "Monday", or "tomorrow" / "today" when that is what it is: when new places come back. */
export function resetDayName(resetsAt, now = Date.now(), locale = undefined) {
  const days = Math.round((new Date(resetsAt).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return new Date(resetsAt).toLocaleDateString(locale, { weekday: 'long' });
}

/**
 * The line that tells the player where they stand. Always says what does not count, because a limit
 * with no way round it reads as a wall.
 */
export function limitText(gate, now = Date.now(), locale = undefined) {
  const n = gate.limit;
  if (gate.left > 0) {
    return {
      headline: `New places this week: ${gate.left} of ${n} left`,
      detail: 'Scenic rides and places you have ridden before never count.',
    };
  }
  const day = resetDayName(gate.resetsAt, now, locale);
  const when = day === 'today' || day === 'tomorrow' ? day : 'on ' + day;
  return {
    headline: `You have looked up this week’s ${n} new places`,
    detail: `More ${when}. Scenic rides and your own places are still open.`,
  };
}

const near = (a, b) => !!a && !!b && Math.abs(a.lat - b.lat) < 0.0005 && Math.abs(a.lon - b.lon) < 0.0005;   // ~50 m
const sameRide = (p, q) => near(p.from, q.from) && ((!p.to && !q.to) || near(p.to, q.to));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A place the player already has for this typed text (what they typed last time, or its full address):
 * riding it again needs no lookup and does not count. → the stored point, or null
 */
export function knownPoint(store, text) {
  const t = norm(text);
  if (!t) return null;
  for (const p of (store && store.places) || []) {
    for (const pt of [p.from, p.to]) {
      if (pt && (norm(pt.label) === t || norm(pt.typed) === t)) return pt;
    }
  }
  return null;
}

/** Remember a ride (newest first, no doubles, at most MAX_YOUR_PLACES). → the new store */
export function rememberPlace(store, place) {
  const s = { ...(store || emptyStore()) };
  if (!place || !isValidPoint(place.from)) return s;
  const entry = { from: place.from, to: place.to || null };
  if (Number.isFinite(place.height)) entry.height = place.height;
  if (Number.isFinite(place.toHeight)) entry.toHeight = place.toHeight;
  s.places = [entry, ...(s.places || []).filter((p) => !sameRide(p, entry))].slice(0, MAX_YOUR_PLACES);
  return s;
}

/** A short name for one of the player's places: "Columbus" or "Columbus → Paris". */
export function placeLabel(place) {
  const short = (pt) => {
    const parts = String((pt && pt.label) || '').split(',').map((x) => x.trim()).filter(Boolean);
    return parts[0] || 'A place';
  };
  return place.to ? `${short(place.from)} → ${short(place.to)}` : short(place.from);
}
