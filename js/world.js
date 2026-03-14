// ============================================================
// WORLD — terrain ground, road chunks, trees, lighting
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoadPath } from './road-path.js';
import { RoadChunkManager } from './road-chunks.js';

const GROUND_SIZE = 500;
const GROUND_SEGS = 120;         // ~4.2-unit vertex spacing — covers visible road/tree range
const TREE_POOL_SIZE = 400;
const TREE_AHEAD = 250;       // trees placed this far ahead
const TREE_BEHIND = 50;       // keep trees this far behind
const TREE_BASE_OFFSET = 0.94; // model origin is this far above its base

const CLOUD_COUNT = 100;
const CLOUD_AHEAD = 400;
const CLOUD_BEHIND = 250;
const CLOUD_MIN_Y = 8;
const CLOUD_MAX_Y = 20;
const CLOUD_DRIFT = 1.5;      // units/sec lateral drift

// Chromakey shaders for green-screen video billboards.
// Uses green-dominance (G - max(R,B)) instead of distance from a single key color,
// so it handles wide-ranging green screens (dark to light) in a single pass.
const chromakeyVertex = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const chromakeyFragment = `
  uniform sampler2D map;
  uniform sampler2D maskTex;
  uniform float threshold;
  uniform float smoothness;
  varying vec2 vUv;
  void main() {
    float mask = texture2D(maskTex, vUv).r;
    if (mask > 0.5) discard;
    vec4 texColor = texture2D(map, vUv);
    // Green dominance: how much G exceeds the stronger of R and B
    float greenDom = texColor.g - max(texColor.r, texColor.b);
    // Pixels where green dominates → transparent
    float alpha = 1.0 - smoothstep(threshold, threshold + smoothness, greenDom);
    if (alpha < 0.01) discard;
    // Spill suppression: reduce green where it exceeds average of R and B
    vec3 col = texColor.rgb;
    float spillMax = 0.5 * (col.r + col.b) + 0.05;
    col.g = min(col.g, spillMax);
    gl_FragColor = vec4(col, alpha);
  }
`;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.tileSize = 4;

    // Road path (deterministic)
    this.roadPath = new RoadPath(42);

    // Road chunks
    this.roadChunks = new RoadChunkManager(scene, this.roadPath);

    // Ground deformation tracking — skip when snap position unchanged
    this._lastSnapX = NaN;
    this._lastSnapZ = NaN;

    // Tree PRNG — separate seed so road path changes don't affect trees
    this._treeRngState = 137;
    this._treeSeededRandom = () => {
      this._treeRngState = (this._treeRngState * 9301 + 49297) % 233280;
      return this._treeRngState / 233280;
    };

    // Tree pool
    this._treePool = [];     // { mesh, roadD, lateralOffset, scale, active }
    this._treeNextD = 0;     // next road-distance to place trees at
    this._treeSpacing = 3;   // average spacing along road
    this._treeModelReady = false;

    // Cloud pool
    this._cloudPool = [];    // { group, roadD, lateralOffset, baseY }
    this._cloudNextD = 0;
    this._cloudSpacing = 10;

    // Cloud PRNG — separate seed
    this._cloudRngState = 271;
    this._cloudSeededRandom = () => {
      this._cloudRngState = (this._cloudRngState * 9301 + 49297) % 233280;
      return this._cloudRngState / 233280;
    };

    // Hot air balloons
    this._balloons = [];
    this._balloonRngState = 53;
    this._balloonSeededRandom = () => {
      this._balloonRngState = (this._balloonRngState * 9301 + 49297) % 233280;
      return this._balloonRngState / 233280;
    };

    this._buildGround();
    this._buildTreePool();
    this._buildClouds();
    this._buildLighting();

    // Race markers (checkpoints + destination)
    this._raceMarkers = [];  // { mesh, roadD, type }
  }

  _buildGround() {
    const geom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGS, GROUND_SEGS);
    const size = 512;
    const canvas2d = document.createElement('canvas');
    canvas2d.width = size;
    canvas2d.height = size;
    const ctx = canvas2d.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const d = imgData.data;

    // Seeded PRNG
    let seed = 12345;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // Value noise with permutation table
    const perm = new Uint8Array(512);
    for (let i = 0; i < 256; i++) perm[i] = Math.floor(rand() * 256);
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const grad = new Float32Array(256);
    for (let i = 0; i < 256; i++) grad[i] = rand();

    const noise2d = (x, y) => {
      const ix = Math.floor(x) & 255, iy = Math.floor(y) & 255;
      const fx = x - Math.floor(x), fy = y - Math.floor(y);
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v00 = grad[perm[ix + perm[iy]]];
      const v10 = grad[perm[ix + 1 + perm[iy]]];
      const v01 = grad[perm[ix + perm[iy + 1]]];
      const v11 = grad[perm[ix + 1 + perm[iy + 1]]];
      return v00 + sx * (v10 - v00) + sy * (v01 - v00) + sx * sy * (v11 - v10 - v01 + v00);
    };

    // Multi-octave fbm
    const fbm = (x, y) => {
      return noise2d(x, y) * 0.5 + noise2d(x * 2.1, y * 2.1) * 0.3 + noise2d(x * 4.7, y * 4.7) * 0.2;
    };

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const idx = (py * size + px) * 4;

        // Multi-scale noise layers
        const terrain = fbm(px * 0.012, py * 0.012);     // large patches
        const mid = noise2d(px * 0.05, py * 0.05);        // medium detail
        const detail = noise2d(px * 0.12, py * 0.12);     // fine detail
        const fine = noise2d(px * 0.35, py * 0.35);       // per-blade scale
        const clump = fbm(px * 0.035 + 60, py * 0.035 + 60); // grass clumps

        let r, g, b;

        // Rock outcrops
        const rockZone = terrain < 0.2;
        const rockTransition = terrain >= 0.2 && terrain < 0.28;

        // Dirt patches
        const dirtZone = terrain > 0.62;
        const dirtTransition = terrain > 0.56 && terrain <= 0.62;

        if (rockZone) {
          // Rock — gray-brown boulders with variation
          const br = 0.55 + mid * 0.3 + fine * 0.15;
          r = (115 + detail * 30) * br;
          g = (108 + detail * 25) * br;
          b = (95 + detail * 25) * br;
          // Some rocks darker / more brown
          if (fine > 0.6) { r *= 1.1; g *= 0.95; }
        } else if (rockTransition) {
          // Rock → grass blend
          const bl = (terrain - 0.2) / 0.08;
          const rBr = 0.55 + mid * 0.3 + fine * 0.15;
          const rockR = (115 + detail * 30) * rBr;
          const rockG = (108 + detail * 25) * rBr;
          const rockB = (95 + detail * 25) * rBr;
          const gBr = 0.5 + clump * 0.3 + fine * 0.1;
          const grassR = (30 + mid * 20) * gBr;
          const grassG = (85 + mid * 45 + clump * 25) * gBr;
          const grassB = (22 + mid * 12) * gBr;
          r = rockR * (1 - bl) + grassR * bl;
          g = rockG * (1 - bl) + grassG * bl;
          b = rockB * (1 - bl) + grassB * bl;
        } else if (dirtZone) {
          // Dirt — warm brown
          const br = 0.75 + mid * 0.2 + fine * 0.1;
          r = (130 + detail * 30) * br;
          g = (100 + detail * 20) * br;
          b = (60 + detail * 15) * br;
        } else if (dirtTransition) {
          // Grass → dirt blend
          const bl = (terrain - 0.56) / 0.06;
          const dBr = 0.75 + mid * 0.2 + fine * 0.1;
          const dirtR = (130 + detail * 30) * dBr;
          const dirtG = (100 + detail * 20) * dBr;
          const dirtB = (60 + detail * 15) * dBr;
          const gBr = 0.5 + clump * 0.3 + fine * 0.1;
          const grassR = (30 + mid * 20) * gBr;
          const grassG = (85 + mid * 45 + clump * 25) * gBr;
          const grassB = (22 + mid * 12) * gBr;
          r = grassR * (1 - bl) + dirtR * bl;
          g = grassG * (1 - bl) + dirtG * bl;
          b = grassB * (1 - bl) + dirtB * bl;
        } else {
          // GRASS — deep, lush, saturated greens with thick texture
          const gBr = 0.5 + clump * 0.3 + fine * 0.1;
          const hueShift = (mid - 0.5) * 18;
          r = Math.max(0, (30 + hueShift * 0.7 + mid * 20) * gBr);
          g = (85 + mid * 45 + clump * 25 - hueShift * 0.2) * gBr;
          b = Math.max(0, (22 + hueShift * 0.3 + mid * 12) * gBr);

          // Dark shadow tufts — simulate thick grass depth
          if (detail > 0.55 && fine < 0.45) {
            r *= 0.55; g *= 0.65; b *= 0.5;
          }
          // Bright highlight tufts — sun-lit blade tips
          else if (detail < 0.3 && fine > 0.65) {
            r += 12; g += 20; b += 5;
          }

          // Scattered rocks within grass
          const rockScatter = noise2d(px * 0.09 + 40, py * 0.09 + 40);
          if (rockScatter > 0.74) {
            const bl = (rockScatter - 0.74) / 0.26;
            const rb = 0.55 + fine * 0.35;
            r = r * (1 - bl) + 105 * rb * bl;
            g = g * (1 - bl) + 100 * rb * bl;
            b = b * (1 - bl) + 90 * rb * bl;
          }
        }

        d[idx]     = Math.max(0, Math.min(255, Math.floor(r)));
        d[idx + 1] = Math.max(0, Math.min(255, Math.floor(g)));
        d[idx + 2] = Math.max(0, Math.min(255, Math.floor(b)));
        d[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas2d);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    const mat = new THREE.MeshStandardMaterial({ map: texture });

    this.floor = new THREE.Mesh(geom, mat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.floor.frustumCulled = false; // always visible around bike — skip bounding sphere

    // Pre-set all normals to (0,1,0) — ground is nearly flat, no need to recompute per frame
    const normalAttr = geom.attributes.normal;
    for (let i = 0; i < normalAttr.count; i++) {
      normalAttr.setXYZ(i, 0, 0, 1); // in geometry space (rotated -PI/2 on X → world Y up)
    }
    normalAttr.needsUpdate = true;

    this.scene.add(this.floor);
  }

  _buildTreePool() {
    const scales = [0.7, 1.0, 1.3];

    // Load GLB pine tree model, then populate pool with clones
    const loader = new GLTFLoader();
    loader.load('assets/landscape/lowpoly_pine_tree.glb', (gltf) => {
      const template = gltf.scene;
      // Fix Sketchfab baked transforms: node "PineTree_001" has 100x scale
      // and a large translation offset — neutralise them so the tree is
      // ~2.5 units tall and centred at origin.
      template.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
        }
        if (child.name === 'PineTree_001') {
          child.scale.setScalar(1);
          child.position.set(0, 0, 0);
        }
      });

      for (let i = 0; i < TREE_POOL_SIZE; i++) {
        const si = i % scales.length;
        const scale = scales[si];
        const mesh = template.clone();
        mesh.scale.setScalar(scale);
        mesh.visible = false;
        // Slight random Y rotation for variety
        mesh.rotation.set(0, (i * 2.399) % (Math.PI * 2), 0);
        this.scene.add(mesh);

        this._treePool.push({
          mesh,
          roadD: -1,
          lateralOffset: 0,
          scale,
          active: false
        });
      }

      this._treeModelReady = true;
      // Now place all trees for the loop
      this._placeTreesUpTo(this.roadPath.loopLength);
    }, undefined, (err) => {
      console.error('Failed to load pine tree model:', err);
    });
  }

  _placeTreesUpTo(maxD) {
    const cap = this.roadPath.loopLength;
    if (maxD > cap) maxD = cap;

    while (this._treeNextD < maxD) {
      const d = this._treeNextD;
      this._treeNextD += this._treeSpacing + this._treeSeededRandom() * 4;

      // Find inactive tree slot
      const slot = this._treePool.find(t => !t.active);
      if (!slot) break;

      const side = this._treeSeededRandom() > 0.5 ? 1 : -1;
      const lateralDist = 5 + this._treeSeededRandom() * 40;
      const lateralOffset = side * lateralDist;

      const pt = this.roadPath.getPointAtDistance(d);
      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const worldX = pt.x + rightX * lateralOffset;
      const worldZ = pt.z + rightZ * lateralOffset;
      const terrainY = pt.y;

      slot.mesh.position.set(worldX, terrainY + TREE_BASE_OFFSET * slot.scale, worldZ);
      slot.mesh.visible = false;
      slot.roadD = d;
      slot.lateralOffset = lateralOffset;
      slot.active = true;
    }
  }

  _updateTreeVisibility(bikeD) {
    const L = this.roadPath.loopLength;
    for (const slot of this._treePool) {
      if (!slot.active) continue;
      let ahead = slot.roadD - bikeD;
      if (ahead < -L / 2) ahead += L;
      if (ahead > L / 2) ahead -= L;
      slot.mesh.visible = (ahead > -TREE_BEHIND && ahead < TREE_AHEAD);
    }
  }

  _updateTreeHeights(bikeD) {
    // Update visible tree Y positions using same forward-projection as ground mesh
    const bikePt = this.roadPath.getPointAtDistance(bikeD);
    const fwdX = Math.sin(bikePt.heading);
    const fwdZ = Math.cos(bikePt.heading);

    for (const slot of this._treePool) {
      if (!slot.mesh.visible) continue;
      const dx = slot.mesh.position.x - bikePt.x;
      const dz = slot.mesh.position.z - bikePt.z;
      const estD = bikeD + dx * fwdX + dz * fwdZ;
      const h = this.roadPath.getPointAtDistance(estD).y;
      slot.mesh.position.y = h + TREE_BASE_OFFSET * slot.scale;
    }
  }

  // ── Clouds ──────────────────────────────────────────────────

  _buildClouds() {
    const cloudMat = new THREE.MeshBasicMaterial({
      color: 0xf0f6fc,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      fog: false,
    });

    // Shared sphere geometries for cloud puffs (3 size tiers)
    const puffGeos = [
      new THREE.SphereGeometry(1, 7, 5),
      new THREE.SphereGeometry(1, 7, 5),
      new THREE.SphereGeometry(1, 7, 5),
    ];

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const group = new THREE.Group();
      // Build a cluster of 10-18 overlapping spheres for big fluffy shapes
      const puffCount = 10 + Math.floor(this._cloudSeededRandom() * 9);
      const cloudWidth = 25 + this._cloudSeededRandom() * 40; // 25-65 units wide
      const cloudHeight = 6 + this._cloudSeededRandom() * 8;  // 6-14 units tall

      for (let p = 0; p < puffCount; p++) {
        const geo = puffGeos[p % puffGeos.length];
        const puff = new THREE.Mesh(geo, cloudMat);
        const t = puffCount > 1 ? p / (puffCount - 1) : 0.5;
        const sx = 5 + this._cloudSeededRandom() * 10;  // puff X scale
        const sy = 4 + this._cloudSeededRandom() * 6;   // puff Y scale
        const sz = 4.5 + this._cloudSeededRandom() * 7;
        puff.scale.set(sx, sy, sz);
        puff.position.set(
          (t - 0.5) * cloudWidth + (this._cloudSeededRandom() - 0.5) * 8,
          (this._cloudSeededRandom() - 0.3) * cloudHeight * 0.5,
          (this._cloudSeededRandom() - 0.5) * 10
        );
        group.add(puff);
      }

      group.visible = false;
      this.scene.add(group);
      this._cloudPool.push({
        group,
        roadD: -1,
        lateralOffset: 0,
        baseY: 0,
        active: false,
      });
    }

    // Place all clouds for the loop
    this._placeCloudsUpTo(this.roadPath.loopLength);
  }

  _placeCloudsUpTo(maxD) {
    const cap = this.roadPath.loopLength;
    if (maxD > cap) maxD = cap;

    while (this._cloudNextD < maxD) {
      const d = this._cloudNextD;
      this._cloudNextD += this._cloudSpacing + this._cloudSeededRandom() * 40;

      const slot = this._cloudPool.find(c => !c.active);
      if (!slot) break;

      const side = this._cloudSeededRandom() > 0.5 ? 1 : -1;
      const lateralDist = 8 + this._cloudSeededRandom() * 142; // 8-150 units from road
      const lateralOffset = side * lateralDist;

      const pt = this.roadPath.getPointAtDistance(d);
      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const worldX = pt.x + rightX * lateralOffset;
      const worldZ = pt.z + rightZ * lateralOffset;
      const baseY = CLOUD_MIN_Y + this._cloudSeededRandom() * (CLOUD_MAX_Y - CLOUD_MIN_Y);

      slot.group.position.set(worldX, baseY, worldZ);
      slot.group.visible = false;
      slot.roadD = d;
      slot.lateralOffset = lateralOffset;
      slot.baseY = baseY;
      slot.active = true;
    }
  }

  _updateCloudVisibility(bikeD) {
    const L = this.roadPath.loopLength;
    for (const slot of this._cloudPool) {
      if (!slot.active) continue;
      let ahead = slot.roadD - bikeD;
      if (ahead < -L / 2) ahead += L;
      if (ahead > L / 2) ahead -= L;
      slot.group.visible = (ahead > -CLOUD_BEHIND && ahead < CLOUD_AHEAD);
    }
  }

  _driftClouds(dt) {
    const drift = CLOUD_DRIFT * dt;
    for (const slot of this._cloudPool) {
      if (!slot.active || !slot.group.visible) continue;
      slot.group.position.x += drift;
    }
  }

  // ── Hot air balloons ────────────────────────────────────

  setBalloonColor(hexColor) {
    // Remove old balloons
    for (const b of this._balloons) this.scene.remove(b.group);
    this._balloons = [];
    this._balloonRngState = 53; // reset seed for determinism

    const bikeColor = new THREE.Color(hexColor);
    const white = new THREE.Color(0xffffff);
    const BALLOON_COUNT = 3;
    const stripeCount = 8; // vertical stripe panels

    for (let i = 0; i < BALLOON_COUNT; i++) {
      const group = new THREE.Group();

      // ── Envelope (balloon) via LatheGeometry with striped materials ──
      // Profile curve: teardrop/balloon shape
      const pts = [];
      const segs = 20;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const angle = t * Math.PI;
        // Balloon profile: wider at top, tapering at bottom
        let r = Math.sin(angle);
        // Flatten the top slightly, taper the bottom
        if (t < 0.15) r *= t / 0.15;            // neck opening
        r *= 1.0 - 0.25 * Math.pow(t, 3);       // elongate bottom taper
        const y = (1.0 - t) * 6;                 // 6 units tall
        pts.push(new THREE.Vector2(r * 2.5, y)); // 2.5 radius at widest
      }

      const envelopeGeo = new THREE.LatheGeometry(pts, stripeCount);

      // Assign material groups: alternating stripes
      envelopeGeo.clearGroups();
      const facesPerStripe = (segs) * 2; // triangles per stripe column
      for (let s = 0; s < stripeCount; s++) {
        envelopeGeo.addGroup(s * facesPerStripe * 3, facesPerStripe * 3, s % 2);
      }

      const matColor = new THREE.MeshBasicMaterial({ color: bikeColor, side: THREE.DoubleSide, fog: false });
      const matWhite = new THREE.MeshBasicMaterial({ color: white, side: THREE.DoubleSide, fog: false });
      const envelope = new THREE.Mesh(envelopeGeo, [matColor, matWhite]);
      group.add(envelope);

      // ── Basket ──
      const basketGeo = new THREE.BoxGeometry(1.0, 0.7, 1.0);
      const basketMat = new THREE.MeshBasicMaterial({ color: 0x8B5E3C, fog: false });
      const basket = new THREE.Mesh(basketGeo, basketMat);
      basket.position.y = -1.0;
      group.add(basket);

      // ── Ropes (4 lines from basket corners to envelope base) ──
      const ropeMat = new THREE.LineBasicMaterial({ color: 0x665544 });
      const ropeOffsets = [[0.4, 0.4], [-0.4, 0.4], [0.4, -0.4], [-0.4, -0.4]];
      for (const [rx, rz] of ropeOffsets) {
        const ropeGeo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(rx, -0.6, rz),
          new THREE.Vector3(rx * 0.3, 0.3, rz * 0.3),
        ]);
        group.add(new THREE.Line(ropeGeo, ropeMat));
      }

      // Place in world — keep closer to road so they sit in front of clouds
      const rng = this._balloonSeededRandom;
      const roadD = 200 + rng() * (this.roadPath.loopLength - 400);
      const side = rng() > 0.5 ? 1 : -1;
      const lateralDist = 20 + rng() * 60; // 20-80: closer than most clouds (15-295)
      const pt = this.roadPath.getPointAtDistance(roadD);
      const rightX = Math.cos(pt.heading);
      const rightZ = -Math.sin(pt.heading);
      const worldX = pt.x + rightX * side * lateralDist;
      const worldZ = pt.z + rightZ * side * lateralDist;
      const baseY = 25 + rng() * 30; // Y 25-55: overlap with cloud range
      const scale = 1.5 + rng() * 1.5; // 1.5-3x

      group.position.set(worldX, baseY, worldZ);
      group.scale.setScalar(scale);
      group.visible = false;
      this.scene.add(group);

      this._balloons.push({
        group,
        roadD,
        baseY,
        bobPhase: rng() * Math.PI * 2,
      });
    }
  }

  _updateBalloons(bikeD) {
    if (this._balloons.length === 0) return;
    const L = this.roadPath.loopLength;
    const t = performance.now() * 0.001;
    for (const b of this._balloons) {
      let ahead = b.roadD - bikeD;
      if (ahead < -L / 2) ahead += L;
      if (ahead > L / 2) ahead -= L;
      b.group.visible = (ahead > -CLOUD_BEHIND && ahead < CLOUD_AHEAD);
      if (b.group.visible) {
        // Gentle bob
        b.group.position.y = b.baseY + Math.sin(t * 0.4 + b.bobPhase) * 2;
      }
    }
  }

  // ── Ground deformation ────────────────────────────────────

  _deformGround(bikePos, bikeD) {
    // Floor is rotated -PI/2 on X, so geometry X = world X, geometry Y = world -Z
    // relative to the mesh's snap position
    const snapSize = this.tileSize;
    const snapX = Math.round(bikePos.x / snapSize) * snapSize;
    const snapZ = Math.round(bikePos.z / snapSize) * snapSize;

    // Skip recomputation when snap position hasn't changed (~4-8ms saved per frame)
    if (snapX === this._lastSnapX && snapZ === this._lastSnapZ) return;
    this._lastSnapX = snapX;
    this._lastSnapZ = snapZ;

    const posAttr = this.floor.geometry.attributes.position;
    const count = posAttr.count;

    // Pre-sample road elevations into a 1D height profile.
    // Single dot-product projection per vertex + array lookup — no iterative refinement,
    // no convergence issues on tight curves, ~160x fewer getPointAtDistance calls.
    const profileHalf = 270;
    const profileStep = 2;
    const profileStartD = bikeD - profileHalf;
    const profileEndD = bikeD + profileHalf;
    const profileCount = Math.ceil((profileEndD - profileStartD) / profileStep) + 1;

    // Reuse typed array across frames
    if (!this._heightProfile || this._heightProfile.length < profileCount) {
      this._heightProfile = new Float32Array(profileCount);
    }
    const hp = this._heightProfile;
    for (let i = 0; i < profileCount; i++) {
      hp[i] = this.roadPath.getPointAtDistance(profileStartD + i * profileStep).y;
    }

    const bikePt = this.roadPath.getPointAtDistance(bikeD);
    const fwdX = Math.sin(bikePt.heading);
    const fwdZ = Math.cos(bikePt.heading);

    for (let i = 0; i < count; i++) {
      const gx = posAttr.getX(i);
      const gy = posAttr.getY(i);

      const worldX = snapX + gx;
      const worldZ = snapZ - gy;

      // Project vertex offset onto road forward direction to get estimated road distance
      const dx = worldX - bikePt.x;
      const dz = worldZ - bikePt.z;
      const estD = bikeD + dx * fwdX + dz * fwdZ;

      // Look up height from pre-sampled profile with linear interpolation
      const profileIdx = (estD - profileStartD) / profileStep;
      const idx0 = Math.max(0, Math.min(profileCount - 2, Math.floor(profileIdx)));
      const frac = Math.max(0, Math.min(1, profileIdx - idx0));
      const h = hp[idx0] + (hp[idx0 + 1] - hp[idx0]) * frac;

      posAttr.setZ(i, h - 0.02);
    }

    posAttr.needsUpdate = true;
    // Normals pre-set to (0,0,1) at construction — ground is nearly flat
    // frustumCulled disabled at construction — no bounding sphere needed
  }

  _buildLighting() {
    const ambient = new THREE.AmbientLight(0x5566aa, 0.5);
    this.scene.add(ambient);

    this.sun = new THREE.DirectionalLight(0xffffdd, 1.1);
    this.sun.position.set(30, 40, 20);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.width = 1024;
    this.sun.shadow.mapSize.height = 1024;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 120;
    this.sun.shadow.camera.left = -35;
    this.sun.shadow.camera.right = 35;
    this.sun.shadow.camera.top = 35;
    this.sun.shadow.camera.bottom = -35;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const hemi = new THREE.HemisphereLight(0x99bbff, 0x44aa44, 0.35);
    this.scene.add(hemi);
  }

  checkTreeCollision(bikePos, bikeD, bikeHeading) {
    const L = this.roadPath.loopLength;
    const headX = bikePos.x + Math.sin(bikeHeading) * 2;
    const headZ = bikePos.z + Math.cos(bikeHeading) * 2;

    for (const slot of this._treePool) {
      if (!slot.active || !slot.mesh.visible) continue;

      // Quick road-distance filter (wrap-aware)
      let dd = slot.roadD - bikeD;
      if (dd < -L / 2) dd += L;
      if (dd > L / 2) dd -= L;
      if (Math.abs(dd) > 20) continue;

      const tx = slot.mesh.position.x;
      const tz = slot.mesh.position.z;
      const r = 0.6 * slot.scale;

      // Check bike center
      const dx1 = bikePos.x - tx;
      const dz1 = bikePos.z - tz;
      if (dx1 * dx1 + dz1 * dz1 < r * r) return { hit: true, tree: slot };

      // Check front of bike (2m ahead)
      const dx2 = headX - tx;
      const dz2 = headZ - tz;
      if (dx2 * dx2 + dz2 * dz2 < r * r) return { hit: true, tree: slot };
    }
    return { hit: false, tree: null };
  }

  setRaceMarkers(level, camera) {
    // Remove old markers + clean up video if any
    this._cleanupDestVideo();
    this._raceMarkers.forEach(m => this.scene.remove(m.mesh));
    this._raceMarkers = [];
    this._camera = camera || null;

    const L = this.roadPath.loopLength;

    // Checkpoint gold cloud arches
    const cloudTexture = this._makeCloudSprite();
    const archMat = new THREE.SpriteMaterial({
      map: cloudTexture, color: 0xffd700,
      transparent: true, opacity: 0.6, depthWrite: false
    });
    const minFinishGap = level.checkpointInterval * 0.5;
    for (let d = level.checkpointInterval; d < level.distance - minFinishGap; d += level.checkpointInterval) {
      const roadD = d % L;
      const pt = this.roadPath.getPointAtDistance(roadD);

      const group = new THREE.Group();

      // Place puffs along a semicircular arch over the road
      const archRadius = 2.8;   // half the road width
      const archCenterY = 0.2;  // arch base just above ground
      const puffCount = 16;
      for (let i = 0; i < puffCount; i++) {
        const angle = (i / (puffCount - 1)) * Math.PI; // 0 (right) to PI (left)
        const x = Math.cos(angle) * archRadius;
        const y = archCenterY + Math.sin(angle) * archRadius;
        const puff = new THREE.Sprite(archMat.clone());
        const s = 1.6 + Math.random() * 0.8;
        puff.scale.set(s, s, 1);
        puff.position.set(x, y, (Math.random() - 0.5) * 0.6);
        puff.userData.baseY = y;
        puff.userData.phase = Math.random() * Math.PI * 2;
        group.add(puff);
      }

      group.position.set(pt.x, pt.y, pt.z);
      group.rotation.y = pt.heading;
      group.visible = false;
      this.scene.add(group);

      this._raceMarkers.push({ mesh: group, roadD, type: 'checkpoint' });
    }

    // Your Home: chromakey video billboard just ahead of start line, left side
    {
      const homeD = 15;
      const homePt = this.roadPath.getPointAtDistance(homeD);
      const marker = this._createVideoBillboard({
        videoSrc: 'assets/your_house_chromakey.mp4',
        trimStart: 0.00, trimEnd: 6.04,
        threshold: 0.070, smoothness: 0.085,
        maskSrc: null,
        roadPt: homePt, roadD: homeD, lateralOffset: -4,
        type: 'start'
      });
      this._raceMarkers.push(marker);

      // Clear trees near the billboard so they don't overlap
      const bx = marker.mesh.position.x;
      const bz = marker.mesh.position.z;
      const clearRadius = 5;
      for (const slot of this._treePool) {
        if (!slot.active) continue;
        const dx = slot.mesh.position.x - bx;
        const dz = slot.mesh.position.z - bz;
        if (dx * dx + dz * dz < clearRadius * clearRadius) {
          slot.mesh.visible = false;
          slot.active = false;
        }
      }
    }

    // Destination marker
    const destD = level.distance % L;
    const destPt = this.roadPath.getPointAtDistance(destD);

    if (level.id === 'grandma') {
      // Grandma's House: chromakey video billboard
      const marker = this._createVideoBillboard({
        videoSrc: 'assets/grandma_house_chromakey.mp4',
        trimStart: 0.00, trimEnd: 5.50,
        threshold: -0.02, smoothness: 0.110,
        maskSrc: 'assets/grandma_house_chromakey_mask.png',
        roadPt: destPt, roadD: destD, lateralOffset: 6,
        type: 'destination'
      });
      this._raceMarkers.push(marker);
    } else {
      // Other levels: simple house shape (box + pyramid roof)
      const destGroup = new THREE.Group();
      const wallGeo = new THREE.BoxGeometry(3, 2.5, 3);
      const wallMat = new THREE.MeshPhongMaterial({ color: 0x8888cc, emissive: 0x111111 });
      const walls = new THREE.Mesh(wallGeo, wallMat);
      walls.position.y = 1.25;
      destGroup.add(walls);

      const roofGeo = new THREE.ConeGeometry(2.5, 1.5, 4);
      const roofMat = new THREE.MeshPhongMaterial({ color: 0xddaa22, emissive: 0x111100 });
      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.position.y = 3.25;
      roof.rotation.y = Math.PI / 4;
      destGroup.add(roof);

      const fwdX = Math.sin(destPt.heading);
      const fwdZ = Math.cos(destPt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;
      destGroup.position.set(
        destPt.x + rightX * 6,
        destPt.y,
        destPt.z + rightZ * 6
      );
      destGroup.rotation.y = destPt.heading;
      destGroup.visible = false;
      this.scene.add(destGroup);

      this._raceMarkers.push({ mesh: destGroup, roadD: destD, type: 'destination' });
    }

    // Finish line stripe at the end of every level
    this._createFinishStripe(level.distance);

    // Tutorial: start line + phase boundary stripes
    if (level.isTutorial) {
      this._createFinishStripe(0, 0x44ff66, 0x115511);   // Start line (green)
      this._createFinishStripe(30, 0xffd700, 0x444400);   // Phase 1→2 (gold)
      this._createFinishStripe(70, 0xffd700, 0x444400);   // Phase 2→3
      this._createFinishStripe(105, 0xffd700, 0x444400);  // Phase 3→4
    }
  }

  /** Create a checkered finish-line stripe on the road at the given distance. */
  _createFinishStripe(distance, color1 = 0xffffff, color2 = 0x222222) {
    const L = this.roadPath.loopLength;
    const roadD = distance % L;
    const pt = this.roadPath.getPointAtDistance(roadD);

    // Build checkered texture
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const squareW = 8;
    for (let x = 0; x < 64; x += squareW) {
      for (let y = 0; y < 16; y += squareW) {
        const isWhite = ((x / squareW) + (y / squareW)) % 2 === 0;
        ctx.fillStyle = isWhite ? '#' + color1.toString(16).padStart(6, '0')
                                 : '#' + color2.toString(16).padStart(6, '0');
        ctx.fillRect(x, y, squareW, squareW);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;

    // Stripe is 6m wide (road width) × 0.8m deep
    const geo = new THREE.PlaneGeometry(6, 0.8);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const stripe = new THREE.Mesh(geo, mat);
    stripe.rotation.x = -Math.PI / 2; // lay flat

    // Use a group to handle road heading rotation independently
    const group = new THREE.Group();
    group.add(stripe);
    group.position.set(pt.x, pt.y + 0.05, pt.z);
    group.rotation.y = pt.heading; // align perpendicular to road direction
    group.visible = false;
    this.scene.add(group);

    const mesh = group;

    this._raceMarkers.push({ mesh, roadD, type: 'stripe' });
    return mesh;
  }

  _createVideoBillboard({ videoSrc, trimStart, trimEnd, threshold, smoothness, maskSrc, roadPt, roadD, lateralOffset, type }) {
    const video = document.createElement('video');
    video.src = videoSrc;
    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    video.addEventListener('timeupdate', () => {
      if (video.currentTime > trimEnd) {
        video.currentTime = trimStart;
        video.play().catch(() => {});
      }
    });

    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;

    // Track for cleanup
    if (!this._billboardVideos) this._billboardVideos = [];
    this._billboardVideos.push({ video, texture: videoTexture });

    // Mask texture — fallback to 1x1 empty (no mask)
    const fallbackMask = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    fallbackMask.needsUpdate = true;
    const maskUniform = { value: fallbackMask };
    if (maskSrc) {
      new THREE.TextureLoader().load(
        maskSrc,
        (tex) => { maskUniform.value = tex; },
        undefined,
        () => { /* mask not found — fallback already set */ }
      );
    }

    const size = 6;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: videoTexture },
        maskTex: maskUniform,
        threshold: { value: threshold },
        smoothness: { value: smoothness }
      },
      vertexShader: chromakeyVertex,
      fragmentShader: chromakeyFragment,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const mesh = new THREE.Mesh(geo, mat);
    const fwdX = Math.sin(roadPt.heading);
    const fwdZ = Math.cos(roadPt.heading);
    const rightX = fwdZ;
    const rightZ = -fwdX;
    mesh.position.set(
      roadPt.x + rightX * lateralOffset,
      roadPt.y + size * 0.5,
      roadPt.z + rightZ * lateralOffset
    );
    mesh.visible = false;
    const marker = { mesh, roadD, type, billboard: true, videoReady: false };
    video.addEventListener('playing', () => { marker.videoReady = true; });
    this.scene.add(mesh);
    return marker;
  }

  _makeCloudSprite() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  clearRaceMarkers() {
    this._cleanupDestVideo();
    this._raceMarkers.forEach(m => this.scene.remove(m.mesh));
    this._raceMarkers = [];
  }

  _cleanupDestVideo() {
    if (this._billboardVideos) {
      for (const bv of this._billboardVideos) {
        bv.video.pause();
        bv.video.src = '';
        bv.texture.dispose();
      }
    }
    this._billboardVideos = [];
  }

  _updateRaceMarkerVisibility(bikeD) {
    const L = this.roadPath.loopLength;
    for (const marker of this._raceMarkers) {
      let ahead = marker.roadD - bikeD;
      if (ahead < -L / 2) ahead += L;
      if (ahead > L / 2) ahead -= L;
      const inRange = (ahead > -TREE_BEHIND && ahead < TREE_AHEAD);
      // Gate billboard video on readiness to prevent black frame flash
      marker.mesh.visible = marker.billboard ? (inRange && marker.videoReady) : inRange;
    }
  }

  _updateRaceMarkerHeights(bikeD) {
    const t = performance.now() * 0.001;
    for (const marker of this._raceMarkers) {
      if (!marker.mesh.visible) continue;
      const pt = this.roadPath.getPointAtDistance(marker.roadD);

      // Billboard destination video: offset Y so bottom sits on ground, face camera
      if (marker.billboard) {
        marker.mesh.position.y = pt.y + 3; // half of 6-unit billboard
        if (this._camera) {
          marker.mesh.quaternion.copy(this._camera.quaternion);
        }
      } else if (marker.type === 'stripe') {
        marker.mesh.position.y = pt.y + 0.05; // just above road surface
      } else {
        marker.mesh.position.y = pt.y;
      }

      // Animate checkpoint cloud puffs: gentle bob from stored base position
      if (marker.type === 'checkpoint') {
        for (const child of marker.mesh.children) {
          if (child.userData.baseY === undefined) continue;
          child.position.y = child.userData.baseY + Math.sin(t * 1.2 + child.userData.phase) * 0.08;
        }
      }
    }
  }

  update(bikePos, bikeD, dt) {
    // Default bikeD from position if not provided (backward compat)
    if (bikeD === undefined) {
      bikeD = Math.max(0, bikePos.z);
    }

    // Sun follows bike
    this.sun.position.set(bikePos.x + 30, bikePos.y + 40, bikePos.z + 20);
    this.sun.target.position.copy(bikePos);
    this.sun.target.updateMatrixWorld();

    // Road chunks
    this.roadChunks.update(bikeD);

    // Trees
    this._updateTreeVisibility(bikeD);
    this._updateTreeHeights(bikeD);

    // Clouds & balloons
    this._updateCloudVisibility(bikeD);
    if (dt) this._driftClouds(dt);
    this._updateBalloons(bikeD);

    // Race markers
    if (this._raceMarkers.length > 0) {
      this._updateRaceMarkerVisibility(bikeD);
      this._updateRaceMarkerHeights(bikeD);
    }

    // Floor snap-follow + deform (snap at tileSize to reduce visual pop)
    const snapSize = this.tileSize;
    const snapX = Math.round(bikePos.x / snapSize) * snapSize;
    const snapZ = Math.round(bikePos.z / snapSize) * snapSize;
    this.floor.position.x = snapX;
    this.floor.position.z = snapZ;

    // Offset texture to keep grass stable in world space
    const tex = this.floor.material.map;
    tex.offset.x = snapX / GROUND_SIZE;
    tex.offset.y = -snapZ / GROUND_SIZE;

    this._deformGround(bikePos, bikeD);
  }
}
