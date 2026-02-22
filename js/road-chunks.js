// ============================================================
// ROAD CHUNKS — pooled road surface meshes following RoadPath
// ============================================================

import * as THREE from 'three';

const CHUNK_LENGTH = 50;       // road distance per chunk
const POOL_SIZE = 12;          // number of chunks in pool
const SAMPLES_PER_CHUNK = 50;  // cross-sections per chunk
const ROAD_HALF_WIDTH = 2.5;
const VISUAL_HALF_WIDTH = 4.5;  // wider mesh includes dirt shoulders + grass transition

export class RoadChunkManager {
  constructor(scene, roadPath) {
    this.scene = scene;
    this.roadPath = roadPath;

    // Procedural dirt/rock texture for the road surface
    this._roadTex = this._createDirtTexture();
    this._roadMat = new THREE.MeshPhongMaterial({
      map: this._roadTex, flatShading: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });

    // Pool of chunks
    this._chunks = [];   // { startD, group, roadMesh }
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

    return { startD: -1, group, roadMesh };
  }

  _createDirtTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const d = imgData.data;

    // Seeded PRNG
    let seed = 54321;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    // Value noise
    const perm = new Uint8Array(512);
    for (let i = 0; i < 256; i++) perm[i] = Math.floor(rand() * 256);
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const gradTbl = new Float32Array(256);
    for (let i = 0; i < 256; i++) gradTbl[i] = rand();

    const noise2d = (x, y) => {
      const ix = Math.floor(x) & 255, iy = Math.floor(y) & 255;
      const fx = x - Math.floor(x), fy = y - Math.floor(y);
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const v00 = gradTbl[perm[ix + perm[iy]]];
      const v10 = gradTbl[perm[ix + 1 + perm[iy]]];
      const v01 = gradTbl[perm[ix + perm[iy + 1]]];
      const v11 = gradTbl[perm[ix + 1 + perm[iy + 1]]];
      return v00 + sx * (v10 - v00) + sy * (v01 - v00) + sx * sy * (v11 - v10 - v01 + v00);
    };
    const fbm = (x, y) =>
      noise2d(x, y) * 0.5 + noise2d(x * 2.3, y * 2.3) * 0.3 + noise2d(x * 5.7, y * 5.7) * 0.2;

    // Zone boundaries in U space (fraction of total visual width)
    // Total visual width = VISUAL_HALF_WIDTH * 2 = 9
    // Road proper = ROAD_HALF_WIDTH * 2 = 5, centered
    // Shoulder fraction on each side = (VISUAL_HALF_WIDTH - ROAD_HALF_WIDTH) / (VISUAL_HALF_WIDTH * 2)
    const shoulderFrac = (VISUAL_HALF_WIDTH - ROAD_HALF_WIDTH) / (VISUAL_HALF_WIDTH * 2); // ~0.222
    const roadInner = shoulderFrac;         // where road starts
    const roadOuter = 1.0 - shoulderFrac;   // where road ends

    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const idx = (py * size + px) * 4;
        const u = px / size;

        // Noise layers
        const n1 = fbm(px * 0.05, py * 0.05);
        const n2 = noise2d(px * 0.15, py * 0.15);
        const n3 = noise2d(px * 0.4, py * 0.4);
        const fine = noise2d(px * 0.8, py * 0.8);

        // Distance from road center in normalized space (0 = center, 1 = outer edge of shoulder)
        const distFromCenter = Math.abs(u - 0.5) * 2; // 0..1 across half-width
        const roadEdge = (roadOuter - 0.5) * 2;       // where road edge is (~0.556)

        // Blend factor: 0 = pure road dirt, 1 = pure grass
        // Transition happens from road edge to outer edge with noise-driven irregularity
        const edgeNoise = (n2 - 0.5) * 0.08; // wiggly edge
        const transitionStart = roadEdge - 0.03 + edgeNoise;
        const transitionEnd = 1.0;
        let grassBlend = 0;
        if (distFromCenter > transitionStart) {
          grassBlend = Math.min(1, (distFromCenter - transitionStart) / (transitionEnd - transitionStart));
          // Cubic ease for more natural falloff
          grassBlend = grassBlend * grassBlend * (3 - 2 * grassBlend);
        }

        // --- DIRT COLOR (warm orange-brown like reference) ---
        const dirtBr = 0.85 + n1 * 0.15;
        let dirtR = (165 + n1 * 40 + fine * 15) * dirtBr;
        let dirtG = (120 + n1 * 25 + fine * 10) * dirtBr;
        let dirtB = (70 + n1 * 15 + fine * 8) * dirtBr;

        // Lighter compacted center
        const centerBright = Math.max(0, 1 - distFromCenter * 2.5);
        dirtR += centerBright * 30 * (0.8 + n3 * 0.4);
        dirtG += centerBright * 25 * (0.8 + n3 * 0.4);
        dirtB += centerBright * 15 * (0.8 + n3 * 0.4);

        // Tire ruts
        const rutL = Math.abs((u - 0.5) / (roadOuter - 0.5) - 0.36);
        const rutR = Math.abs((u - 0.5) / (roadOuter - 0.5) + 0.36);
        const rutStr = Math.max(0, 1 - rutL * 10) + Math.max(0, 1 - rutR * 10);
        if (rutStr > 0) {
          const dk = rutStr * 0.18 * (0.7 + n3 * 0.6);
          dirtR *= (1 - dk); dirtG *= (1 - dk); dirtB *= (1 - dk);
        }

        // Rock/pebble speckles on dirt
        if (fine > 0.7 && n2 > 0.45) {
          const rockBr = 0.65 + n3 * 0.35;
          const bl = (fine - 0.7) / 0.3 * 0.6;
          dirtR = dirtR * (1 - bl) + 140 * rockBr * bl;
          dirtG = dirtG * (1 - bl) + 135 * rockBr * bl;
          dirtB = dirtB * (1 - bl) + 125 * rockBr * bl;
        }

        // --- GRASS COLOR (deep lush green matching reference) ---
        const grassClump = fbm(px * 0.04 + 80, py * 0.04 + 80);
        const grassBr = 0.6 + grassClump * 0.3 + fine * 0.1;
        let grassR = (40 + n2 * 25) * grassBr;
        let grassG = (100 + n2 * 50 + grassClump * 30) * grassBr;
        let grassB = (30 + n2 * 15) * grassBr;

        // Dark grass tufts for thick look
        if (n3 > 0.6) {
          grassR *= 0.65;
          grassG *= 0.75;
          grassB *= 0.6;
        }

        // Occasional rocks in grass
        const rockN = noise2d(px * 0.12 + 50, py * 0.12 + 50);
        if (rockN > 0.7 && grassBlend > 0.4) {
          const bl = (rockN - 0.7) / 0.3;
          const rb = 0.6 + fine * 0.4;
          grassR = grassR * (1 - bl) + 110 * rb * bl;
          grassG = grassG * (1 - bl) + 105 * rb * bl;
          grassB = grassB * (1 - bl) + 95 * rb * bl;
        }

        // --- TRANSITION: sparse grass tufts on dirt shoulder ---
        // In the transition zone, add scattered grass patches on top of dirt
        let tufted = grassBlend;
        if (grassBlend > 0.05 && grassBlend < 0.7) {
          const tuftNoise = noise2d(px * 0.2 + 30, py * 0.2 + 30);
          if (tuftNoise > 0.55) {
            tufted = Math.min(1, grassBlend + (tuftNoise - 0.55) * 2.5);
          }
        }

        // Final blend
        const r = dirtR * (1 - tufted) + grassR * tufted;
        const g = dirtG * (1 - tufted) + grassG * tufted;
        const b = dirtB * (1 - tufted) + grassB * tufted;

        d[idx]     = Math.max(0, Math.min(255, Math.floor(r)));
        d[idx + 1] = Math.max(0, Math.min(255, Math.floor(g)));
        d[idx + 2] = Math.max(0, Math.min(255, Math.floor(b)));
        d[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    return tex;
  }

  _createRoadGeometry() {
    // Triangle strip: (SAMPLES_PER_CHUNK + 1) cross-sections, 2 verts each
    const n = SAMPLES_PER_CHUNK + 1;
    const positions = new Float32Array(n * 2 * 3);
    const normals = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const indices = [];

    for (let i = 0; i < n - 1; i++) {
      const base = i * 2;
      indices.push(base, base + 1, base + 2);
      indices.push(base + 1, base + 3, base + 2);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  _fillRoadGeometry(chunk, startD) {
    const step = CHUNK_LENGTH / SAMPLES_PER_CHUNK;
    const n = SAMPLES_PER_CHUNK + 1;
    const pos = chunk.roadMesh.geometry.attributes.position.array;
    const nrm = chunk.roadMesh.geometry.attributes.normal.array;
    const uv = chunk.roadMesh.geometry.attributes.uv.array;
    // V tiles every 10 units along road so texture repeats naturally
    const vScale = 1 / 10;

    for (let i = 0; i < n; i++) {
      const d = startD + i * step;
      const pt = this.roadPath.getPointAtDistance(d);

      // Right vector from heading
      const fwdX = Math.sin(pt.heading);
      const fwdZ = Math.cos(pt.heading);
      const rightX = fwdZ;
      const rightZ = -fwdX;

      const idx = i * 2 * 3;
      // Left vertex (full visual width including shoulder)
      pos[idx]     = pt.x - rightX * VISUAL_HALF_WIDTH;
      pos[idx + 1] = pt.y;
      pos[idx + 2] = pt.z - rightZ * VISUAL_HALF_WIDTH;
      // Right vertex
      pos[idx + 3] = pt.x + rightX * VISUAL_HALF_WIDTH;
      pos[idx + 4] = pt.y;
      pos[idx + 5] = pt.z + rightZ * VISUAL_HALF_WIDTH;

      // Normals pointing up
      nrm[idx] = 0; nrm[idx + 1] = 1; nrm[idx + 2] = 0;
      nrm[idx + 3] = 0; nrm[idx + 4] = 1; nrm[idx + 5] = 0;

      // UVs: U=0 left edge, U=1 right edge; V tiles along road
      const uvIdx = i * 2 * 2;
      uv[uvIdx]     = 0;
      uv[uvIdx + 1] = d * vScale;
      uv[uvIdx + 2] = 1;
      uv[uvIdx + 3] = d * vScale;
    }

    chunk.roadMesh.geometry.attributes.position.needsUpdate = true;
    chunk.roadMesh.geometry.attributes.normal.needsUpdate = true;
    chunk.roadMesh.geometry.attributes.uv.needsUpdate = true;
    chunk.roadMesh.geometry.computeBoundingSphere();
  }

  _buildChunk(chunk, startD) {
    chunk.startD = startD;
    chunk.group.visible = true;
    this._fillRoadGeometry(chunk, startD);
  }

  _rebuildAll(bikeD) {
    this._activeStartDs.clear();
    const L = this.roadPath.loopLength;

    // Center chunks around bike
    const behindChunks = 2;
    const firstChunkD = Math.floor(bikeD / CHUNK_LENGTH) * CHUNK_LENGTH - behindChunks * CHUNK_LENGTH;

    for (let i = 0; i < POOL_SIZE; i++) {
      const rawD = firstChunkD + i * CHUNK_LENGTH;
      const startD = ((rawD % L) + L) % L;
      this._buildChunk(this._chunks[i], startD);
      this._activeStartDs.add(startD);
    }

    this._lastBikeD = bikeD;
  }

  /** Call each frame with current bike road-distance */
  update(bikeD) {
    const L = this.roadPath.loopLength;

    // Determine desired range
    const behindChunks = 2;
    const firstChunkD = Math.floor(bikeD / CHUNK_LENGTH) * CHUNK_LENGTH - behindChunks * CHUNK_LENGTH;

    // Check if we need to recycle
    const neededDs = new Set();
    for (let i = 0; i < POOL_SIZE; i++) {
      const rawD = firstChunkD + i * CHUNK_LENGTH;
      neededDs.add(((rawD % L) + L) % L);
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
    }
  }
}
