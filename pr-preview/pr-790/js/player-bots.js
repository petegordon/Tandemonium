// ============================================================
// PLAYER BOTS — the robot geese who ride the Solo Flight's back seat (#644 step 1; decisions in #610 / #611 / #644)
// ============================================================
//
// Pete, 2026-11-07:
//   - Solo Flight (the Penny-Farthing tandem) is the "player bots" reward: any 80 of the 81 solo achievements
//     (js/rewards.js playerBotsProgress). The player rides captain; a bot rides the back seat.
//   - The bot JUST RIDES ALONG: it doesn't pedal for the player, doesn't balance, doesn't steer and can't crash the
//     bike. It rides only on Solo Flight (no versus bot; races are against a bot ghost team, js/bot-race.js).
//   - Three named bots, each a robot goose in its own colour, picked on the Solo Flight card. Each one counts as a
//     separate partner for the partner achievements (Social Goose, Regulars, 5K Together, the co-op six), and a bot
//     ride pays Tandem Tokens like any multiplayer ride.
//
// Partner key: 'bot:<id>' (the human keys are a server id, 'name:…' or 'local:p2', js/game.js _partnerKey).
// There is no server partner, so a bot's pair stats (rides, metres together) live on this device.
//
// Co-op achievements that read two riders' inputs, with a bot (judgment call, PR for #644):
//   Perfect Sync  the bot answers each of the player's strokes on the beat, so the sync score is the player's own
//                 steadiness (BotSync below): +0.10 for a stroke on the alternate foot within 30% of the last stroke's
//                 gap (a held cadence), -0.10 for a repeated foot, 5%/s decay -- the same numbers as two humans on
//                 js/shared-pedal-controller.js. Ten seconds of steady alternate pedalling earns it; mashing doesn't.
//   Team Player   the bot adds no safe riding of its own, so the player's own safe-riding share has to reach 80%,
//                 over a FINISHED ride (a bot ride counts as multiplayer at the finish, not frame by frame: every
//                 ride starts upright, so the frame check would hand it out in the first seconds).
//
// Pure: no DOM, no three.js (tintBot only calls the Color methods of the materials it is handed).

export const BOTS = Object.freeze({
  // color = the picker's swatch; plate = the flat armour plates; chrome = a tint on the chrome (anodised);
  // light = the glowing lights and orbs; visor = the visor's glow. The suit's printed fabric keeps its own colours.
  bolt: Object.freeze({ id: 'bolt', name: 'Bolt', body: 'm', color: '#4cc9ff',
    plate: '#2f7fe0', chrome: '#dfe9ff', light: '#28d7ff', visor: '#1c97b3' }),
  rivet: Object.freeze({ id: 'rivet', name: 'Rivet', body: 'f', color: '#ff8a3d',
    plate: '#e2531f', chrome: '#f0b88c', light: '#ffb020', visor: '#c25a10' }),
  sprocket: Object.freeze({ id: 'sprocket', name: 'Sprocket', body: 'm', color: '#7be04f',
    plate: '#3fae2c', chrome: '#cfeeb8', light: '#a6ff3a', visor: '#3f9a18' }),
});

/** The bots in picker order. */
export const BOT_IDS = Object.freeze(Object.keys(BOTS));
export const DEFAULT_BOT = 'bolt';
export const BOT_PARTNER_PREFIX = 'bot:';
export const BOT_CHOICE_KEY = 'tandemonium_player_bot';
export const BOT_PAIRS_KEY = 'tandemonium_bot_pairs';
/** #644 step 2 · the back seat left empty (the card's "Nobody"): a solo Solo Flight ride, and a 1v2 bot race (Underdog). */
export const NO_BOT = 'none';

/** A known bot id, else the default. */
export function normalizeBot(id) {
  return Object.prototype.hasOwnProperty.call(BOTS, id) ? id : DEFAULT_BOT;
}

/** The partner key a bot ride credits ('bot:bolt'). */
export function botPartnerKey(id) {
  return BOT_PARTNER_PREFIX + normalizeBot(id);
}

/** Is this partner key a player bot? */
export function isBotPartnerKey(key) {
  return typeof key === 'string' && key.startsWith(BOT_PARTNER_PREFIX) && BOT_IDS.includes(key.slice(BOT_PARTNER_PREFIX.length));
}

/** The look the bot's goose wears on the back seat (the Robot outfit; no colourways, its colour is tintBot's). */
export function botStokerLook(id) {
  return { outfit: 'robot', colourway: 'default', body: BOTS[normalizeBot(id)].body };
}

function read(store, key) {
  try { return store ? store.getItem(key) : null; } catch { return null; }
}
function write(store, key, value) {
  try { if (store) store.setItem(key, value); } catch { /* private window: the choice lasts this session */ }
}

/** The bot picked on the Solo Flight card (saved per device), or NO_BOT for an empty back seat. */
export function loadBotChoice(store) {
  const v = read(store, BOT_CHOICE_KEY);
  return v === NO_BOT ? NO_BOT : normalizeBot(v);
}

export function saveBotChoice(store, id) {
  const b = id === NO_BOT ? NO_BOT : normalizeBot(id);
  write(store, BOT_CHOICE_KEY, b);
  return b;
}

function loadPairs(store) {
  try {
    const o = JSON.parse(read(store, BOT_PAIRS_KEY) || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

/** One bot's lifetime pair stats on this device: {rides, distance (metres)}. */
export function botPairStats(store, id) {
  const p = loadPairs(store)[normalizeBot(id)] || {};
  const n = v => (Number.isFinite(+v) && +v > 0 ? +v : 0);
  return { rides: Math.floor(n(p.rides)), distance: n(p.distance) };
}

/** A finished ride with a bot: +1 ride, + its metres. Returns the bot's stats after it. */
export function recordBotRide(store, id, metres) {
  const b = normalizeBot(id);
  const all = loadPairs(store);
  const cur = botPairStats(store, b);
  const next = { rides: cur.rides + 1, distance: Math.round(cur.distance + Math.max(0, +metres || 0)) };
  all[b] = next;
  write(store, BOT_PAIRS_KEY, JSON.stringify(all));
  return next;
}

/**
 * The bot's sync score: the player's own steadiness (see the header). Feed it each frame's pedal tapEvents
 * (js/pedal-controller.js: kind 'solo' = the alternate foot, 'wrong' = the same foot again; gap = seconds since
 * the last stroke), then update(dt).
 */
export class BotSync {
  constructor() {
    this.offsetScore = 0.5;
    this._lastGap = 0;
  }

  /** Strokes slower than this are coasting starts, not a cadence. */
  static MAX_GAP = 1.0;
  /** How close a stroke's gap must be to the last one's to count as "on the beat". */
  static STEADY = 0.3;

  feed(events) {
    for (const ev of events || []) {
      if (ev.kind === 'wrong') {
        this.offsetScore = Math.max(0, this.offsetScore - 0.1);
        this._lastGap = 0;
        continue;
      }
      const gap = +ev.gap;
      const steady = gap > 0 && gap <= BotSync.MAX_GAP && this._lastGap > 0
        && Math.abs(gap - this._lastGap) <= BotSync.STEADY * this._lastGap;
      if (steady) this.offsetScore = Math.min(1, this.offsetScore + 0.1);
      this._lastGap = gap > 0 && gap <= BotSync.MAX_GAP ? gap : 0;
    }
  }

  update(dt) {
    this.offsetScore *= (1 - 0.05 * (dt || 0));
  }
}

// ---- colour -------------------------------------------------------------------------------------------------

const ORIG = new WeakMap();
const baseName = (n) => String(n || '').replace(/\.\d{3}$/, '');

/** What a robot material is, by name: plates take the bot's colour, lights and the visor glow in it. */
export function botMaterialRole(name) {
  const n = baseName(name);
  if (/^robot_white$/.test(n)) return 'plate';
  if (/^robot_(light|orb)$/.test(n)) return 'light';
  if (/^robot_visor$/.test(n)) return 'visor';
  if (/^robot_chrome$/.test(n) || /^outfit_(male|female)_robot_(waistcoat|waistcoat_lining|gloves)$/.test(n)) return 'chrome';
  return null;   // the printed suit (shirt, breeches) keeps its colours: a tint there read as bare skin
}

function eachMaterial(root, fn) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      fn(m);
    }
  });
}

/** Paint a seated robot goose in a bot's colours (plates, lights, visor). Undo with untintBot. */
export function tintBot(root, id) {
  const bot = BOTS[normalizeBot(id)];
  eachMaterial(root, (m) => {
    const role = botMaterialRole(m.name);
    if (!role) return;
    if (!ORIG.has(m)) ORIG.set(m, { color: m.color ? m.color.getHex() : null, emissive: m.emissive ? m.emissive.getHex() : null });
    if (role === 'plate' && m.color) m.color.set(bot.plate);
    if (role === 'chrome' && m.color) m.color.set(bot.chrome);
    if (role === 'light') { if (m.color) m.color.set(bot.light); if (m.emissive) m.emissive.set(bot.light); }
    if (role === 'visor' && m.emissive) m.emissive.set(bot.visor);
  });
}

/** Back to the robot's own colours. */
export function untintBot(root) {
  eachMaterial(root, (m) => {
    const o = ORIG.get(m);
    if (!o) return;
    if (o.color != null && m.color) m.color.setHex(o.color);
    if (o.emissive != null && m.emissive) m.emissive.setHex(o.emissive);
  });
}
