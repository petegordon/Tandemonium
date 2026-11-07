// ============================================================
// EDITION — full game vs demo (#400, redefined by #641)
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
  /**
   * #641 · Daily Ride rides a day. null = unlimited. A ride counts when it
   * starts (a restart is a new ride; a checkpoint retry is not).
   */
  dailyRideCap: null,
  /** #641 · achievements that must be earned before the Daily Ride opens. */
  dailyNeeds: Object.freeze([]),
  /** Slingshot card + garage. maxStage = last stage playable (null = no cap). */
  slingshot: Object.freeze({ enabled: true, maxStage: null }),
  /** Tourist entries (still also need a Maps key — see tourist-config.js). */
  tourist: true,
  /** RIDE TOGETHER (online + couch co-op) and VERSUS. */
  rideTogether: true,
  versus: true,
  /** #641 · bike colours offered in the chooser. null = all. */
  bikes: null,
  /** #641 · achievements this edition can award. null = all 100. */
  achievements: null,
  /** Level scores go to the 🏆 leaderboard (game._submitScore). */
  postScores: true,
});

/**
 * #641 · the 20 the demo can award (Pete, 2026-11-07). The rest keep counting
 * their stats, so they unlock on the full game's first check.
 */
export const DEMO_ACHIEVEMENTS = Object.freeze([
  'first_pedal', 'tutorial_done', 'first_crash', 'first_remount', 'first_boost',
  'home_sweet', 'grandma_bronze', 'grandma_silver', 'grandma_gold', 'first_km',
  'new_best', 'daily_first', 'daily_gold', 'sling_first', 'sling_stage3',
  'jackpot', 'first_upgrade', 'coop_first', 'grandma_orange', 'days_3',
]);

/**
 * The demo (#641, Pete 2026-11-07, replacing #400's Weekly Ride): Tutorial,
 * Grandma's, the real Daily Ride (3 rides a day, opened by finishing the
 * Tutorial and Grandma's), and the Slingshot to stage 3. Co-op stays; Versus,
 * Tourist, five bike colours and 80 achievements are the full game's.
 */
export const DEMO_RULES = Object.freeze({
  isDemo: true,
  levels: Object.freeze(['tutorial', 'grandma', 'daily']),
  dailyRideCap: 3,
  dailyNeeds: Object.freeze(['tutorial_done', 'home_sweet']),
  slingshot: Object.freeze({ enabled: true, maxStage: 3 }),
  tourist: false,
  rideTogether: true,
  versus: false,
  bikes: Object.freeze(['default', 'bike_orange']),
  achievements: DEMO_ACHIEVEMENTS,
  postScores: true,    // #641 (Pete): demo level scores go on the 🏆 leaderboard too
});

/** #641 · may this edition award achievement `id`? */
export function achievementAllowed(rules, id) {
  return !rules.achievements || rules.achievements.includes(id);
}

/** #641 · is bike preset `key` offered by this edition? */
export function bikeAllowed(rules, key) {
  return !rules.bikes || rules.bikes.includes(key);
}

/**
 * #641 · can another Daily Ride start? `started` = rides already started on
 * today's road, `earnedIds` = the player's earned achievement ids.
 * @returns {{ok:true, left:number|null} | {ok:false, reason:'needs'|'cap', needs?:string[]}}
 */
export function dailyRideGate(rules, started, earnedIds = []) {
  const needs = (rules.dailyNeeds || []).filter(id => !earnedIds.includes(id));
  if (needs.length) return { ok: false, reason: 'needs', needs };
  if (rules.dailyRideCap == null) return { ok: true, left: null };
  const left = Math.max(0, rules.dailyRideCap - Math.max(0, Math.floor(Number(started) || 0)));
  return left > 0 ? { ok: true, left } : { ok: false, reason: 'cap' };
}

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
 * NEXT LEVEL: the first level after `currentId` (in `levels` order) that these
 * rules offer and that is not locked. Never the tutorial — NEXT LEVEL is for
 * moving on, not back. null when there is none (the caller decides: the demo
 * shows its end screen, the full game goes back to the lobby).
 *
 * @param {Array<{id:string,isTutorial?:boolean}>} levels  LEVELS, in order
 * @param {string} currentId
 * @param {object} rules       FULL_RULES / DEMO_RULES
 * @param {(level)=>boolean} [isLocked]
 */
export function nextAllowedLevel(levels, currentId, rules, isLocked = () => false) {
  const i = levels.findIndex(l => l.id === currentId);
  if (i < 0) return null;
  for (let j = i + 1; j < levels.length; j++) {
    const l = levels[j];
    if (l.isTutorial || !levelAllowed(rules, l.id) || isLocked(l)) continue;
    return l;
  }
  return null;
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

/**
 * URL params that define the edition/session and must survive URL tidying and
 * travel in every invite link (PR #397 B4a): without them a reload or an
 * invite drops a demo player into the full game.
 */
export const CARRIED_PARAMS = Object.freeze(['demo', 'media']);

/** `search` reduced to the carried params, as '?demo=1&media=1' or ''. */
export function carriedQuery(search) {
  const out = new URLSearchParams();
  try {
    const p = new URLSearchParams(search || '');
    for (const k of CARRIED_PARAMS) if (p.has(k)) out.set(k, p.get(k));
  } catch { /* bad input */ }
  const s = out.toString();
  return s ? '?' + s : '';
}

/**
 * Room join link: `${base}?room=CODE` plus demo=1 / media=1 when this side is
 * on the demo / has room media on, so the partner opens the same edition.
 */
export function buildJoinUrl(base, code, { demo = false, media = false } = {}) {
  const p = new URLSearchParams();
  p.set('room', code);
  if (demo) p.set('demo', '1');
  if (media) p.set('media', '1');
  return base + '?' + p.toString();
}

// ── rooms: two editions / two versions (PR #397 M1) ─────────

/**
 * What this build understands in a room. Sent in the untyped room profile as
 * { edition, caps }; a partner whose profile carries no `caps` is an OLD
 * client (the build before this list existed).
 *   tourist      co-op Map Tourists (touristPlan / touristReady barrier)
 *   helpingHand  follows the captain's helping-hand tier (timer scaling)
 *   weeklyRoad   knew #400's Weekly Ride. #641 retired that road; the cap
 *                stays advertised so this build still reads as current.
 *   v2LevelSync  adopts levelSync {difficulty, roadKind, key, seed}; refuses
 *                a level its edition does not allow (levelRefused)
 */
export const ROOM_CAPS = Object.freeze(['tourist', 'helpingHand', 'weeklyRoad', 'v2LevelSync']);

/**
 * The { edition, caps } fields this side puts in its room profile. `tourist`
 * is advertised only by an edition that includes Tourist (a side without a
 * Maps key still understands the barrier, and fails it at once).
 */
export function roomProfileFields(rules) {
  const caps = ROOM_CAPS.filter(c => c !== 'tourist' || rules.tourist);
  return { edition: rules.isDemo ? 'demo' : 'full', caps };
}

/** The partner's { edition, caps } from a received room profile (caps null = OLD client). */
export function partnerFromProfile(profile) {
  if (!profile) return null;
  const caps = Array.isArray(profile.caps) ? profile.caps.filter(c => typeof c === 'string') : null;
  return { edition: profile.edition === 'demo' ? 'demo' : 'full', caps };
}

/**
 * The rules a room rides by: the MOST RESTRICTIVE of the two sides. Either
 * player on the demo → DEMO_RULES for both. An OLD partner (or one not heard
 * from yet) → no Map Tourists, no helping hand. A partner without the
 * 'tourist' cap → no Map Tourists.
 * @param {object} mine     this side's FULL_RULES / DEMO_RULES
 * @param {{edition:string, caps:string[]|null}|null} partner
 */
export function mergeRoomRules(mine, partner) {
  const caps = partner && Array.isArray(partner.caps) ? partner.caps : null;
  const base = mine.isDemo || (partner && partner.edition === 'demo') ? DEMO_RULES : mine;
  return Object.freeze({
    ...base,
    tourist: base.tourist && !!caps && caps.includes('tourist'),
    helpingHand: !!caps && caps.includes('helpingHand'),
    partnerOld: !caps,
  });
}

/**
 * Stoker: may it ride the level in this levelSync under ITS OWN edition?
 * #641: there is one shared road again (the Daily Ride), so its kind is
 * always 'daily'. An old #400 demo captain asking for its 'weekly' road is
 * refused: this side can't build that road any more.
 * @returns {{ok:true, roadKind:'daily'|null} | {ok:false, reason:string}}
 */
export function levelSyncVerdict(rules, level, msg = {}) {
  if (!level) return { ok: false, reason: 'unknown' };
  if (!levelAllowed(rules, level.id)) return { ok: false, reason: rules.isDemo ? 'demo' : 'level' };
  if (!level.isDaily) return { ok: true, roadKind: null };
  if (msg.roadKind === 'weekly') return { ok: false, reason: 'level' };
  return { ok: true, roadKind: 'daily' };
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
