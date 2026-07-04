// ============================================================
// FRONT-VIEW CAMERA (picture-in-picture "selfie cam")
// ============================================================
//
// A small window in the lower-right corner that shows a front-facing
// view of the bike as you ride — the camera sits ahead of the bike on
// its heading and looks back at the riders, so you watch the tandem (and
// both riders) coming toward you. Inspired by the r/Unity3D trick of
// parenting a camera to a character's face and dropping a render texture
// in the corner.
//
// Rendering reuses the main WebGLRenderer via a scissored viewport — no
// second renderer, no render target — so the cost is one extra scene
// draw confined to a small rectangle. A DOM frame is layered on top to
// give it the rounded, bordered "screen" look.

import * as THREE from 'three';

export class FrontViewCamera {
  constructor(mainCamera) {
    this.enabled = true;

    // Dedicated camera for the PiP. Square aspect (set in render()).
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);

    // Rig: how the camera sits relative to the bike. Sits just ahead of the
    // front wheel at roughly rider eye level, looking back so the tandem and
    // both riders fill the frame as they come toward you.
    this.frontDist = 4.6;   // units ahead of bike center, along heading
    this.height = 1.95;     // camera eye height above the bike origin
    this.lookHeight = 1.45; // height of the point we aim at (riders)

    // Smoothed position/target so the view glides instead of snapping.
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._initialized = false;

    this._buildFrame();
    this._onResize();
    window.addEventListener('resize', () => this._onResize());
  }

  // ----- DOM frame --------------------------------------------------

  _buildFrame() {
    const frame = document.createElement('div');
    frame.id = 'front-view-frame';
    frame.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:40',
      'border:3px solid rgba(255,255,255,0.92)',
      'border-radius:14px',
      'box-shadow:0 6px 22px rgba(0,0,0,0.45)',
      'overflow:hidden',
      'box-sizing:border-box',
    ].join(';');

    const label = document.createElement('div');
    label.textContent = 'FRONT VIEW';
    label.style.cssText = [
      'position:absolute',
      'left:8px',
      'top:6px',
      'font:600 11px/1 system-ui,sans-serif',
      'letter-spacing:0.08em',
      'color:rgba(255,255,255,0.95)',
      'text-shadow:0 1px 3px rgba(0,0,0,0.8)',
    ].join(';');
    frame.appendChild(label);

    document.body.appendChild(frame);
    this.frame = frame;
  }

  /** Square sized relative to the smaller screen dimension. Returns the
   *  top-left CSS position + size. In multiplayer, if the partner webcam PiP is
   *  on screen (it shares the front-view's lower-right corner), the front view
   *  stacks directly ABOVE it, right-aligned and taken live from its rect, so
   *  the two never overlap. Otherwise it sits lower-right, above the pedal bar. */
  _computeRect() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const size = Math.round(Math.min(w, h) * 0.28);
    const margin = Math.round(Math.min(w, h) * 0.035);

    const pip = this._partnerPipRect();
    if (pip) {
      const gap = Math.round(Math.min(w, h) * 0.02);
      // Right edges aligned to the PiP (match its own edge margin); only clamp
      // enough to keep the square fully on-screen.
      let cssLeft = Math.max(0, Math.min(pip.right - size, w - size));
      let cssTop = Math.max(0, pip.top - size - gap);  // parked just above the PiP
      return { size, cssLeft, cssTop };
    }

    // Clear the bottom pedal bar if it's visible (touch / portrait layout).
    let bottomClear = margin;
    const bar = document.getElementById('pedal-bar');
    if (bar) {
      const r = bar.getBoundingClientRect();
      const visible = r.height > 0 && getComputedStyle(bar).display !== 'none';
      if (visible) bottomClear = Math.max(margin, h - r.top + margin);
    }

    return { size, cssLeft: w - size - margin, cssTop: h - size - bottomClear };
  }

  /** The partner webcam PiP's on-screen rect when it's actually visible with
   *  content, else null. The recorder toggles its display when the partner has
   *  a camera/avatar, so this is how we detect "multiplayer has video there". */
  _partnerPipRect() {
    const el = document.getElementById('partner-pip-wrap');
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.bottom <= 0 || r.top >= window.innerHeight) return null; // off-screen
    return r;
  }

  _applyRectToFrame(r) {
    if (!this.frame) return;
    this.frame.style.width = r.size + 'px';
    this.frame.style.height = r.size + 'px';
    this.frame.style.left = r.cssLeft + 'px';
    this.frame.style.top = r.cssTop + 'px';
  }

  _onResize() {
    this._rect = this._computeRect();
    this._applyRectToFrame(this._rect);
  }

  /** Master on/off (user toggle). When off, nothing renders and the
   *  frame is hidden until re-enabled. */
  setVisible(on) {
    this.enabled = on;
    if (!on) this._showFrame(false);
  }

  toggle() {
    this.setVisible(!this.enabled);
    return this.enabled;
  }

  /** Show/hide just the DOM frame (without touching the master toggle).
   *  Driven each frame so the frame only appears when we actually draw
   *  into the corner. */
  _showFrame(on) {
    if (!this.frame) return;
    const display = on ? 'block' : 'none';
    if (this.frame.style.display !== display) {
      // Re-measure on show — the HUD pedal bar isn't laid out until gameplay.
      if (on) this._onResize();
      this.frame.style.display = display;
    }
  }

  /** Hide the PiP for this frame (e.g. menus/cinematic) without disabling. */
  hide() {
    this._showFrame(false);
  }

  // ----- Per-frame --------------------------------------------------

  update(bike, dt) {
    if (!this.enabled) return;

    const fwd = this._fwd;
    fwd.set(Math.sin(bike.heading), 0, Math.cos(bike.heading));

    // In front of the bike, looking back at it.
    this._desiredPos.copy(bike.position);
    this._desiredPos.x += fwd.x * this.frontDist;
    this._desiredPos.z += fwd.z * this.frontDist;
    this._desiredPos.y += this.height;

    this._desiredLook.copy(bike.position);
    this._desiredLook.y += this.lookHeight;

    if (!this._initialized) {
      this._pos.copy(this._desiredPos);
      this._look.copy(this._desiredLook);
      this._initialized = true;
    } else {
      const k = Math.min(1, 8 * (dt || 0.016));
      this._pos.lerp(this._desiredPos, k);
      this._look.lerp(this._desiredLook, k);
    }

    this.camera.position.copy(this._pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._look);
  }

  /** Re-seat the camera instantly (e.g. after a reset/teleport). */
  reset() {
    this._initialized = false;
  }

  /**
   * Draw the front view into the corner. Call AFTER the main scene
   * render so it composites on top. Uses a scissored viewport on the
   * shared renderer.
   */
  render(renderer, scene) {
    if (!this.enabled) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    // Recompute live so the PiP tracks the partner webcam appearing/leaving
    // (and any resize) mid-ride. Reads happen before the DOM-frame writes below.
    const r = this._computeRect();
    this._rect = r;

    // WebGL viewport origin is bottom-left; derive from the CSS top-left rect.
    const x = Math.round(r.cssLeft);
    const y = Math.round(h - r.cssTop - r.size);

    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    renderer.setScissorTest(true);
    renderer.setScissor(x, y, r.size, r.size);
    renderer.setViewport(x, y, r.size, r.size);
    renderer.render(scene, this.camera);

    // Restore full-screen viewport for the next main render.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);

    this._applyRectToFrame(r);
    this._showFrame(true);
  }
}
