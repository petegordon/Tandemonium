// ============================================================
// PLAYER LOOK (#548) — what each player's goose wears, and which colour their controller glows
// ============================================================
//
// A look is { outfit, colours, body, led }:
//   outfit   a Goose Outfits key (js/goose-outfits.js)
//   colours  { outfit: colourway } — the colourway picked for each outfit, so switching outfits
//            remembers each one's colours (the shape the old global Goose Colours setting used)
//   body     'm' (gander) | 'f' (goose) — the goose's body; today the seat decided it (#574 §3)
//   led      a LED_COLOURS key — the DualSense lightbar / player-light colour of that player's pad
//
// Looks are saved per PLAYER NUMBER (P1–P4) and per CONTROLLER (its serial / MAC when the host
// exposes one, else vendor:product + the slot it sat in; #241), so the same pad gets its look back
// next session and a new pad joining as P2 gets the P2 default. P1 inherits the old global
// Goose Outfits / Goose Colours settings on first run.
//
// Pure: no DOM, no three.js. The store is any {getItem, setItem} (localStorage in the game).

import { GOOSE_OUTFITS, DEFAULT_GOOSE_OUTFIT, normalizeGooseOutfit, SEAT_BODY } from './goose-outfits.js';
import { normalizeColourway, DEFAULT_COLOURWAY } from './goose-colourways.js';
import { TEAM_COLOURWAYS, versusTeamLooks } from './versus/team-looks.js';

export const STORAGE_KEY = 'tandemonium_player_looks';
const LEGACY_OUTFIT_KEY = 'tandemonium_goose_outfit';
const LEGACY_COLOURS_KEY = 'tandemonium_goose_colours';

/** The two bodies, as the Wardrobe names them (a gander is a male goose). */
export const BODIES = {
  m: { label: 'Gander', hint: 'he' },
  f: { label: 'Goose', hint: 'she' },
};

/** Controller light colours. The first four are the ControllerManager's P1–P4 defaults. */
export const LED_COLOURS = [
  { key: 'blue',   label: 'Blue',   rgb: { r: 0,   g: 64,  b: 255 } },
  { key: 'red',    label: 'Red',    rgb: { r: 255, g: 32,  b: 0 } },
  { key: 'green',  label: 'Green',  rgb: { r: 0,   g: 200, b: 0 } },
  { key: 'purple', label: 'Purple', rgb: { r: 160, g: 0,   b: 255 } },
  { key: 'gold',   label: 'Gold',   rgb: { r: 255, g: 160, b: 0 } },
  { key: 'pink',   label: 'Pink',   rgb: { r: 255, g: 40,  b: 150 } },
  { key: 'teal',   label: 'Teal',   rgb: { r: 0,   g: 200, b: 190 } },
  { key: 'white',  label: 'White',  rgb: { r: 255, g: 255, b: 255 } },
  { key: 'off',    label: 'Off',    rgb: { r: 0,   g: 0,   b: 0 } },
];

/** @param {string} key @returns {{r: number, g: number, b: number}} */
export function ledRgb(key) {
  const c = LED_COLOURS.find((x) => x.key === key) || LED_COLOURS[0];
  return { ...c.rgb };
}

/** P1 = the Victorian captain (gander, blue light); P2 = the Victorian lady (goose, red); P3 / P4 alternate. */
export const PLAYER_DEFAULTS = {
  1: { outfit: DEFAULT_GOOSE_OUTFIT, body: 'm', led: 'blue' },
  2: { outfit: DEFAULT_GOOSE_OUTFIT, body: 'f', led: 'red' },
  3: { outfit: DEFAULT_GOOSE_OUTFIT, body: 'm', led: 'green' },
  4: { outfit: DEFAULT_GOOSE_OUTFIT, body: 'f', led: 'purple' },
};

/** @param {number} n player number 1–4 */
export function defaultLook(n) {
  const d = PLAYER_DEFAULTS[n] || PLAYER_DEFAULTS[((Math.max(1, n | 0) - 1) % 4) + 1];
  return { outfit: d.outfit, colours: {}, body: d.body, led: d.led };
}

/** @param {any} b @returns {'m'|'f'} */
export function normalizeBody(b, fallback = 'm') {
  return b === 'm' || b === 'f' ? b : fallback;
}

/** A sound look from anything saved or received; missing fields take player n's defaults. */
export function normalizeLook(raw, n = 1) {
  const d = defaultLook(n);
  const r = raw && typeof raw === 'object' ? raw : {};
  const outfit = normalizeGooseOutfit(r.outfit);
  const colours = {};
  if (r.colours && typeof r.colours === 'object') {
    for (const o of Object.keys(GOOSE_OUTFITS)) {
      if (!Object.prototype.hasOwnProperty.call(r.colours, o)) continue;
      const way = normalizeColourway(o, r.colours[o]);
      if (way !== DEFAULT_COLOURWAY) colours[o] = way;
    }
  }
  const led = LED_COLOURS.some((c) => c.key === r.led) ? r.led : d.led;
  return { outfit, colours, body: normalizeBody(r.body, d.body), led };
}

/** The colourway a look wears for its current outfit. */
export function lookColourway(look) {
  return normalizeColourway(look.outfit, look.colours && look.colours[look.outfit]);
}

/** A copy of `look` wearing colourway `key` for its current outfit. */
export function withColourway(look, key) {
  const colours = { ...(look.colours || {}) };
  const way = normalizeColourway(look.outfit, key);
  if (way === DEFAULT_COLOURWAY) delete colours[look.outfit]; else colours[look.outfit] = way;
  return { ...look, colours };
}

/** What a seat needs to dress its goose: {outfit, colourway, body}. */
export function seatLook(look) {
  return { outfit: look.outfit, colourway: lookColourway(look), body: look.body };
}

// ── Controller identity keys (#241) ──

/**
 * The key a controller's look is saved under. A serial / MAC (the desktop app
 * exposes them) names the unit; a browser only sees vendor:product, so the
 * slot the pad sat in tells two identical pads apart.
 * @param {{serial?: string|null, vendorId?: number|null, productId?: number|null, slotId?: string|null, kind?: string|null}} id
 * @returns {string|null}
 */
export function padKeyFor({ serial = null, vendorId = null, productId = null, slotId = null, kind = null, name = null } = {}) {
  if (kind === 'keyboard') return 'keyboard';
  if (serial) return `serial:${String(serial).trim()}`;
  if (vendorId != null && productId != null) {
    const hex = (v) => Number(v).toString(16).padStart(4, '0');
    return `pad:${hex(vendorId)}:${hex(productId)}:${slotId || 'P?'}`;
  }
  if (kind === 'steam') return `steam:${slotId || 'P?'}`;
  // An XInput pad's Gamepad-API id carries no vendor:product; its name + slot is all there is.
  if (name) {
    const slug = String(name).replace(/\s*\(.*$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug) return `pad:name:${slug}:${slotId || 'P?'}`;
  }
  return null;
}

/** vendor:product from a Gamepad-API id ("… (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)" or Firefox's "054c-0ce6-…"). */
export function vidPidFromGamepadId(id) {
  const s = String(id || '');
  let m = /Vendor:\s*([0-9a-f]{4})\s*Product:\s*([0-9a-f]{4})/i.exec(s);
  if (!m) m = /^([0-9a-f]{4})-([0-9a-f]{4})-/i.exec(s);
  return m ? { vendorId: parseInt(m[1], 16), productId: parseInt(m[2], 16) } : null;
}

// ── The store ──

/** @typedef {{outfit: string, colours: Record<string, string>, body: 'm'|'f', led: string}} Look */

export class PlayerLooks {
  /** @param {{getItem: (k: string) => string|null, setItem: (k: string, v: string) => void}|null} store */
  constructor(store = null) {
    this._store = store;
    this._data = null;        // { v, byPad: {key: Look}, byPlayer: {n: Look} }
    this._pads = {};          // live binding: player number → pad key (this session)
    this.version = 0;         // bumps on every change (cheap dirty-checks)
  }

  _read() {
    if (this._data) return this._data;
    let data = null;
    try {
      const raw = this._store && this._store.getItem(STORAGE_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }
    if (!data || typeof data !== 'object' || data.v !== 1) data = this._migrate();
    data.byPad = data.byPad && typeof data.byPad === 'object' ? data.byPad : {};
    data.byPlayer = data.byPlayer && typeof data.byPlayer === 'object' ? data.byPlayer : {};
    this._data = data;
    return data;
  }

  /** First run: today's global Goose Outfits / Goose Colours become Player 1's look. */
  _migrate() {
    const data = { v: 1, byPad: {}, byPlayer: {} };
    let legacyOutfit = null, legacyColours = null;
    try { legacyOutfit = this._store && this._store.getItem(LEGACY_OUTFIT_KEY); } catch (e) {}
    try { legacyColours = JSON.parse((this._store && this._store.getItem(LEGACY_COLOURS_KEY)) || 'null'); } catch (e) {}
    if (legacyOutfit || (legacyColours && typeof legacyColours === 'object' && Object.keys(legacyColours).length)) {
      data.byPlayer[1] = normalizeLook({ outfit: legacyOutfit, colours: legacyColours }, 1);
      this._write(data);
    }
    return data;
  }

  _write(data) {
    try { if (this._store) this._store.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  /** Remember which pad is player n this session (null forgets). */
  bindPad(n, key) {
    if (key) this._pads[n] = key; else delete this._pads[n];
  }

  /** The pad key bound to player n, if any. */
  padKey(n) { return this._pads[n] || null; }

  /**
   * Player n's look: the pad's own saved look first, then the look saved for
   * that player number, then the player's default.
   * @param {number} n @param {string|null} [padKey] defaults to the bound pad
   * @returns {Look}
   */
  get(n, padKey = undefined) {
    const d = this._read();
    const key = padKey === undefined ? this.padKey(n) : padKey;
    if (key && d.byPad[key]) return normalizeLook(d.byPad[key], n);
    if (d.byPlayer[n]) return normalizeLook(d.byPlayer[n], n);
    return defaultLook(n);
  }

  /** Has anyone picked a look for this player (or pad)? False = the default is in use. */
  isPicked(n, padKey = undefined) {
    const d = this._read();
    const key = padKey === undefined ? this.padKey(n) : padKey;
    return !!((key && d.byPad[key]) || d.byPlayer[n]);
  }

  /**
   * Save player n's look under the player number and under the pad.
   * P1's outfit and colours are mirrored to the old global keys, so anything
   * still reading them sees the same answer.
   * @returns {Look} the normalized look
   */
  set(n, padKey, look) {
    const d = this._read();
    const clean = normalizeLook(look, n);
    d.byPlayer[n] = clean;
    const key = padKey === undefined ? this.padKey(n) : padKey;
    if (key) d.byPad[key] = clean;
    this._write(d);
    if (n === 1) {
      try {
        if (this._store) {
          this._store.setItem(LEGACY_OUTFIT_KEY, clean.outfit);
          this._store.setItem(LEGACY_COLOURS_KEY, JSON.stringify(clean.colours));
        }
      } catch (e) {}
    }
    this.version++;
    return clean;
  }

  /** Change some fields of player n's look. */
  update(n, patch, padKey = undefined) {
    return this.set(n, padKey, { ...this.get(n, padKey), ...patch });
  }

  /** Forget everything cached (tests). */
  reset() { this._data = null; this._pads = {}; this.version++; }
}

// ── Seats ──

/**
 * The look each seat wears for a ride, by mode.
 *   solo             the captain is P1; the stoker mirrors P1's outfit and colours in the seat's
 *                    body (as the old Goose Outfits pair did), so a solo ride looks as it does today
 *   local            P1 captain, P2 stoker — each in their own look
 *   captain/stoker   online: my seat wears my look, the partner's wears the look they sent; an
 *                    older partner (no look) mirrors mine, like solo
 * @param {{mode: string, p1: Look, p2?: Look|null, partner?: Look|null}} args
 * @returns {{Captain: {outfit: string, colourway: string, body: 'm'|'f'}, Stoker: {outfit: string, colourway: string, body: 'm'|'f'}}}
 */
export function seatLooks({ mode, p1, p2 = null, partner = null }) {
  const mirror = (seat) => ({ ...seatLook(p1), body: SEAT_BODY[seat] });
  if (mode === 'local') return { Captain: seatLook(p1), Stoker: seatLook(p2 || defaultLook(2)) };
  if (mode === 'captain') return { Captain: seatLook(p1), Stoker: partner ? seatLook(partner) : mirror('Stoker') };
  if (mode === 'stoker') return { Captain: partner ? seatLook(partner) : mirror('Captain'), Stoker: seatLook(p1) };
  return { Captain: seatLook(p1), Stoker: mirror('Stoker') };
}

/**
 * Versus: a team's two seats. A member who picked a look wears it; a seat whose
 * player never picked (or an empty stoker seat on a solo team) wears the
 * team's fallback — the outfit + team colourway versusTeamLooks gives that team
 * (#538), in the seat's own body.
 * @param {'A'|'B'} team
 * @param {Array<{look: Look, picked: boolean}>} members captain first
 * @param {string} p1Outfit Player 1's outfit (drives the team fallback outfits)
 */
export function versusSeatLooks(team, members, p1Outfit) {
  const fb = versusTeamLooks(p1Outfit)[team];
  const seat = (s, m) => {
    if (m && m.picked) {
      const look = m.look;
      // A picked look in the outfit's own colours still takes the team colour, so the two bikes
      // read apart; a picked colourway is the player's call.
      const way = lookColourway(look);
      const colourway = way === DEFAULT_COLOURWAY ? (TEAM_COLOURWAYS[team][look.outfit] || DEFAULT_COLOURWAY) : way;
      return { outfit: look.outfit, colourway, body: look.body };
    }
    return { outfit: fb.outfit, colourway: fb.colourway, body: m && m.look ? m.look.body : SEAT_BODY[s] };
  };
  return { Captain: seat('Captain', members[0]), Stoker: seat('Stoker', members[1]) };
}

// ── Wire format (online profile) ──

/**
 * The look as the room profile carries it: {outfit, colourway, body, led}. The light only shows
 * as a swatch on the partner's room screen (#672): each player lights their own pad.
 */
export function lookToWire(look) {
  const s = seatLook(look);
  const w = { outfit: s.outfit, colourway: s.colourway, body: s.body };
  if (look && LED_COLOURS.some((c) => c.key === look.led)) w.led = look.led;
  return w;
}

/** A partner's look from their profile; null when they sent none (an older build). */
export function lookFromWire(wire) {
  if (!wire || typeof wire !== 'object') return null;
  const outfit = normalizeGooseOutfit(wire.outfit);
  const colours = {};
  const way = normalizeColourway(outfit, wire.colourway);
  if (way !== DEFAULT_COLOURWAY) colours[outfit] = way;
  const led = LED_COLOURS.some((c) => c.key === wire.led) ? wire.led : 'off';   // an older peer sends none
  return { outfit, colours, body: normalizeBody(wire.body, 'f'), led };
}

// ── The game's singleton (localStorage-backed when there is one) ──

function browserStore() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

export const playerLooks = new PlayerLooks(browserStore());
if (typeof window !== 'undefined') window.__playerLooks = playerLooks;   // smokes
