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
  }

  _buildGround() {
    const geom = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEGS, GROUND_SEGS);
    const canvas2d = document.createElement('canvas');
    const tilesPerSide = GROUND_SIZE / this.tileSize;
    canvas2d.width = tilesPerSide;
    canvas2d.height = tilesPerSide;
    const ctx = canvas2d.getContext('2d');
    for (let y = 0; y < tilesPerSide; y++) {
      for (let x = 0; x < tilesPerSide; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#5a9a4a' : '#4a8a3a';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const texture = new THREE.CanvasTexture(canvas2d);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
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

    // Floor snap-follow + deform (snap at tileSize to reduce visual pop)
    const snapSize = this.tileSize;
    const snapX = Math.round(bikePos.x / snapSize) * snapSize;
    const snapZ = Math.round(bikePos.z / snapSize) * snapSize;
    this.floor.position.x = snapX;
    this.floor.position.z = snapZ;

    // Offset texture to keep checkerboard stable in world space
    const tex = this.floor.material.map;
    tex.offset.x = snapX / GROUND_SIZE;
    tex.offset.y = -snapZ / GROUND_SIZE;

    this._deformGround(bikePos, bikeD);
  }
}
