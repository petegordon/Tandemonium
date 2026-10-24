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

    // Last measured PiP rect + when it was measured. _computeRect() forces a
    // synchronous layout (getComputedStyle/getBoundingClientRect) right after
    // the HUD has written to the DOM, which on iPhone Safari costs a full
    // style/layout pass every frame (#390). render() reuses this cached rect
    // and only re-measures on a throttle or on resize/orientation change.
    this._rect = null;
    this._measuredAt = -Infinity;
    this._remeasureMs = 250;
    // Last values written to the DOM frame, so steady frames write nothing.
    this._applied = { size: -1, cssLeft: NaN, cssTop: NaN };

    // #456 · redraw the scene for the corner only every Nth frame (1 = every
    // frame). In between, the last picture is copied back in, which is one
    // cheap draw instead of the bike, geese and world again.
    this.renderEvery = 2;
    this._rt = null;        // the corner's last picture
    this._blit = null;      // a full-viewport quad that copies it to the screen
    this._stale = true;     // draw a fresh picture on the next frame
    this._skipped = 0;

    this._buildFrame();
    this._onResize();
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
    window.addEventListener('orientationchange', this._resizeHandler);
  }

  // ----- DOM frame --------------------------------------------------

  _buildFrame() {
    const frame = document.createElement('div');
    frame.className = 'front-view-frame'; // class, not id — versus uses one per bike
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
    // Write-on-change: this runs every frame, and even same-value style
    // writes dirty style on Safari (#390).
    const a = this._applied;
    const st = this.frame.style;
    if (a.size !== r.size) {
      st.width = r.size + 'px';
      st.height = r.size + 'px';
      a.size = r.size;
    }
    if (a.cssLeft !== r.cssLeft) { st.left = r.cssLeft + 'px'; a.cssLeft = r.cssLeft; }
    if (a.cssTop !== r.cssTop) { st.top = r.cssTop + 'px'; a.cssTop = r.cssTop; }
  }

  _onResize() {
    this._rect = this._computeRect();
    this._measuredAt = performance.now();
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
    if (!on) this._stale = true;   // the picture is old by the time it's back
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
    // Riders taller or shorter than the fused riders model this rig was tuned on
    // (the goose tandem's geese are ~14% taller at the game's 4.4 m bike length).
    const s = bike.riderViewScale || 1;
    this._desiredPos.y += this.height * s;

    this._desiredLook.copy(bike.position);
    this._desiredLook.y += this.lookHeight * s;

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
    this._stale = true;
  }

  /**
   * The render target for the corner picture, sized to `cssSize` device
   * pixels.
   *
   * It must draw with exactly the shaders the main view just used. three.js
   * gives an ordinary render target no tone mapping and linear colour, so
   * every material in the corner would switch shader program twice a frame
   * (into the target and back), and that switch costs more CPU than the
   * skipped frame saves. Marked as an XR target, three.js tone-maps and
   * encodes into it as it does for the screen (`isXRRenderTarget` is what
   * three.js r161 checks; see setProgram / getParameters). Storage is plain
   * RGBA8 holding the already-encoded colour, as the canvas does, so the copy
   * is a raw texel copy with no colour conversion.
   */
  _target(renderer, cssSize) {
    if (!this._rt) {
      const aa = !!(renderer.getContext().getContextAttributes() || {}).antialias;
      this._rt = new THREE.WebGLRenderTarget(1, 1, {
        samples: aa ? 4 : 0,   // match the main view's edge smoothing
      });
      this._rt.isXRRenderTarget = true;
      this._rt.texture.colorSpace = THREE.SRGBColorSpace;   // the shaders encode to sRGB, as for the canvas
      this._rt.texture.internalFormat = 'RGBA8';            // ...into plain storage: no second encode
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: this._rt.texture } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(quad);
      this._blit = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), quad };
    }
    const px = Math.max(1, Math.round(cssSize * renderer.getPixelRatio()));
    if (this._rt.width !== px || this._rt.height !== px) {
      this._rt.setSize(px, px);
      this._stale = true;
    }
    return this._rt;
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
    // Re-measure on a throttle so the PiP still tracks the partner webcam
    // appearing/leaving mid-ride (resize/orientation re-measure immediately),
    // but steady-state frames do no layout reads (#390).
    const now = performance.now();
    if (!this._rect || now - this._measuredAt >= this._remeasureMs) {
      this._rect = this._computeRect();
      this._measuredAt = now;
    }
    const r = this._rect;

    // WebGL viewport origin is bottom-left; derive from the CSS top-left rect.
    const x = Math.round(r.cssLeft);
    const y = Math.round(h - r.cssTop - r.size);

    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    // #395 · the main view was drawn just before this, with the sun already
    // placed on this bike, so its shadow map is still right. Without this,
    // three.js redraws every shadow caster again for the small corner view.
    const autoShadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    // (WebGL1 draws every frame, as before: no RGBA8 render targets to copy from.)
    const rt = this.renderEvery > 1 && renderer.capabilities.isWebGL2 ? this._target(renderer, r.size) : null;
    if (rt) {
      // #456 · draw the scene into a small picture every other frame, and
      // copy that picture into the corner every frame (the main view clears
      // the whole canvas, so the corner has to be redrawn each frame).
      if (this._stale || ++this._skipped >= this.renderEvery) {
        renderer.setRenderTarget(rt);
        renderer.render(scene, this.camera);
        renderer.setRenderTarget(null);
        this._stale = false;
        this._skipped = 0;
      }
      renderer.setScissorTest(true);
      renderer.setScissor(x, y, r.size, r.size);
      renderer.setViewport(x, y, r.size, r.size);
      renderer.render(this._blit.scene, this._blit.camera);
    } else {
      renderer.setScissorTest(true);
      renderer.setScissor(x, y, r.size, r.size);
      renderer.setViewport(x, y, r.size, r.size);
      renderer.render(scene, this.camera);
    }
    renderer.shadowMap.autoUpdate = autoShadows;

    // Restore full-screen viewport for the next main render.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);

    this._applyRectToFrame(r);
    this._showFrame(true);
  }

  /**
   * Versus: draw the front view into the lower-right corner of ONE viewport
   * half. Call after that half's main render, inside the same scissored pass.
   * halfX/halfW are the half's CSS-pixel bounds (left origin); the full window
   * height is used. Each versus bike owns its own FrontViewCamera instance.
   */
  renderInHalf(renderer, scene, bike, dt, halfX, halfW) {
    if (!this.enabled) return;
    this.update(bike, dt);

    const w = window.innerWidth;
    const h = window.innerHeight;
    const size = Math.round(Math.min(halfW, h) * 0.30);
    const margin = Math.round(Math.min(halfW, h) * 0.045);
    const cssLeft = halfX + halfW - size - margin; // lower-right of this half
    const cssTop = h - size - margin;
    const r = { size, cssLeft, cssTop };
    this._rect = r;
    // Not a live measurement — force render() to re-measure if the same
    // instance is later used full-screen.
    this._measuredAt = -Infinity;

    const x = Math.round(cssLeft);
    const y = Math.round(h - cssTop - size);

    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();

    renderer.setScissorTest(true);
    renderer.setScissor(x, y, size, size);
    renderer.setViewport(x, y, size, size);
    renderer.render(scene, this.camera);

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setScissor(0, 0, w, h);

    this._applyRectToFrame(r);
    this._showFrame(true);
  }

  /** Tear down the DOM frame (e.g. leaving versus). */
  dispose() {
    window.removeEventListener('resize', this._resizeHandler);
    window.removeEventListener('orientationchange', this._resizeHandler);
    if (this.frame && this.frame.parentNode) this.frame.parentNode.removeChild(this.frame);
    this.frame = null;
    if (this._rt) {
      this._rt.dispose();
      this._blit.quad.geometry.dispose();
      this._blit.quad.material.dispose();
      this._rt = null;
      this._blit = null;
    }
  }
}
