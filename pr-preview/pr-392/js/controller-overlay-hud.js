// ============================================================
// CONTROLLER OVERLAY HUD — live 3D view of the riders' controllers
// ============================================================
//
// The in-game version of the lab's controller overlay (tandemonium-controller-lab
// → apps/overlay): one small tile per rider showing their physical pad as an
// animated 3D model — buttons sink, sticks tilt, triggers pull, the body follows
// the gyro, a DualSense touchpad / Steam Controller trackpad shows the finger.
// It reads the SAME ControllerManager slots the game steers from, so a tile
// shows exactly what the game is receiving (a stuck stick, a pad the manager
// claimed for the wrong seat, gyro drift) — which is the whole point.
//
// Invoke: press C, or CONTROLLERS in the in-ride quick menu. The choice is
// persisted (tandemonium_controller_overlay) so it comes back next launch.
//
// Placement (docs/controller-overlay.md has the reasoning + alternatives):
//   solo / online          one tile, lower-right (your own pad — always slot P1)
//   local co-op            P1 lower-right (same corner as solo), P2 lower-left
//   versus (split screen)  team A's riders in the lower-LEFT of the LEFT half,
//                          team B's riders in the lower-RIGHT of the RIGHT half,
//                          captain outermost and stoker beside it, in the team
//                          colour — so P3/P4 sit under their own viewport and
//                          each rider glances at their own half's outer corner.
//   lobby                  every claimed slot, lower-right, P1 outermost — the
//                          "which pad is which" identify view (issue #241).
//
// Tiles dodge what the ride already draws in the corners — the front-view
// selfie cam, the partner webcam PiP, the pedal bars — so nothing gets covered.
//
// Cost: nothing while off. The visualizer (and its Three addons) is imported
// on first enable; each tile owns a small WebGL canvas with its own render
// loop, so everything is built on enable and disposed on disable — the same
// lazy-create / dispose the lab's multi-controller overlay uses.

import { ControllerRegistry } from '../shared/drivers/controller-registry.js';
import { steamTypeForGamepad } from './input-manager.js';

export const CONTROLLER_OVERLAY_PREF = 'tandemonium_controller_overlay';

/** Persisted preference: off by default (opt-in). */
export function getControllerOverlayPref() {
  try { return localStorage.getItem(CONTROLLER_OVERLAY_PREF) === 'on'; }
  catch (e) { return false; }
}

// P1 green + P2 coral are the game's own player colours (see the local co-op
// spike); P3/P4 borrow the lab's multi-overlay blue/purple so four lobby
// tiles stay distinct. Versus tiles use the TEAM colour instead.
export const PLAYER_COLORS = { P1: '#44ff66', P2: '#ff4560', P3: '#6ea8ff', P4: '#c79dff' };

// Result / cinematic states: the overlays there are modal and the front view
// hides too, so the tiles step aside as well.
const HIDDEN_STATES = new Set(['finishCinematic', 'versusCinematic', 'gameover', 'victory', 'versusResults']);
const LAYOUT_INTERVAL_MS = 250; // re-measure obstacles at ~4Hz (plus on resize / roster change)

const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// Tile styling lives with the module (injected once, like the front view's
// frame) so the game and test/controller-overlay.html render identically.
// Tinted per player / team via --cohud-color. z-index sits under the front
// view (40) — they dodge each other anyway.
const STYLE_ID = 'controller-overlay-style';
const STYLE = `
#controller-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 39; }
#controller-overlay[hidden] { display: none; }
.cohud-tile {
  position: fixed; box-sizing: border-box; pointer-events: none; overflow: hidden;
  border: 2px solid var(--cohud-color, #fff); border-radius: 14px;
  background: rgba(0,0,0,0.42); box-shadow: 0 6px 22px rgba(0,0,0,0.45);
  font-family: 'Helvetica Neue', Arial, sans-serif;
}
.cohud-tile canvas { display: block; width: 100%; height: 100%; }
.cohud-head {
  position: absolute; top: 6px; left: 10px; right: 10px;
  display: flex; align-items: baseline; gap: 6px;
  font-size: 11px; font-weight: 700; letter-spacing: 1px;
  color: var(--cohud-color, #fff); text-shadow: 0 1px 3px rgba(0,0,0,0.8);
  white-space: nowrap; overflow: hidden;
}
.cohud-seat { color: rgba(255,255,255,0.85); }
.cohud-seat:empty { display: none; }
.cohud-sub {
  font-weight: 500; letter-spacing: 0.3px; color: rgba(255,255,255,0.7);
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.cohud-kb {
  position: absolute; inset: 0; display: none;
  flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  color: rgba(255,255,255,0.7); font-size: 11px; letter-spacing: 1.5px;
}
.cohud-kb .cohud-glyph { font-size: 30px; line-height: 1; }
.cohud-tile.cohud-keyboard canvas { display: none; }
.cohud-tile.cohud-keyboard .cohud-kb { display: flex; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = STYLE;
  document.head.appendChild(el);
}

/** Gamepad id with the "(Vendor: … Product: …)" / "(STANDARD GAMEPAD …)" tail dropped. */
function shortLabel(label) {
  return String(label || '').replace(/\s*\(.*$/, '').trim().slice(0, 28) || 'Controller';
}

// Steam Input's ESteamInputType → what to call it and which model to show.
// main.js stringifies the enum, so it arrives as '13', not 'PS5Controller';
// accept both forms (the SDK has flip-flopped). Steam-family pads share the
// Steam Controller model; PlayStation-family pads share the DualSense model.
const STEAM_TYPES = {
  1:  { name: 'Steam Controller', profile: 'steam-controller' },
  2:  { name: 'Xbox 360',         profile: 'xbox' },
  3:  { name: 'Xbox',             profile: 'xbox' },
  5:  { name: 'DualShock 4',      profile: 'dualsense' },
  10: { name: 'Switch Pro',       profile: 'switch-pro' },
  12: { name: 'DualShock 3',      profile: 'dualsense' },
  13: { name: 'DualSense',        profile: 'dualsense' },
  14: { name: 'Steam Controller', profile: 'steam-controller' }, // what the 2026 Puck reports as
};
const STEAM_TYPE_NAMES = {
  steamcontroller: 1, xbox360controller: 2, xboxonecontroller: 3, ps4controller: 5,
  switchprocontroller: 10, ps3controller: 12, ps5controller: 13, steamdeckcontroller: 14,
};
export function steamTypeIdentity(type) {
  const t = String(type ?? '').trim().replace(/^k_ESteamInputType_/i, '');
  const code = /^\d+$/.test(t) ? Number(t) : STEAM_TYPE_NAMES[t.toLowerCase()];
  const hit = code != null ? STEAM_TYPES[code] : null;
  return hit ? { ...hit } : { name: t ? `Steam Input (${t})` : 'Steam Input', profile: null };
}

/**
 * The slot's WebHID entry, but only if it is a real controller: a fan-out
 * receiver interface (Steam Puck) that has never streamed is an idle sibling,
 * not the pad in the player's hands — never let it name or model a seat.
 */
export function liveHidEntry(slot) {
  const entry = slot && slot._hidEntry;
  if (!entry) return null;
  const fanout = !!(entry.driver && entry.driver.constructor && entry.driver.constructor.needsSiblingFanout);
  return (fanout && !(entry.hidActiveSince > 0)) ? null : entry;
}

/** Same rule InputManager._slotFusionIsLive applies before it trusts WebHID. */
export function slotFusionLive(slot) {
  return !!(slot && slot.fusion && liveHidEntry(slot));
}

// What fed the tile — shown after the pad's name so a photo of the tile says
// which source won ("DualSense · Steam" vs "· WebHID" vs "· Pad").
const SOURCE_LABEL = { hid: 'WebHID', steam: 'Steam', pad: 'Pad', none: '' };

/**
 * Who is this seat's pad, really? { name, profile, key, source }.
 *
 * Under Steam every captured pad reaches Chromium as Steam's virtual XInput
 * device, so a DualSense's `gamepad.id` literally says "Xbox 360 Controller".
 * The slot's WebHID binding (where its gyro comes from) still carries the real
 * vendor:product, and when Steam owns the pad exclusively Steam Input tells us
 * the type. Order, mirroring the game's WebHID-first rule:
 *   HID device → driver's registry entry → Steam Input type → gamepad id → sniff.
 * `key` changes whenever any input to the decision changes, so a tile can
 * re-resolve when a HID binding or the Steam capture arrives after the claim.
 *
 * @param {Object|null} slot        ControllerManager slot (may be empty/null)
 * @param {Object|null} [steamEntry] the InputManager's Steam Input snapshot
 *   entry, ONLY when that manager is actually reading Steam for this seat
 */
export function slotIdentity(slot, steamEntry = null, pad = null, pads = null) {
  const label = (slot && slot.controllerLabel) || '';
  const hid = liveHidEntry(slot);
  const device = hid ? hid.device : null;
  const vp = device ? `${device.vendorId}:${device.productId}` : '';
  // A virtual XInput pad under Steam: ask Steam which controller sits in that
  // XInput slot (#362) — the only way to tell a DualSense from the Steam
  // Controller's own twin when the Steam snapshot is empty (emulation mode).
  const xinputType = pad ? steamTypeForGamepad(pad, pads) : null;
  const steamType = steamEntry ? String(steamEntry.type ?? '') : (xinputType || '');
  const key = `${label}|${vp}|${steamType}`;
  let entry = null;
  if (device) entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
  if (!entry && hid && hid.driver && hid.driver.entry) entry = hid.driver.entry;
  if (entry) {
    return { key, source: 'hid', name: entry.name, profile: entry.controllerProfile || entry.protocol || null };
  }
  if (steamEntry) {
    const st = steamTypeIdentity(steamEntry.type);
    if (st.profile) return { key, source: 'steam', ...st };
  }
  if (xinputType) {
    const st = steamTypeIdentity(xinputType);
    if (st.profile) return { key, source: 'steam', ...st };
  }
  const info = ControllerRegistry.identifyFromGamepadId(label);
  if (info) return { key, source: 'pad', name: info.driverName || shortLabel(label), profile: info.controllerProfile || null };
  if (steamEntry) return { key, source: 'steam', ...steamTypeIdentity(steamEntry.type) };
  return { key, source: label ? 'pad' : 'none', name: device ? (device.productName || shortLabel(label)) : shortLabel(label), profile: null };
}

/**
 * The Steam Input snapshot entry an InputManager is steering from right now,
 * or null. Mirrors the manager's own arbitration (pollGamepad): Steam Input
 * is the source only when Steam has captured a pad AND the seat has no live
 * WebHID fusion (WebHID-first). Read-only — nothing here mutates the manager.
 */
export function steamEntryFor(input, slot) {
  if (!input || !input._steamInputActive) return null;
  if (slotFusionLive(slot)) return null;
  if (typeof input._selectedSteamEntry !== 'function') return null;
  return input._selectedSteamEntry() || null;
}

/** Short human name for a slot's pad (see slotIdentity). */
export function controllerDisplayName(slotOrLabel) {
  if (!slotOrLabel) return '';
  if (typeof slotOrLabel === 'string') return slotIdentity({ controllerLabel: slotOrLabel }).name;
  return slotIdentity(slotOrLabel).name;
}

export class ControllerOverlayHud {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.assetBase='shared/visualizer/'] where the vendored
   *   visualizer GLBs live (prefix for the profiles' assets/controllers/… paths)
   * @param {HTMLElement} [opts.container=document.body]
   * @param {() => Promise<Object>} [opts.loadVisualizer] override for the lazy
   *   import (tests inject the module; the game uses the vendored copy)
   */
  constructor({ assetBase = 'shared/visualizer/', container = null, loadVisualizer = null } = {}) {
    this.assetBase = assetBase;
    this.container = container || document.body;
    this.enabled = false;
    this.root = null;             // #controller-overlay wrapper
    this.tiles = new Map();       // entry.key -> Tile
    this._viz = null;             // the visualizer module once imported
    this._vizLoading = null;
    this._loadVisualizer = loadVisualizer || (() => import('../shared/visualizer/src/index.js'));
    this._lastLayout = 0;
    this._layoutDirty = true;
    this._onResize = () => { this._layoutDirty = true; };
    this.onChange = null;         // callback(enabled) — the quick menu mirrors it
    this.disposed = false;
  }

  isOn() { return this.enabled; }

  /**
   * Turn the tiles on/off. Persists the choice unless told not to (boot
   * applies the saved preference without re-writing it).
   */
  setEnabled(on, { persist = true } = {}) {
    on = !!on;
    if (on === this.enabled) return;
    this.enabled = on;
    if (persist) { try { localStorage.setItem(CONTROLLER_OVERLAY_PREF, on ? 'on' : 'off'); } catch (e) {} }
    if (on) {
      this._ensureRoot();
      this.root.hidden = false;
      this._layoutDirty = true;
      window.addEventListener('resize', this._onResize);
      this._ensureVisualizer();
    } else {
      window.removeEventListener('resize', this._onResize);
      this._clearTiles();
      if (this.root) this.root.hidden = true;
    }
    if (this.onChange) this.onChange(on);
  }

  toggle() { this.setEnabled(!this.enabled); }

  /**
   * Per-frame driver. Call once per game frame AFTER the ride has rendered
   * (so the tiles can dodge wherever the front view landed this frame).
   *
   * @param {Object} ctx
   * @param {string} ctx.state  game state ('lobby' | 'countdown' | 'playing' | …)
   * @param {string} ctx.mode   'solo' | 'captain' | 'stoker' | 'local' | 'versus'
   * @param {import('../shared/manager.js').ControllerManager} ctx.manager
   * @param {Array} [ctx.versusRigs]   live TeamRigs (versus)
   * @param {Object} [ctx.input]       P1's InputManager (Steam Input source + gyro)
   * @param {Object} [ctx.inputP2]     P2 InputManager (local co-op)
   * @param {string} [ctx.localP2Type] 'gamepad' | 'keyboard' (local co-op)
   * @param {ArrayLike<Gamepad>} [ctx.pads] this frame's navigator.getGamepads()
   */
  update(ctx) {
    if (!this.enabled || !this.root || this.disposed) return;
    const hidden = HIDDEN_STATES.has(ctx.state);
    if (this.root.hidden !== hidden) this.root.hidden = hidden;
    if (hidden) return;

    this._reconcile(this._roster(ctx));

    const now = performance.now();
    if (this._layoutDirty || now - this._lastLayout > LAYOUT_INTERVAL_MS) {
      this._lastLayout = now;
      this._layoutDirty = false;
      this._layout();
    }

    const pads = ctx.pads || (navigator.getGamepads ? navigator.getGamepads() : []);
    for (const tile of this.tiles.values()) tile.tick(pads);
  }

  dispose() {
    this.setEnabled(false, { persist: false });
    this.disposed = true;
    if (this.root) { this.root.remove(); this.root = null; }
  }

  // ── Roster: who gets a tile, and which corner ──────────────────────────

  _roster(ctx) {
    const mgr = ctx.manager;
    const w = window.innerWidth;
    const slotOf = (id) => (mgr && id) ? mgr.getSlot(id) : null;
    const entries = [];

    if (ctx.mode === 'versus' && ctx.versusRigs) {
      ctx.versusRigs.forEach((rig, i) => {
        const band = i === 0 ? { left: 0, right: w / 2 } : { left: w / 2, right: w };
        const anchor = i === 0 ? 'bl' : 'br';
        (rig.members || []).forEach((m, j) => {
          const gamepad = m.type === 'gamepad';
          entries.push({
            key: `${rig.id}:${m.slotId || 'kb'}:${j}`,
            label: rig.color ? rig.color.name : `TEAM ${rig.id}`,
            seat: m.slotId || (gamepad ? '' : 'KEYBOARD'),
            color: rig.color ? rig.color.hex : '#ffffff',
            anchor, band,
            kind: gamepad ? 'gamepad' : 'keyboard',
            slot: gamepad ? slotOf(m.slotId) : null,
            input: gamepad ? (m.input || null) : null,
          });
        });
      });
      return entries;
    }

    if (ctx.mode === 'local') {
      // P1 keeps the solo corner (lower-right); P2 takes the lower-left.
      entries.push(this._playerEntry('P1', slotOf('P1'), 'br', ctx.input));
      const p2 = (ctx.inputP2 && ctx.inputP2._slot) || slotOf('P2');
      const p2Keyboard = ctx.localP2Type === 'keyboard';
      entries.push(this._playerEntry('P2', p2Keyboard ? null : p2, 'bl', p2Keyboard ? null : ctx.inputP2));
      return entries;
    }

    if (ctx.state === 'lobby' && mgr) {
      // Every claimed slot; P1 also counts when Steam Input alone holds its
      // pad (Electron under Steam often surfaces no Gamepad-API device, so the
      // slot stays empty while the InputManager steers from the snapshot).
      const p1 = this._playerEntry('P1', slotOf('P1'), 'br', ctx.input);
      if (p1.kind === 'gamepad') entries.push(p1);
      for (const s of mgr.slots || []) {
        if (s.id === 'P1' || s.state === 'empty') continue;
        entries.push(this._playerEntry(s.id, s, 'br'));
      }
      if (!entries.length) entries.push(p1);
      return entries;
    }

    // solo / captain / stoker: your own pad is always seat P1
    entries.push(this._playerEntry('P1', slotOf('P1'), 'br', ctx.input));
    return entries;
  }

  _playerEntry(id, slot, anchor, input = null) {
    const live = !!slot && slot.state !== 'empty';
    const steam = !!steamEntryFor(input, live ? slot : null);
    return {
      key: id, label: id, seat: '', color: PLAYER_COLORS[id] || '#ffffff',
      anchor, band: null,
      kind: (live || steam) ? 'gamepad' : 'keyboard',
      slot: live ? slot : null,
      input: input || null,
    };
  }

  // ── Tiles ────────────────────────────────────────────────────────────

  _ensureRoot() {
    if (this.root) return;
    ensureStyle();
    let el = document.getElementById('controller-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'controller-overlay';
      this.container.appendChild(el);
    }
    this.root = el;
  }

  _ensureVisualizer() {
    if (this._viz || this._vizLoading) return this._vizLoading;
    this._vizLoading = Promise.resolve()
      .then(() => this._loadVisualizer())
      .then((mod) => { this._viz = mod; return mod; })
      .catch((err) => {
        console.warn('[controller-overlay] visualizer failed to load:', err);
        this._vizLoading = null;
        this.setEnabled(false);
      });
    return this._vizLoading;
  }

  _reconcile(entries) {
    const keep = new Set();
    let changed = false;
    for (const e of entries) {
      keep.add(e.key);
      let tile = this.tiles.get(e.key);
      if (!tile) {
        tile = new Tile(this, e);
        this.root.appendChild(tile.el);
        this.tiles.set(e.key, tile);
        changed = true;
      } else if (tile.setEntry(e)) {
        changed = true;
      }
      tile.order = keep.size; // roster order → outer-to-inner stacking
    }
    for (const [key, tile] of this.tiles) {
      if (!keep.has(key)) { tile.dispose(); this.tiles.delete(key); changed = true; }
    }
    if (changed) this._layoutDirty = true;
  }

  _clearTiles() {
    for (const tile of this.tiles.values()) tile.dispose();
    this.tiles.clear();
  }

  // ── Layout: corners, bands, and dodging the ride's own corner widgets ──

  _visibleRect(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return null;
    return r;
  }

  /** Tile size scales with the smaller screen dimension, like the front view. */
  metrics() {
    const w = window.innerWidth, h = window.innerHeight;
    const base = Math.min(w, h);
    const tileW = Math.max(140, Math.min(260, Math.round(base * 0.26)));
    return {
      w, h, tileW,
      tileH: Math.round(tileW * 0.7),
      margin: Math.round(base * 0.035),
      gap: Math.max(6, Math.round(base * 0.0175)),
    };
  }

  _layout() {
    const { w, h, tileW, tileH, margin, gap } = this.metrics();

    // Things already living in the bottom corners. Selfie cams + the partner
    // PiP are slid past sideways; the pedal bars are cleared vertically (they
    // span the width of their half, so sliding would never escape them).
    const obstacles = [];
    for (const el of document.querySelectorAll('.front-view-frame')) {
      const r = this._visibleRect(el); if (r) obstacles.push(r);
    }
    const pip = this._visibleRect(document.getElementById('partner-pip-wrap'));
    if (pip) obstacles.push(pip);
    const bars = [];
    for (const el of [document.getElementById('pedal-bar'), ...document.querySelectorAll('.versus-pedals')]) {
      const r = this._visibleRect(el); if (r) bars.push(r);
    }

    // Group by corner + band; each group stacks inward from its anchor edge.
    const groups = new Map();
    for (const tile of [...this.tiles.values()].sort((a, b) => a.order - b.order)) {
      const e = tile.entry;
      const band = e.band || { left: 0, right: w };
      const key = `${e.anchor}|${Math.round(band.left)}|${Math.round(band.right)}`;
      if (!groups.has(key)) groups.set(key, { anchor: e.anchor, band, tiles: [] });
      groups.get(key).tiles.push(tile);
    }

    for (const g of groups.values()) {
      const inward = g.anchor === 'br' ? -1 : 1;
      let x = g.anchor === 'br' ? g.band.right - margin - tileW : g.band.left + margin;
      for (const tile of g.tiles) {
        let rect = { left: x, right: x + tileW, top: h - margin - tileH, bottom: h - margin };
        // Two passes: a sideways slide can land back over a bar, and a lift
        // can bring a tile level with a selfie cam.
        for (let pass = 0; pass < 2; pass++) {
          for (const b of bars) {
            if (!intersects(rect, b)) continue;
            const lift = rect.bottom - b.top + gap;
            rect = { ...rect, top: rect.top - lift, bottom: rect.bottom - lift };
          }
          for (const o of obstacles) {
            if (!intersects(rect, o)) continue;
            const nx = g.anchor === 'br' ? o.left - gap - tileW : o.right + gap;
            rect = { ...rect, left: nx, right: nx + tileW };
          }
        }
        const left = Math.max(0, Math.min(w - tileW, rect.left));
        const top = Math.max(0, rect.top);
        tile.applyRect({ left, top, width: tileW, height: tileH });
        x = left + inward * (tileW + gap);
      }
    }
  }
}

// ── One tile: a player label + the visualizer canvas (or a keyboard glyph) ──

class Tile {
  constructor(hud, entry) {
    this.hud = hud;
    this.entry = null;
    this.slot = null;
    this.input = null;         // the seat's InputManager (Steam Input source), if any
    this.order = 0;
    this.overlay = null;       // ControllerOverlay once the model is up
    this.profile = null;       // visualizer profile key currently loaded
    this._creating = false;
    this._seq = 0;
    this._unsub = null;
    this._identityKey = null;  // slotIdentity().key the title + profile were derived from
    this._size = { width: 0, height: 0 };
    this._disposed = false;

    const el = document.createElement('div');
    el.className = 'cohud-tile';
    el.innerHTML =
      '<canvas class="cohud-canvas"></canvas>' +
      '<div class="cohud-head"><span class="cohud-label"></span><span class="cohud-seat"></span><span class="cohud-sub"></span></div>' +
      '<div class="cohud-kb"><span class="cohud-glyph">&#x2328;&#xFE0F;</span><span>KEYBOARD</span></div>';
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.labelEl = el.querySelector('.cohud-label');
    this.seatEl = el.querySelector('.cohud-seat');
    this.subEl = el.querySelector('.cohud-sub');
    this.setEntry(entry);
  }

  /** Apply a (possibly changed) roster entry. Returns true if layout-relevant
   *  fields changed. */
  setEntry(entry) {
    const prev = this.entry;
    this.entry = entry;
    const layoutChanged = !prev || prev.anchor !== entry.anchor ||
      (prev.band ? prev.band.left : -1) !== (entry.band ? entry.band.left : -1) ||
      (prev.band ? prev.band.right : -1) !== (entry.band ? entry.band.right : -1);
    if (!prev || prev.color !== entry.color) {
      this.el.style.setProperty('--cohud-color', entry.color);
      if (this.overlay) this.overlay.setPressColor(entry.color);
    }
    if (!prev || prev.label !== entry.label) this.labelEl.textContent = entry.label;
    if (!prev || prev.seat !== entry.seat) this.seatEl.textContent = entry.seat;
    const keyboard = entry.kind !== 'gamepad';
    if (this.el.classList.contains('cohud-keyboard') !== keyboard) {
      this.el.classList.toggle('cohud-keyboard', keyboard);
    }
    if (entry.slot !== this.slot) this._bindSlot(entry.slot);
    if ((entry.input || null) !== this.input) { this.input = entry.input || null; this._identityKey = null; }
    if (keyboard) { this.subEl.textContent = ''; this._destroyOverlay(); }
    return layoutChanged;
  }

  /** Does this seat have a pad to draw — a live slot or a Steam Input capture? */
  _hasSource() { return this.entry.kind === 'gamepad' && (!!this.slot || !!steamEntryFor(this.input, null)); }

  _bindSlot(slot) {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this.slot = slot || null;
    this._identityKey = null;
    if (!slot) return; // a Steam-only seat keeps its overlay; tick() drives it
    // Report-level extras that never reach the Gamepad shape: the touchpad
    // finger(s) and the Steam Controller's capacitive grips.
    this._unsub = slot.on((s, reason, data) => {
      if (reason !== 'hid-report' || !data || !this.overlay) return;
      if (data.touchpad && this.overlay.updateTouchpad) this.overlay.updateTouchpad(data.touchpad, data.touchpadButton);
      if (data.grips && this.overlay.setGripState) this.overlay.setGripState(data.grips);
    });
  }

  _profileFor(pad = null, pads = null) {
    const viz = this.hud._viz;
    const id = slotIdentity(this.slot, steamEntryFor(this.input, this.slot), pad, pads);
    let type = id.profile || viz.detectControllerType((this.slot && this.slot.controllerLabel) || '');
    if (!viz.PROFILES[type]) type = 'dualsense';
    return type;
  }

  async _createOverlay() {
    const viz = this.hud._viz;
    const seq = ++this._seq;
    this._creating = true;
    const type = this._profileFor();
    const overlay = new viz.ControllerOverlay({
      canvas: this.canvas,
      transparent: true,
      controllerType: type,
      assetBase: this.hud.assetBase,
    });
    try {
      await overlay.init();
    } catch (err) {
      console.warn('[controller-overlay] tile init failed:', err);
      this._creating = false;
      return;
    }
    if (seq !== this._seq || this._disposed || !this._hasSource()) { overlay.dispose(); this._creating = false; return; }
    overlay.setCameraPreset('player');
    overlay.setPressColor(this.entry.color);
    this.overlay = overlay;
    this.profile = type;
    this._creating = false;
    this._resize();
  }

  _destroyOverlay() {
    this._seq++; // cancels an in-flight init
    if (this.overlay) { try { this.overlay.dispose(); } catch (e) {} }
    this.overlay = null;
    this.profile = null;
    this._creating = false;
  }

  tick(pads) {
    if (!this._hasSource()) return;
    if (!this.overlay) {
      if (this.hud._viz && !this._creating && this._size.width > 0) this._createOverlay();
      return;
    }
    const slot = this.slot;
    const input = this.input;
    // Steam Input is this seat's source only when its InputManager says so
    // (captured by Steam AND no live WebHID fusion) — same arbitration the
    // steering uses, so the tile never shows a source the game isn't reading.
    const steam = steamEntryFor(input, slot);

    // Re-resolve name + model whenever the identity inputs change — a
    // re-claim with a different pad, a HID binding or Steam capture arriving
    // after the claim.
    const realPad = (slot && slot.gamepadIndex != null) ? (pads[slot.gamepadIndex] || null) : null;
    const id = slotIdentity(slot, steam, realPad, pads);
    if (id.key !== this._identityKey) {
      this._identityKey = id.key;
      const src = SOURCE_LABEL[id.source] || '';
      this.subEl.textContent = src ? `${id.name} · ${src}` : id.name;
      const type = this._profileFor(realPad, pads);
      if (type !== this.profile) { this.profile = type; this.overlay.setControllerType(type); }
    }

    // Buttons/sticks: the slot's pad when it has one (under Steam that is the
    // virtual XInput device — full button set), else the manager's synthetic
    // Steam Input gamepad (the bound actions: confirm/cancel/pedals/menu).
    let gp = slot ? slot.effectiveGamepad(pads) : null;
    if (!gp && steam && input && typeof input._buildSteamInputGamepad === 'function') gp = input._buildSteamInputGamepad();

    // Orientation: the WebHID fusion when bound; otherwise the manager's
    // per-handle fusion fed from Steam's getMotionData (design B) — present
    // only while motion is enabled and Steam reports motion for this pad.
    // displayOrientation is the recentred / yaw-returned pose (what the lab
    // overlay shows and what steering reads), so RECENTER TILT levels the
    // tile too; older fusions without it fall back to the raw integration.
    let f = (slot && slot.state === 'claimed' && slotFusionLive(slot)) ? slot.fusion : null;
    if (!f && steam && input && input._steamFusions) f = input._steamFusions.get(steam.handle) || null;
    const q = (f && !f.calibrating) ? (f.displayOrientation || f.orientation || null) : null;
    this.overlay.update(gp, q);
  }

  applyRect(r) {
    const s = this.el.style;
    s.left = r.left + 'px';
    s.top = r.top + 'px';
    if (r.width !== this._size.width || r.height !== this._size.height) {
      this._size = { width: r.width, height: r.height };
      s.width = r.width + 'px';
      s.height = r.height + 'px';
      this._resize();
    }
    this.rect = r;
  }

  _resize() {
    if (!this.overlay) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w > 0 && h > 0) this.overlay.resize(w, h);
  }

  dispose() {
    this._disposed = true;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._destroyOverlay();
    this.el.remove();
  }
}
