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
  uniform float videoReady;
  uniform vec3 fallbackColor;
  varying vec2 vUv;
  void main() {
    if (videoReady < 0.5) {
      // Video not playing yet — show colored fallback instead of black
      float r = length(vUv - vec2(0.5));
      float alpha = smoothstep(0.5, 0.35, r);
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(fallbackColor, alpha);
      return;
    }
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

      const videoTexture = new THREE.VideoTexture(video);
      videoTexture.minFilter = THREE.LinearFilter;
      videoTexture.magFilter = THREE.LinearFilter;

      // Aspect ratio: 200x296 — sized to be visible against the bike
      const w = 1.4, h = 1.4 * (296 / 200);
      const geo = new THREE.PlaneGeometry(w, h);

      // videoReady flips to 1.0 once the video is actually playing
      const videoReadyUniform = { value: 0.0 };
      video.addEventListener('playing', () => { videoReadyUniform.value = 1.0; });

      // Attempt autoplay; log errors and retry on user gesture
      video.play().catch(err => {
        console.warn('Collectible video autoplay blocked:', err.message);
        const retry = () => {
          video.play().then(() => {
            document.removeEventListener('touchstart', retry);
            document.removeEventListener('click', retry);
          }).catch(() => {});
        };
        document.addEventListener('touchstart', retry, { once: true });
        document.addEventListener('click', retry, { once: true });
      });

      // All presents share the same video + chromakey material (cloned per pool slot)
      const baseMat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: videoTexture },
          keyColor: { value: new THREE.Color(58 / 255, 180 / 255, 38 / 255) },
          similarity: { value: 0.3 },
          smoothness: { value: 0.08 },
          videoReady: videoReadyUniform,
          fallbackColor: { value: new THREE.Color(1.0, 0.84, 0.0) } // gold
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
  constructor(scene, roadPath, level, camera, difficulty) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.difficulty = difficulty || 'chill';
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
    if (this.level.isTutorial) return; // tutorial items placed via replaceItems()
    const rng = makeRng(this.level.id.charCodeAt(0) * 1000 + 7);
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
        collected: false,
        poolIdx: -1
      });
    }
    this.collected = 0;
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
      slot.mesh.visible = true;
    }

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
