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
const GOOSE_GRAVITY = 5.5;
const GOOSE_LIFE = 3.2;       // seconds airborne before recycling

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

/**
 * Placeholder goose sprite drawn to a canvas — a white body, dark head and
 * bill in the Canada-goose read, over a transparent background. Step 2 of
 * #363 replaces this with a ComfyUI-generated sprite sheet; the swap is this
 * function only, so nothing else in the system changes.
 * @param {boolean} wingsUp draw the raised-wing frame
 */
function makeGooseTexture(wingsUp) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d');

  const body = '#f2f0ea';
  const dark = '#2b2b2f';

  // Body — fat ellipse, slightly nose-down
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(S * 0.52, S * 0.62, S * 0.26, S * 0.19, -0.15, 0, Math.PI * 2);
  g.fill();

  // Wings — the only thing that differs between frames. Up reads as flapping.
  g.fillStyle = wingsUp ? '#e6e3db' : '#dedbd3';
  g.beginPath();
  if (wingsUp) {
    g.ellipse(S * 0.50, S * 0.36, S * 0.20, S * 0.11, -0.55, 0, Math.PI * 2);
  } else {
    g.ellipse(S * 0.50, S * 0.66, S * 0.22, S * 0.09, 0.18, 0, Math.PI * 2);
  }
  g.fill();

  // Neck + head — dark, the strongest silhouette cue at distance
  g.strokeStyle = dark;
  g.lineWidth = S * 0.075;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(S * 0.70, S * 0.58);
  g.quadraticCurveTo(S * 0.80, S * 0.40, S * 0.76, S * 0.24);
  g.stroke();

  g.fillStyle = dark;
  g.beginPath();
  g.ellipse(S * 0.77, S * 0.21, S * 0.062, S * 0.052, 0.2, 0, Math.PI * 2);
  g.fill();

  // Cheek patch — the giveaway that reads "goose" even tiny
  g.fillStyle = body;
  g.beginPath();
  g.ellipse(S * 0.745, S * 0.225, S * 0.022, S * 0.032, 0.2, 0, Math.PI * 2);
  g.fill();

  // Bill
  g.fillStyle = '#1d1d20';
  g.beginPath();
  g.moveTo(S * 0.83, S * 0.20);
  g.lineTo(S * 0.90, S * 0.225);
  g.lineTo(S * 0.83, S * 0.245);
  g.closePath();
  g.fill();

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

    this._texIdle = makeGooseTexture(false);
    this._texFly = makeGooseTexture(true);

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

    // Release pool slots for items that left the window
    for (const slot of this._pool) {
      if (slot.itemIdx < 0) continue;
      const item = this._items[slot.itemIdx];
      if (!item || !this._nearAny(item.absoluteD, anchorDs)) {
        slot.mesh.visible = false;
        slot.itemIdx = -1;
        if (item) item.poolIdx = -1;
      }
    }

    const t = performance.now() / 1000;

    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      if (!this._nearAny(item.absoluteD, anchorDs)) continue;

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
        item.vy -= GOOSE_GRAVITY * dt;
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
        if (slot.mat.map !== this._texFly) { slot.mat.map = this._texFly; slot.mat.needsUpdate = true; }
      }
      if (this.camera) slot.mesh.quaternion.copy(this.camera.quaternion);
      // Tumble applied AFTER the billboard quaternion so it reads as roll
      // about the view axis rather than fighting the facing.
      if (item.state === STATE_FLYING) slot.mesh.rotateZ(item.spin * item.age);
      slot.mesh.visible = true;
    }
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
    const speed = 3.2 + Math.random() * 2.4;
    item.vx = awayX * speed + (Math.random() - 0.5) * 1.2;
    item.vz = awayZ * speed + (Math.random() - 0.5) * 1.2;
    item.vy = 4.6 + Math.random() * 2.2;
    item.spin = (Math.random() - 0.5) * 5.0;
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
      if (item && item.state === STATE_FLYING) slot.mesh.rotateZ(item.spin * item.age);
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
    this._texFly.dispose();
  }
}
