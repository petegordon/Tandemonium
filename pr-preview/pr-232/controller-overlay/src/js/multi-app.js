// ============================================================
// MULTI-APP.JS — Multi-controller overlay view layer
// ============================================================
//
// Thin view on top of shared/controller-manager.js. The manager owns
// all slot state, claim/release lifecycle, HID pairing, and sensor
// fusion. This file only:
//   - instantiates 3D ControllerOverlay canvases
//   - wires slot state changes to DOM text/classes
//   - runs the raf loop and forwards pads + gyro to overlays
//   - renders diagnostics panels + debug strip
//
// See shared/controller-manager.js for the state machine, #222 for
// the design doc, #224 for the consolidation plan.
// ============================================================

import { ControllerOverlay } from './controller-overlay.js';
import { detectControllerType } from './controller-profiles.js';
import { ControllerRegistry } from '../shared/controllers/controller-registry.js';
import { ControllerManager, gamepadHasActivity } from '../shared/controller-manager.js';

const SLOT_IDS = ['P1', 'P2'];

const manager = new ControllerManager({ slotIds: SLOT_IDS });

// ── View: per-slot DOM wiring ──

class SlotView {
  constructor(slot, root) {
    this.slot = slot;
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

    this.overlay = null;
    this.controllerType = 'dualsense';
    this._diagLastUpdate = 0;

    root.classList.toggle('p1', slot.id === 'P1');
    root.classList.toggle('p2', slot.id === 'P2');

    if (this.connectBtn) {
      this.connectBtn.addEventListener('click', () => {
        manager.connectHidForSlot(slot.id).catch((err) => {
          this.hintEl.textContent = `HID error: ${err.message}`;
        });
      });
    }
    if (this.diagBtn) {
      this.diagBtn.addEventListener('click', () => {
        if (!this.diagEl) return;
        if (this.diagEl.hasAttribute('hidden')) this.diagEl.removeAttribute('hidden');
        else this.diagEl.setAttribute('hidden', '');
      });
    }
    if (this.calibBtn) {
      this.calibBtn.addEventListener('click', () => {
        if (slot.fusion) {
          slot.startGyroCalibration();
          this.hintEl.textContent = 'Calibrating gyro — hold still…';
        }
      });
    }

    slot.on((s, reason, data) => this._onSlotChange(reason, data));
    this._renderEmpty();
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

  _onSlotChange(reason, data) {
    const s = this.slot;
    switch (reason) {
      case 'claimed':
        this._renderClaimed();
        break;
      case 'released':
        this._renderEmpty();
        break;
      case 'orphaned':
        this.hintEl.textContent = 'Reconnecting…';
        this.root.classList.add('orphan');
        break;
      case 'hid-bound':
        this._renderHidBadge(true);
        break;
      case 'hid-unbound':
        this._renderHidBadge(false);
        break;
      case 'ring':
        this._renderRing(s.ringPct);
        break;
      case 'hid-report':
        // Forward touchpad data to the 3D overlay.
        if (data?.touchpad && this.overlay?.updateTouchpad) {
          this.overlay.updateTouchpad(data.touchpad, data.touchpadButton);
        }
        break;
    }
  }

  _renderEmpty() {
    this.root.classList.remove('claimed', 'orphan');
    this.root.classList.add('empty');
    this.promptEl.innerHTML = '<span class="pulse">Press any button to join</span>';
    this.hintEl.textContent = '';
    this.subEl.textContent = '';
    this._renderRing(0);
  }

  _renderClaimed() {
    const s = this.slot;
    this.root.classList.remove('empty', 'orphan');
    this.root.classList.add('claimed');
    this.promptEl.textContent = labelForGamepad(s.controllerLabel);
    this.hintEl.textContent = 'Hold PS/Home 2s to release';
    this.subEl.textContent = (s.controllerId || '').slice(0, 28);

    // Swap 3D model to match the claimed controller.
    const desired = detectControllerType(s.controllerLabel || '') || 'dualsense';
    if (desired !== this.controllerType && this.overlay) {
      this.controllerType = desired;
      this.overlay.setControllerType(desired);
    }
  }

  _renderRing(pct) {
    if (!this.ringEl) return;
    if (pct > 0) {
      this.ringEl.classList.add('visible');
      this.ringEl.style.setProperty('--p', String(pct));
    } else {
      this.ringEl.classList.remove('visible');
      this.ringEl.style.setProperty('--p', '0');
    }
  }

  _renderHidBadge(on) {
    if (!this.connectBtn) return;
    this.connectBtn.classList.toggle('status', on);
    this.connectBtn.textContent = on ? 'Gyro Connected' : 'Connect Gyro (WebHID)';
    if (this.calibBtn) this.calibBtn.style.display = on ? '' : 'none';
  }

  /**
   * Called each frame. Pushes the effective gamepad + gyro quaternion into
   * the 3D overlay, and updates the calibration-finished hint text.
   */
  tick(pads) {
    const s = this.slot;
    // Calibration-complete transition
    const isCalibrating = !!(s.fusion && s.fusion.calibrating);
    if (s._wasCalibrating && !isCalibrating) {
      s.fusion?.reset();
      this.hintEl.textContent = s.state === 'claimed'
        ? 'Hold PS/Home 2s to release'
        : '';
    }
    s._wasCalibrating = isCalibrating;

    const gp = s.effectiveGamepad(pads);
    // Gyro only applies once the slot is claimed — unclaimed slots stay
    // still even though the fusion keeps running in the background.
    const gyroQ = (s.state === 'claimed' && s.fusion) ? s.fusion.orientation : null;
    if (this.overlay) this.overlay.update(gp, gyroQ);
  }
}

function labelForGamepad(gamepadIdString) {
  const type = detectControllerType(gamepadIdString || '');
  if (type === 'dualsense') return 'DualSense connected';
  if (type === 'switch-pro') return 'Switch Pro connected';
  if (type === 'xbox') return 'Xbox Controller connected';
  return 'Controller connected';
}

// ── Diagnostics panel ──

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function hex4(n) {
  return n != null ? '0x' + n.toString(16).padStart(4, '0') : '—';
}

function renderSlotDiagnostics(view, pads) {
  if (!view.diagEl || view.diagEl.hasAttribute('hidden')) return;
  const now = performance.now();
  if (now - view._diagLastUpdate < 160) return; // throttle ~6Hz
  view._diagLastUpdate = now;

  const s = view.slot;
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
    const gyroOk = s.fusion && s.fusion._lastGyroTime > 0 && !s.fusion.calibrating;
    lines.push(`<span class="k">gyro     </span> ${gyroOk ? '<span class="ok">integrating</span>' : (s.fusion?.calibrating ? '<span class="warn">calibrating…</span>' : '<span class="warn">idle</span>')}`);
    lines.push(`<span class="k">synth    </span> pressed=[<span class="v">${pressedSynth.join(',')}</span>] axes=[<span class="v">${esc(axesSynth)}</span>]`);
  } else {
    lines.push(`<span class="warn">no HID bound</span>`);
  }

  view.diagEl.innerHTML = lines.join('\n');
}

// ── Debug strip ──

const debugEl = document.getElementById('debug-readout');

function renderDebugStrip(pads, views) {
  if (!debugEl) return;
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
  for (const v of views) {
    const s = v.slot;
    if (s.synthetic) {
      const pressed = [];
      for (let b = 0; b < s.synthetic.buttons.length; b++) {
        if (s.synthetic.buttons[b].pressed) pressed.push(b);
      }
      lines.push(`  [${s.id} HID] ${s.hidDevice?.productName || '?'} pressed=[${pressed.join(',')}]`);
    }
  }
  // Pooled HID devices (paired but not yet bound to a slot)
  if (manager._hidPool.size > 0) {
    for (const entry of manager._hidPool.values()) {
      const pressed = [];
      for (let b = 0; b < entry.synthetic.buttons.length; b++) {
        if (entry.synthetic.buttons[b].pressed) pressed.push(b);
      }
      lines.push(`  [pool] ${entry.device.productName || '?'} pressed=[${pressed.join(',')}]`);
    }
  }
  lines.push(`slots: ${views.map((v) => `${v.slot.id}=${v.slot.state}`).join(' ')}`);
  debugEl.textContent = lines.join('\n');
}

// ── Wiring ──

const views = manager.slots.map((slot) => {
  const root = document.querySelector(`.slot[data-slot="${slot.id}"]`);
  return new SlotView(slot, root);
});

async function boot() {
  for (const v of views) {
    try {
      await v.initOverlay('dualsense');
    } catch (err) {
      console.error(`[${v.slot.id}] overlay init failed`, err);
    }
  }

  window.addEventListener('resize', () => views.forEach((v) => v._resize()));
  window.addEventListener('gamepadconnected', (e) => {
    console.log('gamepadconnected', e.gamepad.index, e.gamepad.id);
  });
  window.addEventListener('gamepaddisconnected', (e) => {
    console.log('gamepaddisconnected', e.gamepad.index, e.gamepad.id);
  });

  if (navigator.hid) {
    await manager.autoPoolApprovedHid();
    if (navigator.userAgent.includes('Electron')) {
      await manager.electronAutoRequestDevice();
    }
    manager.wireHidHotplug();
  }

  loop();
}

function loop() {
  const now = performance.now();
  const pads = (navigator.getGamepads && navigator.getGamepads()) || [];

  manager.ingestFrame(pads, now);

  for (const v of views) {
    v.tick(pads);
    renderSlotDiagnostics(v, pads);
  }

  renderDebugStrip(pads, views);

  requestAnimationFrame(loop);
}

boot();
