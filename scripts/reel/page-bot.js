// page-bot.js — loaded into the game page by scripts/reel/lib.mjs (trailer capture only).
// window.__reel.tick(dt) runs once per captured frame, BEFORE the game loop:
//   bots   — pedal taps + lean for any InputManager (solo P1, local co-op P2, versus members);
//   camera — optional override of the main camera (orbits, tracking shots), else the game's chase cam.
import { InputManager } from '/js/input-manager.js';
import { BalanceController } from '/js/balance-controller.js';

const game = window._game;
const THREE_V = () => game.camera.position.constructor;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);

const reel = {
  t: 0, bots: [], cam: null, camState: null,
  steerHelper: new BalanceController(null),

  /** A fresh input for a second rider (no keyboard / motion / touch listeners). */
  newInput() { return new InputManager({ enableKeyboard: false, enableMotion: false, enableTouch: false }); },

  /**
   * Drive `input` as a rider of `getBike()`.
   * opts: role 'captain'|'stoker' (stoker taps the opposite foot just after the captain),
   *       cadence taps/s, sway {amp, freq, phase} (rider lean, -1..1 input), steer gain, enabled
   */
  attach(input, getBike, opts = {}) {
    const bot = Object.assign({ input, getBike, role: 'captain', cadence: 3.2, steer: 0.9, stab: 0.35,
      sway: { amp: 0.55, freq: 0.32, phase: 0 }, extra: 0, pedal: true, lean: 0, leanOut: 0, foot: 'left', acc: 0, enabled: true,
      offset: 0 }, opts);
    input.getGamepadLean = () => (bot.enabled ? bot.leanOut : 0);
    if (bot.role === 'stoker') bot.foot = 'right';
    this.bots.push(bot);
    return bot;
  },
  clearBots() { this.bots = []; },

  tick(dt) {
    this.t += dt;
    const fv = game.frontView;   // the PiP draws into the main canvas: skip it for clean shots
    if (fv && !fv.__reel) { fv.__reel = true; const fr = fv.render.bind(fv); fv.render = (...a) => (this.noPip ? undefined : fr(...a)); }
    if (this.noPip) this._clearRoad();
    for (const b of this.bots) if (b.enabled) this._drive(b, dt);
  },

  _drive(b, dt) {
    const bike = b.getBike(); if (!bike) return;
    b.input._markActive();   // a rider who is riding (P2's lean is dropped after 10 s idle)
    // pedal: alternate feet at the cadence; the stoker's tap lands 80 ms after the captain's (a "perfect" pair)
    if (b.pedal && game.state === 'playing') {
      b.acc += dt * b.cadence;
      if (b.acc >= 1 + (b.role === 'stoker' ? 0.08 * b.cadence : 0)) {
        b.acc -= 1;
        // the stoker starts on the other foot, so each pair is opposite feet
        b.foot = b.foot === 'left' ? 'right' : 'left';
        if (b.foot === 'left') b.input._leftTapped = true; else b.input._rightTapped = true;
      }
    }
    // lean: follow the road, steady the bike, and sway on top (each rider their own sway)
    const steer = b.steer ? this._steer(b, bike, dt) * b.steer : 0;
    // most of the sway the riders share is taken back out, so the bike keeps its line while the
    // geese still visibly lean their own ways (they lean the same way only in a gentle weave)
    const mates = this.bots.filter(o => o.enabled && o.getBike() === bike);
    const mean = mates.reduce((a, o) => a + this._swayOf(o, bike), 0) / mates.length;
    const target = clamp(steer + this._swayOf(b, bike) - this.swayComp * mean + b.extra, -1, 1);
    b.lean += (target - b.lean) * Math.min(1, dt * 12);   // a body, not a switch
    b.leanOut = clamp(b.lean, -1, 1);
  },

  /**
   * Road follower, a cascade: lateral offset (to b.offset) -> wanted heading -> wanted lean -> input.
   * The bike turns by its lean (heading rate = -lean * speed * turnRate), so the inner loop holds
   * the lean angle and the outer loops pick it.
   */
  _steer(b, bike, dt) {
    const rp = bike.roadPath; if (!rp) return 0;
    const g = this.gains;
    const ahead = rp.getPointAtDistance(bike.roadD + Math.max(1, bike.speed * g.look));
    // lane: dodge the next obstacle, else go for the next present / coin, else b.offset; slewed so it weaves
    // b.path [[distance, lateral], ...]: a scripted line (e.g. the tutorial's exact weave) from its first
    // distance on; before that (and with no path) the bot dodges / collects
    const want0 = (b.path && bike.distanceTraveled >= b.path[0][0]) ? this._pathAt(b.path, bike.distanceTraveled)
      : b.dodge === false ? (b.offset || 0) : this._lane(b, bike);
    b._lane = b._lane == null ? want0 : b._lane + clamp(want0 - b._lane, -g.slew * dt, g.slew * dt);
    const lat = bike._lateralOffset - b._lane;
    const want = ahead.heading - Math.atan(g.kl * lat);
    let eh = want - bike.heading;
    while (eh > Math.PI) eh -= 2 * Math.PI; while (eh < -Math.PI) eh += 2 * Math.PI;
    const leanCmd = clamp(-g.kh * eh, -g.maxLean, g.maxLean);
    // feed-forward: the input that holds leanCmd against the bike's self-righting (gyro - gravity)
    const ff = leanCmd * (Math.min(bike.speed * 0.8, 6) - 2.5) / 12;
    return ff + g.kp * (leanCmd - (bike.lean || 0)) - g.kv * (bike.leanVelocity || 0);
  },
  _pathAt(path, d) {
    if (d <= path[0][0]) return path[0][1];
    for (let i = 0; i < path.length - 1; i++) {
      const [d0, x0] = path[i], [d1, x1] = path[i + 1];
      if (d <= d1) return lerp(x0, x1, ease((d - d0) / Math.max(1e-6, d1 - d0)));
    }
    return path[path.length - 1][1];
  },
  gains: { kh: 0.4, kl: 0.08, look: 0.5, kp: 1.5, kv: 0.25, maxLean: 0.45, slew: 2.5 },

  /** Clean beauty shots: no presents (their gold arches wash the lens) and no pylons on the road. */
  _clearRoad() {
    const om = game.obstacleManager, cm = game.collectibleManager;
    if (om) om._items = [];
    if (cm) for (const it of cm._items || []) it.collected = true;
    for (const m of [om, cm]) for (const slot of (m && m._pool) || [])
      for (const v of Object.values(slot)) if (v && v.isObject3D) v.visible = false;
    // the gold-cloud checkpoint arches: riding through one fills the frame with yellow
    // (the world re-shows markers every frame unless _permanentlyHidden; the destination house stays)
    for (const mk of (game.world && game.world._raceMarkers) || []) {
      if (mk.type === 'checkpoint') { mk._permanentlyHidden = true; mk.mesh.visible = false; }
    }
  },

  swayComp: 0.75,
  _swayOf(b, bike) {
    const s = b.sway;
    return s.amp * Math.sin(2 * Math.PI * s.freq * this.t + s.phase) * (bike.speed > 2 ? 1 : bike.speed / 2);
  },

  _lane(b, bike) {
    const at = bike.distanceTraveled, horizon = Math.max(8, bike.speed * 2.2);
    const om = game.obstacleManager, cm = game.collectibleManager;
    let ob = null;
    // b.collect === 'avoid': presents count as obstacles (clean beauty shots: no gold arch across the lens)
    const hazards = [...((om && om._items) || []), ...(b.collect === 'avoid' ? ((cm && cm._items) || []).filter(i => !i.collected) : [])];
    for (const it of hazards) {
      const ahead = it.absoluteD - at;
      if (ahead > -1 && ahead < horizon && (!ob || it.absoluteD < ob.absoluteD)) ob = it;
    }
    if (ob && Math.abs((b._lane ?? 0) - ob.lateralOffset) < 1.7) {
      const side = ob.lateralOffset > 0 ? -1 : 1;
      return clamp(ob.lateralOffset + side * 1.7, -2.1, 2.1);
    }
    if (b.collect === true || b.collect == null) {
      let best = null;
      for (const it of (cm && cm._items) || []) {
        if (it.collected) continue;
        const ahead = it.absoluteD - at;
        if (ahead > 2 && ahead < 30 && (!best || it.absoluteD < best.absoluteD)) best = it;
      }
      if (best && !(ob && Math.abs(best.lateralOffset - ob.lateralOffset) < 1.7)) return clamp(best.lateralOffset, -2, 2);
    }
    return b.offset || 0;
  },

  // ---------------- camera ----------------
  /**
   * shot: { keys: [{t, deg, dist, h, look, fov}], world: false }
   *   deg  0 = in front of the bike, 90 = its left, 180 = behind (bike frame unless world:true, then compass)
   *   dist / h  metres from the bike's centre; look = height of the aim point above the seats; fov degrees
   * null = the game's own chase camera.
   */
  setCamera(shot, bike = game.bike) { this.cam = shot ? Object.assign({ t0: this.t, bike }, shot) : null; this.camState = null; },

  _bikeFrame(bike) {
    const V = THREE_V();
    const model = bike.group.children[0];
    const cap = model && model.getObjectByName('Seat_Captain'), sto = model && model.getObjectByName('Seat_Stoker');
    let ctr, fwd;
    if (cap && sto) {
      const a = cap.getWorldPosition(new V()), c = sto.getWorldPosition(new V());
      ctr = a.clone().add(c).multiplyScalar(0.5); fwd = a.sub(c); fwd.y = 0; fwd.normalize();
    } else {
      ctr = bike.group.position.clone().add(new V(0, 1.2, 0));
      fwd = new V(Math.sin(bike.heading), 0, Math.cos(bike.heading));
    }
    return { ctr, fwd };
  },

  _cameraFor(cam) {
    const sh = this.cam; if (!sh) return null;
    const V = THREE_V();
    const st = this.camState || (this.camState = { cam: cam.clone(), ctr: null, fwd: null });
    const { ctr, fwd } = this._bikeFrame(sh.bike);
    // smooth the follow so road bumps and the lean don't shake the shot
    const k = 0.18;
    st.ctr = st.ctr ? st.ctr.lerp(ctr, sh.stiff ?? k) : ctr.clone();
    st.fwd = st.fwd ? st.fwd.lerp(fwd, 0.05).normalize() : fwd.clone();
    // keyframes
    const t = this.t - sh.t0, keys = sh.keys;
    let a = keys[0], b = keys[keys.length - 1], u = 0;
    for (let i = 0; i < keys.length - 1; i++) if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; u = ease((t - a.t) / Math.max(1e-6, b.t - a.t)); break; }
    if (t > b.t) { a = b; u = 0; }
    const p = {}; for (const key of ['deg', 'dist', 'h', 'look', 'fov', 'side']) p[key] = lerp(a[key] ?? 0, (b[key] ?? a[key]) ?? 0, u);
    const ks = (sh.bike.group.children[0] && sh.bike.group.children[0].scale.x) || 1;   // bike metres -> world units
    p.dist *= ks; p.h *= ks; p.look *= ks; p.side *= ks;
    const up = new V(0, 1, 0);
    const base = sh.world ? new V(0, 0, 1) : st.fwd;
    const side = base.clone().cross(up).normalize();
    const ang = p.deg * Math.PI / 180;
    const dir = base.clone().multiplyScalar(Math.cos(ang)).addScaledVector(side, -Math.sin(ang));
    const c = st.cam;
    c.fov = p.fov || 40; c.aspect = cam.aspect; c.near = 0.05; c.far = cam.far;
    const aim = st.ctr.clone().addScaledVector(up, p.look || 0).addScaledVector(side, p.side || 0);
    c.position.copy(st.ctr).addScaledVector(dir, p.dist).addScaledVector(up, p.h);
    c.up.set(0, 1, 0); c.lookAt(aim); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    return c;
  },

  /** Hide every HUD / overlay element for clean beauty shots (true) or restore (false). */
  clean(on) {
    // every top-level element except the one holding the 3D canvas; the front-view PiP is drawn into the
    // main canvas by the game, so it is switched off separately
    // (a CSS rule, so toasts added later are hidden too)
    let keep = game.renderer.domElement;
    while (keep.parentElement && keep.parentElement !== document.body) keep = keep.parentElement;
    keep.setAttribute('data-reel-keep', '');
    let s = document.getElementById('reel-clean-style');
    if (!s) { s = document.createElement('style'); s.id = 'reel-clean-style'; document.head.appendChild(s); }
    s.textContent = on ? 'body > *:not([data-reel-keep]) { visibility: hidden !important; } [data-reel-keep] > *:not(canvas) { visibility: hidden !important; }' : '';
    this.noPip = !!on;
  },

  /** Gameplay look: keep the game HUD, drop the touch pedal pads and menu button (desktop/controller play). */
  gameplayHud() {
    let s = document.getElementById('reel-hud-style');
    if (!s) { s = document.createElement('style'); s.id = 'reel-hud-style'; document.head.appendChild(s); }
    s.textContent = '#touch-left, #touch-right, #quick-menu-btn { display: none !important; }';
  },
};

// main-camera override: swap the game's camera for ours in the main render only
const r = game.renderer, origRender = r.render.bind(r);
r.render = (scene, camera) => {
  const c = (reel.cam && camera === game.camera) ? reel._cameraFor(camera) : null;
  return origRender(scene, c || camera);
};

window.__reel = reel;
console.log('[reel] page bot ready');
