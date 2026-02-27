// ============================================================
// WORLD — terrain ground, road chunks, trees, lighting
// ============================================================

import * as THREE from 'three';
import { RoadPath } from './road-path.js';
import { RoadChunkManager } from './road-chunks.js';

const GROUND_SIZE = 500;
const GROUND_SEGS = 120;         // ~4.2-unit vertex spacing — covers visible road/tree range
const TREE_POOL_SIZE = 200;
const TREE_AHEAD = 250;       // trees placed this far ahead
const TREE_BEHIND = 50;       // keep trees this far behind

export class World {
  constructor(scene) {
    this.scene = scene;
    this.tileSize = 4;

    // Road path (deterministic)
    this.roadPath = new RoadPath(42);

    // Road chunks
    this.roadChunks = new RoadChunkManager(scene, this.roadPath);

    // Tree PRNG — separate seed so road path changes don't affect trees
    this._treeRngState = 137;
    this._treeSeededRandom = () => {
      this._treeRngState = (this._treeRngState * 9301 + 49297) % 233280;
      return this._treeRngState / 233280;
    };

    // Tree pool
    this._treePool = [];     // { trunk, canopy, roadD, lateralOffset, scale }
    this._treeNextD = 0;     // next road-distance to place trees at
    this._treeSpacing = 6;   // average spacing along road

    this._buildGround();
    this._buildTreePool();
    this._buildLighting();

    // Pre-place all trees for the entire loop
    this._placeTreesUpTo(this.roadPath.loopLength);

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
    this.scene.add(this.floor);
  }

  _buildTreePool() {
    const trunkMat = new THREE.MeshPhongMaterial({ color: 0x7a5230, flatShading: true });
    const leafMat = new THREE.MeshPhongMaterial({ color: 0x2d8a2d, flatShading: true });
    const leafMat2 = new THREE.MeshPhongMaterial({ color: 0x1f7a1f, flatShading: true });

    // Shared geometries for each scale bucket (3 sizes)
    const scales = [0.7, 1.0, 1.3];
    const trunkGeos = scales.map(s =>
      new THREE.CylinderGeometry(0.12 * s, 0.18 * s, 2.0 * s, 6)
    );
    const canopyGeos = scales.map(s =>
      new THREE.SphereGeometry(1.0 * s, 6, 5)
    );

    for (let i = 0; i < TREE_POOL_SIZE; i++) {
      const si = i % scales.length;
      const scale = scales[si];

      const trunk = new THREE.Mesh(trunkGeos[si], trunkMat);
      trunk.castShadow = true;
      trunk.visible = false;
      this.scene.add(trunk);

      const mat = (i % 2 === 0) ? leafMat : leafMat2;
      const canopy = new THREE.Mesh(canopyGeos[si], mat);
      canopy.castShadow = true;
      canopy.visible = false;
      this.scene.add(canopy);

      this._treePool.push({
        trunk, canopy,
        roadD: -1,
        lateralOffset: 0,
        scale,
        active: false
      });
    }
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

      slot.trunk.position.set(worldX, terrainY + slot.scale, worldZ);
      slot.canopy.position.set(worldX, terrainY + 2.3 * slot.scale, worldZ);
      slot.trunk.visible = false;
      slot.canopy.visible = false;
      slot.roadD = d;
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
      const visible = (ahead > -TREE_BEHIND && ahead < TREE_AHEAD);
      slot.trunk.visible = visible;
      slot.canopy.visible = visible;
    }
  }

  _updateTreeHeights(bikeD) {
    // Update visible tree Y positions using same forward-projection as ground mesh
    const bikePt = this.roadPath.getPointAtDistance(bikeD);
    const fwdX = Math.sin(bikePt.heading);
    const fwdZ = Math.cos(bikePt.heading);

    for (const slot of this._treePool) {
      if (!slot.trunk.visible) continue;
      const dx = slot.trunk.position.x - bikePt.x;
      const dz = slot.trunk.position.z - bikePt.z;
      const estD = bikeD + dx * fwdX + dz * fwdZ;
      const h = this.roadPath.getPointAtDistance(estD).y;
      slot.trunk.position.y = h + slot.scale;
      slot.canopy.position.y = h + 2.3 * slot.scale;
    }
  }

  _deformGround(bikePos, bikeD) {
    const posAttr = this.floor.geometry.attributes.position;
    const count = posAttr.count;

    // Floor is rotated -PI/2 on X, so geometry X = world X, geometry Y = world -Z
    // relative to the mesh's snap position
    const snapSize = this.tileSize;
    const snapX = Math.round(bikePos.x / snapSize) * snapSize;
    const snapZ = Math.round(bikePos.z / snapSize) * snapSize;

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
    this.floor.geometry.computeVertexNormals();
    this.floor.geometry.computeBoundingSphere();
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
      if (!slot.active || !slot.trunk.visible) continue;

      // Quick road-distance filter (wrap-aware)
      let dd = slot.roadD - bikeD;
      if (dd < -L / 2) dd += L;
      if (dd > L / 2) dd -= L;
      if (Math.abs(dd) > 20) continue;

      const tx = slot.trunk.position.x;
      const tz = slot.trunk.position.z;
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

  setRaceMarkers(level) {
    // Remove old markers
    this._raceMarkers.forEach(m => this.scene.remove(m.mesh));
    this._raceMarkers = [];

    const L = this.roadPath.loopLength;

    // Checkpoint gold cloud arches
    const cloudTexture = this._makeCloudSprite();
    const archMat = new THREE.SpriteMaterial({
      map: cloudTexture, color: 0xffd700,
      transparent: true, opacity: 0.6, depthWrite: false
    });
    for (let d = level.checkpointInterval; d < level.distance; d += level.checkpointInterval) {
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

    // Destination marker
    const destD = level.distance % L;
    const destPt = this.roadPath.getPointAtDistance(destD);
    const destGroup = new THREE.Group();

    // Simple house shape: box + pyramid roof
    const wallGeo = new THREE.BoxGeometry(3, 2.5, 3);
    const wallMat = new THREE.MeshPhongMaterial({ color: level.id === 'grandma' ? 0xdd8844 : 0x8888cc, emissive: 0x111111 });
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.position.y = 1.25;
    destGroup.add(walls);

    const roofGeo = new THREE.ConeGeometry(2.5, 1.5, 4);
    const roofMat = new THREE.MeshPhongMaterial({ color: level.id === 'grandma' ? 0xcc3333 : 0xddaa22, emissive: 0x111100 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 3.25;
    roof.rotation.y = Math.PI / 4;
    destGroup.add(roof);

    // Place off to the side of the road so it's visible but not blocking
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
    this._raceMarkers.forEach(m => this.scene.remove(m.mesh));
    this._raceMarkers = [];
  }

  _updateRaceMarkerVisibility(bikeD) {
    const L = this.roadPath.loopLength;
    for (const marker of this._raceMarkers) {
      let ahead = marker.roadD - bikeD;
      if (ahead < -L / 2) ahead += L;
      if (ahead > L / 2) ahead -= L;
      marker.mesh.visible = (ahead > -TREE_BEHIND && ahead < TREE_AHEAD);
    }
  }

  _updateRaceMarkerHeights(bikeD) {
    const t = performance.now() * 0.001;
    for (const marker of this._raceMarkers) {
      if (!marker.mesh.visible) continue;
      const pt = this.roadPath.getPointAtDistance(marker.roadD);
      marker.mesh.position.y = pt.y;

      // Animate checkpoint cloud puffs: gentle bob from stored base position
      if (marker.type === 'checkpoint') {
        for (const child of marker.mesh.children) {
          if (child.userData.baseY === undefined) continue;
          child.position.y = child.userData.baseY + Math.sin(t * 1.2 + child.userData.phase) * 0.08;
        }
      }
    }
  }

  update(bikePos, bikeD) {
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
