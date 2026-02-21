// ============================================================
// ROAD CHUNKS — pooled road surface meshes following RoadPath
// ============================================================

import * as THREE from 'three';

const CHUNK_LENGTH = 50;       // road distance per chunk
const POOL_SIZE = 12;          // number of chunks in pool
const SAMPLES_PER_CHUNK = 50;  // cross-sections per chunk
const ROAD_HALF_WIDTH = 2.5;
const DASH_SPACING = 4;        // distance between dashes
const DASH_LENGTH = 1.8;

export class RoadChunkManager {
  constructor(scene, roadPath) {
    this.scene = scene;
    this.roadPath = roadPath;

    // Materials
    this._roadMat = new THREE.MeshPhongMaterial({
      color: 0x555555, flatShading: true, side: THREE.DoubleSide
    });
    this._dashMat = new THREE.MeshPhongMaterial({
      color: 0xdddd00, flatShading: true, side: THREE.DoubleSide
    });
    this._edgeMat = new THREE.MeshPhongMaterial({
      color: 0xffffff, flatShading: true, side: THREE.DoubleSide
    });

    // Pool of chunks
    this._chunks = [];   // { startD, group, roadMesh, dashMesh, edgeMeshL, edgeMeshR }
    this._activeStartDs = new Set();
    this._lastBikeD = 0;

    // Pre-build pool
    for (let i = 0; i < POOL_SIZE; i++) {
      this._chunks.push(this._createChunkSlot());
    }

    // Initial placement
    this._rebuildAll(0);
  }

  _createChunkSlot() {
    const group = new THREE.Group();
    group.visible = false;
    this.scene.add(group);

    // Road surface
    const roadGeo = this._createRoadGeometry();
    const roadMesh = new THREE.Mesh(roadGeo, this._roadMat);
    roadMesh.receiveShadow = true;
    group.add(roadMesh);

    // Center dashes
    const dashGeo = this._createStripGeometry(0.06);
    const dashMesh = new THREE.Mesh(dashGeo, this._dashMat);
    group.add(dashMesh);

    // Edge lines
    const edgeGeoL = this._createStripGeometry(0.05);
    const edgeMeshL = new THREE.Mesh(edgeGeoL, this._edgeMat);
    group.add(edgeMeshL);

    const edgeGeoR = this._createStripGeometry(0.05);
    const edgeMeshR = new THREE.Mesh(edgeGeoR, this._edgeMat);
    group.add(edgeMeshR);

    return { startD: -1, group, roadMesh, dashMesh, edgeMeshL, edgeMeshR };
  }

  _createRoadGeometry() {
    // Triangle strip: (SAMPLES_PER_CHUNK + 1) cross-sections, 2 verts each
    const n = SAMPLES_PER_CHUNK + 1;
    const positions = new Float32Array(n * 2 * 3);
    const normals = new Float32Array(n * 2 * 3);
    const indices = [];

    for (let i = 0; i < n - 1; i++) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
  }

  _createStripGeometry(halfWidth) {
    // Same structure but narrower, for dashes and edges
    const n = SAMPLES_PER_CHUNK + 1;
    const positions = new Float32Array(n * 2 * 3);
    const normals = new Float32Array(n * 2 * 3);
    const indices = [];

    for (let i = 0; i < n - 1; i++) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setIndex(indices);
    return geo;
  }

  _fillRoadGeometry(chunk, startD) {
    const step = CHUNK_LENGTH / SAMPLES_PER_CHUNK;
    const n = SAMPLES_PER_CHUNK + 1;
    const pos = chunk.roadMesh.geometry.attributes.position.array;
    const nrm = chunk.roadMesh.geometry.attributes.normal.array;

    for (let i = 0; i < n; i++) {
      const d = startD + i * step;
      const pt = this.roadPath.getPointAtDistance(d);

      // Right vector from heading
      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const idx = i * 2 * 3;
      // Left vertex
      pos[idx]     = pt.x - rightX * ROAD_HALF_WIDTH;
      pos[idx + 1] = pt.y + 0.12; // slight offset above terrain
      pos[idx + 2] = pt.z - rightZ * ROAD_HALF_WIDTH;
      // Right vertex
      pos[idx + 3] = pt.x + rightX * ROAD_HALF_WIDTH;
      pos[idx + 4] = pt.y + 0.12;
      pos[idx + 5] = pt.z + rightZ * ROAD_HALF_WIDTH;

      // Normals pointing up
      nrm[idx] = 0; nrm[idx + 1] = 1; nrm[idx + 2] = 0;
      nrm[idx + 3] = 0; nrm[idx + 4] = 1; nrm[idx + 5] = 0;
    }

    chunk.roadMesh.geometry.attributes.position.needsUpdate = true;
    chunk.roadMesh.geometry.attributes.normal.needsUpdate = true;
    chunk.roadMesh.geometry.computeBoundingSphere();
  }

  _fillDashGeometry(chunk, startD) {
    const step = CHUNK_LENGTH / SAMPLES_PER_CHUNK;
    const n = SAMPLES_PER_CHUNK + 1;
    const pos = chunk.dashMesh.geometry.attributes.position.array;
    const nrm = chunk.dashMesh.geometry.attributes.normal.array;
    const hw = 0.06; // dash half-width

    for (let i = 0; i < n; i++) {
      const d = startD + i * step;
      const pt = this.roadPath.getPointAtDistance(d);

      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      // Dash pattern: visible when within dash portion of cycle
      const cycle = d % DASH_SPACING;
      const visible = cycle < DASH_LENGTH;
      const y = visible ? pt.y + 0.14 : pt.y - 1.0; // hide below ground

      const idx = i * 2 * 3;
      pos[idx]     = pt.x - rightX * hw;
      pos[idx + 1] = y;
      pos[idx + 2] = pt.z - rightZ * hw;
      pos[idx + 3] = pt.x + rightX * hw;
      pos[idx + 4] = y;
      pos[idx + 5] = pt.z + rightZ * hw;

      nrm[idx] = 0; nrm[idx + 1] = 1; nrm[idx + 2] = 0;
      nrm[idx + 3] = 0; nrm[idx + 4] = 1; nrm[idx + 5] = 0;
    }

    chunk.dashMesh.geometry.attributes.position.needsUpdate = true;
    chunk.dashMesh.geometry.attributes.normal.needsUpdate = true;
    chunk.dashMesh.geometry.computeBoundingSphere();
  }

  _fillEdgeGeometry(chunk, startD, lateralOffset) {
    const step = CHUNK_LENGTH / SAMPLES_PER_CHUNK;
    const n = SAMPLES_PER_CHUNK + 1;
    const mesh = lateralOffset < 0 ? chunk.edgeMeshL : chunk.edgeMeshR;
    const pos = mesh.geometry.attributes.position.array;
    const nrm = mesh.geometry.attributes.normal.array;
    const hw = 0.05; // edge line half-width

    for (let i = 0; i < n; i++) {
      const d = startD + i * step;
      const pt = this.roadPath.getPointAtDistance(d);

      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const edgeX = pt.x + rightX * lateralOffset;
      const edgeZ = pt.z + rightZ * lateralOffset;

      const idx = i * 2 * 3;
      pos[idx]     = edgeX - rightX * hw;
      pos[idx + 1] = pt.y + 0.14;
      pos[idx + 2] = edgeZ - rightZ * hw;
      pos[idx + 3] = edgeX + rightX * hw;
      pos[idx + 4] = pt.y + 0.14;
      pos[idx + 5] = edgeZ + rightZ * hw;

      nrm[idx] = 0; nrm[idx + 1] = 1; nrm[idx + 2] = 0;
      nrm[idx + 3] = 0; nrm[idx + 4] = 1; nrm[idx + 5] = 0;
    }

    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.normal.needsUpdate = true;
    mesh.geometry.computeBoundingSphere();
  }

  _buildChunk(chunk, startD) {
    chunk.startD = startD;
    chunk.group.visible = true;
    this._fillRoadGeometry(chunk, startD);
    this._fillDashGeometry(chunk, startD);
    this._fillEdgeGeometry(chunk, startD, -2.3); // left edge
    this._fillEdgeGeometry(chunk, startD, 2.3);  // right edge
  }

  _rebuildAll(bikeD) {
    this._activeStartDs.clear();

    // Center chunks around bike
    const behindChunks = 2;
    const firstChunkD = Math.max(0,
      Math.floor(bikeD / CHUNK_LENGTH) * CHUNK_LENGTH - behindChunks * CHUNK_LENGTH
    );

    for (let i = 0; i < POOL_SIZE; i++) {
      const startD = firstChunkD + i * CHUNK_LENGTH;
      this._buildChunk(this._chunks[i], startD);
      this._activeStartDs.add(startD);
    }

    this._lastBikeD = bikeD;
  }

  /** Call each frame with current bike road-distance */
  update(bikeD) {
    // Determine desired range
    const behindChunks = 2;
    const firstChunkD = Math.max(0,
      Math.floor(bikeD / CHUNK_LENGTH) * CHUNK_LENGTH - behindChunks * CHUNK_LENGTH
    );

    // Check if we need to recycle
    const neededDs = new Set();
    for (let i = 0; i < POOL_SIZE; i++) {
      neededDs.add(firstChunkD + i * CHUNK_LENGTH);
    }

    // Find chunks that are no longer needed, reassign them
    for (const chunk of this._chunks) {
      if (!neededDs.has(chunk.startD)) {
        // Find a needed D that isn't currently assigned
        for (const nd of neededDs) {
          if (!this._activeStartDs.has(nd)) {
            this._activeStartDs.delete(chunk.startD);
            this._buildChunk(chunk, nd);
            this._activeStartDs.add(nd);
            neededDs.delete(nd);
            break;
          }
        }
      } else {
        neededDs.delete(chunk.startD);
      }
    }

    this._lastBikeD = bikeD;
  }

  dispose() {
    for (const chunk of this._chunks) {
      this.scene.remove(chunk.group);
      chunk.roadMesh.geometry.dispose();
      chunk.dashMesh.geometry.dispose();
      chunk.edgeMeshL.geometry.dispose();
      chunk.edgeMeshR.geometry.dispose();
    }
  }
}
