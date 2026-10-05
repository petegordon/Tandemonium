// ============================================================
// COLLECTIBLES — themed spinning items on the road
// ============================================================

import * as THREE from 'three';

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
  // Slingshot mode's Chaos Coins: big glossy gold discs stood on edge so the
  // spin flashes the face, each with a soft halo and twinkling star sparkles
  // that orbit with the spin — they have to read from the chase camera.
  coins: {
    build(scene) {
      const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.1, 28);
      geo.rotateX(Math.PI / 2);
      const mat = new THREE.MeshPhongMaterial({
        color: 0xffd23f, emissive: 0x9a6400, shininess: 220, specular: 0xffffff,
      });
      return [{ geo, mat }, { geo, mat }, { geo, mat }];
    },
    decorate(mesh) {
      const halo = new THREE.Sprite(coinSparkleMaterials().halo);
      halo.scale.set(1.9, 1.9, 1);
      halo.userData.halo = true;
      mesh.add(halo);
      for (let k = 0; k < 3; k++) {
        const star = new THREE.Sprite(coinSparkleMaterials().star);
        const a = (k / 3) * Math.PI * 2;
        star.position.set(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.1);
        star.userData.phase = k * 2.1;
        mesh.add(star);
      }
    },
    animate(mesh, t, i) {
      for (const c of mesh.children) {
        if (c.userData.halo) { const h = 1.7 + Math.sin(t * 3 + i) * 0.25; c.scale.set(h, h, 1); continue; }
        // A twinkle is a quick flare then nothing: max(0, sin)^3.
        const tw = Math.pow(Math.max(0, Math.sin(t * 5 + i * 1.3 + c.userData.phase)), 3);
        const sc = 0.05 + 0.55 * tw;
        c.scale.set(sc, sc, 1);
      }
    }
  }
};

// Shared sparkle textures/materials for the coins theme (built once).
let _coinSparkle = null;
function coinSparkleMaterials() {
  if (_coinSparkle) return _coinSparkle;
  const canvas = (draw) => { const c = document.createElement('canvas'); c.width = c.height = 64; draw(c.getContext('2d')); return new THREE.CanvasTexture(c); };
  const haloTex = canvas((g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,236,150,0.9)'); r.addColorStop(0.35, 'rgba(255,210,63,0.45)'); r.addColorStop(1, 'rgba(255,200,40,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  });
  const starTex = canvas((g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 30);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,245,200,0.9)'); r.addColorStop(1, 'rgba(255,220,120,0)');
    g.fillStyle = r;
    g.beginPath();                                   // a four-point star
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, rad = k % 2 === 0 ? 31 : 6;
      g.lineTo(32 + Math.cos(a) * rad, 32 + Math.sin(a) * rad);
    }
    g.closePath(); g.fill();
  });
  const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
  _coinSparkle = {
    halo: new THREE.SpriteMaterial({ map: haloTex, opacity: 0.55, ...add }),
    star: new THREE.SpriteMaterial({ map: starTex, ...add }),
  };
  return _coinSparkle;
}

export class CollectibleManager {
  constructor(scene, roadPath, level, camera, difficulty, placementSalt = 0) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this.difficulty = difficulty || 'chill';
    this.placementSalt = placementSalt || 0;   // B-4, see ObstacleManager
    this.collected = 0;
    this._pool = [];
    this._items = []; // { roadD, lateralOffset, collected, poolIdx, absoluteD }
    this._loopLen = roadPath.loopLength;

    // Build themed meshes
    const theme = THEMES[level.collectibles] || THEMES.presents;
    this._variants = theme.build(scene);
    this._animate = theme.animate || null;
    this._billboard = !!theme.billboard;

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
    this._placeItems();
  }

  _placeItems() {
    if (this.level.isTutorial) return; // tutorial items placed via replaceItems()
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
      if (this._animate) this._animate(slot.mesh, t, i);
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
