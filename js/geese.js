// ============================================================
// GEESE — roadside geese that scatter and fly away as you ride through
// ============================================================
//
// Decorative only (#363). Geese live on the VERGES, never the racing line,
// and have no collision response: they must not perturb handling, crash
// detection, or scoring. The player ploughs through them because it looks
// great, not because the game asked them to.
//
// Deliberately rig-free. The moment lasts under a second at riding speed, so
// motion and audio sell it and articulation does not — a parabolic arc plus
// tumble reads unmistakably as "startled bird". Three design choices keep this
// an afternoon rather than a pipeline:
//
//   1. Flee on APPROACH, not contact. A proximity trigger lifts them before
//      the bike arrives, so most are never touched — which deletes the hard
//      collision case entirely and reads as more alive (real birds see you
//      coming).
//   2. Physics is the animator. Arc + tumble on a billboard, no skeleton.
//   3. Feathers and a honk carry the beat. Audio does most of the work.
//
// Placement, pooling and road-relative positioning follow ObstacleManager;
// the feather burst follows GrassParticles. faceCamera() exists for the same
// reason it does on obstacles: split-screen renders each rig with its own
// camera, so billboards must be re-faced per pass.

import * as THREE from 'three';
import { isMobile } from './config.js';

// Pool has to cover everything on screen at once: the visible window holds
// roughly (VISIBLE_AHEAD + VISIBLE_BEHIND) / GROUP_GAP groups, and airborne
// geese hold their slot past the window until they time out. Undersized, the
// far geese simply never appear.
const POOL_SIZE = isMobile ? 34 : 72;
const FEATHER_POOL = isMobile ? 90 : 220;

// A standing Canada goose is about a metre tall and near two across in flight.
const GOOSE_SIZE = 1.3;
const GOOSE_HALF = GOOSE_SIZE * 0.5;

const VISIBLE_AHEAD = 140;
const VISIBLE_BEHIND = 30;

// Verge placement: geese sit beyond the road edge (road half-width ~2.5) so
// they are scenery, not hazards. Riding onto the verge is what reaches them.
const VERGE_MIN = 3.3;
const VERGE_MAX = 7.0;

// Flee radius must stay BELOW VERGE_MIN, or riding down the centre of the road
// sits inside every goose's trigger and the whole verge flushes whether you
// went near them or not (what 7.0 did). But it wants to be as close to that
// ceiling as the margin allows, or scattering demands a direct hit.
//
// The margin has to be real, not a knife edge: geese wander and the verge clamp
// pins them at exactly VERGE_MIN, so a radius a hair under it would trigger on
// any small steering wobble — unpredictable, which is worse than either
// extreme. VERGE_MIN moved out to 3.3 to buy that headroom rather than trimming
// the radius further.
const FLEE_RADIUS = 3.0;

// Not every goose spooks at the same distance. Each carries a boldness factor
// scaling its own trigger, so a pass through a gaggle lifts the skittish ones
// while the bold ones hold their ground until you are right on top of them —
// truer to real birds, and what makes a scatter read as individuals reacting
// rather than one object dissolving.
const BOLDNESS_MIN = 0.60;
const BOLDNESS_VAR = 0.40;

// Two-phase flight. The burst is ballistic — that initial "thrown" pop is what
// sells the startle. Then gravity fades out and they beat away under their own
// power, climbing and accelerating into the distance. Staying ballistic the
// whole way made them arc up and fall back down like launched objects rather
// than birds leaving.
const BURST_TIME = 0.42;
const GOOSE_GRAVITY = 7.5;    // during burst only
const CLIMB_RATE = 2.2;       // steady climb once flying
const FLY_ACCEL = 3.4;        // horizontal beat-away acceleration
const FLY_SPEED_MAX = 15.0;
const GOOSE_LIFE = 5.0;       // long enough to get properly small

const FLAP_FRAMES = 4;
const FLAP_HZ = 9;            // wingbeats read best a bit slower than reality

// Three view angles. Which one a goose uses is picked at random on startle,
// together with a random horizontal flip (mesh.scale.x) — so 6 apparent
// headings from 3 drawings. Without this every goose leaves in the same
// profile and a gaggle reads as one object moving, not many.
const VIEW_SIDE = 0;      // full profile
const VIEW_QUARTER = 1;   // three-quarter, body foreshortened
const VIEW_AWAY = 2;      // from behind, wings spread symmetrically
const VIEW_COUNT = 3;

// How far a goose's escape heading may deviate from "straight away from the
// bike", in radians. Real flushed birds scatter; a shared vector looks
// choreographed.
const ESCAPE_SPREAD = 1.15;

// Ground behaviour. Geese potter about the verge: slow, mostly straight, with
// occasional pauses to graze. Wandering is deliberately gentle — birds that
// change heading constantly read as agitated, and these are meant to look
// oblivious right up until you arrive.
// Density. Gaps and group sizes are what make the verges feel populated —
// tuned for "a lot of them" rather than occasional set dressing.
const GROUP_GAP_MIN = 16;
const GROUP_GAP_VAR = 30;
const GROUP_MIN = 3;
const GROUP_VAR = 6;           // group of GROUP_MIN … GROUP_MIN+GROUP_VAR-1

// Honk throttle. A group of eight startling within a couple of frames would
// fire eight honks on top of each other and read as noise, not geese. Cap the
// rate and let the rest scatter silently — the eye fills in the sound.
const HONK_WINDOW_MS = 220;
const HONK_MAX_IN_WINDOW = 3;

const GROUND_FRAMES = 3;       // neck upright → grazing
const STRIDE_FRAMES = 4;       // leg positions through one walk cycle
const STRIDE_HZ = 3.4;         // steps/sec — geese waddle unhurriedly
const WALK_SPEED = 0.42;       // m/s
const WALK_TURN_RATE = 0.55;   // rad/s of heading drift while walking
const WALK_MIN = 1.6;          // seconds per walk/pause leg
const WALK_MAX = 4.5;
const PAUSE_CHANCE = 0.45;     // fraction of legs spent standing/grazing
const LEASH = 2.6;             // metres from spawn before steering back

const STATE_IDLE = 0;
const STATE_FLYING = 1;

// Seeded PRNG — identical placement across clients (versus) and reloads.
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Canada goose palette. The species reads by CONTRAST, not shape: a near-black
// neck against a hard white chinstrap, over a pale breast and a warm brown
// back. Get those four values apart and it reads at 20m and 3cm alike; muddy
// them together and it's a grey blob (which the first pass was).
const C_NECK   = '#141416';  // near-black head + neck
const C_CHEEK  = '#ffffff';  // chinstrap — the single strongest cue
const C_BREAST = '#e8dcc4';  // pale cream underside
const C_BACK   = '#6d5c43';  // warm brown back/wing
const C_WING   = '#5a4b36';  // darker wing, separates from the back
const C_WINGTIP= '#3a3026';  // primaries
const C_BILL   = '#0d0d0f';
const C_LEG    = '#1b1a1c';  // legs/feet — near-black, same read as the neck

/**
 * Goose sprite drawn to a canvas. Step 2 of #363 swaps these for a ComfyUI
 * sprite sheet; that swap is this function alone.
 *
 * @param {'idle'|'fly'} mode  standing (neck up, wings folded) or airborne
 *   (body horizontal, neck extended forward)
 * @param {number} frame  wing position 0..FLAP_FRAMES-1, ignored when idle
 */
function makeGooseTexture(mode, frame = 0, view = VIEW_SIDE, stride = -1) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');
  const flying = mode === 'fly';

  // Wing phase: -1 fully down … +1 fully up, around the flap cycle.
  const phase = flying ? Math.cos((frame / FLAP_FRAMES) * Math.PI * 2) : 0;

  const ell = (x, y, rx, ry, rot, fill) => {
    g.fillStyle = fill;
    g.beginPath();
    g.ellipse(x * S, y * S, rx * S, ry * S, rot, 0, Math.PI * 2);
    g.fill();
  };

  if (flying && view === VIEW_AWAY) {
    // Seen from behind — the common case, since most geese leave away from the
    // camera. Wings spread symmetrically, body foreshortened to almost nothing,
    // head a small dark knob above. Reads as "bird receding" far better than a
    // profile does when the flight vector points downrange.
    const spread = 0.30 + phase * 0.10;
    const lift = -phase * 0.13;
    for (const side of [-1, 1]) {
      g.save();
      g.translate(S * 0.5, S * 0.52);
      g.rotate(side * (0.20 - phase * 0.75));
      ell(side * spread, lift, 0.215, 0.058, 0, C_WING);
      ell(side * (spread + 0.15), lift, 0.09, 0.040, 0, C_WINGTIP);
      g.restore();
    }
    ell(0.50, 0.545, 0.088, 0.115, 0, C_BACK);        // foreshortened body
    ell(0.50, 0.585, 0.062, 0.075, 0, C_BREAST);
    g.fillStyle = C_WINGTIP;                          // tail below
    g.beginPath();
    g.moveTo(S * 0.455, S * 0.645);
    g.lineTo(S * 0.545, S * 0.645);
    g.lineTo(S * 0.50, S * 0.715);
    g.closePath();
    g.fill();
    g.strokeStyle = C_NECK;                           // neck straight away
    g.lineWidth = S * 0.055;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(S * 0.50, S * 0.475);
    g.lineTo(S * 0.50, S * 0.395);
    g.stroke();
    ell(0.50, 0.378, 0.046, 0.042, 0, C_NECK);
    ell(0.50, 0.400, 0.030, 0.016, 0, C_CHEEK);       // chinstrap from behind
  } else if (flying) {
    // Profile (VIEW_SIDE) and three-quarter (VIEW_QUARTER). The quarter view
    // compresses the body along x and shortens the neck reach, so the same
    // drawing code covers both without a second sprite set.
    const q = view === VIEW_QUARTER ? 0.62 : 1.0;   // horizontal foreshortening
    const cx = 0.5 - 0.03 * q;
    const sx = (x) => cx + (x - 0.5) * q;           // squash about centre

    // FAR wing first so the body overlaps it — cheap depth.
    const farY = 0.50 - phase * 0.16;
    g.save();
    g.translate(S * sx(0.44), S * farY);
    g.rotate(-phase * 0.55);
    ell(0, 0, 0.20 * q, 0.055, 0, C_WINGTIP);
    g.restore();

    // Body — horizontal, tapering to the tail
    ell(sx(0.47), 0.52, 0.23 * q, 0.115, -0.06 * q, C_BACK);
    ell(sx(0.47), 0.565, 0.20 * q, 0.075, -0.04 * q, C_BREAST);
    g.fillStyle = C_WINGTIP;
    g.beginPath();
    g.moveTo(S * sx(0.26), S * 0.50);
    g.lineTo(S * sx(0.14), S * 0.47);
    g.lineTo(S * sx(0.16), S * 0.56);
    g.closePath();
    g.fill();

    // Neck extended forward — the flight silhouette
    g.strokeStyle = C_NECK;
    g.lineWidth = S * 0.062;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(S * sx(0.66), S * 0.515);
    g.lineTo(S * sx(0.86), S * 0.478);
    g.stroke();

    ell(sx(0.885), 0.472, 0.052, 0.045, 0, C_NECK);
    ell(sx(0.868), 0.492, 0.020, 0.026, 0.5, C_CHEEK);
    g.fillStyle = C_BILL;
    g.beginPath();
    g.moveTo(S * sx(0.930), S * 0.462);
    g.lineTo(S * sx(0.985), S * 0.478);
    g.lineTo(S * sx(0.930), S * 0.492);
    g.closePath();
    g.fill();

    // NEAR wing over the body
    const nearY = 0.50 - phase * 0.20;
    g.save();
    g.translate(S * sx(0.46), S * nearY);
    g.rotate(-phase * 0.62);
    ell(0, 0, 0.235 * q, 0.068, 0, C_WING);
    ell(0.13 * q, 0.005, 0.105 * q, 0.040, 0, C_WINGTIP);
    g.restore();
  } else {
    // Ground poses. `frame` walks the neck from fully upright (0) down to
    // grazing (GROUND_FRAMES-1). Geese on a verge spend most of their time
    // head-down eating, so the pose cycle is doing most of the "alive" work —
    // more than the leg motion a billboard can't show anyway.
    const t = frame / (GROUND_FRAMES - 1);           // 0 up … 1 grazing

    // Legs go down FIRST so the body ellipse overlaps their tops and they
    // read as attached rather than stuck on. stride < 0 means standing:
    // both feet planted, slightly apart.
    const walking = stride >= 0;
    const sp = walking ? Math.sin((stride / STRIDE_FRAMES) * Math.PI * 2) : 0;
    const hipX = 0.505, hipY = 0.745;
    const leg = (dx, lift) => {
      const footX = hipX + dx;
      const footY = 0.905 - lift;
      g.strokeStyle = C_LEG;
      g.lineWidth = S * 0.030;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(S * hipX, S * hipY);
      g.quadraticCurveTo(S * (hipX + dx * 0.4), S * (hipY + 0.075), S * footX, S * footY);
      g.stroke();
      // Webbed foot — a small wedge, the cue that says waterfowl
      g.fillStyle = C_LEG;
      g.beginPath();
      g.moveTo(S * (footX - 0.030), S * (footY + 0.012));
      g.lineTo(S * (footX + 0.052), S * (footY + 0.012));
      g.lineTo(S * (footX + 0.010), S * (footY - 0.018));
      g.closePath();
      g.fill();
    };
    // Far leg first (dimmer via draw order under the body), then near leg.
    leg(walking ? -sp * 0.075 : -0.032, walking ? Math.max(0, -sp) * 0.045 : 0);
    leg(walking ? sp * 0.075 : 0.030, walking ? Math.max(0, sp) * 0.045 : 0);

    const headX = 0.745 + t * 0.115;
    const headY = 0.235 + t * 0.475;
    const ctrlX = 0.78 + t * 0.035;
    const ctrlY = 0.42 + t * 0.30;
    // Body tips forward as the neck goes down
    const tilt = -0.10 - t * 0.16;

    ell(0.50, 0.635, 0.235, 0.165, tilt, C_BACK);
    ell(0.505, 0.685, 0.205, 0.105, tilt * 0.6, C_BREAST);
    ell(0.455, 0.615, 0.175, 0.075, tilt - 0.06, C_WING);   // folded wing
    g.fillStyle = C_WINGTIP;                                 // tail lifts as head drops
    g.beginPath();
    g.moveTo(S * 0.29, S * (0.60 - t * 0.04));
    g.lineTo(S * 0.17, S * (0.575 - t * 0.09));
    g.lineTo(S * 0.20, S * (0.655 - t * 0.05));
    g.closePath();
    g.fill();

    g.strokeStyle = C_NECK;
    g.lineWidth = S * 0.070;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(S * 0.66, S * 0.60);
    g.quadraticCurveTo(S * ctrlX, S * ctrlY, S * headX, S * headY);
    g.stroke();

    ell(headX + 0.003, headY - 0.020, 0.056, 0.048, 0.1 + t * 0.6, C_NECK);
    ell(headX - 0.026, headY + 0.007, 0.021, 0.030, 0.25 + t * 0.6, C_CHEEK);
    g.fillStyle = C_BILL;
    const bx = headX + 0.052, by = headY - 0.032 + t * 0.055;
    g.beginPath();
    g.moveTo(S * bx, S * by);
    g.lineTo(S * (bx + 0.062), S * (by + 0.025));
    g.lineTo(S * bx, S * (by + 0.044));
    g.closePath();
    g.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

export class GeeseManager {
  /**
   * @param {THREE.Scene} scene
   * @param {object} roadPath  provides getPointAtDistance() + loopLength
   * @param {object} level     provides distance
   * @param {THREE.Camera} camera billboard target (versus re-faces per pass)
   * @param {object} [audio]   AudioEngine; honks are skipped when absent
   */
  constructor(scene, roadPath, level, camera, audio) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.audio = audio || null;
    this.enabled = true;

    this._loopLen = roadPath.loopLength;
    this._items = [];
    this._pool = [];
    this._honkWindowStart = 0;
    this._honksInWindow = 0;
    // Disruption tally. Attributed to the bike that startled each goose —
    // solo only ever uses index 0, but versus already passes multiple anchors,
    // so per-bike attribution is free here and avoids a rewrite later (#364).
    this._disrupted = [0, 0, 0, 0];

    // [pose][stride] — stride 0 is the standing (planted-feet) variant, so a
    // grazing goose isn't mid-step. Poses x strides is 3 x 5 small canvases.
    this._texIdle = [];
    for (let f = 0; f < GROUND_FRAMES; f++) {
      const strides = [makeGooseTexture('idle', f, VIEW_SIDE, -1)];
      for (let s = 0; s < STRIDE_FRAMES; s++) strides.push(makeGooseTexture('idle', f, VIEW_SIDE, s));
      this._texIdle.push(strides);
    }
    // [view][frame] — 3 views x 4 flap frames, plus a per-goose horizontal
    // flip at render time, giving 6 apparent headings from 3 drawings.
    this._texFly = [];
    for (let v = 0; v < VIEW_COUNT; v++) {
      const frames = [];
      for (let f = 0; f < FLAP_FRAMES; f++) frames.push(makeGooseTexture('fly', f, v));
      this._texFly.push(frames);
    }

    const geo = new THREE.PlaneGeometry(GOOSE_SIZE, GOOSE_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this._texIdle,
        transparent: true,
        alphaTest: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this._pool.push({ mesh, mat, itemIdx: -1 });
    }

    this._initFeathers();
    this._placeGeese();
  }

  // ---- feathers -------------------------------------------------------

  _initFeathers() {
    this._fLife = new Float32Array(FEATHER_POOL);
    this._fMaxLife = new Float32Array(FEATHER_POOL);
    this._fvx = new Float32Array(FEATHER_POOL);
    this._fvy = new Float32Array(FEATHER_POOL);
    this._fvz = new Float32Array(FEATHER_POOL);
    this._fNext = 0;

    const positions = new Float32Array(FEATHER_POOL * 3);
    const colors = new Float32Array(FEATHER_POOL * 3);
    const sizes = new Float32Array(FEATHER_POOL);

    this._fGeo = new THREE.BufferGeometry();
    this._fGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._fGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this._fGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    this._fMat = new THREE.PointsMaterial({
      size: 0.07,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      sizeAttenuation: true,
      depthWrite: false,
    });
    this._fPoints = new THREE.Points(this._fGeo, this._fMat);
    this._fPoints.frustumCulled = false;
    this.scene.add(this._fPoints);
  }

  _emitFeathers(x, y, z, count) {
    const pos = this._fGeo.attributes.position.array;
    const col = this._fGeo.attributes.color.array;
    const sz = this._fGeo.attributes.size.array;
    for (let n = 0; n < count; n++) {
      const i = this._fNext;
      this._fNext = (this._fNext + 1) % FEATHER_POOL;
      const idx = i * 3;
      pos[idx] = x + (Math.random() - 0.5) * 0.4;
      pos[idx + 1] = y + Math.random() * 0.5;
      pos[idx + 2] = z + (Math.random() - 0.5) * 0.4;
      // Off-white with a little variation so the burst isn't a flat blob
      const w = 0.88 + Math.random() * 0.12;
      col[idx] = w; col[idx + 1] = w; col[idx + 2] = w * 0.97;
      sz[i] = 0.5 + Math.random() * 0.6;
      this._fvx[i] = (Math.random() - 0.5) * 2.4;
      this._fvy[i] = 0.8 + Math.random() * 1.8;
      this._fvz[i] = (Math.random() - 0.5) * 2.4;
      this._fLife[i] = 1.4 + Math.random() * 1.2;
      this._fMaxLife[i] = this._fLife[i];
    }
    this._fGeo.attributes.position.needsUpdate = true;
    this._fGeo.attributes.color.needsUpdate = true;
    this._fGeo.attributes.size.needsUpdate = true;
  }

  _updateFeathers(dt) {
    const pos = this._fGeo.attributes.position.array;
    const sz = this._fGeo.attributes.size.array;
    let dirty = false;
    for (let i = 0; i < FEATHER_POOL; i++) {
      if (this._fLife[i] <= 0) continue;
      dirty = true;
      this._fLife[i] -= dt;
      if (this._fLife[i] <= 0) { sz[i] = 0; continue; }
      // Feathers flutter: weak gravity, heavy drag, a little wander.
      this._fvy[i] -= 1.6 * dt;
      this._fvx[i] *= (1 - 2.2 * dt);
      this._fvz[i] *= (1 - 2.2 * dt);
      this._fvx[i] += (Math.random() - 0.5) * 1.2 * dt;
      this._fvz[i] += (Math.random() - 0.5) * 1.2 * dt;
      const idx = i * 3;
      pos[idx] += this._fvx[i] * dt;
      pos[idx + 1] += this._fvy[i] * dt;
      pos[idx + 2] += this._fvz[i] * dt;
      sz[i] = 0.5 + (this._fLife[i] / this._fMaxLife[i]) * 0.6;
    }
    if (dirty) {
      this._fGeo.attributes.position.needsUpdate = true;
      this._fGeo.attributes.size.needsUpdate = true;
    }
  }

  // ---- placement ------------------------------------------------------

  _placeGeese() {
    const rng = makeRng(Math.floor((this.level?.distance || 1000) * 7) + 991);
    const dist = this.level?.distance || 1000;
    // Clustered, not evenly spread — a gaggle you can aim at beats a
    // uniform sprinkle, and gives the trailer a denser burst.
    let d = 40;
    while (d < dist - 40) {
      const side = rng() < 0.5 ? -1 : 1;
      const groupSize = GROUP_MIN + Math.floor(rng() * GROUP_VAR);
      const baseLateral = VERGE_MIN + rng() * (VERGE_MAX - VERGE_MIN);
      for (let n = 0; n < groupSize; n++) {
        const gd = d + rng() * 5;
        const glat = side * (baseLateral + (rng() - 0.5) * 1.6);
        this._items.push({
          absoluteD: gd,
          roadD: gd % this._loopLen,
          lateralOffset: glat,
          side,
          state: STATE_IDLE,
          poolIdx: -1,
          phase: rng() * Math.PI * 2,
          vx: 0, vy: 0, vz: 0,
          spin: 0,
          age: 0,
          // Standing geese face either way too, so a gaggle isn't a row of
          // clones. view/flapOffset are re-rolled on startle.
          view: VIEW_SIDE,
          flip: rng() < 0.5 ? -1 : 1,
          flapOffset: 0,
          boldness: BOLDNESS_MIN + rng() * BOLDNESS_VAR,
          // Ground wander. homeD/homeLat is the spawn point the leash pulls
          // back toward, so a gaggle stays a gaggle instead of dispersing.
          homeD: gd, homeLat: glat,
          heading: rng() * Math.PI * 2,
          walking: rng() > PAUSE_CHANCE,
          legTimer: WALK_MIN + rng() * (WALK_MAX - WALK_MIN),
          pose: 0,          // 0..GROUND_FRAMES-1, eased toward poseTarget
          poseTarget: 0,
          _worldX: 0, _worldY: 0, _worldZ: 0,
        });
      }
      d += GROUP_GAP_MIN + rng() * GROUP_GAP_VAR;
    }
  }

  // ---- update ---------------------------------------------------------

  /** Solo: one anchor. @param {THREE.Vector3[]} bikePositions flee sources */
  update(dt, bikeDistanceTraveled, bikePositions) {
    this._updateWithAnchors(dt, [bikeDistanceTraveled], bikePositions);
  }

  /** Versus: pool follows every team's bike. */
  updateVersus(dt, anchorDs, bikePositions) {
    this._updateWithAnchors(dt, anchorDs, bikePositions);
  }

  _nearAny(absoluteD, anchorDs) {
    for (const d of anchorDs) {
      if (absoluteD > d - VISIBLE_BEHIND && absoluteD < d + VISIBLE_AHEAD) return true;
    }
    return false;
  }

  _updateWithAnchors(dt, anchorDs, bikePositions) {
    if (!this.enabled) return;
    this._updateFeathers(dt);

    const bikes = Array.isArray(bikePositions)
      ? bikePositions
      : (bikePositions ? [bikePositions] : []);

    // Release pool slots for items that left the window. Airborne geese keep
    // their slot regardless: absoluteD is their ground position and never
    // moves, so a goose startled just ahead falls out of the window ~2s after
    // you pass it — while it is still climbing in the upper half of the frame.
    // Releasing it there pops it out of existence mid-flight.
    for (const slot of this._pool) {
      if (slot.itemIdx < 0) continue;
      const item = this._items[slot.itemIdx];
      if (item && item.state === STATE_FLYING) continue;
      if (!item || !this._nearAny(item.absoluteD, anchorDs)) {
        slot.mesh.visible = false;
        slot.itemIdx = -1;
        if (item) item.poolIdx = -1;
      }
    }

    const t = performance.now() / 1000;

    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      // Airborne geese keep integrating even once their ground position leaves
      // the window — they hold a pool slot until they land or time out, and
      // skipping them here would freeze them in mid-air instead.
      if (item.state !== STATE_FLYING && !this._nearAny(item.absoluteD, anchorDs)) continue;

      if (item.state === STATE_IDLE) {
        this._wander(item, dt);
        const pt = this.roadPath.getPointAtDistance(item.roadD);
        const rightX = Math.cos(pt.heading);
        const rightZ = -Math.sin(pt.heading);
        item._worldX = pt.x + rightX * item.lateralOffset;
        item._worldZ = pt.z + rightZ * item.lateralOffset;
        item._worldY = pt.y;

        // Proximity flee — the whole reason contact never has to be handled.
        for (let bi = 0; bi < bikes.length; bi++) {
          const b = bikes[bi];
          if (!b) continue;
          const dx = b.x - item._worldX;
          const dz = b.z - item._worldZ;
          const d2 = dx * dx + dz * dz;
          const r = FLEE_RADIUS * item.boldness;
          if (d2 < r * r) {
            this._startle(item, dx, dz, Math.sqrt(d2), bi);
            break;
          }
        }
      } else {
        item.age += dt;
        if (item.age < BURST_TIME) {
          // Ballistic pop — the startle
          item.vy -= GOOSE_GRAVITY * dt;
        } else {
          // Under their own power now: settle to a steady climb and beat away.
          item.vy += (CLIMB_RATE - item.vy) * Math.min(1, 2.5 * dt);
          const sp = Math.hypot(item.vx, item.vz);
          if (sp > 0.001 && sp < FLY_SPEED_MAX) {
            const k = 1 + (FLY_ACCEL * dt) / sp;
            item.vx *= k;
            item.vz *= k;
          }
        }
        item._worldX += item.vx * dt;
        item._worldY += item.vy * dt;
        item._worldZ += item.vz * dt;
        if (item.age > GOOSE_LIFE) {
          // Recycle: drop it far ahead so a long ride keeps finding geese.
          item.state = STATE_IDLE;
          item.age = 0;
          item.absoluteD += 600;
          item.roadD = item.absoluteD % this._loopLen;
          if (item.poolIdx >= 0) {
            this._pool[item.poolIdx].mesh.visible = false;
            this._pool[item.poolIdx].itemIdx = -1;
            item.poolIdx = -1;
          }
          continue;
        }
      }

      // Assign a pool slot on demand
      if (item.poolIdx < 0) {
        const free = this._pool.findIndex(s => s.itemIdx < 0);
        if (free < 0) continue;
        item.poolIdx = free;
        this._pool[free].itemIdx = i;
      }

      const slot = this._pool[item.poolIdx];
      if (item.state === STATE_IDLE) {
        // Idle bob — enough life that a still goose doesn't look like a decal
        // Walking geese bob at a stride cadence; standing ones just breathe.
        const bob = item.walking
          ? Math.abs(Math.sin(t * 5.2 + item.phase)) * 0.035
          : Math.sin(t * 1.6 + item.phase) * 0.02;
        slot.mesh.position.set(item._worldX, item._worldY + GOOSE_HALF + bob, item._worldZ);
        slot.mesh.rotation.z = 0;
        // Face the way it's walking, as seen by THIS camera: project the road-
        // space heading into world space and compare with the camera's right
        // vector. A billboard has no yaw of its own, so the mirror is the only
        // thing that can express which way the bird is pointing.
        slot.mesh.scale.x = item.walking
          ? this._flipForHeading(this.camera, item)
          : item.flip;
        const pf = Math.min(GROUND_FRAMES - 1, Math.max(0, Math.round(item.pose)));
        // stride index 0 = planted; 1..STRIDE_FRAMES = the walk cycle
        const sf = item.walking
          ? 1 + (Math.floor(t * STRIDE_HZ + item.phase) % STRIDE_FRAMES)
          : 0;
        const tex = this._texIdle[pf][sf];
        if (slot.mat.map !== tex) { slot.mat.map = tex; slot.mat.needsUpdate = true; }
      } else {
        slot.mesh.position.set(item._worldX, item._worldY, item._worldZ);
        const f = Math.floor(item.age * FLAP_HZ + item.flapOffset) % FLAP_FRAMES;
        const tex = this._texFly[item.view][f];
        if (slot.mat.map !== tex) { slot.mat.map = tex; slot.mat.needsUpdate = true; }
        // Flip mirrors the sprite so a heading can point either way.
        slot.mesh.scale.x = item.flip;
      }
      if (this.camera) slot.mesh.quaternion.copy(this.camera.quaternion);
      // Tumble applied AFTER the billboard quaternion so it reads as roll about
      // the view axis rather than fighting the facing. It decays with the
      // burst: a startled bird tips as it leaves the ground, then levels off.
      // Carrying the spin the whole way makes it read as a thrown object.
      if (item.state === STATE_FLYING) slot.mesh.rotateZ(this._tiltFor(item));
      slot.mesh.visible = true;
    }
  }

  /**
   * Potter about the verge. Movement is in ROAD space — heading 0 is along the
   * road, PI/2 is across it — so the leash and the verge clamp are both simple
   * scalars and a goose can never wander onto the racing line no matter how
   * the road curves.
   *
   * Legs alternate walk/pause. Grazing is tied to standing still, because a
   * goose that walks with its head down looks broken, and one that never puts
   * its head down looks like a statue.
   */
  /**
   * Mirror a walking goose so it faces its direction of travel on screen.
   * Road-space heading → world direction → dot with the camera's right axis.
   * Returns +1/-1 for mesh.scale.x. Falls back to the goose's stored flip
   * when there's no camera or the motion is edge-on.
   */
  _flipForHeading(camera, item) {
    if (!camera) return item.flip;
    const pt = this.roadPath.getPointAtDistance(item.roadD);
    // Road tangent (heading 0) and its right normal (heading PI/2)
    const fwdX = Math.sin(pt.heading), fwdZ = Math.cos(pt.heading);
    const rgtX = Math.cos(pt.heading), rgtZ = -Math.sin(pt.heading);
    const ch = Math.cos(item.heading), sh = Math.sin(item.heading);
    const dirX = fwdX * ch + rgtX * sh;
    const dirZ = fwdZ * ch + rgtZ * sh;
    const e = camera.matrixWorld.elements;   // camera right axis = column 0
    const dot = dirX * e[0] + dirZ * e[2];
    if (Math.abs(dot) < 0.08) return item.flip;
    return dot > 0 ? 1 : -1;
  }

  _wander(item, dt) {
    item.legTimer -= dt;
    if (item.legTimer <= 0) {
      item.walking = Math.random() > PAUSE_CHANCE;
      item.legTimer = WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN);
      // Standing geese graze; walkers carry their heads up.
      item.poseTarget = item.walking ? 0 : 1 + Math.floor(Math.random() * (GROUND_FRAMES - 1));
      if (item.walking) item.heading += (Math.random() - 0.5) * 1.4;
    }

    // Ease the neck between poses so it lifts and lowers instead of snapping.
    item.pose += (item.poseTarget - item.pose) * Math.min(1, 3.2 * dt);

    if (!item.walking) return;

    // Gentle heading drift — enough that paths curve, not so much they look
    // agitated.
    item.heading += (Math.random() - 0.5) * WALK_TURN_RATE * dt;

    const alongD = Math.cos(item.heading) * WALK_SPEED * dt;
    const acrossD = Math.sin(item.heading) * WALK_SPEED * dt;
    item.absoluteD += alongD;
    item.roadD = ((item.absoluteD % this._loopLen) + this._loopLen) % this._loopLen;
    item.lateralOffset += acrossD;

    // Verge clamp: never step inside VERGE_MIN (the road) or past VERGE_MAX.
    const mag = Math.abs(item.lateralOffset);
    if (mag < VERGE_MIN || mag > VERGE_MAX + 1.0) {
      item.lateralOffset = item.side * Math.min(VERGE_MAX, Math.max(VERGE_MIN, mag));
      item.heading = Math.PI - item.heading;   // turn back
    }

    // Leash toward home so a gaggle stays together over a long ride.
    const dHome = item.absoluteD - item.homeD;
    const latHome = item.lateralOffset - item.homeLat;
    if (Math.hypot(dHome, latHome) > LEASH) {
      const want = Math.atan2(-latHome, -dHome);
      let diff = want - item.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      item.heading += diff * Math.min(1, 1.5 * dt);
    }
  }

  /**
   * Body roll for an airborne goose: a sharp tip during the ballistic burst
   * that decays to level as it settles into flight. Shared by update() and
   * faceCamera() so split-screen passes agree.
   */
  _tiltFor(item) {
    const decay = Math.max(0, 1 - item.age / (BURST_TIME * 2.2));
    return item.spin * item.age * decay * decay;
  }

  /** Launch one goose: arc away from the bike, tumbling, feathers, honk. */
  _startle(item, dx, dz, dist, bikeIndex = 0) {
    item.state = STATE_FLYING;
    item.age = 0;
    if (bikeIndex >= 0 && bikeIndex < this._disrupted.length) this._disrupted[bikeIndex]++;
    // Away from the bike, with a forward bias so they burst outward rather
    // than hanging in the player's face.
    const inv = dist > 0.001 ? 1 / dist : 0;
    let awayX = -dx * inv;
    let awayZ = -dz * inv;

    // Scatter the heading. Every goose leaving on the exact away-vector looks
    // choreographed; real flushed birds fan out. Rotate the away-vector by a
    // random yaw within ESCAPE_SPREAD.
    const yaw = (Math.random() - 0.5) * 2 * ESCAPE_SPREAD;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const rx = awayX * cs - awayZ * sn;
    const rz = awayX * sn + awayZ * cs;
    awayX = rx; awayZ = rz;

    const speed = 4.0 + Math.random() * 2.6;
    item.vx = awayX * speed;
    item.vz = awayZ * speed;
    item.vy = 4.8 + Math.random() * 2.6;
    item.spin = (Math.random() - 0.5) * 4.0;

    // Appearance: random view + flip, and a random flap phase so a whole
    // gaggle doesn't beat its wings in unison.
    item.view = Math.floor(Math.random() * VIEW_COUNT);
    item.flip = Math.random() < 0.5 ? -1 : 1;
    item.flapOffset = Math.random() * FLAP_FRAMES;
    item._worldY += GOOSE_HALF;

    this._emitFeathers(item._worldX, item._worldY, item._worldZ, 5 + Math.floor(Math.random() * 5));

    // Throttled: a big group startles within a couple of frames, and eight
    // simultaneous honks read as noise rather than birds. The silent ones still
    // look right — the eye supplies the sound.
    if (this.audio && typeof this.audio.gooseHonk === 'function') {
      const now = performance.now();
      if (now - this._honkWindowStart > HONK_WINDOW_MS) {
        this._honkWindowStart = now;
        this._honksInWindow = 0;
      }
      if (this._honksInWindow < HONK_MAX_IN_WINDOW) {
        this._honksInWindow++;
        this.audio.gooseHonk();
      }
    }
  }

  /**
   * Geese startled so far. Pass a bike index for that bike's own tally
   * (versus); omit it for the total across all bikes.
   */
  getDisruptedCount(bikeIndex) {
    if (bikeIndex == null) return this._disrupted.reduce((a, b) => a + b, 0);
    return this._disrupted[bikeIndex] || 0;
  }

  /** Re-face billboards for a split-screen render pass. */
  faceCamera(camera) {
    if (!camera) return;
    for (const slot of this._pool) {
      if (slot.itemIdx < 0 || !slot.mesh.visible) continue;
      const item = this._items[slot.itemIdx];
      slot.mesh.quaternion.copy(camera.quaternion);
      if (item && item.state === STATE_FLYING) slot.mesh.rotateZ(this._tiltFor(item));
    }
  }

  clear() {
    this._disrupted.fill(0);
    for (const slot of this._pool) {
      slot.mesh.visible = false;
      slot.itemIdx = -1;
    }
    for (const item of this._items) {
      item.state = STATE_IDLE;
      item.poolIdx = -1;
      item.age = 0;
    }
    this._fLife.fill(0);
    const sz = this._fGeo.attributes.size.array;
    sz.fill(0);
    this._fGeo.attributes.size.needsUpdate = true;
  }

  dispose() {
    for (const slot of this._pool) {
      this.scene.remove(slot.mesh);
      slot.mat.dispose();
    }
    this._pool.length = 0;
    this.scene.remove(this._fPoints);
    this._fGeo.dispose();
    this._fMat.dispose();
    for (const strides of this._texIdle) for (const t of strides) t.dispose();
    for (const frames of this._texFly) for (const t of frames) t.dispose();
  }
}
