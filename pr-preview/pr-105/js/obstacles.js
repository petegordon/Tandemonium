// ============================================================
// OBSTACLES — road hazards that cause crashes on contact
// ============================================================

import * as THREE from 'three';

const POOL_SIZE = 30;
const HIT_RADIUS = 1.2;
const VISIBLE_AHEAD = 200;
const VISIBLE_BEHIND = 40;

// Seeded PRNG for deterministic placement
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// Chromakey shaders (same as collectibles)
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
      float cx = abs(vUv.x - 0.5);
      float cy = 1.0 - vUv.y;
      float cone = smoothstep(0.4, 0.2, cx - cy * 0.15);
      if (cone < 0.01) discard;
      gl_FragColor = vec4(fallbackColor, cone);
      return;
    }
    vec4 texColor = texture2D(map, vUv);
    float d = distance(texColor.rgb, keyColor);
    float alpha = smoothstep(similarity, similarity + smoothness, d);
    if (alpha < 0.01) discard;
    // Spill suppression: reduce green where it exceeds average of R and B
    vec3 col = texColor.rgb;
    float spillMax = 0.5 * (col.r + col.b) + 0.05;
    col.g = min(col.g, spillMax);
    gl_FragColor = vec4(col, alpha);
  }
`;

export class ObstacleManager {
  constructor(scene, roadPath, level, camera) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this._pool = [];
    this._items = []; // { absoluteD, roadD, lateralOffset, poolIdx }
    this._loopLen = roadPath.loopLength;

    // Create shared video element for the pylon animation
    this._video = document.createElement('video');
    this._video.src = 'assets/pylon_200.mp4';
    this._video.loop = true;
    this._video.muted = true;
    this._video.playsInline = true;

    const videoTexture = new THREE.VideoTexture(this._video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    this._videoTexture = videoTexture;

    // videoReady flips to 1.0 once the video is actually playing
    const videoReadyUniform = { value: 0.0 };
    this._video.addEventListener('playing', () => { videoReadyUniform.value = 1.0; });

    // Attempt autoplay; log errors and retry on user gesture
    this._video.play().catch(err => {
      console.warn('Obstacle video autoplay blocked:', err.message);
      const retry = () => {
        this._video.play().then(() => {
          document.removeEventListener('touchstart', retry);
          document.removeEventListener('click', retry);
        }).catch(() => {});
      };
      document.addEventListener('touchstart', retry, { once: true });
      document.addEventListener('click', retry, { once: true });
    });

    // Aspect ratio: 200x320 — sized to be visible on the road
    const w = 1.2, h = 1.2 * (320 / 200);
    const geo = new THREE.PlaneGeometry(w, h);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: videoTexture },
        keyColor: { value: new THREE.Color(58 / 255, 180 / 255, 38 / 255) },
        similarity: { value: 0.4 },
        smoothness: { value: 0.15 },
        videoReady: videoReadyUniform,
        fallbackColor: { value: new THREE.Color(1.0, 0.55, 0.0) } // orange
      },
      vertexShader: chromakeyVertex,
      fragmentShader: chromakeyFragment,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // Ground shadow — triangular cone shadow using a radial-gradient circle texture
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
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false
    });

    // Create mesh pool (pylon + shadow per slot)
    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      const shadow = new THREE.Mesh(shadowGeo, shadowMat);
      shadow.rotation.x = -Math.PI / 2; // lay flat on ground
      shadow.visible = false;
      scene.add(shadow);
      this._pool.push({ mesh, shadow, itemIdx: -1 });
    }

    // Place obstacles deterministically along the race
    this._placeItems();
  }

  _placeItems() {
    if (this.level.isTutorial) {
      this._placeTutorialItems();
      return;
    }
    // Use a different seed than collectibles so they don't overlap
    const rng = makeRng(this.level.id.charCodeAt(0) * 2000 + 13);
    const spacing = 55 + (this.level.distance > 2000 ? 25 : 0);

    // Start obstacles after the first section so the player gets going
    const startD = spacing * 1.5;
    for (let d = startD; d < this.level.distance - 50; d += spacing + rng() * 25) {
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

  _placeTutorialItems() {
    // Phase 2 zone (70–105m): 4 pylons alternating left/right
    // Phase 3 zone (105–135m): 3 pylons interleaved with collectibles
    const positions = [
      { d: 77, offset: -1.2 },
      { d: 85, offset:  1.2 },
      { d: 93, offset: -1.2 },
      { d: 101, offset: 1.2 },
      { d: 113, offset: -1.2 }, // Phase 3: collect-dodge-collect-dodge-collect-dodge
      { d: 122, offset:  1.2 },
      { d: 131, offset: -1.2 },
    ];
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
      const ahead = item.absoluteD - bikeDistanceTraveled;
      if (ahead < -VISIBLE_BEHIND || ahead > VISIBLE_AHEAD) {
        slot.mesh.visible = false;
        slot.shadow.visible = false;
        item.poolIdx = -1;
        slot.itemIdx = -1;
      }
    }

    // Assign pool slots to visible items
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      const ahead = item.absoluteD - bikeDistanceTraveled;
      if (ahead < -VISIBLE_BEHIND || ahead > VISIBLE_AHEAD) continue;

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

      // Position mesh — sits on the road surface
      const slot = this._pool[item.poolIdx];
      const h = 1.2 * (320 / 200); // plane height
      slot.mesh.position.set(item._worldX, item._worldY + h * 0.5, item._worldZ);
      if (this.camera) {
        slot.mesh.quaternion.copy(this.camera.quaternion);
      }
      slot.mesh.visible = true;
      // Shadow sits just above ground
      slot.shadow.position.set(item._worldX, item._worldY + 0.02, item._worldZ);
      slot.shadow.visible = true;
    }
  }

  checkCollision(bikePosition) {
    for (const item of this._items) {
      if (item._worldX === undefined) continue; // not yet positioned
      const dx = bikePosition.x - item._worldX;
      const dz = bikePosition.z - item._worldZ;
      if (dx * dx + dz * dz < HIT_RADIUS * HIT_RADIUS) {
        return true;
      }
    }
    return false;
  }

  /**
   * For tutorial: call each frame to record which side the bike passes each pylon.
   * Captures the bike's lateral offset when within ±1.5m of each pylon's distance.
   * The closest-approach sample determines whether the pass was correct.
   */
  updateTutorialTracking(bikeDistanceTraveled, bikeLateralOffset) {
    for (const item of this._items) {
      const along = bikeDistanceTraveled - item.absoluteD;
      // Capture lateral offset in a window around the pylon
      if (along >= -1.5 && along <= 1.5) {
        if (item._bestDist === undefined || Math.abs(along) < item._bestDist) {
          item._bestDist = Math.abs(along);
          item._bikeLateralAtPass = bikeLateralOffset;
        }
      }
    }
  }

  /**
   * Returns tutorial pylon results: how many passed, and whether any were on the wrong side.
   * "Correct side" = bike lateral offset is opposite sign from the pylon's lateral offset.
   */
  getTutorialResults() {
    let passed = 0;
    let wrongSide = 0;
    const total = this._items.length;
    for (const item of this._items) {
      if (item._bikeLateralAtPass === undefined) continue;
      passed++;
      const correct = (item.lateralOffset < 0 && item._bikeLateralAtPass > 0) ||
                       (item.lateralOffset > 0 && item._bikeLateralAtPass < 0);
      if (!correct) wrongSide++;
    }
    return { passed, total, wrongSide };
  }

  /** Reset tutorial pass tracking (for retry). */
  resetTutorialTracking() {
    for (const item of this._items) {
      delete item._bestDist;
      delete item._bikeLateralAtPass;
    }
  }

  destroy() {
    for (const slot of this._pool) {
      this.scene.remove(slot.mesh);
      this.scene.remove(slot.shadow);
    }
    if (this._video) {
      this._video.pause();
      this._video.src = '';
    }
    if (this._videoTexture) {
      this._videoTexture.dispose();
    }
    this._pool = [];
    this._items = [];
  }
}
