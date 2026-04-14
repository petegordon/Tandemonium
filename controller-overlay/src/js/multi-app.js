// ============================================================
// MULTI-APP.JS — Prototype multi-controller overlay
// ============================================================
//
// Runs against src/multi.html. Shows two side-by-side controller
// slots (P1, P2). Claim-based assignment:
//  - First input from an unclaimed gamepad OR WebHID device claims
//    the next empty slot.
//  - Holding PS/Home button for 2s on a claimed slot releases it.
//
// WebHID is the primary input path for gyro-capable devices, and is
// a fallback for BT DualSense which is silent on the Gamepad API
// after its 0x31 full-report mode switch (see #220). When a slot has
// a WebHID device, we build a synthetic Gamepad-shaped object from
// the parsed HID reports so downstream code stays uniform.
// ============================================================

import * as THREE from 'three';
import { ControllerOverlay } from './controller-overlay.js';
import { detectControllerType, PROFILES } from './controller-profiles.js';
import { ControllerRegistry } from '../../../shared/controllers/controller-registry.js';
import { DualSenseDriver } from '../../../shared/controllers/dualsense-driver.js';
import { SensorFusion } from '../../../shared/sensor-fusion.js';

const RELEASE_HOLD_MS = 2000;
const PS_BUTTON_INDEX = 16;
const RECLAIM_COOLDOWN_MS = 1500;
const SLOT_IDS = ['P1', 'P2'];

// gamepad.index -> timestamp it was released at (Gamepad-API-backed claims)
const recentlyReleased = new Map();
// Slot id -> timestamp it was released at (covers HID-synthetic claims)
const slotRecentlyReleased = new Map();

// ── Synthetic gamepad ──
//
// Shape-compatible subset of the Gamepad interface: .buttons[] with
// { pressed, value }, .axes[], .id, .index, .mapping. Enough for
// ControllerOverlay.update() and our gamepadHasActivity() / isPsPressed().
function makeSyntheticGamepad(hidDevice) {
  const buttons = [];
  for (let i = 0; i < 17; i++) buttons.push({ pressed: false, touched: false, value: 0 });
  return {
    id: `DualSense (WebHID)::${hidDevice.productName || 'hid'}`,
    index: -1, // synthetic
    mapping: 'standard',
    connected: true,
    timestamp: 0,
    buttons,
    axes: [0, 0, 0, 0],
    _isSynthetic: true,
  };
}

function resetSynthetic(gp) {
  if (!gp) return;
  for (const b of gp.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
  for (let i = 0; i < gp.axes.length; i++) gp.axes[i] = 0;
  gp.timestamp = 0;
}

function applyParsedToSynthetic(gp, parsed) {
  if (!gp || !parsed) return;
  const setBtn = (i, pressed, value) => {
    gp.buttons[i].pressed = !!pressed;
    gp.buttons[i].touched = !!pressed;
    gp.buttons[i].value = typeof value === 'number' ? value : (pressed ? 1 : 0);
  };
  const b = parsed.buttons;
  if (b) {
    // DualSense-shape button layout. Drivers that don't populate .buttons
    // (e.g. current Switch Pro driver, which only decodes IMU) skip this
    // block — the Gamepad API provides buttons for those.
    setBtn(0, b.cross);
    setBtn(1, b.circle);
    setBtn(2, b.square);
    setBtn(3, b.triangle);
    setBtn(4, b.l1);
    setBtn(5, b.r1);
    setBtn(8, b.create);
    setBtn(9, b.options);
    setBtn(10, b.l3);
    setBtn(11, b.r3);
    setBtn(12, b.dpadUp);
    setBtn(13, b.dpadDown);
    setBtn(14, b.dpadLeft);
    setBtn(15, b.dpadRight);
    setBtn(16, b.ps);
  }
  if (parsed.triggers) {
    setBtn(6, parsed.triggers.l2 > 0.1, parsed.triggers.l2);
    setBtn(7, parsed.triggers.r2 > 0.1, parsed.triggers.r2);
  }
  if (parsed.sticks) {
    gp.axes[0] = parsed.sticks.lx;
    gp.axes[1] = parsed.sticks.ly;
    gp.axes[2] = parsed.sticks.rx;
    gp.axes[3] = parsed.sticks.ry;
  }
  gp.timestamp = performance.now();
}

// ── Slot ──
class Slot {
  constructor(id, root) {
    this.id = id;
    this.root = root;
    this.canvas = root.querySelector('[data-role="canvas"]');
    this.promptEl = root.querySelector('[data-role="prompt"]');
    this.hintEl = root.querySelector('[data-role="hint"]');
    this.subEl = root.querySelector('[data-role="sub"]');
    this.ringEl = root.querySelector('[data-role="ring"]');
    this.connectBtn = root.querySelector('[data-role="connect-hid"]');
    this.calibBtn = root.querySelector('[data-role="calibrate"]');
    this.diagBtn = root.querySelector('[data-role="diag-toggle"]');
    this.diagEl = root.querySelector('[data-role="diag"]');
    this._diagLastUpdate = 0;

    this.overlay = null;
    this.gamepadIndex = null;
    this.controllerId = null;
    this.controllerType = 'dualsense';
    this.state = 'empty';
    this.psHoldStart = 0;

    // WebHID
    this.hidDevice = null;
    this.driver = null;
    this.synthetic = null;
    this.gyro = null;
    this.hidActiveSince = 0;
    this._synthHasButtons = false; // set true once a driver emits parsed.buttons
    this._reportHandler = null;
    // Edge-triggered reclaim guard: after release, the controller must be
    // observed fully idle for at least one frame before it can re-claim
    // this slot. Prevents "hold PS to power off" from cycling release /
    // reclaim while the user is still holding across the cooldown.
    this._awaitingSilence = false;

    root.classList.toggle('p1', id === 'P1');
    root.classList.toggle('p2', id === 'P2');

    this._wasCalibrating = false;

    if (this.connectBtn) this.connectBtn.addEventListener('click', () => this._onConnectClicked());
    if (this.diagBtn) this.diagBtn.addEventListener('click', () => {
      if (!this.diagEl) return;
      const showing = !this.diagEl.hasAttribute('hidden');
      if (showing) this.diagEl.setAttribute('hidden', '');
      else this.diagEl.removeAttribute('hidden');
    });
    if (this.calibBtn) this.calibBtn.addEventListener('click', () => {
      if (this.gyro) {
        this.gyro.startCalibration();
        this.hintEl.textContent = 'Calibrating gyro — hold still…';
        this._wasCalibrating = true;
      }
    });
  }

  async initOverlay(controllerType) {
    this.controllerType = controllerType || 'dualsense';
    this.overlay = new ControllerOverlay({
      canvas: this.canvas,
      transparent: true,
      controllerType: this.controllerType,
    });
    await this.overlay.init();
    this._resize();
  }

  _resize() {
    if (!this.overlay || !this.canvas) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0) this.overlay.resize(w, h);
  }

  claim(gamepad) {
    this.state = 'claimed';
    this.gamepadIndex = gamepad.index >= 0 ? gamepad.index : null;
    this.controllerId = stableIdFor(gamepad);
    this.root.classList.remove('empty');
    this.root.classList.add('claimed');
    this.promptEl.textContent = labelForGamepad(gamepad);
    this.hintEl.textContent = 'Hold PS/Home 2s to release';
    this.subEl.textContent = (this.controllerId || '').slice(0, 28);

    const desired = detectControllerType(gamepad.id) || 'dualsense';
    if (desired !== this.controllerType && this.overlay) {
      this.controllerType = desired;
      this.overlay.setControllerType(desired);
    }
  }

  release() {
    this.state = 'empty';
    this.gamepadIndex = null;
    this.controllerId = null;
    this.psHoldStart = 0;
    this.root.classList.remove('claimed');
    this.root.classList.add('empty');
    this.promptEl.innerHTML = '<span class="pulse">Press any button to join</span>';
    this.hintEl.textContent = '';
    this.subEl.textContent = '';
    this._setRing(0);
    // Clear synthetic state so stale "PS pressed" from the release gesture
    // doesn't immediately retrigger the claim/release loop on next HID report.
    resetSynthetic(this.synthetic);
    this.hidActiveSince = 0;
    // Require the controller to go idle at least once before it can reclaim
    // this slot. Covers "user keeps holding PS past the 2s release ring".
    this._awaitingSilence = true;
    // Keep the WebHID pairing on release — user may re-claim without re-pairing.
  }

  orphan() {
    this.hintEl.textContent = 'Reconnecting…';
    this.root.classList.add('orphan');
    this.gamepadIndex = null;
  }

  async bindHidDevice(device) {
    if (this.hidDevice === device) return;
    await this._unbindHid();
    try {
      const driver = await ControllerRegistry.connect(device);
      this.hidDevice = device;
      this.driver = driver;
      this.synthetic = makeSyntheticGamepad(device);
      this.gyro = new SensorFusion();
      this.gyro.startCalibration();
      this._reportHandler = (ev) => this._onHidReport(ev);
      device.addEventListener('inputreport', this._reportHandler);
      this._updateHidBadge(true);
      console.log(`[${this.id}] HID bound:`, device.productName);
    } catch (err) {
      console.error(`[${this.id}] HID bind failed`, err);
      this.hintEl.textContent = `HID error: ${err.message}`;
    }
  }

  async _unbindHid() {
    if (this._reportHandler && this.hidDevice) {
      try { this.hidDevice.removeEventListener('inputreport', this._reportHandler); } catch {}
    }
    this._reportHandler = null;
    this.hidDevice = null;
    this.driver = null;
    this.synthetic = null;
    this.gyro = null;
    this._updateHidBadge(false);
  }

  _updateHidBadge(on) {
    if (!this.connectBtn) return;
    this.connectBtn.classList.toggle('status', on);
    this.connectBtn.textContent = on ? 'Gyro Connected' : 'Connect Gyro (WebHID)';
    if (this.calibBtn) this.calibBtn.style.display = on ? '' : 'none';
  }

  _onHidReport(ev) {
    if (!this.driver) return;
    const parsed = this.driver.parseReport(ev.reportId, ev.data);
    if (!parsed) return;
    if (parsed.buttons) this._synthHasButtons = true;
    // Feed synthetic gamepad
    applyParsedToSynthetic(this.synthetic, parsed);
    this.hidActiveSince = performance.now();
    // Integrate gyro
    if (parsed.gyro && this.gyro) {
      const accel = parsed.accel;
      this.gyro.ingest(
        parsed.gyro.x, parsed.gyro.y, parsed.gyro.z,
        accel ? accel.x : null, accel ? accel.y : null, accel ? accel.z : null,
        parsed.gyroScale || (2000 / 32768),
        parsed.accelScale || (1 / 8192),
        performance.now(),
      );
    }
    // Touchpad passthrough
    if (parsed.touchpad && this.overlay?.updateTouchpad) {
      this.overlay.updateTouchpad(parsed.touchpad, parsed.touchpadButton);
    }
  }

  async _onConnectClicked() {
    if (!navigator.hid) {
      alert('WebHID not available in this browser');
      return;
    }
    try {
      const claimedDevices = new Set(
        slots.filter((s) => s !== this && s.hidDevice).map((s) => s.hidDevice)
      );
      // Try already-approved devices first (no user gesture required beyond the click).
      const approved = await navigator.hid.getDevices();
      const candidate = approved.find((d) =>
        ControllerRegistry.isKnownDevice(d) && !claimedDevices.has(d)
      );
      if (candidate) {
        await this.bindHidDevice(candidate);
        return;
      }
      const filters = ControllerRegistry.getHIDFilters();
      const picked = await navigator.hid.requestDevice({ filters });
      const d = picked.find((d) => !claimedDevices.has(d));
      if (!d) {
        this.hintEl.textContent = 'No new controller selected';
        return;
      }
      await this.bindHidDevice(d);
    } catch (err) {
      console.error('HID connect error', err);
      this.hintEl.textContent = `HID error: ${err.message}`;
    }
  }

  _setRing(pct) {
    if (!this.ringEl) return;
    if (pct > 0) {
      this.ringEl.classList.add('visible');
      this.ringEl.style.setProperty('--p', String(pct));
    } else {
      this.ringEl.classList.remove('visible');
      this.ringEl.style.setProperty('--p', '0');
    }
  }

  updateReleaseRing(now, psPressed) {
    if (this.state !== 'claimed') { this._setRing(0); return false; }
    if (!psPressed) { this.psHoldStart = 0; this._setRing(0); return false; }
    if (this.psHoldStart === 0) this.psHoldStart = now;
    const held = now - this.psHoldStart;
    const pct = Math.min(100, (held / RELEASE_HOLD_MS) * 100);
    this._setRing(pct);
    return held >= RELEASE_HOLD_MS;
  }

  // The effective input source for this slot each frame.
  //  - If HID is bound and the driver emits buttons (DualSense), prefer the
  //    synthetic gamepad — Gamepad API is silent over BT after 0x31 mode.
  //  - If HID is bound but the driver only emits IMU (Switch Pro & friends),
  //    use the Gamepad API for buttons/sticks. HID still drives gyro.
  //  - If HID reports have stopped for >800ms, treat synthetic as stale
  //    (controller went to sleep / powered off) and reset its state so
  //    frozen "PS pressed" doesn't loop the release gesture forever.
  effectiveGamepad(pads) {
    const realGp = this.gamepadIndex != null ? pads[this.gamepadIndex] : null;
    if (this.synthetic && this.hidActiveSince > 0 && this._synthHasButtons) {
      const staleFor = performance.now() - this.hidActiveSince;
      if (staleFor > 800) {
        resetSynthetic(this.synthetic);
        this.hidActiveSince = 0;
        return realGp;
      }
      return this.synthetic;
    }
    return realGp;
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function hex4(n) {
  return n != null ? '0x' + n.toString(16).padStart(4, '0') : '—';
}

function renderSlotDiagnostics(s, pads) {
  if (!s.diagEl || s.diagEl.hasAttribute('hidden')) return;
  const now = performance.now();
  if (now - s._diagLastUpdate < 160) return; // throttle ~6Hz
  s._diagLastUpdate = now;

  const gp = s.gamepadIndex != null ? pads[s.gamepadIndex] : null;
  const synth = s.synthetic;
  const hid = s.hidDevice;
  const driver = s.driver;
  const gpInfo = gp ? ControllerRegistry.identifyFromGamepadId(gp.id) : null;

  const pressedGp = gp ? [...gp.buttons].map((b, i) => b?.pressed ? i : -1).filter((i) => i >= 0) : [];
  const pressedSynth = synth ? synth.buttons.map((b, i) => b.pressed ? i : -1).filter((i) => i >= 0) : [];
  const axesGp = gp ? [...gp.axes].map((a) => a.toFixed(2)).join(', ') : '';
  const axesSynth = synth ? synth.axes.map((a) => a.toFixed(2)).join(', ') : '';

  const lines = [];
  lines.push(`<span class="k">── Gamepad API ──</span>`);
  if (gp) {
    lines.push(`<span class="k">id       </span> <span class="v">${esc(gp.id)}</span>`);
    lines.push(`<span class="k">mapping  </span> <span class="v">${esc(gp.mapping || '(empty)')}</span>${gp.mapping === 'standard' ? ' <span class="ok">✓</span>' : ' <span class="warn">non-standard</span>'}`);
    lines.push(`<span class="k">index    </span> <span class="v">${gp.index}</span>  <span class="k">buttons</span> <span class="v">${gp.buttons.length}</span>  <span class="k">axes</span> <span class="v">${gp.axes.length}</span>`);
    lines.push(`<span class="k">driver?  </span> ${gpInfo ? `<span class="ok">${esc(gpInfo.driverName)}</span> gyro=${gpInfo.hasGyro} tp=${gpInfo.hasTouchpad}` : '<span class="warn">no match</span>'}`);
    lines.push(`<span class="k">pressed  </span> [<span class="v">${pressedGp.join(',')}</span>]`);
    lines.push(`<span class="k">axes     </span> [<span class="v">${esc(axesGp)}</span>]`);
  } else {
    lines.push(`<span class="warn">no pad at this slot's index (${s.gamepadIndex ?? 'none'})</span>`);
  }

  lines.push('');
  lines.push(`<span class="k">── WebHID ──</span>`);
  if (hid) {
    lines.push(`<span class="k">product  </span> <span class="v">${esc(hid.productName || '(unnamed)')}</span>`);
    lines.push(`<span class="k">vid:pid  </span> <span class="v">${hex4(hid.vendorId)}:${hex4(hid.productId)}</span>`);
    lines.push(`<span class="k">driver   </span> <span class="ok">${esc(driver?.constructor?.driverName || '?')}</span>  <span class="k">conn</span> <span class="v">${esc(driver?.connectionType || '?')}</span>`);
    const caps = driver?.constructor?.capabilities || {};
    lines.push(`<span class="k">caps     </span> gyro=${caps.gyro} accel=${caps.accel} touchpad=${caps.touchpad}`);
    const gyroOk = s.gyro && s.gyro._lastGyroTime > 0 && !s.gyro.calibrating;
    lines.push(`<span class="k">gyro     </span> ${gyroOk ? '<span class="ok">integrating</span>' : (s.gyro?.calibrating ? '<span class="warn">calibrating…</span>' : '<span class="warn">idle</span>')}`);
    lines.push(`<span class="k">synth    </span> pressed=[<span class="v">${pressedSynth.join(',')}</span>] axes=[<span class="v">${esc(axesSynth)}</span>]`);
  } else {
    lines.push(`<span class="warn">no HID bound</span>`);
  }

  s.diagEl.innerHTML = lines.join('\n');
}

function stableIdFor(gamepad) {
  return `${gamepad.id}::${gamepad.mapping || 'std'}`;
}

function labelForGamepad(gp) {
  const type = detectControllerType(gp.id);
  if (type === 'dualsense') return 'DualSense connected';
  if (type === 'switch-pro') return 'Switch Pro connected';
  if (type === 'xbox') return 'Xbox Controller connected';
  return 'Controller connected';
}

function gamepadHasActivity(gp) {
  if (!gp) return false;
  for (const b of gp.buttons) {
    if (b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5))) return true;
  }
  for (const a of gp.axes) {
    if (Math.abs(a) > 0.6) return true;
  }
  return false;
}

function isPsPressed(gp) {
  if (!gp) return false;
  const b = gp.buttons[PS_BUTTON_INDEX];
  return !!(b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5)));
}

// ── Wiring ──

const slots = SLOT_IDS.map((id) => new Slot(id, document.querySelector(`.slot[data-slot="${id}"]`)));
const slotById = Object.fromEntries(slots.map((s) => [s.id, s]));

async function boot() {
  for (const s of slots) {
    try {
      await s.initOverlay('dualsense');
    } catch (err) {
      console.error(`[${s.id}] overlay init failed`, err);
    }
  }

  window.addEventListener('resize', () => slots.forEach((s) => s._resize()));
  window.addEventListener('gamepadconnected', (e) => {
    console.log('gamepadconnected', e.gamepad.index, e.gamepad.id);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    console.log('gamepaddisconnected', e.gamepad.index, e.gamepad.id);
  });

  // Auto-attach any previously approved HID devices to empty slots at boot.
  if (navigator.hid) {
    try {
      const approved = await navigator.hid.getDevices();
      const knownDevices = approved.filter((d) => ControllerRegistry.isKnownDevice(d));
      for (const d of knownDevices) {
        const free = slots.find((s) => !s.hidDevice);
        if (!free) break;
        await free.bindHidDevice(d);
      }
      // In Electron, requestDevice() is auto-approved by main.js's
      // select-hid-device handler. Request once per remaining empty slot
      // to pick up controllers that aren't in getDevices() yet.
      const isElectron = navigator.userAgent.includes('Electron');
      if (isElectron) {
        const filters = ControllerRegistry.getHIDFilters();
        // Give Electron a tick so the first getDevices-bound driver
        // finishes init before the next requestDevice call lands.
        await new Promise((r) => setTimeout(r, 400));
        for (const s of slots) {
          if (s.hidDevice) continue;
          try {
            const picked = await navigator.hid.requestDevice({ filters });
            const claimed = new Set(slots.map((sl) => sl.hidDevice).filter(Boolean));
            const d = (picked || []).find((dev) => !claimed.has(dev));
            if (d) {
              await s.bindHidDevice(d);
              await new Promise((r) => setTimeout(r, 200));
            } else {
              break; // no more controllers available
            }
          } catch (err) {
            console.log('auto requestDevice failed:', err.message);
            break;
          }
        }
      }
      // Listen for hot-plug events.
      navigator.hid.addEventListener('connect', async (ev) => {
        if (!ControllerRegistry.isKnownDevice(ev.device)) return;
        const free = slots.find((s) => !s.hidDevice);
        if (free) await free.bindHidDevice(ev.device);
      });
      navigator.hid.addEventListener('disconnect', (ev) => {
        const s = slots.find((sl) => sl.hidDevice === ev.device);
        if (s) s._unbindHid();
      });
    } catch (err) {
      console.warn('HID auto-attach failed', err);
    }
  }

  loop();
}

const debugEl = document.getElementById('debug-readout');

function loop() {
  const now = performance.now();
  const pads = (navigator.getGamepads && navigator.getGamepads()) || [];

  if (debugEl) {
    const lines = [`pads array length: ${pads.length}`];
    let seen = 0;
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      if (!gp) { lines.push(`  [${i}] null`); continue; }
      seen++;
      const pressed = [];
      for (let b = 0; b < gp.buttons.length; b++) {
        if (gp.buttons[b]?.pressed) pressed.push(b);
      }
      lines.push(`  [${i}] ${gp.id.slice(0, 40)} map=${gp.mapping} pressed=[${pressed.join(',')}]`);
    }
    if (seen === 0) lines.push('  (no gamepads visible via Gamepad API)');
    for (const s of slots) {
      if (s.synthetic) {
        const pressed = [];
        for (let b = 0; b < s.synthetic.buttons.length; b++) {
          if (s.synthetic.buttons[b].pressed) pressed.push(b);
        }
        lines.push(`  [${s.id} HID] ${s.hidDevice?.productName || '?'} pressed=[${pressed.join(',')}]`);
      }
    }
    debugEl.textContent = lines.join('\n');
  }

  const livePads = [];
  for (const gp of pads) { if (gp) livePads.push(gp); }

  // Orphan check for Gamepad-API-backed claims.
  for (const s of slots) {
    if (s.state !== 'claimed') continue;
    if (s.gamepadIndex != null) {
      const gp = pads[s.gamepadIndex];
      if (gp) {
        s.root.classList.remove('orphan');
      } else if (!s.synthetic) {
        s.orphan();
      }
    }
  }

  // Claim via Gamepad API activity.
  const claimedIndices = new Set(
    slots.filter((s) => s.gamepadIndex != null).map((s) => s.gamepadIndex)
  );
  const claimDebug = [];
  claimDebug.push(`slots: P1=${slotById.P1.state} P2=${slotById.P2.state}`);
  // Clear awaiting-silence flag for any slot whose gamepad/synthetic has
  // gone fully idle since release.
  for (const s of slots) {
    if (!s._awaitingSilence) continue;
    const gp = s.gamepadIndex != null ? pads[s.gamepadIndex] : null;
    const synth = s.synthetic;
    const gpActive = gamepadHasActivity(gp);
    const synthActive = synth && gamepadHasActivity(synth);
    if (!gpActive && !synthActive) s._awaitingSilence = false;
  }

  for (const gp of livePads) {
    const activity = gamepadHasActivity(gp);
    const already = claimedIndices.has(gp.index);
    const releasedAt = recentlyReleased.get(gp.index);
    const onCooldown = releasedAt != null && (now - releasedAt) < RECLAIM_COOLDOWN_MS;
    if (already || onCooldown || !activity) continue;
    const empty = slots.find((s) => s.state === 'empty' && !s._awaitingSilence);
    if (!empty) continue;
    empty.claim(gp);
    claimDebug.push(`  CLAIMED pad idx=${gp.index} -> ${empty.id}`);
    claimedIndices.add(gp.index);
  }

  // Claim via WebHID synthetic activity (covers BT-silent DualSense).
  for (const s of slots) {
    if (s.state === 'claimed') continue;
    if (!s.synthetic) continue;
    if (s._awaitingSilence) continue;
    const slotReleasedAt = slotRecentlyReleased.get(s.id);
    if (slotReleasedAt != null && (now - slotReleasedAt) < RECLAIM_COOLDOWN_MS) continue;
    if (!gamepadHasActivity(s.synthetic)) continue;
    s.claim(s.synthetic);
    claimDebug.push(`  CLAIMED via HID -> ${s.id}`);
  }
  if (debugEl && claimDebug.length) debugEl.textContent += '\n' + claimDebug.join('\n');

  // Calibration transition: clear "hold still" hint when it finishes.
  for (const s of slots) {
    const isCalibrating = !!(s.gyro && s.gyro.calibrating);
    if (s._wasCalibrating && !isCalibrating) {
      s.gyro?.reset();
      s.hintEl.textContent = s.state === 'claimed'
        ? 'Hold PS/Home 2s to release'
        : '';
    }
    s._wasCalibrating = isCalibrating;
  }

  // Per-slot update.
  for (const s of slots) {
    const gp = s.effectiveGamepad(pads);
    // Gyro only applies once the slot is claimed; unclaimed slots show a
    // neutral ghost. (The integrator keeps running so orientation is ready
    // the moment the slot is claimed.)
    const gyroQ = (s.state === 'claimed' && s.gyro) ? s.gyro.orientation : null;
    if (s.overlay) s.overlay.update(gp, gyroQ);
    const ps = gp ? isPsPressed(gp) : false;
    if (s.updateReleaseRing(now, ps)) {
      const freedIndex = s.gamepadIndex;
      console.log(`[${s.id}] released via PS hold`);
      s.release();
      if (freedIndex != null) recentlyReleased.set(freedIndex, now);
      slotRecentlyReleased.set(s.id, now);
    }
    renderSlotDiagnostics(s, pads);
  }

  requestAnimationFrame(loop);
}

boot();
