// ============================================================
// OBSTACLES — road hazards that cause crashes on contact
// ============================================================

import * as THREE from 'three';
import { buildConeGeometry, coneMaterial, buildSpiritGeometry, spiritMaterial, CONE_COLLIDER, SkullBurst } from './props-3d.js';

const POOL_SIZE = 30;
/** Skull spirits orbiting each standing cone (#478). */
const SPIRITS = 2;
const HIT_RADIUS = 0.75;
const VISIBLE_AHEAD = 200;
const VISIBLE_BEHIND = 40;

// Seeded PRNG for deterministic placement
import { itemSeed, SALT } from './daily-seed.js';

function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export class ObstacleManager {
  constructor(scene, roadPath, level, camera, difficulty, placementSalt = 0) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.difficulty = difficulty || 'chill';
    // B-4: varies WHERE items sit from run to run without moving the road.
    // 0 = legacy placement.
    this.placementSalt = placementSalt || 0;
    this._pool = [];
    this._items = []; // { absoluteD, roadD, lateralOffset, poolIdx }
    // Pylons knocked out of the pool by the debris sim. Kept so a restart can
    // stand them back up — a checkpoint retry must face the same road, not an
    // easier one with the hazards you already hit missing. See restoreKnocked.
    this._knocked = [];
    this._loopLen = roadPath.loopLength;

    // #478 · the death cone is a 3D model now, not a video billboard. Every
    // standing cone is one InstancedMesh (one draw), their blob shadows a
    // second, and the skull spirits rising off them a third. The pool keeps
    // a plain Object3D per slot for the cone and its shadow; _sync() copies
    // the visible ones into the instances.
    this._coneGeo = buildConeGeometry();
    this._coneMat = coneMaterial();
    this._cones = new THREE.InstancedMesh(this._coneGeo, this._coneMat, POOL_SIZE);
    this._cones.name = 'death-cones';
    this._cones.castShadow = true;

    // Ground shadow — a soft dark disc under each cone
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 64;
    shadowCanvas.height = 64;
    const sctx = shadowCanvas.getContext('2d');
    const grad = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.45)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 64, 64);
    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    const shadowGeo = new THREE.PlaneGeometry(1.6, 1.6);
    shadowGeo.rotateX(-Math.PI / 2);   // lay flat on the ground
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false
    });
    this._shadows = new THREE.InstancedMesh(shadowGeo, shadowMat, POOL_SIZE);
    this._shadows.name = 'death-cone-shadows';

    // Skull spirits: SPIRITS per cone, phases spread round the orbit
    this._time = { value: 0 };
    const spiritGeo = buildSpiritGeometry();
    const phases = new Float32Array(POOL_SIZE * SPIRITS);
    for (let i = 0; i < phases.length; i++) phases[i] = (i % SPIRITS) / SPIRITS;
    spiritGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    this._spiritGeo = spiritGeo;
    this._spiritMat = spiritMaterial(this._time);
    this._spirits = new THREE.InstancedMesh(spiritGeo, this._spiritMat, POOL_SIZE * SPIRITS);
    this._spirits.name = 'death-cone-spirits';

    for (const m of [this._cones, this._shadows, this._spirits]) {
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
    }

    // Hold refs to the shared GPU resources so destroy() can dispose them.
    this._shadowGeo = shadowGeo;
    this._shadowMat = shadowMat;
    this._shadowTex = shadowTex;

    // Pool of transform proxies (cone + shadow per slot)
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Object3D();
      mesh.visible = false;
      const shadow = new THREE.Object3D();
      shadow.visible = false;
      this._pool.push({ mesh, shadow, itemIdx: -1 });
    }

    // Place obstacles deterministically along the race
    this._placeItems();
  }

  _placeItems() {
    if (this.level.isTutorial) return; // tutorial items placed via replaceItems()
    // Map Tourist has no road line: its roadPath stub puts every distance at the
    // start point, so anything placed along the road piled up where you start (#432).
    if (this.level.isTourist) return;
    // Use a different seed than collectibles so they don't overlap.
    // B-4: a seeded level (Today's Road) derives from its own seed, and a
    // placement salt varies WHERE the items go from run to run without moving
    // the road — so a second lap of Grandma's is not the identical pylon at
    // 88 m. Unsalted, unseeded levels are byte-identical to before.
    const rng = makeRng(itemSeed(this.level, SALT.obstacles, this.placementSalt,
      this.level.id.charCodeAt(0) * 2000 + 13));
    // Difficulty scales spacing: more obstacles on harder difficulties
    const diffSpacing = { chill: 35, adventurous: 22, daredevil: 15 };
    const baseSpacing = diffSpacing[this.difficulty] || 35;
    const spacing = baseSpacing + (this.level.distance > 2000 ? 10 : 0);

    // Build checkpoint distance list to avoid placing pylons near them
    const cpInterval = this.level.checkpointInterval || this.level.distance;
    const checkpoints = [];
    for (let cp = 0; cp <= this.level.distance; cp += cpInterval) {
      checkpoints.push(cp);
    }
    checkpoints.push(this.level.distance); // finish line
    const cpClearance = 15; // no pylons within 15m of a checkpoint/start/finish

    // Start obstacles after the first section so the player gets going
    const startD = spacing * 1.5;
    for (let d = startD; d < this.level.distance - 50; d += spacing + rng() * (spacing * 0.4)) {
      // Skip if too close to any checkpoint
      const nearCheckpoint = checkpoints.some(cp => Math.abs(d - cp) < cpClearance);
      if (nearCheckpoint) continue;

      // Place on the road, biased toward center but still avoidable
      const lateralOffset = (rng() - 0.5) * 3; // ±1.5 units from center
      this._items.push({
        absoluteD: d,
        roadD: d % this._loopLen,
        lateralOffset,
        poolIdx: -1
      });
    }
  }

  replaceItems(positions) {
    for (const slot of this._pool) {
      slot.mesh.visible = false;
      slot.shadow.visible = false;
      slot.itemIdx = -1;
    }
    this._sync();
    this._items = [];
    for (const p of positions) {
      this._items.push({
        absoluteD: p.d,
        roadD: p.d % this._loopLen,
        lateralOffset: p.offset,
        poolIdx: -1
      });
    }
  }

  update(dt, bikeDistanceTraveled, bikePosition) {
    this._updateWithAnchors([bikeDistanceTraveled]);
  }

  /**
   * Versus: pool + world positions maintained around BOTH bikes. Matters
   * for correctness, not just visuals — checkCollision reads item._worldX,
   * which is only computed for items inside an anchor's visible window.
   * @param {number[]} anchorDs bike road distances, one per team
   */
  updateVersus(dt, anchorDs) {
    this._updateWithAnchors(anchorDs);
  }

  _nearAny(absoluteD, anchorDs) {
    for (const d of anchorDs) {
      const ahead = absoluteD - d;
      if (ahead >= -VISIBLE_BEHIND && ahead <= VISIBLE_AHEAD) return true;
    }
    return false;
  }

  _updateWithAnchors(anchorDs) {
    // Release pool slots for items out of range
    for (const slot of this._pool) {
      if (slot.itemIdx < 0) continue;
      const item = this._items[slot.itemIdx];
      if (!item) {
        slot.mesh.visible = false;
        slot.shadow.visible = false;
        slot.itemIdx = -1;
        continue;
      }
      if (!this._nearAny(item.absoluteD, anchorDs)) {
        slot.mesh.visible = false;
        slot.shadow.visible = false;
        item.poolIdx = -1;
        slot.itemIdx = -1;
      }
    }

    // Assign pool slots to visible items
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      if (item._hidden) continue;
      if (!this._nearAny(item.absoluteD, anchorDs)) continue;

      // Compute world position
      const pt = this.roadPath.getPointAtDistance(item.roadD);
      const rightX = Math.cos(pt.heading);
      const rightZ = -Math.sin(pt.heading);
      item._worldX = pt.x + rightX * item.lateralOffset;
      item._worldZ = pt.z + rightZ * item.lateralOffset;
      item._worldY = pt.y;

      // Assign pool mesh if not already assigned
      if (item.poolIdx < 0) {
        const freeSlot = this._pool.findIndex(s => s.itemIdx < 0);
        if (freeSlot < 0) continue;
        item.poolIdx = freeSlot;
        this._pool[freeSlot].itemIdx = i;
      }

      // Position the cone on the road surface, skull towards the oncoming
      // riders, with a slow uneasy wobble (the billboard's cone swayed).
      const slot = this._pool[item.poolIdx];
      const t = performance.now() / 1000;
      slot.mesh.position.set(item._worldX, item._worldY, item._worldZ);
      slot.mesh.rotation.set(
        Math.sin(t * 2.1 + i * 1.3) * 0.03,
        pt.heading + Math.PI + Math.sin(i * 2.7) * 0.25,
        Math.cos(t * 1.7 + i * 0.9) * 0.03,
      );
      slot.mesh.visible = true;
      // Shadow sits just above ground
      slot.shadow.position.set(item._worldX, item._worldY + 0.02, item._worldZ);
      slot.shadow.visible = true;
    }
    this._sync();
  }

  /**
   * #478 · copy the visible slots into the instanced cones, shadows and
   * spirits. Called after every update and anything that hides a slot.
   */
  _sync() {
    if (!this._cones) return;
    this._time.value = performance.now() / 1000;
    let n = 0, ns = 0;
    const m4 = this._m4 || (this._m4 = new THREE.Matrix4());
    for (const slot of this._pool) {
      if (!slot.mesh.visible) continue;
      slot.mesh.updateMatrix();
      this._cones.setMatrixAt(n, slot.mesh.matrix);
      if (slot.shadow.visible) {
        slot.shadow.updateMatrix();
        this._shadows.setMatrixAt(ns++, slot.shadow.matrix);
      }
      // spirits: just the cone's base position (orbit + rise are in the shader)
      m4.makeTranslation(slot.mesh.position.x, slot.mesh.position.y, slot.mesh.position.z);
      for (let k = 0; k < SPIRITS; k++) this._spirits.setMatrixAt(n * SPIRITS + k, m4);
      n++;
    }
    this._cones.count = n;
    this._shadows.count = ns;
    this._spirits.count = n * SPIRITS;
    for (const m of [this._cones, this._shadows, this._spirits]) m.instanceMatrix.needsUpdate = true;
  }

  /** Standing cones drawn right now (tests, perf probes). */
  visibleCount() {
    return this._pool.filter((s) => s.itemIdx >= 0 && s.mesh.visible).length;
  }

  /**
   * Kept for the split-screen render passes, which call it per camera. The
   * cones were camera-facing billboards; since #478 they are 3D and need no
   * re-facing.
   */
  faceCamera() {}

  /**
   * The pylon the bike is currently inside, if any.
   *
   * Returns the ITEM rather than a bare true so the caller can knock it over
   * (see knockOut). Every existing call site uses this in a boolean test, and
   * an item object is truthy, so that behaviour is unchanged.
   *
   * @returns {object|null} the struck item, or null
   */
  checkCollision(bikePosition) {
    for (const item of this._items) {
      if (item._hidden) continue;
      if (item._worldX === undefined) continue; // not yet positioned
      const dx = bikePosition.x - item._worldX;
      const dz = bikePosition.z - item._worldZ;
      if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS) {
        return item;
      }
    }
    return null;
  }

  /**
   * Retire a struck cone and hand back a cone for the debris sim.
   *
   * The pool slot is released immediately. The returned mesh is a fresh,
   * standalone cone (sharing this manager's geometry and material) standing
   * exactly where the instance stood; physics-fx clones it and tumbles the
   * clone as a solid body (userData.solid), with the skull burst.
   *
   * @returns {THREE.Mesh|null} the cone to copy, or null if the item wasn't
   *   being rendered (too far away to have a slot)
   */
  knockOut(item) {
    if (!item || item._hidden) return null;
    item._hidden = true;
    this._knocked.push(item);
    if (item.poolIdx < 0) return null;
    const slot = this._pool[item.poolIdx];
    const cone = new THREE.Mesh(this._coneGeo, this._coneMat);
    cone.name = 'knocked-cone';
    cone.position.copy(slot.mesh.position);
    cone.quaternion.copy(slot.mesh.quaternion);
    cone.castShadow = true;
    cone.userData.solid = { ...CONE_COLLIDER, burst: (target, scene) => new SkullBurst(target, scene) };
    slot.mesh.visible = false;
    slot.shadow.visible = false;
    slot.itemIdx = -1;
    item.poolIdx = -1;
    this._sync();
    return cone;
  }

  /**
   * For tutorial: call each frame to record which side the bike passes each pylon.
   * Captures the bike's lateral offset when within ±1.5m of each pylon's distance.
   * The closest-approach sample determines whether the pass was correct.
   */
  updatePassTracking(bikeDistanceTraveled, bikeLateralOffset) {
    let result = null;
    for (const item of this._items) {
      const along = bikeDistanceTraveled - item.absoluteD;
      // Capture lateral offset in a window around the pylon
      if (along >= -1.5 && along <= 1.5) {
        if (item._bestDist === undefined || Math.abs(along) < item._bestDist) {
          item._bestDist = Math.abs(along);
          item._bikeLateralAtPass = bikeLateralOffset;
        }
      }
      // Once past the tracking window, evaluate and report the result once
      if (along > 1.5 && item._bikeLateralAtPass !== undefined && !item._passEvaluated) {
        item._passEvaluated = true;
        const correct = (item.lateralOffset < 0 && item._bikeLateralAtPass > 0) ||
                         (item.lateralOffset > 0 && item._bikeLateralAtPass < 0);
        result = { correct, pylonOffset: item.lateralOffset };
      }
    }
    return result;
  }

  /**
   * Returns tutorial pylon results: how many passed, and whether any were on the wrong side.
   * "Correct side" = bike lateral offset is opposite sign from the pylon's lateral offset.
   */
  getPassResults(minD, maxD) {
    let passed = 0;
    let wrongSide = 0;
    let total = 0;
    for (const item of this._items) {
      if (minD !== undefined && (item.absoluteD < minD || item.absoluteD > maxD)) continue;
      total++;
      if (item._bikeLateralAtPass === undefined) continue;
      passed++;
      const correct = (item.lateralOffset < 0 && item._bikeLateralAtPass > 0) ||
                       (item.lateralOffset > 0 && item._bikeLateralAtPass < 0);
      if (!correct) wrongSide++;
    }
    return { passed, total, wrongSide };
  }

  /** Reset tutorial pass tracking (for retry). */
  resetPassTracking() {
    for (const item of this._items) {
      delete item._bestDist;
      delete item._bikeLateralAtPass;
      delete item._passEvaluated;
    }
  }

  /**
   * Stand every knocked-over pylon back up.
   *
   * Called on a restart or checkpoint retry. Without it a knocked pylon is gone
   * for the rest of the ride: the retry is quietly easier than the attempt that
   * killed you, and the road you already rode is missing a cone.
   *
   * The caller must also drop the debris (PhysicsFx.clear) in the same breath,
   * or the restored pylon stands up next to its own wreckage.
   */
  restoreKnocked() {
    for (const item of this._knocked) item._hidden = false;
    this._knocked.length = 0;
  }

  /** Hide obstacles in a distance range (for skipping completed tutorial phases). */
  hideInRange(minD, maxD) {
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD) {
        item._hidden = true;
        if (item.poolIdx >= 0) {
          this._pool[item.poolIdx].mesh.visible = false;
          this._pool[item.poolIdx].shadow.visible = false;
          this._pool[item.poolIdx].itemIdx = -1;
          item.poolIdx = -1;
        }
      }
    }
    this._sync();
  }

  destroy() {
    for (const m of [this._cones, this._shadows, this._spirits]) {
      if (!m) continue;
      this.scene.remove(m);
      m.dispose();
    }
    this._cones = this._shadows = this._spirits = null;
    // Shared GPU resources: without this every race-restart leaks them, which
    // on iOS Chrome accumulates fast enough to OOM the renderer. The cone's
    // atlas and the skull texture are shared module-wide and kept.
    if (this._coneGeo)   { this._coneGeo.dispose();   this._coneGeo = null; }
    if (this._coneMat)   { this._coneMat.dispose();   this._coneMat = null; }
    if (this._spiritGeo) { this._spiritGeo.dispose(); this._spiritGeo = null; }
    if (this._spiritMat) { this._spiritMat.dispose(); this._spiritMat = null; }
    if (this._shadowGeo) { this._shadowGeo.dispose(); this._shadowGeo = null; }
    if (this._shadowMat) { this._shadowMat.dispose(); this._shadowMat = null; }
    if (this._shadowTex) { this._shadowTex.dispose(); this._shadowTex = null; }
    this._pool = [];
    this._items = [];
  }
}
