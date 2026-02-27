// ============================================================
// COLLECTIBLES — themed spinning items on the road
// ============================================================

import * as THREE from 'three';

const POOL_SIZE = 40;
const COLLECT_RADIUS = 2.0;
const VISIBLE_AHEAD = 200;
const VISIBLE_BEHIND = 60;

// Seeded PRNG for deterministic placement
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Chromakey vertex/fragment shaders for green-screen video
const chromakeyVertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const chromakeyFragment = `
  uniform sampler2D map;
  uniform vec3 keyColor;
  uniform float similarity;
  uniform float smoothness;
  varying vec2 vUv;
  void main() {
    vec4 texColor = texture2D(map, vUv);
    float d = distance(texColor.rgb, keyColor);
    float alpha = smoothstep(similarity, similarity + smoothness, d);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(texColor.rgb, alpha);
  }
`;

// Theme definitions: geometry + colors for each level type
const THEMES = {
  presents: {
    billboard: true,
    build(scene) {
      // Create shared video element for the gold gift animation
      const video = document.createElement('video');
      video.src = 'assets/gold_gift_200.mp4';
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.play().catch(() => {});

      const videoTexture = new THREE.VideoTexture(video);
      videoTexture.minFilter = THREE.LinearFilter;
      videoTexture.magFilter = THREE.LinearFilter;

      // Aspect ratio: 200x296 — sized to be visible against the bike
      const w = 1.4, h = 1.4 * (296 / 200);
      const geo = new THREE.PlaneGeometry(w, h);

      // All presents share the same video + chromakey material (cloned per pool slot)
      const baseMat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: videoTexture },
          keyColor: { value: new THREE.Color(58 / 255, 180 / 255, 38 / 255) },
          similarity: { value: 0.3 },
          smoothness: { value: 0.08 }
        },
        vertexShader: chromakeyVertex,
        fragmentShader: chromakeyFragment,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      // Return 3 identical variants (pool cycles through them)
      return [
        { geo, mat: baseMat },
        { geo, mat: baseMat },
        { geo, mat: baseMat }
      ];
    },
    _video: null // stored on destroy
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
  constructor(scene, roadPath, level, camera) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.collected = 0;
    this._pool = [];
    this._items = []; // { roadD, lateralOffset, collected, poolIdx, absoluteD }
    this._loopLen = roadPath.loopLength;

    // Build themed meshes
    const theme = THEMES[level.collectibles] || THEMES.presents;
    this._variants = theme.build(scene);
    this._billboard = !!theme.billboard;

    // Create mesh pool
    for (let i = 0; i < POOL_SIZE; i++) {
      const variant = this._variants[i % this._variants.length];
      const mesh = new THREE.Mesh(variant.geo, variant.mat);
      mesh.castShadow = !this._billboard;
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

    return collected; // array of collected item indices
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
    // Clean up video element if presents theme
    for (const v of this._variants) {
      if (v.mat.uniforms && v.mat.uniforms.map) {
        const tex = v.mat.uniforms.map.value;
        if (tex.image && tex.image.tagName === 'VIDEO') {
          tex.image.pause();
          tex.image.src = '';
          tex.dispose();
          break; // all variants share same texture
        }
      }
    }
    this._pool = [];
    this._items = [];
  }
}
