// ============================================================
// COLLECTIBLES — themed spinning items on the road
// ============================================================

import * as THREE from 'three';

const POOL_SIZE = 40;
const COLLECT_RADIUS = 2.0;
const VISIBLE_AHEAD = 200;
const VISIBLE_BEHIND = 30;

// Seeded PRNG for deterministic placement
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Theme definitions: geometry + colors for each level type
const THEMES = {
  presents: {
    build(scene) {
      const geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
      const colors = [0xdd2222, 0x22aa22, 0xddaa22];
      return colors.map(c => {
        const mat = new THREE.MeshPhongMaterial({ color: c, emissive: 0x111111 });
        return { geo, mat };
      });
    }
  },
  gems: {
    build(scene) {
      const geo = new THREE.OctahedronGeometry(0.35, 0);
      const colors = [0x4444ff, 0xaa44dd, 0x22cc66];
      return colors.map(c => {
        const mat = new THREE.MeshPhongMaterial({ color: c, emissive: 0x111122, shininess: 80 });
        return { geo, mat };
      });
    }
  }
};

export class CollectibleManager {
  constructor(scene, roadPath, level) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.collected = 0;
    this._pool = [];
    this._items = []; // { roadD, lateralOffset, collected, poolIdx, absoluteD }
    this._loopLen = roadPath.loopLength;

    // Build themed meshes
    const theme = THEMES[level.collectibles] || THEMES.presents;
    this._variants = theme.build(scene);

    // Create mesh pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const variant = this._variants[i % this._variants.length];
      const mesh = new THREE.Mesh(variant.geo, variant.mat);
      mesh.castShadow = true;
      mesh.visible = false;
      scene.add(mesh);
      this._pool.push({ mesh, itemIdx: -1 });
    }

    // Place items deterministically along the entire race distance
    this._placeItems();
  }

  _placeItems() {
    const rng = makeRng(this.level.id.charCodeAt(0) * 1000 + 7);
    const spacing = 30 + (this.level.distance > 2000 ? 20 : 0); // wider spacing for longer races

    for (let d = spacing; d < this.level.distance - 20; d += spacing + rng() * 20) {
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

  update(dt, bikeDistanceTraveled, bikePosition) {
    const collected = [];
    const bikeRoadD = bikeDistanceTraveled % this._loopLen;

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

      // Collection check
      if (Math.abs(ahead) < COLLECT_RADIUS) {
        const pt = this.roadPath.getPointAtDistance(item.roadD);
        const rightX = Math.cos(pt.heading);
        const rightZ = -Math.sin(pt.heading);
        const itemX = pt.x + rightX * item.lateralOffset;
        const itemZ = pt.z + rightZ * item.lateralOffset;
        const dx = bikePosition.x - itemX;
        const dz = bikePosition.z - itemZ;
        if (dx * dx + dz * dz < COLLECT_RADIUS * COLLECT_RADIUS) {
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
      const pt = this.roadPath.getPointAtDistance(item.roadD);
      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const worldX = pt.x + rightX * item.lateralOffset;
      const worldZ = pt.z + rightZ * item.lateralOffset;

      // Spin and bob
      const t = performance.now() / 1000;
      const bobY = Math.sin(t * 2 + i * 1.7) * 0.15;
      slot.mesh.position.set(worldX, pt.y + 0.8 + bobY, worldZ);
      slot.mesh.rotation.y = t * 1.5 + i;
      slot.mesh.visible = true;
    }

    return collected; // array of collected item indices
  }

  getTotalItems() {
    return this._items.length;
  }

  destroy() {
    for (const slot of this._pool) {
      this.scene.remove(slot.mesh);
    }
    this._pool = [];
    this._items = [];
  }
}
