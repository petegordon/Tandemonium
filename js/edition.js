// ============================================================
// EDITION — full game vs demo (#400)
//
// The demo is a restricted set of the full game, not a fork. Every place that
// behaves differently in the demo reads these rules instead of re-parsing the
// URL, so changing what the demo includes is a one-line edit here.
//
// Pure + DOM-free at the top (resolveIsDemo / rulesFor) so node tests can
// import it; the cached getters at the bottom touch window/location.
// ============================================================

/**
 * What the full game allows. Everything on.
 */
export const FULL_RULES = Object.freeze({
  isDemo: false,
  /** Level ids offered in the level lists (lobby + NEXT LEVEL). null = all. */
  levels: null,
  /** Today's Road becomes "This Week's Road": one seeded road per ISO week. */
  weeklyRoad: false,
  /** Ranked Today's Road runs + leaderboard submission. */
  ranked: true,
  /** Slingshot card + garage. maxStage = last stage playable (null = no cap). */
  slingshot: Object.freeze({ enabled: true, maxStage: null }),
  /** Tourist entries (still also need a Maps key — see tourist-config.js). */
  tourist: true,
  /** RIDE TOGETHER (online + couch co-op) and VERSUS. */
  rideTogether: true,
  versus: true,
});

/**
 * The demo (#400, Pete 2026-10-04): Tutorial, Grandma's and one road a week.
 * The Slingshot stays in with an early stage gate that points at the full game.
 * Multiplayer stays. These are the knobs to change when the demo is redefined.
 */
export const DEMO_RULES = Object.freeze({
  isDemo: true,
  levels: Object.freeze(['tutorial', 'grandma', 'daily']),
  weeklyRoad: true,
  ranked: false,
  slingshot: Object.freeze({ enabled: true, maxStage: 3 }),
  tourist: false,
  rideTogether: true,
  versus: true,
});

/**
 * Is this the demo? `?demo=1` (web demo link, and what electron/main.js
 * appends when launched with --demo or TANDEMONIUM_DEMO=1), or an explicit
 * flag from the Steam side.
 */
export function resolveIsDemo(search, steamFlag) {
  let demo = false;
  try { demo = new URLSearchParams(search || '').get('demo') === '1'; } catch { /* bad input */ }
  return demo || !!steamFlag;
}

export function rulesFor(isDemo) {
  return isDemo ? DEMO_RULES : FULL_RULES;
}

/** Is level `id` offered under these rules? */
export function levelAllowed(rules, id) {
  return !rules.levels || rules.levels.includes(id);
}

/**
 * Room camera + microphone (WebRTC media) — #400 D7. Multiplayer itself is
 * NOT behind this: rooms, data channels, co-op and versus always work. Off in
 * every edition unless `?media=1` is passed, so nothing ever prompts for a
 * camera or mic by default.
 */
export function resolveMediaEnabled(search) {
  try { return new URLSearchParams(search || '').get('media') === '1'; } catch { return false; }
}

// ── cached, browser-facing ──────────────────────────────────

let _rules = null;
let _media = null;

export function getEditionRules() {
  if (_rules) return _rules;
  const search = typeof location !== 'undefined' ? location.search : '';
  const steamFlag = typeof window !== 'undefined' && window.tandemoniumSteam
    ? window.tandemoniumSteam.isDemo : false;
  _rules = rulesFor(resolveIsDemo(search, steamFlag));
  return _rules;
}

export function isDemoEdition() {
  return getEditionRules().isDemo;
}

export function isMediaEnabled() {
  if (_media !== null) return _media;
  _media = resolveMediaEnabled(typeof location !== 'undefined' ? location.search : '');
  return _media;
}
