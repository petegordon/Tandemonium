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

const POOL_SIZE = isMobile ? 14 : 28;
const FEATHER_POOL = isMobile ? 60 : 140;

const VISIBLE_AHEAD = 140;
const VISIBLE_BEHIND = 30;

// Verge placement: geese sit beyond the road edge (road half-width ~2.5) so
// they are scenery, not hazards. Riding onto the verge is what reaches them.
const VERGE_MIN = 2.9;
const VERGE_MAX = 6.5;

const FLEE_RADIUS = 7.0;      // start lifting this far out
const FLEE_RADIUS_SQ = FLEE_RADIUS * FLEE_RADIUS;

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

/**
 * Goose sprite drawn to a canvas. Step 2 of #363 swaps these for a ComfyUI
 * sprite sheet; that swap is this function alone.
 *
 * @param {'idle'|'fly'} mode  standing (neck up, wings folded) or airborne
 *   (body horizontal, neck extended forward)
 * @param {number} frame  wing position 0..FLAP_FRAMES-1, ignored when idle
 */
function makeGooseTexture(mode, frame = 0) {
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

  if (flying) {
    // FAR wing first so the body overlaps it — cheap depth.
    const farY = 0.50 - phase * 0.16;
    g.save();
    g.translate(S * 0.44, S * farY);
    g.rotate(-phase * 0.55);
    ell(0, 0, 0.20, 0.055, 0, C_WINGTIP);
    g.restore();

    // Body — horizontal, tapering to the tail
    ell(0.47, 0.52, 0.23, 0.115, -0.06, C_BACK);
    ell(0.47, 0.565, 0.20, 0.075, -0.04, C_BREAST);   // pale underside
    // Tail
    g.fillStyle = C_WINGTIP;
    g.beginPath();
    g.moveTo(S * 0.26, S * 0.50);
    g.lineTo(S * 0.14, S * 0.47);
    g.lineTo(S * 0.16, S * 0.56);
    g.closePath();
    g.fill();

    // Neck extended straight forward — the flight silhouette
    g.strokeStyle = C_NECK;
    g.lineWidth = S * 0.062;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(S * 0.66, S * 0.515);
    g.lineTo(S * 0.86, S * 0.478);
    g.stroke();

    ell(0.885, 0.472, 0.052, 0.045, 0, C_NECK);       // head
    ell(0.868, 0.492, 0.020, 0.026, 0.5, C_CHEEK);    // chinstrap
    g.fillStyle = C_BILL;
    g.beginPath();
    g.moveTo(S * 0.930, S * 0.462);
    g.lineTo(S * 0.985, S * 0.478);
    g.lineTo(S * 0.930, S * 0.492);
    g.closePath();
    g.fill();

    // NEAR wing over the body
    const nearY = 0.50 - phase * 0.20;
    g.save();
    g.translate(S * 0.46, S * nearY);
    g.rotate(-phase * 0.62);
    ell(0, 0, 0.235, 0.068, 0, C_WING);
    ell(0.13, 0.005, 0.105, 0.040, 0, C_WINGTIP);     // primaries
    g.restore();
  } else {
    // Standing: upright neck, wings folded along the back
    ell(0.50, 0.635, 0.235, 0.165, -0.10, C_BACK);
    ell(0.505, 0.685, 0.205, 0.105, -0.06, C_BREAST);
    ell(0.455, 0.615, 0.175, 0.075, -0.16, C_WING);   // folded wing
    // Tail
    g.fillStyle = C_WINGTIP;
    g.beginPath();
    g.moveTo(S * 0.29, S * 0.60);
    g.lineTo(S * 0.17, S * 0.575);
    g.lineTo(S * 0.20, S * 0.655);
    g.closePath();
    g.fill();

    g.strokeStyle = C_NECK;
    g.lineWidth = S * 0.070;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(S * 0.66, S * 0.60);
    g.quadraticCurveTo(S * 0.78, S * 0.42, S * 0.745, S * 0.235);
    g.stroke();

    ell(0.748, 0.215, 0.056, 0.048, 0.1, C_NECK);
    ell(0.722, 0.242, 0.021, 0.030, 0.25, C_CHEEK);
    g.fillStyle = C_BILL;
    g.beginPath();
    g.moveTo(S * 0.800, S * 0.203);
    g.lineTo(S * 0.862, S * 0.228);
    g.lineTo(S * 0.800, S * 0.247);
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

    this._texIdle = makeGooseTexture('idle');
    this._texFly = [];
    for (let f = 0; f < FLAP_FRAMES; f++) this._texFly.push(makeGooseTexture('fly', f));

    const geo = new THREE.PlaneGeometry(0.85, 0.85);
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
      const groupSize = 2 + Math.floor(rng() * 4);
      const baseLateral = VERGE_MIN + rng() * (VERGE_MAX - VERGE_MIN);
      for (let n = 0; n < groupSize; n++) {
        this._items.push({
          absoluteD: d + rng() * 5,
          roadD: (d + rng() * 5) % this._loopLen,
          lateralOffset: side * (baseLateral + (rng() - 0.5) * 1.6),
          state: STATE_IDLE,
          poolIdx: -1,
          phase: rng() * Math.PI * 2,
          vx: 0, vy: 0, vz: 0,
          spin: 0,
          age: 0,
          _worldX: 0, _worldY: 0, _worldZ: 0,
        });
      }
      d += 45 + rng() * 90;
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
        const pt = this.roadPath.getPointAtDistance(item.roadD);
        const rightX = Math.cos(pt.heading);
        const rightZ = -Math.sin(pt.heading);
        item._worldX = pt.x + rightX * item.lateralOffset;
        item._worldZ = pt.z + rightZ * item.lateralOffset;
        item._worldY = pt.y;

        // Proximity flee — the whole reason contact never has to be handled.
        for (const b of bikes) {
          if (!b) continue;
          const dx = b.x - item._worldX;
          const dz = b.z - item._worldZ;
          const d2 = dx * dx + dz * dz;
          if (d2 < FLEE_RADIUS_SQ) {
            this._startle(item, dx, dz, Math.sqrt(d2));
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
        const bob = Math.sin(t * 1.6 + item.phase) * 0.03;
        slot.mesh.position.set(item._worldX, item._worldY + 0.42 + bob, item._worldZ);
        slot.mesh.rotation.z = 0;
        if (slot.mat.map !== this._texIdle) { slot.mat.map = this._texIdle; slot.mat.needsUpdate = true; }
      } else {
        slot.mesh.position.set(item._worldX, item._worldY, item._worldZ);
        const f = Math.floor(item.age * FLAP_HZ) % FLAP_FRAMES;
        const tex = this._texFly[f];
        if (slot.mat.map !== tex) { slot.mat.map = tex; slot.mat.needsUpdate = true; }
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
   * Body roll for an airborne goose: a sharp tip during the ballistic burst
   * that decays to level as it settles into flight. Shared by update() and
   * faceCamera() so split-screen passes agree.
   */
  _tiltFor(item) {
    const decay = Math.max(0, 1 - item.age / (BURST_TIME * 2.2));
    return item.spin * item.age * decay * decay;
  }

  /** Launch one goose: arc away from the bike, tumbling, feathers, honk. */
  _startle(item, dx, dz, dist) {
    item.state = STATE_FLYING;
    item.age = 0;
    // Away from the bike, with a forward bias so they burst outward rather
    // than hanging in the player's face.
    const inv = dist > 0.001 ? 1 / dist : 0;
    const awayX = -dx * inv;
    const awayZ = -dz * inv;
    const speed = 4.0 + Math.random() * 2.6;
    item.vx = awayX * speed + (Math.random() - 0.5) * 1.4;
    item.vz = awayZ * speed + (Math.random() - 0.5) * 1.4;
    item.vy = 5.2 + Math.random() * 2.0;
    item.spin = (Math.random() - 0.5) * 4.0;
    item._worldY += 0.42;

    this._emitFeathers(item._worldX, item._worldY, item._worldZ, 5 + Math.floor(Math.random() * 5));
    if (this.audio && typeof this.audio.gooseHonk === 'function') {
      this.audio.gooseHonk();
    }
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
    this._texIdle.dispose();
    for (const t of this._texFly) t.dispose();
  }
}
