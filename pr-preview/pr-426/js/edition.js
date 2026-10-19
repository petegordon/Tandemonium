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
 *   weeklyRoad   knows the demo's This Week's Road
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
 * from yet) → no ranked, no Map Tourists, no helping hand. A partner without
 * the 'tourist' cap → no Map Tourists.
 * @param {object} mine     this side's FULL_RULES / DEMO_RULES
 * @param {{edition:string, caps:string[]|null}|null} partner
 */
export function mergeRoomRules(mine, partner) {
  const caps = partner && Array.isArray(partner.caps) ? partner.caps : null;
  const base = mine.isDemo || (partner && partner.edition === 'demo') ? DEMO_RULES : mine;
  return Object.freeze({
    ...base,
    ranked: base.ranked && !!caps,
    tourist: base.tourist && !!caps && caps.includes('tourist'),
    helpingHand: !!caps && caps.includes('helpingHand'),
    partnerOld: !caps,
  });
}

/**
 * Stoker: may it ride the level in this levelSync under ITS OWN edition?
 * The road kind is the captain's (`roadKind`); a captain that sends none is
 * an old build, whose shared road is always Today's Road ('daily').
 * @returns {{ok:true, roadKind:'daily'|'weekly'|null} | {ok:false, reason:string}}
 */
export function levelSyncVerdict(rules, level, msg = {}) {
  if (!level) return { ok: false, reason: 'unknown' };
  if (!levelAllowed(rules, level.id)) return { ok: false, reason: rules.isDemo ? 'demo' : 'level' };
  if (!level.isDaily) return { ok: true, roadKind: null };
  const roadKind = msg.roadKind === 'weekly' ? 'weekly' : 'daily';
  if (roadKind === 'daily' && rules.weeklyRoad) return { ok: false, reason: 'demo' };
  return { ok: true, roadKind };
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
