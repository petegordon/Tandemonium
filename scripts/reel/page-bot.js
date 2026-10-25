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
    if (this.noPip && !this.keepRoad) this._clearRoad();
    for (const b of this.bots) if (b.enabled) this._drive(b, dt);
    if (this.faces) for (const f of Object.values(this.faces)) {
      for (const k of ['honkT', 'blinkT', 'startleT']) if (f[k] >= 0) f[k] += dt;
    }
  },

  // ---------------------------------------------------------------- faces (trailer: honk + startle)
  /**
   * Give both riders a face layer: honk (jaw + tongue + neck, the rider GLB's own honk clip), blink, and a
   * STARTLE: eyes go wide (lids pulled back past rest, the blink run backwards), the head jerks up and back,
   * then a hard blink. Applied after the riding clips every frame (they never key the face bones).
   */
  async setupFaces(outfit) {
    const { GOOSE_OUTFITS } = await import('/js/goose-outfits.js');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const goose = game.bike.goose; if (!goose) return;
    const loader = new GLTFLoader(), paths = GOOSE_OUTFITS[outfit] || GOOSE_OUTFITS.victorian;
    const Q = game.camera.quaternion.constructor;
    this.faces = {};
    for (const seat of ['Captain', 'Stoker']) {
      const r = goose.riders[seat]; if (!r) continue;
      const gltf = await loader.loadAsync(paths[seat]);
      const bones = {}; r.root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
      const tr = {};
      for (const cn of ['honk', 'blink']) {
        const c = gltf.animations.find((a) => a.name === cn); if (!c) continue;
        for (const t of c.tracks) {
          const dot = t.name.lastIndexOf('.'), b = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
          if (prop === 'scale' || !bones[b]) continue;
          const n = t.getValueSize();
          tr[cn + ':' + b + '.' + prop] = { bone: bones[b], prop, interp: t.createInterpolant(), dur: c.duration,
            rest: Array.from(t.values.slice(0, n)) };
        }
      }
      // rest-relative rotations: the honk's neck at full stretch, the blink fully closed (-> run backwards = wide)
      const rel = (key, at) => { const k = tr[key]; if (!k) return null;
        const v = new Q().fromArray(k.interp.evaluate(at)); return new Q().fromArray(k.rest).invert().multiply(v); };
      const f = { seat, bones, tr, honkT: -1, blinkT: -1, startleT: -1, Q,
        neckUp: Object.fromEntries(['Neck', 'Neck1', 'Head'].map((b) => [b, rel('honk:' + b + '.quaternion', 0.5)])),
        lidShut: Object.fromEntries(['LeftEyelidUpper', 'RightEyelidUpper', 'LeftEyelidLower', 'RightEyelidLower']
          .map((b) => [b, rel('blink:' + b + '.quaternion', 0.16)])) };
      // the hat rides HatSocket (as in the Goose Studio), so a startle can pop it off the head
      r.root.traverse((m) => {
        if (!m.isSkinnedMesh || !/hat/i.test(m.name + (m.parent ? m.parent.name : ''))) return;
        const sb = m.skeleton.bones, hi = sb.findIndex((x) => x.name === 'Head'), si = sb.findIndex((x) => x.name === 'HatSocket');
        if (hi < 0 || si < 0) return;
        const a = m.geometry.attributes.skinIndex;
        for (let i = 0; i < a.array.length; i++) if (a.array[i] === hi) a.array[i] = si;
        a.needsUpdate = true;
      });
      this.faces[seat] = f;
    }
    if (!goose.__faces) {
      goose.__faces = true;
      const orig = goose.update.bind(goose);
      goose.update = (...a) => { orig(...a); this._applyFaces(); };
    }
    console.log('[reel] faces', Object.keys(this.faces));
  },
  startleGain: { neck: 4.0, head: 1.4, spine: 1.2, lids: 1.0, eyes: 0.28, hat: 0.3 },
  honk(seat) { const f = this.faces && this.faces[seat]; if (f) f.honkT = 0; },
  startle(seats = ['Captain', 'Stoker'], stagger = 0.06) {
    seats.forEach((s, i) => { const f = this.faces && this.faces[s]; if (f) f.startleT = -i * stagger - 1e-6; });
    // a negative time is "about to": start them a frame or two apart, so the pair don't move like one
    for (const s of seats) { const f = this.faces && this.faces[s]; if (f && f.startleT < 0) { f._delay = -f.startleT; f.startleT = 0; } }
  },
  /** startle envelope: snap in 70 ms, hold, ease out by 1.3 s */
  _startleW(t) {
    if (t < 0) return 0;
    if (t < 0.07) return t / 0.07;
    if (t < 0.55) return 1;
    if (t < 1.3) { const u = (t - 0.55) / 0.75; return 1 - u * u * (3 - 2 * u); }
    return 0;
  },
  _applyFaces() {
    for (const f of Object.values(this.faces || {})) {
      const Q = f.Q, I = new Q();
      const setFrom = (clip, t, only) => {
        for (const [key, k] of Object.entries(f.tr)) {
          if (!key.startsWith(clip + ':')) continue;
          const bn = key.slice(clip.length + 1, key.lastIndexOf('.'));
          if (!only(bn)) continue;
          const v = t >= 0 ? k.interp.evaluate(Math.min(t, k.dur - 1e-3)) : k.rest;
          if (k.prop === 'quaternion') k.bone.quaternion.fromArray(v); else if (k.prop === 'position') k.bone.position.fromArray(v);
        }
      };
      const st = f.startleT >= 0 ? f.startleT - (f._delay || 0) : -1;
      const w = this._startleW(st);
      // a hard blink as the startle lets go
      const blinkT = f.blinkT >= 0 ? f.blinkT : (st > 1.05 && st < 1.55 ? st - 1.05 : -1);
      if (f.honkT > (f.tr['honk:Jaw.quaternion']?.dur ?? 1.25)) f.honkT = -1;
      if (f.blinkT > 0.5) f.blinkT = -1;
      if (st > 2) { f.startleT = -1; f._delay = 0; }
      setFrom('honk', f.honkT, (b) => b === 'Jaw' || b === 'Tongue');
      setFrom('blink', blinkT, (b) => /Eyelid/.test(b));
      // neck: the honk's own stretch, plus the startle's jerk (the same stretch, much harder) on top of the riding pose
      const pow = (q, a) => { const out = new Q(); let left = a; while (left > 1e-4) { const k = Math.min(1, left); out.multiply(new Q().slerpQuaternions(I, q, k)); left -= k; } return out; };
      for (const b of ['Neck', 'Neck1', 'Head']) {
        const bone = f.bones[b], up = f.neckUp[b]; if (!bone || !up) continue;
        if (f.honkT >= 0) { const k = f.tr['honk:' + b + '.quaternion'];
          const v = new Q().fromArray(k.interp.evaluate(Math.min(f.honkT, k.dur - 1e-3)));
          bone.quaternion.multiply(new Q().fromArray(k.rest).invert().multiply(v)); }
        const amt = w * (b === 'Head' ? this.startleGain.head : this.startleGain.neck);
        if (amt > 0) bone.quaternion.multiply(pow(up, amt));
      }
      // the body flinches back with it
      if (w > 0 && f.bones.Spine2 && f.neckUp.Neck) f.bones.Spine2.quaternion.multiply(pow(f.neckUp.Neck, w * this.startleGain.spine));
      // eyes wide: the lids pulled back past rest (the blink, backwards), and the eyes themselves pop
      if (w > 0) for (const [b, shut] of Object.entries(f.lidShut)) {
        const bone = f.bones[b]; if (!bone || !shut) continue;
        bone.quaternion.multiply(new Q().slerpQuaternions(I, shut.clone().invert(), this.startleGain.lids * w));
      }
      for (const b of ['LeftEye', 'RightEye']) { const bone = f.bones[b]; if (bone) bone.scale.setScalar(1 + this.startleGain.eyes * w); }
      // and the hat jumps off the head
      const hs = f.bones.HatSocket;
      if (hs) {
        if (!f.hatRest) f.hatRest = hs.position.clone();
        const hop = st >= 0 && st < 0.6 ? Math.sin(Math.PI * st / 0.6) * this.startleGain.hat : 0;
        hs.position.copy(f.hatRest);
        if (hop > 0) { const V = hs.position.constructor; hs.parent.updateMatrixWorld(true);
          const a = hs.parent.worldToLocal(hs.getWorldPosition(new V()).add(new V(0, hop, 0))); hs.position.copy(a); }
      }
    }
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
    const want0 = b.dodge === false ? (b.offset || 0) : this._lane(b, bike);
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

  grandma() { const gf = game.world && game.world._grandmaFinish; return gf ? gf.grandma : null; },

  _bikeFrame(bike) {
    const V = THREE_V();
    if (this.cam && this.cam.anchor === 'grandma' && this.grandma()) {
      const g = this.grandma().group; g.updateMatrixWorld(true);
      const ctr = g.getWorldPosition(new V()).add(new V(0, this.cam.anchorH ?? 2.2, 0));
      const fwd = new V(0, 0, 1).applyQuaternion(g.getWorldQuaternion(game.camera.quaternion.clone())); fwd.y = 0; fwd.normalize();
      return { ctr, fwd };
    }
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
  // the house is a video billboard turned to face the game's camera: turn it to ours (else it's a thin shard)
  if (c) for (const m of (game.world && game.world._raceMarkers) || []) if (m.billboard && m.mesh.visible) m.mesh.quaternion.copy(c.quaternion);
  return origRender(scene, c || camera);
};

window.__reel = reel;
console.log('[reel] page bot ready');
