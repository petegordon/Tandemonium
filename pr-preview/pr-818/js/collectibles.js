// ============================================================
// COLLECTIBLES — themed spinning items on the road
// ============================================================

import * as THREE from 'three';
import { buildTokenGeometry, tokenMaterials, buildTokenFxGeometry, tokenFxMaterial } from './token-face.js';
import { buildPresentGeometry, presentMaterial, buildPresentFxGeometry, presentFxMaterial, PRESENT } from './props-3d.js';

const POOL_SIZE = 40;
const COLLECT_RADIUS = 2.0;
const VISIBLE_AHEAD = 200;
const VISIBLE_BEHIND = 60;

// Seeded PRNG for deterministic placement
import { itemSeed, SALT } from './daily-seed.js';

function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Theme definitions: geometry + colors for each level type
const THEMES = {
  // #478 · a 3D present (cream box, gold ribbon and bow) with its magic —
  // gold rays, a swirling rainbow ring, a twinkle — in a second additive
  // mesh. Both are instanced: every present on the road is two draws.
  presents: {
    instanced: true,
    build() {
      const time = { value: 0 };
      return {
        geo: buildPresentGeometry(), mat: presentMaterial(),
        fxGeo: buildPresentFxGeometry(), fxMat: presentFxMaterial(time, { glow: 1.5 }), time,
      };
    },
  },
  // #512 · Tandem Tokens, one look in every mode (Pete, 2026-11-07): the
  // Daily Ride's full gold disc, stamped with the House Tandem controller
  // (heads) and a star (tails), with the Slingshot's soft breathing halo and
  // twinkling star sparkles — js/token-face.js. Body and glow are each one
  // instanced draw however many are out (a Daily Ride has 40; the TV and phone
  // low tiers stay smooth). On a regular road they are placed by
  // js/token-runs.js through `opts.items`, never by _placeItems; Slingshot
  // places its course.
  tokens: {
    instanced: true, name: 'tokens', scale: 1,
    build() {
      const time = { value: 0 };
      return {
        geo: buildTokenGeometry(), mat: tokenMaterials(), sharedMat: true,   // shared: [edge, heads, tails]
        fxGeo: buildTokenFxGeometry(), fxMat: tokenFxMaterial(time), time,
      };
    },
  },
};
// Slingshot's level still says 'coins' (analytics' collectible_type): since
// Pete's 2026-11-07 playtest it is the same token as every other road.
THEMES.coins = THEMES.tokens;

export class CollectibleManager {
  /**
   * @param {object} [opts]
   * @param {Array<{d:number, offset:number, value?:number}>} [opts.items]
   *   a fixed layout (#512 · the Tandem Token runs) instead of the seeded
   *   placement; `value` is what each item pays (collectedValue()).
   */
  constructor(scene, roadPath, level, camera, difficulty, placementSalt = 0, opts = {}) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.difficulty = difficulty || 'chill';
    this.placementSalt = placementSalt || 0;   // B-4, see ObstacleManager
    this.collected = 0;
    this._pool = [];
    this._items = []; // { roadD, lateralOffset, collected, poolIdx, absoluteD, value }
    this._loopLen = roadPath.loopLength;
    /** updateVersus: the item indices each anchor collected on the last call. */
    this.lastCollected = [];
    const place = () => (opts.items ? this.replaceItems(opts.items) : this._placeItems());

    // Build themed meshes
    const theme = THEMES[level.collectibles] || THEMES.presents;
    this._animate = theme.animate || null;
    this._billboard = !!theme.billboard;
    this._instanced = null;

    if (theme.instanced) {
      // #478 · one InstancedMesh for the presents and one for their fx. The
      // pool keeps a plain Object3D per slot (position/rotation/visible, as
      // before); _sync() copies the visible ones into the instances.
      const parts = theme.build(scene);
      const body = new THREE.InstancedMesh(parts.geo, parts.mat, POOL_SIZE);
      const fx = new THREE.InstancedMesh(parts.fxGeo, parts.fxMat, POOL_SIZE);
      for (const m of [body, fx]) { m.count = 0; m.frustumCulled = false; scene.add(m); }
      const name = theme.name || 'presents';
      body.name = name; fx.name = name + '-fx';
      body.castShadow = true;
      this._instanced = { body, fx, time: parts.time };
      // Shared materials (the tokens') are left out so destroy() never disposes them.
      this._variants = [{ geo: parts.geo, mat: parts.sharedMat ? null : parts.mat }, { geo: parts.fxGeo, mat: parts.fxMat }];
      for (let i = 0; i < POOL_SIZE; i++) {
        const mesh = new THREE.Object3D();
        mesh.scale.setScalar(theme.scale || PRESENT.ROAD_SCALE);
        mesh.visible = false;
        this._pool.push({ mesh, itemIdx: -1 });
      }
      place();
      return;
    }
    this._variants = theme.build(scene);

    // Create mesh pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const variant = this._variants[i % this._variants.length];
      const mesh = new THREE.Mesh(variant.geo, variant.mat);
      mesh.castShadow = !this._billboard;
      mesh.visible = false;
      if (theme.decorate) theme.decorate(mesh);
      scene.add(mesh);
      this._pool.push({ mesh, itemIdx: -1 });
    }

    // Place items deterministically along the entire race distance
    place();
  }

  _placeItems() {
    if (this.level.isTutorial) return; // tutorial items placed via replaceItems()
    if (this.level.isTourist) return; // no road line in Map Tourist (#432, see obstacles.js)
    // B-4: see ObstacleManager._placeItems for the seeding rules.
    const rng = makeRng(itemSeed(this.level, SALT.collectibles, this.placementSalt,
      this.level.id.charCodeAt(0) * 1000 + 7));
    // Difficulty scales spacing: more presents on harder difficulties
    const diffSpacing = { chill: 25, adventurous: 20, daredevil: 15 };
    const baseSpacing = diffSpacing[this.difficulty] || 25;
    const spacing = baseSpacing + (this.level.distance > 2000 ? 10 : 0);

    for (let d = spacing; d < this.level.distance - 20; d += spacing + rng() * (spacing * 0.5)) {
      const lateralOffset = (rng() - 0.5) * 4; // ±2 units from center
      this._items.push({
        absoluteD: d,
        roadD: d % this._loopLen,
        lateralOffset,
        collected: false,
        poolIdx: -1
      });
    }
  }

  /**
   * #478 · copy the visible pool slots into the instanced meshes. Called at
   * the end of every update and after anything that hides slots. A no-op for
   * the per-mesh themes.
   */
  _sync() {
    const inst = this._instanced;
    if (!inst) return;
    inst.time.value = performance.now() / 1000;
    let n = 0;
    for (const slot of this._pool) {
      if (!slot.mesh.visible) continue;
      slot.mesh.updateMatrix();
      inst.body.setMatrixAt(n, slot.mesh.matrix);
      inst.fx.setMatrixAt(n, slot.mesh.matrix);
      n++;
    }
    inst.body.count = inst.fx.count = n;
    inst.body.instanceMatrix.needsUpdate = true;
    inst.fx.instanceMatrix.needsUpdate = true;
  }

  /** Visible present slots (tests, the reel bot): how many are drawn now. */
  visibleCount() {
    return this._pool.filter((s) => s.itemIdx >= 0 && s.mesh.visible).length;
  }

  replaceItems(positions) {
    // Release all pool slots
    for (const slot of this._pool) {
      slot.mesh.visible = false;
      slot.itemIdx = -1;
    }
    // Clear and rebuild items
    this._items = [];
    for (const p of positions) {
      this._items.push({
        absoluteD: p.d,
        roadD: p.d % this._loopLen,
        lateralOffset: p.offset,
        value: Number.isFinite(p.value) ? p.value : 0,
        collected: false,
        poolIdx: -1
      });
    }
    this.collected = 0;
  }

  /** #512 · what the collected items pay (items placed with a `value`). */
  collectedValue() {
    let v = 0;
    for (const item of this._items) if (item.collected) v += item.value || 0;
    return v;
  }

  /** The sum of every item's value on this road. */
  totalValue() {
    let v = 0;
    for (const item of this._items) v += item.value || 0;
    return v;
  }

  resetCollected() {
    for (const item of this._items) {
      item.collected = false;
      if (item.poolIdx >= 0) {
        this._pool[item.poolIdx].mesh.visible = false;
        this._pool[item.poolIdx].itemIdx = -1;
        item.poolIdx = -1;
      }
    }
    this.collected = 0;
    this._sync();
  }

  /** Reset only items in a distance range (for tutorial phase-specific retry). */
  resetInRange(minD, maxD) {
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD && item.collected) {
        item.collected = false;
        this.collected--;
        if (item.poolIdx >= 0) {
          this._pool[item.poolIdx].mesh.visible = false;
          this._pool[item.poolIdx].itemIdx = -1;
          item.poolIdx = -1;
        }
      }
    }
    if (this.collected < 0) this.collected = 0;
  }

  /** Mark items in range as collected and hide them (for skipping completed phases). */
  hideInRange(minD, maxD) {
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD && !item.collected) {
        item.collected = true;
        this.collected++;
        if (item.poolIdx >= 0) {
          this._pool[item.poolIdx].mesh.visible = false;
          this._pool[item.poolIdx].itemIdx = -1;
          item.poolIdx = -1;
        }
      }
    }
  }

  /** Check if any uncollected item in range is behind the bike by more than margin. */
  hasMissedItem(bikeDistance, minD, maxD, margin = 5) {
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD && !item.collected) {
        if (bikeDistance > item.absoluteD + margin) return true;
      }
    }
    return false;
  }

  /** Count collected items in a distance range. */
  countCollectedInRange(minD, maxD) {
    let count = 0;
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD && item.collected) count++;
    }
    return count;
  }

  /** Count total items in a distance range. */
  countTotalInRange(minD, maxD) {
    let count = 0;
    for (const item of this._items) {
      if (item.absoluteD >= minD && item.absoluteD <= maxD) count++;
    }
    return count;
  }

  update(dt, bikeDistanceTraveled, bikePosition) {
    const collected = [];

    // Release pool slots for items out of range or collected
    for (const slot of this._pool) {
      if (slot.itemIdx < 0) continue;
      const item = this._items[slot.itemIdx];
      if (!item || item.collected) {
        slot.mesh.visible = false;
        slot.itemIdx = -1;
        continue;
      }
      let ahead = item.absoluteD - bikeDistanceTraveled;
      if (ahead < -VISIBLE_BEHIND || ahead > VISIBLE_AHEAD) {
        slot.mesh.visible = false;
        item.poolIdx = -1;
        slot.itemIdx = -1;
      }
    }

    // Assign pool slots to visible items, check collections
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      if (item.collected) continue;

      let ahead = item.absoluteD - bikeDistanceTraveled;
      if (ahead < -VISIBLE_BEHIND || ahead > VISIBLE_AHEAD) continue;

      // Compute item world position (used for both rendering and collection)
      const pt = this.roadPath.getPointAtDistance(item.roadD);
      const rightX = Math.cos(pt.heading);
      const rightZ = -Math.sin(pt.heading);
      const worldX = pt.x + rightX * item.lateralOffset;
      const worldZ = pt.z + rightZ * item.lateralOffset;

      // Collection check — pure world-space distance
      // (avoid using bikeDistanceTraveled here; it drifts from road distance
      //  when the player steers, eventually exceeding COLLECT_RADIUS)
      const dx = bikePosition.x - worldX;
      const dz = bikePosition.z - worldZ;
      const radius = this._tutorialRadius || COLLECT_RADIUS;
      if (dx * dx + dz * dz < radius * radius) {
        item.collected = true;
        this.collected++;
        collected.push(i);
        if (item.poolIdx >= 0) {
          this._pool[item.poolIdx].mesh.visible = false;
          this._pool[item.poolIdx].itemIdx = -1;
          item.poolIdx = -1;
        }
        continue;
      }

      // Assign pool mesh if not already assigned
      if (item.poolIdx < 0) {
        const freeSlot = this._pool.findIndex(s => s.itemIdx < 0);
        if (freeSlot < 0) continue;
        item.poolIdx = freeSlot;
        this._pool[freeSlot].itemIdx = i;
      }

      // Position mesh
      const slot = this._pool[item.poolIdx];
      const t = performance.now() / 1000;
      const bobY = Math.sin(t * 2 + i * 1.7) * 0.15;
      slot.mesh.position.set(worldX, pt.y + 0.8 + bobY, worldZ);
      if (this._billboard && this.camera) {
        slot.mesh.quaternion.copy(this.camera.quaternion);
      } else {
        slot.mesh.rotation.y = t * 1.5 + i;
      }
      if (this._animate) this._animate(slot.mesh, t, i);
      slot.mesh.visible = true;
    }

    this._sync();
    return collected; // array of collected item indices
  }

  /**
   * Versus (issue #351): both bikes share one item set, first-come-first-
   * served. Pool slots are assigned to items visible near EITHER bike.
   * @param {number} dt
   * @param {Array<{d: number, position: {x,z}}>} anchors one per team,
   *   in team order — a same-frame tie goes to the earlier entry
   * @returns {number[]} items collected this frame, per anchor
   */
  updateVersus(dt, anchors) {
    const counts = anchors.map(() => 0);
    const taken = anchors.map(() => []);
    this.lastCollected = taken;
    const nearAny = (absD) => {
      for (const a of anchors) {
        const ahead = absD - a.d;
        if (ahead >= -VISIBLE_BEHIND && ahead <= VISIBLE_AHEAD) return true;
      }
      return false;
    };

    // Release pool slots for items out of range or collected
    for (const slot of this._pool) {
      if (slot.itemIdx < 0) continue;
      const item = this._items[slot.itemIdx];
      if (!item || item.collected || !nearAny(item.absoluteD)) {
        slot.mesh.visible = false;
        if (item) item.poolIdx = -1;
        slot.itemIdx = -1;
      }
    }

    // Assign pool slots to visible items, check collections per team
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      if (item.collected) continue;
      if (!nearAny(item.absoluteD)) continue;

      const pt = this.roadPath.getPointAtDistance(item.roadD);
      const rightX = Math.cos(pt.heading);
      const rightZ = -Math.sin(pt.heading);
      const worldX = pt.x + rightX * item.lateralOffset;
      const worldZ = pt.z + rightZ * item.lateralOffset;

      // FCFS collection — first team within radius takes it
      const radius = this._tutorialRadius || COLLECT_RADIUS;
      let taken = false;
      for (let a = 0; a < anchors.length; a++) {
        const dx = anchors[a].position.x - worldX;
        const dz = anchors[a].position.z - worldZ;
        if (dx * dx + dz * dz < radius * radius) {
          item.collected = true;
          this.collected++;
          counts[a]++;
          taken[a].push(i);
          if (item.poolIdx >= 0) {
            this._pool[item.poolIdx].mesh.visible = false;
            this._pool[item.poolIdx].itemIdx = -1;
            item.poolIdx = -1;
          }
          taken = true;
          break;
        }
      }
      if (taken) continue;

      // Assign pool mesh if not already assigned
      if (item.poolIdx < 0) {
        const freeSlot = this._pool.findIndex(s => s.itemIdx < 0);
        if (freeSlot < 0) continue;
        item.poolIdx = freeSlot;
        this._pool[freeSlot].itemIdx = i;
      }

      // Position mesh
      const slot = this._pool[item.poolIdx];
      const t = performance.now() / 1000;
      const bobY = Math.sin(t * 2 + i * 1.7) * 0.15;
      slot.mesh.position.set(worldX, pt.y + 0.8 + bobY, worldZ);
      if (this._billboard && this.camera) {
        slot.mesh.quaternion.copy(this.camera.quaternion);
      } else {
        slot.mesh.rotation.y = t * 1.5 + i;
      }
      slot.mesh.visible = true;
    }

    this._sync();
    return counts;
  }

  /**
   * Re-face visible billboarded items to `camera` — called once per
   * split-screen render pass so each viewport's billboards face its own
   * chase camera.
   */
  faceCamera(camera) {
    if (!this._billboard || !camera) return;
    for (const slot of this._pool) {
      if (slot.itemIdx >= 0 && slot.mesh.visible) {
        slot.mesh.quaternion.copy(camera.quaternion);
      }
    }
  }

  resetToCheckpoint(checkpointDistance) {
    // Un-collect items that were past the checkpoint — they need to be re-collected
    let restored = 0;
    for (const item of this._items) {
      if (item.collected && item.absoluteD > checkpointDistance) {
        item.collected = false;
        restored++;
      }
    }
    this.collected -= restored;
    if (this.collected < 0) this.collected = 0;
  }

  getTotalItems() {
    return this._items.length;
  }

  destroy() {
    for (const slot of this._pool) {
      this.scene.remove(slot.mesh);
    }
    if (this._instanced) {
      this.scene.remove(this._instanced.body, this._instanced.fx);
      this._instanced.body.dispose();
      this._instanced.fx.dispose();
      this._instanced = null;
    }
    // Variants may share their geo/mat (presents theme uses a single
    // geo+mat across 3 variants). Dedupe before dispose so we don't
    // call .dispose() twice on the same resource.
    const seenGeo = new Set();
    const seenMat = new Set();
    const seenTex = new Set();
    for (const v of this._variants) {
      if (v.geo && !seenGeo.has(v.geo)) {
        seenGeo.add(v.geo);
        v.geo.dispose();
      }
      if (v.mat && !seenMat.has(v.mat)) {
        seenMat.add(v.mat);
        // Pull video off the texture before disposing — without removing
        // the .src + .load() the <video> can stay decoding in the
        // background and pin GPU/decoder memory on iOS.
        if (v.mat.uniforms && v.mat.uniforms.map) {
          const tex = v.mat.uniforms.map.value;
          if (tex && !seenTex.has(tex)) {
            seenTex.add(tex);
            if (tex.image && tex.image.tagName === 'VIDEO') {
              try { tex.image.pause(); } catch (e) {}
              try {
                tex.image.removeAttribute('src');
                tex.image.load();
              } catch (e) {}
            }
            tex.dispose();
          }
        }
        if (v.mat.map && !seenTex.has(v.mat.map)) {
          seenTex.add(v.mat.map);
          v.mat.map.dispose();
        }
        v.mat.dispose();
      }
    }
    this._variants = [];
    this._pool = [];
    this._items = [];
  }
}
