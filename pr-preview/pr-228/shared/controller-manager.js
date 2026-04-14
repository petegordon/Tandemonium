// ============================================================
// CONTROLLER MANAGER — headless slot/claim model
// ============================================================
//
// Owns the list of N player slots (typically P1/P2) and the lifecycle
// of each: empty → claimed → (orphan) → empty. Agnostic of UI; the
// view layer subscribes to slot change events and renders whatever
// visualization it wants (3D overlay, lobby card, debug HUD, etc.).
//
// WebHID devices live in a **pool** that is independent of slots.
// Pairing a device (auto at boot, hot-plug, or via user gesture) adds
// a `HidEntry` to the pool — the entry starts its own fusion +
// synthetic gamepad and processes HID reports immediately. A slot
// only takes ownership of an entry at claim time, which keeps the
// P1/P2 assignment strictly "first to press". On release, the entry
// returns to the pool (fusion continues running for a seamless re-
// claim).
//
// See #222 for the design doc and #224 for the consolidation plan.
// ============================================================

import { ControllerRegistry } from './controllers/controller-registry.js';
import { SensorFusion } from './sensor-fusion.js';

const DEFAULTS = {
  releaseHoldMs: 2000,
  reclaimCooldownMs: 1500,
  psButtonIndex: 16,
  hidStaleMs: 800,
  axisActivityThreshold: 0.6,
};

// ── Synthetic gamepad helpers ──

export function makeSyntheticGamepad(hidDevice) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: false, touched: false, value: 0 });
  return {
    id: `HID::${hidDevice.productName || 'hid'}`,
    index: -1,
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    buttons,
    axes: [0, 0, 0, 0],
    _isSynthetic: true,
  };
}

export function resetSynthetic(gp) {
  if (!gp) return;
  for (const b of gp.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
  for (let i = 0; i < gp.axes.length; i++) gp.axes[i] = 0;
  gp.timestamp = 0;
}

export function applyParsedToSynthetic(gp, parsed) {
  if (!gp || !parsed) return;
  const setBtn = (i, pressed, value) => {
    gp.buttons[i].pressed = !!pressed;
    gp.buttons[i].touched = !!pressed;
    gp.buttons[i].value = typeof value === 'number' ? value : (pressed ? 1 : 0);
  };
  const b = parsed.buttons;
  if (b) {
    setBtn(0, b.cross); setBtn(1, b.circle); setBtn(2, b.square); setBtn(3, b.triangle);
    setBtn(4, b.l1); setBtn(5, b.r1);
    setBtn(8, b.create); setBtn(9, b.options);
    setBtn(10, b.l3); setBtn(11, b.r3);
    setBtn(12, b.dpadUp); setBtn(13, b.dpadDown);
    setBtn(14, b.dpadLeft); setBtn(15, b.dpadRight);
    setBtn(16, b.ps);
  }
  if (parsed.triggers) {
    setBtn(6, parsed.triggers.l2 > 0.1, parsed.triggers.l2);
    setBtn(7, parsed.triggers.r2 > 0.1, parsed.triggers.r2);
  }
  if (parsed.sticks) {
    gp.axes[0] = parsed.sticks.lx; gp.axes[1] = parsed.sticks.ly;
    gp.axes[2] = parsed.sticks.rx; gp.axes[3] = parsed.sticks.ry;
  }
  gp.timestamp = performance.now();
}

export function stableIdFor(gamepad) {
  return `${gamepad.id}::${gamepad.mapping || 'std'}`;
}

export function gamepadHasActivity(gp, axisThreshold = DEFAULTS.axisActivityThreshold) {
  if (!gp) return false;
  for (const b of gp.buttons) {
    if (b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5))) return true;
  }
  for (const a of gp.axes) {
    if (Math.abs(a) > axisThreshold) return true;
  }
  return false;
}

// ── HidEntry ──
//
// One per paired WebHID device. Lives in ControllerManager._hidPool
// when unclaimed; moves into Slot._hidEntry at claim time. Owns the
// device handle, driver instance, per-device sensor fusion, synthetic
// Gamepad, and the inputreport listener.
//
// Reports update the entry's synthetic + fusion unconditionally. When
// the entry is attached to a slot, it also calls slot._emit('hid-report',
// parsed) so views can forward touchpad / other report-level data.

class HidEntry {
  constructor(device, driver) {
    this.device = device;
    this.driver = driver;
    this.fusion = new SensorFusion();
    this.fusion.startCalibration();
    this.synthetic = makeSyntheticGamepad(device);
    this.hasButtons = false;
    this.hidActiveSince = 0;
    this.slot = null; // set by ControllerManager when claimed
    this._handler = (ev) => this._onReport(ev);
    device.addEventListener('inputreport', this._handler);
  }

  _onReport(ev) {
    if (!this.driver) return;
    const parsed = this.driver.parseReport(ev.reportId, ev.data);
    if (!parsed) return;
    if (parsed.buttons) this.hasButtons = true;
    applyParsedToSynthetic(this.synthetic, parsed);
    this.hidActiveSince = performance.now();
    if (parsed.gyro) {
      const a = parsed.accel;
      this.fusion.ingest(
        parsed.gyro.x, parsed.gyro.y, parsed.gyro.z,
        a ? a.x : null, a ? a.y : null, a ? a.z : null,
        parsed.gyroScale || (2000 / 32768),
        parsed.accelScale || (1 / 8192),
        performance.now(),
      );
    }
    if (this.slot) this.slot._emit('hid-report', parsed);
  }

  destroy() {
    try { this.device.removeEventListener('inputreport', this._handler); } catch {}
    this._handler = null;
    this.slot = null;
  }
}

// ── Slot ──

/**
 * Per-player slot. Headless — no DOM references. View layer subscribes
 * via `slot.on(fn)` and inspects state directly.
 *
 * The slot's HID-backed state (driver, fusion, synthetic, hidDevice) is
 * proxied from an attached HidEntry. When no entry is attached, these
 * getters return null/default.
 */
export class Slot {
  constructor(id, opts) {
    this.id = id;
    this.state = 'empty';

    this.gamepadIndex = null;
    this.controllerId = null;
    this.controllerType = null;
    this.controllerLabel = null;

    this._hidEntry = null;

    this.psHoldStart = 0;
    this.ringPct = 0;
    this._awaitingSilence = false;

    this._listeners = [];
    this._opts = opts || DEFAULTS;

    this._wasCalibrating = false;
  }

  // ── HID passthrough getters ──
  get hidDevice()       { return this._hidEntry?.device || null; }
  get driver()          { return this._hidEntry?.driver || null; }
  get fusion()          { return this._hidEntry?.fusion || null; }
  get synthetic()       { return this._hidEntry?.synthetic || null; }
  get hidActiveSince()  { return this._hidEntry?.hidActiveSince || 0; }
  get _synthHasButtons() { return this._hidEntry?.hasButtons || false; }

  on(fn) {
    this._listeners.push(fn);
    return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
  }

  _emit(reason, data) {
    for (const fn of this._listeners) {
      try { fn(this, reason, data); } catch (err) { console.error('slot listener threw', err); }
    }
  }

  claim(gamepad, { controllerTypeHint, silent = false } = {}) {
    this.state = 'claimed';
    this.gamepadIndex = gamepad.index >= 0 ? gamepad.index : null;
    this.controllerId = stableIdFor(gamepad);
    this.controllerLabel = gamepad.id;
    if (controllerTypeHint) this.controllerType = controllerTypeHint;
    // Manager uses silent=true so it can attach a matching pool entry
    // before the 'claimed' event fires — listeners then see a slot that
    // already has its HID binding, fusion, and synthetic ready.
    if (!silent) this._emit('claimed');
  }

  release() {
    this.state = 'empty';
    this.gamepadIndex = null;
    this.controllerId = null;
    this.controllerLabel = null;
    this.psHoldStart = 0;
    this.ringPct = 0;
    // Note: we do NOT clear the attached HidEntry here — the manager
    // does that at release time so the entry can return to the pool
    // cleanly. We also don't reset the synthetic buttons (manager will
    // handle via pool-side reset in the unbind path).
    this._awaitingSilence = true;
    this._emit('released');
  }

  orphan() {
    if (this.state !== 'claimed') return;
    this.state = 'orphan';
    this.gamepadIndex = null;
    this._emit('orphaned');
  }

  startGyroCalibration() {
    if (!this.fusion) return;
    this.fusion.startCalibration();
    this._wasCalibrating = true;
    this._emit('calibration-start');
  }

  /**
   * Choose the input source each frame: prefer the HID-backed synthetic
   * when bound and the driver emits buttons (BT DualSense case); fall
   * back to Gamepad API for driver-skinny devices (Switch Pro) or when
   * HID reports have gone stale.
   */
  effectiveGamepad(pads) {
    const realGp = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    const entry = this._hidEntry;
    if (entry && entry.hidActiveSince > 0 && entry.hasButtons) {
      const staleFor = performance.now() - entry.hidActiveSince;
      if (staleFor > this._opts.hidStaleMs) {
        resetSynthetic(entry.synthetic);
        entry.hidActiveSince = 0;
        return realGp;
      }
      return entry.synthetic;
    }
    return realGp;
  }

  _advanceReleaseRing(now, psPressed) {
    if (this.state !== 'claimed') {
      if (this.ringPct !== 0) { this.ringPct = 0; this._emit('ring'); }
      return false;
    }
    if (!psPressed) {
      if (this.psHoldStart !== 0 || this.ringPct !== 0) {
        this.psHoldStart = 0;
        this.ringPct = 0;
        this._emit('ring');
      }
      return false;
    }
    if (this.psHoldStart === 0) this.psHoldStart = now;
    const held = now - this.psHoldStart;
    const pct = Math.min(100, (held / this._opts.releaseHoldMs) * 100);
    if (pct !== this.ringPct) { this.ringPct = pct; this._emit('ring'); }
    return held >= this._opts.releaseHoldMs;
  }
}

// ── Controller Manager ──

export class ControllerManager {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    const slotIds = options.slotIds || ['P1', 'P2'];
    this.slots = slotIds.map((id) => new Slot(id, this.opts));
    this._slotById = Object.fromEntries(this.slots.map((s) => [s.id, s]));
    this._hidPool = new Map(); // HIDDevice -> HidEntry
    this._recentlyReleasedByIndex = new Map();
    this._recentlyReleasedBySlot = new Map();
    this._hidConnectHandler = null;
    this._hidDisconnectHandler = null;
  }

  getSlot(id) { return this._slotById[id] || null; }

  _isDeviceInPoolOrSlot(device) {
    if (this._hidPool.has(device)) return true;
    return this.slots.some((s) => s.hidDevice === device);
  }

  _psPressed(gp) {
    if (!gp) return false;
    const b = gp.buttons[this.opts.psButtonIndex];
    return !!(b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5)));
  }

  /** Create a HidEntry for `device` and add it to the pool. */
  async poolDevice(device) {
    if (this._isDeviceInPoolOrSlot(device)) return this._hidPool.get(device) || null;
    try {
      const driver = await ControllerRegistry.connect(device);
      const entry = new HidEntry(device, driver);
      this._hidPool.set(device, entry);
      return entry;
    } catch (err) {
      console.error('poolDevice failed', err);
      return null;
    }
  }

  /** Remove a device from the pool and destroy its entry (e.g. on disconnect). */
  _evictFromPool(device) {
    const entry = this._hidPool.get(device);
    if (entry) {
      this._hidPool.delete(device);
      entry.destroy();
    }
  }

  /** Attach a pool entry to a slot (called during claim / reconcile). */
  _attachEntryToSlot(slot, entry) {
    if (slot._hidEntry === entry) return;
    if (slot._hidEntry) this._detachEntryFromSlot(slot);
    this._hidPool.delete(entry.device);
    slot._hidEntry = entry;
    entry.slot = slot;
    slot._emit('hid-bound');
  }

  /** Detach the slot's entry back to the pool. */
  _detachEntryFromSlot(slot) {
    const entry = slot._hidEntry;
    if (!entry) return;
    entry.slot = null;
    slot._hidEntry = null;
    // Reset synthetic so a stale "PS pressed" doesn't bleed into the
    // pool's activity detection after release.
    resetSynthetic(entry.synthetic);
    entry.hidActiveSince = 0;
    this._hidPool.set(entry.device, entry);
    slot._emit('hid-unbound');
  }

  /**
   * Match vid:pid to a pool entry. Used by reconciliation + HID claim.
   */
  _findPoolEntryByVidPid(vendorId, productId) {
    for (const entry of this._hidPool.values()) {
      if (entry.device.vendorId === vendorId && entry.device.productId === productId) return entry;
    }
    return null;
  }

  ingestFrame(pads, now) {
    const claimedThisFrame = [];
    const releasedThisFrame = [];

    // Orphan check (Gamepad-API-backed claims only)
    for (const s of this.slots) {
      if (s.state !== 'claimed') continue;
      if (s.gamepadIndex == null) continue;
      const gp = pads[s.gamepadIndex];
      if (!gp && !s._hidEntry) s.orphan();
    }

    // Clear awaiting-silence flag once seen idle.
    for (const s of this.slots) {
      if (!s._awaitingSilence) continue;
      const gp = s.gamepadIndex != null ? pads[s.gamepadIndex] : null;
      const gpActive = gamepadHasActivity(gp);
      const synthActive = s._hidEntry && gamepadHasActivity(s._hidEntry.synthetic);
      if (!gpActive && !synthActive) s._awaitingSilence = false;
    }

    // Claim via Gamepad API activity.
    const claimedIndices = new Set(
      this.slots.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex)
    );
    for (const gp of pads) {
      if (!gp) continue;
      if (claimedIndices.has(gp.index)) continue;
      const releasedAt = this._recentlyReleasedByIndex.get(gp.index);
      if (releasedAt != null && (now - releasedAt) < this.opts.reclaimCooldownMs) continue;
      if (!gamepadHasActivity(gp)) continue;
      const empty = this.slots.find((s) => s.state === 'empty' && !s._awaitingSilence);
      if (!empty) break;
      const info = ControllerRegistry.identifyFromGamepadId(gp.id);
      empty.claim(gp, {
        controllerTypeHint: info?.driverName?.toLowerCase().replace(' ', '-') || null,
        silent: true,
      });
      claimedThisFrame.push(empty.id);
      claimedIndices.add(gp.index);
      // Attach matching pool entry BEFORE emitting 'claimed' so listeners
      // see a slot with its HID binding, fusion, and synthetic already
      // hooked up. Without this defer, a lobby subscriber asking "does
      // this slot have gyro?" at claim time would always see false and
      // skip arming the motion toggle.
      this._attachMatchingPoolEntry(empty);
      empty._emit('claimed');
    }

    // Claim via WebHID synthetic activity (covers BT-silent DualSense):
    // iterate the HID pool, not slots. Any pool entry showing activity
    // promotes into an empty slot.
    for (const entry of this._hidPool.values()) {
      if (!gamepadHasActivity(entry.synthetic)) continue;
      const empty = this.slots.find((s) => s.state === 'empty' && !s._awaitingSilence);
      if (!empty) break;
      const releasedAt = this._recentlyReleasedBySlot.get(empty.id);
      if (releasedAt != null && (now - releasedAt) < this.opts.reclaimCooldownMs) continue;
      // Build a gamepad-shaped claim payload from the HID device's label.
      const pseudoPad = {
        index: -1,
        id: `HID::${entry.device.productName || ''} Vendor: ${entry.device.vendorId.toString(16)} Product: ${entry.device.productId.toString(16)}`,
        mapping: 'standard',
      };
      const info = ControllerRegistry.identifyFromGamepadId(pseudoPad.id);
      empty.claim(pseudoPad, {
        controllerTypeHint: info?.driverName?.toLowerCase().replace(' ', '-') || null,
        silent: true,
      });
      this._attachEntryToSlot(empty, entry);
      empty._emit('claimed');
      claimedThisFrame.push(empty.id);
    }

    // Release gesture.
    for (const s of this.slots) {
      const gp = s.effectiveGamepad(pads);
      const ps = this._psPressed(gp);
      if (s._advanceReleaseRing(now, ps)) {
        const freedIndex = s.gamepadIndex;
        if (s._hidEntry) this._detachEntryFromSlot(s);
        s.release();
        if (freedIndex != null) this._recentlyReleasedByIndex.set(freedIndex, now);
        this._recentlyReleasedBySlot.set(s.id, now);
        releasedThisFrame.push(s.id);
      }
    }

    return { claimed: claimedThisFrame, released: releasedThisFrame };
  }

  /**
   * On Gamepad API claim, pull a matching HID entry from the pool into
   * this slot. Matches by vid:pid parsed from gamepad.id.
   */
  _attachMatchingPoolEntry(slot) {
    if (slot._hidEntry) return;
    const vp = ControllerRegistry.parseGamepadVendorProduct(slot.controllerLabel);
    if (!vp) return;
    const entry = this._findPoolEntryByVidPid(vp.vendorId, vp.productId);
    if (entry) this._attachEntryToSlot(slot, entry);
  }

  /**
   * Pool approved HID devices at boot (no user gesture required).
   * Only pools devices whose vid:pid has a live Gamepad API counterpart,
   * so stale pairings from prior sessions don't get initialized.
   */
  async autoPoolApprovedHid() {
    if (!navigator.hid) return;
    try {
      const approved = await navigator.hid.getDevices();
      const known = approved.filter((d) => ControllerRegistry.isKnownDevice(d));
      const liveVidPids = new Set();
      const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
      for (const gp of pads) {
        if (!gp) continue;
        const vp = ControllerRegistry.parseGamepadVendorProduct(gp.id);
        if (vp) liveVidPids.add(`${vp.vendorId}:${vp.productId}`);
      }
      for (const d of known) {
        if (this._isDeviceInPoolOrSlot(d)) continue;
        const key = `${d.vendorId}:${d.productId}`;
        if (liveVidPids.size > 0 && !liveVidPids.has(key)) {
          console.log(`[manager] skipping stale HID pairing ${key} (not live in Gamepad API)`);
          continue;
        }
        await this.poolDevice(d);
      }
    } catch (err) {
      console.warn('autoPoolApprovedHid failed', err);
    }
  }

  /**
   * Electron-only: requestDevice auto-approved by main.js handler, so we
   * can call it at boot to pool controllers that haven't been approved yet.
   */
  async electronAutoRequestDevice() {
    if (!navigator.hid) return;
    const filters = ControllerRegistry.getHIDFilters();
    await new Promise((r) => setTimeout(r, 400));
    // Call once per slot count so we cover the typical 2-controller case
    // without looping forever on a single-controller setup.
    for (let i = 0; i < this.slots.length; i++) {
      try {
        const picked = await navigator.hid.requestDevice({ filters });
        const d = (picked || []).find((dev) => !this._isDeviceInPoolOrSlot(dev));
        if (!d) break;
        await this.poolDevice(d);
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        console.log('electronAutoRequestDevice stopped:', err.message);
        break;
      }
    }
  }

  /**
   * User-gesture HID pairing, initiated from a Connect button. If a slot
   * is specified and is currently claimed, attach the newly-paired device
   * to that slot. Otherwise pool it and let ingestFrame assign on claim.
   */
  async connectHidForSlot(slotId) {
    if (!navigator.hid) throw new Error('WebHID not available');
    const slot = slotId ? this.getSlot(slotId) : null;
    const approved = await navigator.hid.getDevices();
    const candidate = approved.find((d) =>
      ControllerRegistry.isKnownDevice(d) && !this._isDeviceInPoolOrSlot(d)
    );
    let device = candidate;
    if (!device) {
      const filters = ControllerRegistry.getHIDFilters();
      const picked = await navigator.hid.requestDevice({ filters });
      device = (picked || []).find((d) => !this._isDeviceInPoolOrSlot(d));
    }
    if (!device) return null;
    const entry = await this.poolDevice(device);
    // If the calling slot is currently claimed, attach immediately.
    if (entry && slot && slot.state === 'claimed' && !slot._hidEntry) {
      const vp = ControllerRegistry.parseGamepadVendorProduct(slot.controllerLabel);
      if (!vp || (vp.vendorId === device.vendorId && vp.productId === device.productId)) {
        this._attachEntryToSlot(slot, entry);
      }
    }
    return device;
  }

  wireHidHotplug() {
    if (!navigator.hid) return;
    this._hidConnectHandler = async (ev) => {
      if (!ControllerRegistry.isKnownDevice(ev.device)) return;
      if (this._isDeviceInPoolOrSlot(ev.device)) return;
      await this.poolDevice(ev.device);
    };
    this._hidDisconnectHandler = (ev) => {
      // If the device is currently bound to a slot, detach and remove.
      const slot = this.slots.find((s) => s.hidDevice === ev.device);
      if (slot) {
        this._detachEntryFromSlot(slot);
      }
      this._evictFromPool(ev.device);
    };
    navigator.hid.addEventListener('connect', this._hidConnectHandler);
    navigator.hid.addEventListener('disconnect', this._hidDisconnectHandler);
  }

  unwireHidHotplug() {
    if (!navigator.hid) return;
    if (this._hidConnectHandler) navigator.hid.removeEventListener('connect', this._hidConnectHandler);
    if (this._hidDisconnectHandler) navigator.hid.removeEventListener('disconnect', this._hidDisconnectHandler);
    this._hidConnectHandler = null;
    this._hidDisconnectHandler = null;
  }
}
