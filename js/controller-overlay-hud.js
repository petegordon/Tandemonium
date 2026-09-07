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
//   local co-op            P1 lower-left, P2 lower-right
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

/**
 * Who is this slot, really? { name, profile, key }.
 *
 * The bound WebHID device wins over the Gamepad-API id. Under Steam every
 * captured pad reaches Chromium as Steam's virtual XInput device, so a
 * DualSense's `gamepad.id` literally says "Xbox 360 Controller" — while the
 * slot's HID entry (where its gyro comes from) still carries the real
 * vendor:product. Order: HID device → driver's registry entry → gamepad id →
 * id sniffing. `key` changes whenever any input to the decision changes, so
 * a tile can re-resolve when the HID binding arrives after the claim.
 */
export function slotIdentity(slot) {
  const label = (slot && slot.controllerLabel) || '';
  const device = slot && slot._hidEntry ? slot._hidEntry.device : null;
  const vp = device ? `${device.vendorId}:${device.productId}` : '';
  const key = `${label}|${vp}`;
  let entry = null;
  if (device) entry = ControllerRegistry.getEntry(device.vendorId, device.productId);
  if (!entry && slot && slot.driver && slot.driver.entry) entry = slot.driver.entry;
  if (entry) {
    return { key, name: entry.name, profile: entry.controllerProfile || entry.protocol || null };
  }
  const info = ControllerRegistry.identifyFromGamepadId(label);
  if (info) return { key, name: info.driverName || shortLabel(label), profile: info.controllerProfile || null };
  return { key, name: device ? (device.productName || shortLabel(label)) : shortLabel(label), profile: null };
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
          });
        });
      });
      return entries;
    }

    if (ctx.mode === 'local') {
      entries.push(this._playerEntry('P1', slotOf('P1'), 'bl'));
      const p2 = (ctx.inputP2 && ctx.inputP2._slot) || slotOf('P2');
      entries.push(this._playerEntry('P2', ctx.localP2Type === 'keyboard' ? null : p2, 'br'));
      return entries;
    }

    if (ctx.state === 'lobby' && mgr) {
      for (const s of mgr.slots || []) if (s.state !== 'empty') entries.push(this._playerEntry(s.id, s, 'br'));
      if (!entries.length) entries.push(this._playerEntry('P1', null, 'br'));
      return entries;
    }

    // solo / captain / stoker: your own pad is always slot P1
    entries.push(this._playerEntry('P1', slotOf('P1'), 'br'));
    return entries;
  }

  _playerEntry(id, slot, anchor) {
    const live = !!slot && slot.state !== 'empty';
    return {
      key: id, label: id, seat: '', color: PLAYER_COLORS[id] || '#ffffff',
      anchor, band: null,
      kind: live ? 'gamepad' : 'keyboard',
      slot: live ? slot : null,
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
    if (keyboard) this.subEl.textContent = '';
    return layoutChanged;
  }

  _bindSlot(slot) {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this.slot = slot || null;
    this._identityKey = null;
    if (!slot) { this._destroyOverlay(); return; }
    // Report-level extras that never reach the Gamepad shape: the touchpad
    // finger(s) and the Steam Controller's capacitive grips.
    this._unsub = slot.on((s, reason, data) => {
      if (reason !== 'hid-report' || !data || !this.overlay) return;
      if (data.touchpad && this.overlay.updateTouchpad) this.overlay.updateTouchpad(data.touchpad, data.touchpadButton);
      if (data.grips && this.overlay.setGripState) this.overlay.setGripState(data.grips);
    });
  }

  _profileFor() {
    const viz = this.hud._viz;
    const id = slotIdentity(this.slot);
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
    if (seq !== this._seq || this._disposed || !this.slot) { overlay.dispose(); this._creating = false; return; }
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
    const slot = this.slot;
    if (!slot) return;
    if (!this.overlay) {
      if (this.hud._viz && !this._creating && this._size.width > 0) this._createOverlay();
      return;
    }
    // Re-resolve name + model whenever the slot's identity inputs change —
    // a re-claim with a different pad, or the HID binding arriving late.
    const id = slotIdentity(slot);
    if (id.key !== this._identityKey) {
      this._identityKey = id.key;
      this.subEl.textContent = id.name;
      const type = this._profileFor();
      if (type !== this.profile) { this.profile = type; this.overlay.setControllerType(type); }
    }
    const gp = slot.effectiveGamepad(pads);
    const q = (slot.state === 'claimed' && slot.fusion) ? slot.fusion.orientation : null;
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
