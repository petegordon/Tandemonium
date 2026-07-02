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

import { ControllerRegistry } from './drivers/controller-registry.js';
// NOTE: SensorFusion (and its `three` dependency) is loaded lazily in
// poolDevice — the only place a real fusion is constructed — so importing
// this module for its slot/claim/reconnect logic doesn't drag in `three`.
// That keeps the headless manager tests dependency-free (CI runs them with
// no `npm install`) and matches core's package.json, which doesn't declare
// `three` directly.

const DEFAULTS = {
  releaseHoldMs: 2000,
  reclaimCooldownMs: 1500,
  psButtonIndex: 16,
  hidStaleMs: 800,
  axisActivityThreshold: 0.6,
  // Per-player DualSense lightbar colors (1-indexed by slot ordinal).
  // Override via `new ControllerManager({ playerColors: { 1: {...}, ... } })`.
  playerColors: {
    1: { r: 0,   g: 64,  b: 255 },  // P1 blue
    2: { r: 255, g: 32,  b: 0 },    // P2 red
    3: { r: 0,   g: 200, b: 0 },    // P3 green
    4: { r: 160, g: 0,   b: 255 },  // P4 purple
  },
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

/**
 * Stricter activity check for claim-time only: button presses count
 * unconditionally, but axes have to *move* between frames (not just be
 * pinned at a non-center value). Chrome persists BT-reconnect ghost
 * pads with stuck stick axes that gamepadHasActivity would falsely
 * treat as active input; this check needs prevAxes from the last frame
 * to distinguish. Call with the output of `prevAxesByIndex.get(gp.index)`.
 */
export function gamepadHasFreshActivity(gp, prevAxes, axisThreshold = DEFAULTS.axisActivityThreshold) {
  if (!gp) return false;
  // Buttons: any press is fresh activity.
  for (const b of gp.buttons) {
    if (b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5))) return true;
  }
  // Axes: require motion (delta > 0.1) vs last-frame values. If we have
  // no prev data yet, axes must be near center (<= threshold) to count —
  // otherwise they're probably a stuck ghost we've never seen move.
  if (!prevAxes) {
    for (const a of gp.axes) {
      if (Math.abs(a) > axisThreshold) return false; // suspect ghost
    }
    return false; // no motion, no buttons, nothing fresh
  }
  for (let i = 0; i < gp.axes.length; i++) {
    const prev = prevAxes[i] != null ? prevAxes[i] : 0;
    if (Math.abs(gp.axes[i] - prev) > 0.1) return true;
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

// Stuck-IMU self-heal thresholds (#198 — BT controller transient where
// IMU goes silent without dropping the inputreport stream). Real IMU
// data is never all-zero across six axes — noise alone produces small
// non-zero values — so all six reading exactly 0 for IMU_ZERO_TIMEOUT_MS+
// is unambiguously a stuck-IMU signal. Without this self-heal, a stuck
// IMU freezes orientation at its last value and the bike pulls hard to
// whatever direction was being held.
const IMU_ZERO_TIMEOUT_MS = 500;
const MAX_IMU_REINIT = 2;

class HidEntry {
  constructor(device, driver, fusion) {
    this.device = device;
    this.driver = driver;
    this.fusion = fusion;
    this.fusion.startCalibration(driver?.connectionType);
    this.synthetic = makeSyntheticGamepad(device);
    this.hasButtons = false;
    this.hidActiveSince = 0;
    this.slot = null; // set by ControllerManager when claimed
    this._handler = (ev) => this._onReport(ev);
    device.addEventListener('inputreport', this._handler);
    // Stuck-IMU self-heal state.
    this._imuZeroSince = 0;
    this._imuReinitAttempts = 0;
    this._imuReinitInFlight = false;
    // One-time accel magnitude sanity check (diagnostic log only). Confirms
    // the driver is parsing accel bytes at the expected scale (~1g at rest)
    // — if a new driver's parseReport is wrong, mag would be off by 10×+
    // and gravity correction would be garbage. Logged once per entry.
    this._accelVerified = false;
    // Snapshot of buttons reported as pressed on the first report. Used
    // to gate pool-to-slot auto-claim: a "fresh press" is a button that
    // wasn't stuck-pressed from the start. Some drivers mis-parse foreign
    // HID layouts (e.g. DualSense driver reading a GameSir-as-DS4 report)
    // and report phantom stuck buttons that would otherwise auto-claim a
    // slot with no user input.
    this._initialPressedMask = null;
  }

  /** True if any button not in the initial-stuck set is currently pressed. */
  hasFreshButtonPress() {
    if (!this.synthetic) return false;
    const buttons = this.synthetic.buttons;
    if (this._initialPressedMask == null) {
      // Snapshot on first query — by now the first HID report has landed.
      if (!this.hasButtons) return false;
      this._initialPressedMask = new Set();
      for (let i = 0; i < buttons.length; i++) {
        if (buttons[i] && buttons[i].pressed) this._initialPressedMask.add(i);
      }
      return false; // first frame never counts as fresh
    }
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (!b) continue;
      const pressed = b.pressed || (typeof b.value === 'number' && b.value > 0.5);
      if (pressed && !this._initialPressedMask.has(i)) return true;
    }
    return false;
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
      const rawGx = parsed.gyro.x, rawGy = parsed.gyro.y, rawGz = parsed.gyro.z;
      const rawAx = a ? a.x : 0, rawAy = a ? a.y : 0, rawAz = a ? a.z : 0;
      this._checkStuckImu(rawGx, rawGy, rawGz, rawAx, rawAy, rawAz);
      if (!this._accelVerified && a) {
        const mag = Math.sqrt(rawAx * rawAx + rawAy * rawAy + rawAz * rawAz);
        const expectedG = parsed.accelScale ? (1.0 / parsed.accelScale) : 8192;
        if (mag > expectedG * 0.4 && mag < expectedG * 2.0) {
          this._accelVerified = true;
          console.log(`Accel verified (${this.driver.entry?.name || '?'}): mag=${mag.toFixed(0)} expected ~${expectedG.toFixed(0)}`);
        }
      }
      this.fusion.ingest(
        rawGx, rawGy, rawGz,
        a ? rawAx : null, a ? rawAy : null, a ? rawAz : null,
        parsed.gyroScale || (2000 / 32768),
        parsed.accelScale || (1 / 8192),
        performance.now(),
      );
    }
    if (this.slot) this.slot._emit('hid-report', parsed);
  }

  _checkStuckImu(gx, gy, gz, ax, ay, az) {
    const now = performance.now();
    const allZero = gx === 0 && gy === 0 && gz === 0 && ax === 0 && ay === 0 && az === 0;
    if (allZero) {
      if (this._imuZeroSince === 0) this._imuZeroSince = now;
      if (!this._imuReinitInFlight &&
          (now - this._imuZeroSince) >= IMU_ZERO_TIMEOUT_MS &&
          this._imuReinitAttempts < MAX_IMU_REINIT) {
        this._imuReinitAttempts++;
        this._imuZeroSince = 0;
        this._imuReinitInFlight = true;
        console.warn(`IMU stuck at zero for ${IMU_ZERO_TIMEOUT_MS}ms — re-running driver init (${this._imuReinitAttempts}/${MAX_IMU_REINIT})`);
        this._reinitDriver();
      }
    } else if (this._imuZeroSince !== 0) {
      this._imuZeroSince = 0;
    }
  }

  async _reinitDriver() {
    if (!this.driver || typeof this.driver.init !== 'function') {
      this._imuReinitInFlight = false;
      return;
    }
    try {
      await this.driver.init();
      this.fusion.startCalibration(this.driver?.connectionType);
    } catch (err) {
      console.warn('Driver re-init failed:', err.message);
    } finally {
      this._imuReinitInFlight = false;
    }
  }

  destroy() {
    try { this.device.removeEventListener('inputreport', this._handler); } catch {}
    // Let the driver tear down its own timers/listeners (PlayStation BT
    // background re-activation, Steam lizard-mode heartbeat) so they don't
    // keep running against a disconnected device.
    try { this.driver?.destroy?.(); } catch {}
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
    this.fusion.startCalibration(this.driver?.connectionType);
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
    // Prev-frame axes per gamepad index — lets ingestFrame's claim path
    // require axis motion (not just pinned position) to treat a pad as
    // active. Counters Chrome BT-reconnect ghost pads with stuck axes.
    this._prevAxesByIndex = new Map();
    this._hidConnectHandler = null;
    this._hidDisconnectHandler = null;
    // When true, ingestFrame skips BOTH activity-claim paths (Gamepad API
    // and HID pool) — report ingestion, orphan recovery, reconciliation,
    // and the release gesture keep running. The versus join screen sets
    // this so IT is the sole claimer: without it, a joiner's first button
    // press would auto-claim the first empty slot (P1!) and hijack a
    // keyboard-driven P1 InputManager. Cleared when the screen closes.
    this.autoClaimSuspended = false;
  }

  getSlot(id) { return this._slotById[id] || null; }

  /**
   * Claim a specific slot to the first live Gamepad API pad that isn't
   * already claimed by another slot. Used by callers that need P1 to be
   * bound to "whatever pad is plugged in" *before* the user presses any
   * button — e.g. the lobby's local-MP detection, which needs to know
   * which pad is P1's so it can label the other one as P2.
   *
   * Returns the claimed pad or null if nothing changed.
   */
  claimFirstAvailable(slotId, pads) {
    const slot = this.getSlot(slotId);
    if (!slot || slot.state !== 'empty' || slot._awaitingSilence) return null;
    const claimedIndices = new Set(
      this.slots.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex)
    );
    // Boot-claim is a convenience for "controller plugged in before page
    // loaded" — we don't want the user forced to press a button to start
    // nav. BUT Chrome persists ghost slots from past BT reconnects that
    // are indistinguishable from live pads with centered sticks. Without
    // a button press or stick motion we can't tell them apart.
    //
    // Heuristics:
    //  - Skip pads with stuck stick axes (>0.5 at rest — definitely ghost)
    //  - If exactly one clean candidate remains, claim it. That's the
    //    single-controller-plugged-in case.
    //  - If multiple clean candidates remain, DEFER. Activity-based claim
    //    in ingestFrame handles the multi-pad case via button press.
    const candidates = [];
    for (const gp of pads) {
      if (!gp) continue;
      if (claimedIndices.has(gp.index)) continue;
      const stickMag = Math.max(
        Math.abs(gp.axes[0] || 0),
        Math.abs(gp.axes[1] || 0),
        Math.abs(gp.axes[2] || 0),
        Math.abs(gp.axes[3] || 0),
      );
      if (stickMag > 0.5) continue; // definitely ghost
      candidates.push(gp);
    }
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      console.log(`[manager] deferring boot-claim: ${candidates.length} candidate pads — waiting for user input to disambiguate`);
      return null;
    }
    const gp = candidates[0];
    const info = ControllerRegistry.identifyFromGamepadId(gp.id);
    slot.claim(gp, {
      controllerTypeHint: info?.controllerProfile || info?.protocol || null,
      silent: true,
    });
    this._attachMatchingPoolEntry(slot);
    slot._emit('claimed');
    return gp;
  }

  /**
   * Claim a specific WebHID device to a specific slot — the explicit-join
   * twin of claimPadForSlot for pads the Gamepad API can't see (BT
   * DualSense in 0x31 full-report mode). If a slot already holds this
   * device, that slot is returned as-is (adopt). Otherwise the device's
   * pool entry is promoted with the same pseudo-pad shape ingestFrame's
   * HID claim path uses. Returns the claimed slot, or null.
   */
  claimHidDeviceForSlot(slotId, device) {
    if (!device) return null;
    const holder = this.slots.find((s) => s.hidDevice === device);
    if (holder) return holder;
    const slot = this.getSlot(slotId);
    if (!slot || slot.state !== 'empty') return null;
    const entry = this._hidPool.get(device);
    if (!entry) return null;
    const pseudoPad = {
      index: -1,
      id: `HID::${device.productName || ''} Vendor: ${device.vendorId.toString(16)} Product: ${device.productId.toString(16)}`,
      mapping: 'standard',
    };
    const info = ControllerRegistry.identifyFromGamepadId(pseudoPad.id);
    slot.claim(pseudoPad, {
      controllerTypeHint: info?.controllerProfile || info?.protocol || null,
      silent: true,
    });
    this._attachEntryToSlot(slot, entry);
    slot._emit('claimed');
    return slot;
  }

  /**
   * Release a slot and return its HID entry (if any) to the pool so an
   * explicit claim can move the device to a different slot. Unlike the
   * release GESTURE this does not stamp the reclaim cooldown for the pad —
   * the caller is about to re-claim it deliberately.
   */
  releaseSlotToPool(slotId) {
    const slot = this.getSlot(slotId);
    if (!slot || slot.state === 'empty') return false;
    if (slot._hidEntry) this._detachEntryFromSlot(slot);
    slot.release();
    // Clear the awaiting-silence latch: this is a programmatic move, not a
    // user release gesture — the device should be immediately re-claimable.
    slot._awaitingSilence = false;
    return true;
  }

  /**
   * Claim a specific Gamepad API pad to a specific slot. Used by the versus
   * join screen, where the pad that pressed A is known exactly — no
   * disambiguation heuristics needed. No-ops if the slot isn't empty or the
   * pad is already claimed by another slot (returns null in both cases).
   */
  claimPadForSlot(slotId, gp) {
    const slot = this.getSlot(slotId);
    if (!slot || slot.state !== 'empty' || !gp) return null;
    const alreadyClaimed = this.slots.some((s) => s.gamepadIndex === gp.index && s !== slot);
    if (alreadyClaimed) return null;
    const info = ControllerRegistry.identifyFromGamepadId(gp.id);
    slot.claim(gp, {
      controllerTypeHint: info?.controllerProfile || info?.protocol || null,
      silent: true,
    });
    this._attachMatchingPoolEntry(slot);
    slot._emit('claimed');
    return gp;
  }

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
      // Lazy-load SensorFusion (pulls in `three`) only here, where a real
      // fusion is actually needed — see the import note at the top.
      const { SensorFusion } = await import('./sensor-fusion.js');
      const entry = new HidEntry(device, driver, new SensorFusion());
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
    this._applyPlayerFeedback(slot, entry);
    slot._emit('hid-bound');
  }

  /** Detach the slot's entry back to the pool. */
  _detachEntryFromSlot(slot) {
    const entry = slot._hidEntry;
    if (!entry) return;
    this._clearPlayerFeedback(entry);
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
   * Light up the DualSense player-LED row + lightbar to reflect the slot
   * ordinal. P1 = blue, P2 = red (per #222 design). Silently no-ops for
   * drivers that don't implement setPlayerLEDs / setLightbar.
   */
  _applyPlayerFeedback(slot, entry) {
    const driver = entry.driver;
    if (!driver) return;
    const playerNum = this.slots.indexOf(slot) + 1;
    const color = this.opts.playerColors?.[playerNum] || null;
    const pattern = driver.constructor.PLAYER_LED_PATTERNS?.[playerNum];
    // Prefer combined setPlayerFeedback (single output report = more
    // reliable over BT). Fall back to individual setters if the driver
    // only has those.
    if (typeof driver.setPlayerFeedback === 'function') {
      driver.setPlayerFeedback({
        playerLEDs: pattern != null ? pattern : undefined,
        lightbar: color || undefined,
      }).catch(() => {});
    } else {
      if (typeof driver.setPlayerLEDs === 'function' && pattern != null) {
        driver.setPlayerLEDs(pattern).catch(() => {});
      }
      if (color && typeof driver.setLightbar === 'function') {
        driver.setLightbar(color.r, color.g, color.b).catch(() => {});
      }
    }
  }

  _clearPlayerFeedback(entry) {
    const driver = entry.driver;
    if (!driver) return;
    if (typeof driver.setPlayerFeedback === 'function') {
      driver.setPlayerFeedback({ playerLEDs: 0, lightbar: { r: 0, g: 0, b: 0 } }).catch(() => {});
    } else {
      if (typeof driver.setPlayerLEDs === 'function') driver.setPlayerLEDs(0).catch(() => {});
      if (typeof driver.setLightbar === 'function') driver.setLightbar(0, 0, 0).catch(() => {});
    }
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

  /**
   * Find an already-claimed slot that this pool entry belongs to but isn't
   * yet bound to — matched by the slot's gamepad vid:pid OR by productName
   * substring (covers multi-interface pads like GameSir Super Nova where
   * the Gamepad API and WebHID report different vid:pid for one physical
   * device). Returns the slot or null. Binding-only: never creates a slot.
   */
  _findClaimedUnboundSlotForEntry(entry) {
    return this.slots.find((s) =>
      s.state === 'claimed' && !s._hidEntry && this._entryMatchesSlot(entry, s)
    ) || null;
  }

  /**
   * Does this pool entry belong to `slot`'s controller? Matched by the
   * slot's gamepad vid:pid OR by productName substring (covers multi-
   * interface pads like GameSir Super Nova where the Gamepad API and
   * WebHID report different vid:pid for one physical device). Works for
   * orphaned slots too — orphan() keeps controllerLabel.
   */
  _entryMatchesSlot(entry, slot) {
    const vp = ControllerRegistry.parseGamepadVendorProduct(slot.controllerLabel);
    if (vp && vp.vendorId === entry.device.vendorId && vp.productId === entry.device.productId) return true;
    const name = (entry.device.productName || '').trim().toLowerCase();
    if (name && slot.controllerLabel && slot.controllerLabel.toLowerCase().includes(name)) return true;
    return false;
  }

  /**
   * A live Gamepad-API pad whose stable id matches `slot`'s remembered
   * controller and that no OTHER slot already owns. Used for sticky
   * reconnect (an orphaned slot recovering the SAME physical controller,
   * keeping its player number).
   */
  _findReturningPadForSlot(slot, pads) {
    if (!slot.controllerId) return null;
    return pads.find((p) =>
      p && stableIdFor(p) === slot.controllerId &&
      !this.slots.some((o) => o !== slot && o.gamepadIndex === p.index)
    ) || null;
  }

  ingestFrame(pads, now) {
    const claimedThisFrame = [];
    const releasedThisFrame = [];

    // Orphan check (Gamepad-API-backed claims only)
    // Note: _prevAxesByIndex is updated at the END of the frame so the
    // claim path sees "previous frame" axes vs this-frame's.
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

    // ── Reconnect recovery ──
    // An orphaned slot — its controller dropped, e.g. the GameSir Super
    // Nova docking on its charger — is reclaimed by the SAME controller
    // when it returns, keeping its player number. Without this, orphan was
    // a dead end: nothing ever transitioned a slot out of it, so a re-
    // paired controller recovered neither buttons nor gyro (#30 State 2).
    // Two signals can bring it back; take whichever lands first and the
    // other half wires up afterward:
    //   (1) its Gamepad-API pad re-enumerates (match by stable id), or
    //   (2) its WebHID handle re-pools (match by vid:pid / productName) —
    //       restores gyro immediately; the adopt pass below re-attaches
    //       buttons if/when the Gamepad pad returns.
    for (const s of this.slots) {
      if (s.state !== 'orphan') continue;
      const gp = this._findReturningPadForSlot(s, pads);
      if (gp) {
        s.claim(gp, { controllerTypeHint: s.controllerType, silent: true });
        this._attachMatchingPoolEntry(s);
        s._emit('claimed');
        claimedThisFrame.push(s.id);
        console.log(`[manager] ${s.id}: reconnected — re-claimed orphan via Gamepad API`);
        continue;
      }
      const entry = [...this._hidPool.values()].find((e) => this._entryMatchesSlot(e, s));
      if (entry) {
        const pseudo = { index: -1, id: s.controllerLabel || `HID::${entry.device.productName || ''}`, mapping: 'standard' };
        s.claim(pseudo, { controllerTypeHint: s.controllerType, silent: true });
        this._attachEntryToSlot(s, entry);
        s._emit('claimed');
        claimedThisFrame.push(s.id);
        console.log(`[manager] ${s.id}: reconnected — re-claimed orphan via WebHID (gyro restored, awaiting Gamepad pad)`);
      }
    }

    // Adopt a returning Gamepad pad into a slot that recovered HID-first
    // (gamepadIndex still null) so one physical controller isn't split
    // across two slots. effectiveGamepad picks up the buttons next frame.
    for (const s of this.slots) {
      if (s.state !== 'claimed' || s.gamepadIndex != null) continue;
      const gp = this._findReturningPadForSlot(s, pads);
      if (gp) {
        s.gamepadIndex = gp.index;
        console.log(`[manager] ${s.id}: adopted returning Gamepad pad (buttons restored)`);
      }
    }

    // Claim via Gamepad API activity. Uses gamepadHasFreshActivity
    // (not gamepadHasActivity) so pinned-stick ghost pads don't get
    // claimed — only real button presses or stick motion count.
    // Suspended while an explicit-claim UI (versus join screen) is open.
    const claimedIndices = new Set(
      this.slots.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex)
    );
    for (const gp of this.autoClaimSuspended ? [] : pads) {
      if (!gp) continue;
      if (claimedIndices.has(gp.index)) continue;
      const releasedAt = this._recentlyReleasedByIndex.get(gp.index);
      if (releasedAt != null && (now - releasedAt) < this.opts.reclaimCooldownMs) continue;
      const prevAxes = this._prevAxesByIndex.get(gp.index);
      if (!gamepadHasFreshActivity(gp, prevAxes)) continue;
      const empty = this.slots.find((s) => s.state === 'empty' && !s._awaitingSilence);
      if (!empty) break;
      const info = ControllerRegistry.identifyFromGamepadId(gp.id);
      empty.claim(gp, {
        controllerTypeHint: info?.controllerProfile || info?.protocol || null,
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

    // Reconcile late / reconnected HID entries with already-claimed slots.
    // _attachMatchingPoolEntry only binds at claim time, and the HID-pool
    // claim loop below is gated on a fresh button press — so a device whose
    // WebHID handle arrives (or RE-arrives after a reconnect) AFTER the
    // Gamepad-API claim, and that never emits buttons (IMU-only, e.g.
    // GameSir-as-DS4), would otherwise be left with working buttons but a
    // dead gyro toggle after a reconnect (GameSir Super Nova auto-re-pairs
    // off its charger, so this path gets hit constantly). Binding-only — it
    // never creates a
    // slot — so it's safe to run every frame regardless of button activity.
    // Snapshot the pool values: _attachEntryToSlot mutates the pool map.
    for (const entry of [...this._hidPool.values()]) {
      const slot = this._findClaimedUnboundSlotForEntry(entry);
      if (slot) this._attachEntryToSlot(slot, entry);
    }

    // Claim via WebHID synthetic activity (covers BT-silent DualSense):
    // iterate the HID pool, not slots. Any pool entry showing activity
    // promotes into an empty slot. Suspended alongside the Gamepad path
    // while an explicit-claim UI is open.
    for (const entry of this.autoClaimSuspended ? [] : this._hidPool.values()) {
      // Require a *fresh* button press to claim via HID pool (ignoring
      // buttons that were stuck-pressed from the first HID report).
      // GameSir-as-DS4 gets mis-parsed by the DualSense driver, producing
      // phantom stuck buttons (e.g. button 12) that would otherwise
      // auto-claim a slot with no user input. BT-silent DualSense still
      // claims normally because the user's PS press is a fresh transition.
      if (!entry.hasFreshButtonPress()) continue;
      // Dedupe: if this physical controller is already claimed via the
      // Gamepad API path (same vid:pid), attach the HID entry to that slot
      // for gyro/touchpad rather than spawning a second slot. Fixes pads
      // that expose both Gamepad API and WebHID interfaces (e.g. GameSir
      // Super Nova presenting as DS4 + raw HID). (The reconciliation pass
      // above already covers IMU-only devices; this catches a device that
      // emits buttons AND matches an already-claimed slot.)
      const existing = this._findClaimedUnboundSlotForEntry(entry);
      if (existing) {
        this._attachEntryToSlot(existing, entry);
        continue;
      }
      // Also skip spawning a new slot if any unclaimed live Gamepad API pad
      // shares this HID device's productName — the Gamepad API claim path
      // will pick it up on its own button press, and we don't want to beat
      // it to a second slot. Covers multi-interface pads like GameSir Super
      // Nova where Gamepad API and WebHID report different vid:pid for the
      // same physical device.
      const claimedIdx = new Set(this.slots.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex));
      const hidName = (entry.device.productName || '').trim().toLowerCase();
      if (hidName) {
        const dupeUnclaimed = pads.some((gp) => gp && !claimedIdx.has(gp.index) && gp.id.toLowerCase().includes(hidName));
        if (dupeUnclaimed) continue;
      }
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
        controllerTypeHint: info?.controllerProfile || info?.protocol || null,
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

    // Snapshot axes for next frame's fresh-activity check.
    for (const gp of pads) {
      if (!gp) continue;
      this._prevAxesByIndex.set(gp.index, [...gp.axes]);
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
