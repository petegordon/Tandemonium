// ============================================================
// COBBLES VISUAL — a real stretch of cobbled road (E-2, #404)
// ============================================================
//
// Cobbles used to be a banner and a scoring threshold. Nothing on the road
// changed, so in solo — where the threshold does nothing at all — the game
// announced a hazard that did not exist.
//
// This lays actual cobblestones down the road for the length of the event. It
// is built once at the start of the ride and left in the world, so the surface
// is visible from a long way back: the road itself tells you what is coming,
// and the three-second banner only confirms it. A hazard you can see coming is
// a challenge; one that appears under you is noise.
//
// #404 · the first version was one tiled rectangle down the middle 5 m of a
// 9 m road, so it read as a grey patch rather than a cobbled road. Now each
// stretch gets its own drawn texture: stones packed tight across the whole
// visible road, thinning out into the dirt at the verges and at both ends
// (ragged, never a straight line), with a soft shadow under each stone and a
// bump map so the stones catch the light. The rough stretch itself (the
// gameplay) is still exactly startD..endD; only the feathering spills past it.

import * as THREE from 'three';

const HALF_WIDTH = 4.2;        // road-chunks.js VISUAL_HALF_WIDTH is 4.5; grass starts there
const SOLID_HALF = 3.1;        // fully paved out to here, then thinning to HALF_WIDTH
const FEATHER_M = 3.5;         // stones scatter this far past each end of the stretch
const LIFT = 0.025;            // sit just above the road so it never z-fights
const STEP_M = 1.5;            // sampling along the road
const PX_PER_M = 48;           // texture resolution
const STONE_M = 0.34;          // typical stone length along the road
const ROW_M = 0.27;            // row pitch along the road

/** Small deterministic PRNG so a stretch looks the same on both co-op screens. */
function rng(seed) {
  let s = (Math.floor(Math.abs(seed) * 9973) % 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Cheap 1-D value noise in [0,1], for ragged (not straight) edges. */
function noise1(rand, n) {
  const pts = Array.from({ length: n + 2 }, () => rand());
  return (t) => {
    const x = Math.min(n, Math.max(0, t * n));
    const i = Math.floor(x), f = x - i, k = f * f * (3 - 2 * f);
    return pts[i] * (1 - k) + pts[i + 1] * k;
  };
}

/**
 * Draw one stretch's stones. u runs across the road (0 = left verge, 1 =
 * right), v along it (0 = start of the feather, 1 = end). Transparent where
 * there are no stones, so the dirt road shows between the scattered ones.
 */
function stretchTexture(lengthM, seed) {
  const totalM = lengthM + FEATHER_M * 2;
  const w = Math.round(HALF_WIDTH * 2 * PX_PER_M);
  const h = Math.min(4096, Math.round(totalM * PX_PER_M));
  const pxM = h / totalM;                       // actual px per metre along v
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rand = rng(seed);

  // Ragged boundaries: how far each verge reaches, and where each end begins.
  const leftEdge = noise1(rand, 24), rightEdge = noise1(rand, 24);
  const startEdge = noise1(rand, 8), endEdge = noise1(rand, 8);

  // 0..1: how densely paved a point is (1 = solid cobbles, 0 = bare dirt).
  const density = (xM, yM) => {
    const t = yM / totalM;
    const side = xM < 0 ? leftEdge(t) : rightEdge(t);
    const solid = SOLID_HALF - 0.5 + side * 0.9;
    const across = Math.abs(xM) <= solid ? 1
      : 1 - (Math.abs(xM) - solid) / Math.max(0.2, HALF_WIDTH - solid);
    const s = xM / (HALF_WIDTH * 2) + 0.5;
    const inStart = yM - FEATHER_M * (0.35 + startEdge(s) * 0.9);
    const inEnd = (totalM - yM) - FEATHER_M * (0.35 + endEdge(s) * 0.9);
    const along = Math.min(1, Math.max(0, Math.min(inStart, inEnd) / 1.6 + 1));
    return Math.max(0, Math.min(1, across)) * along;
  };

  const stones = [];
  for (let yM = ROW_M * 0.5, row = 0; yM < totalM; yM += ROW_M * (0.92 + rand() * 0.16), row++) {
    const offset = (row % 2) * STONE_M * 0.5;
    for (let xM = -HALF_WIDTH + offset; xM < HALF_WIDTH; xM += STONE_M * (0.9 + rand() * 0.25)) {
      const d = density(xM, yM);
      if (d <= 0 || rand() > d * d * 1.15) continue;
      const loose = 1 - d;                         // scattered stones sit looser
      stones.push({
        x: (xM + HALF_WIDTH + (rand() - 0.5) * STONE_M * (0.12 + loose * 0.6)) * PX_PER_M,
        y: (yM + (rand() - 0.5) * ROW_M * (0.15 + loose * 0.8)) * pxM,
        rx: STONE_M * PX_PER_M * (0.40 + rand() * 0.10) * (1 - loose * 0.25),
        ry: ROW_M * pxM * (0.42 + rand() * 0.10) * (1 - loose * 0.25),
        rot: (rand() - 0.5) * (0.3 + loose * 1.6),
        tone: 142 + Math.floor(rand() * 46),
        warm: rand() < 0.5 ? 8 + Math.floor(rand() * 14) : 3,
        moss: d > 0.9 && rand() < 0.05,
        d
      });
    }
  }

  ctx.clearRect(0, 0, w, h);
  // Mortar / packed grit between the tight stones only: verges stay dirt.
  for (const s of stones) {
    if (s.d < 0.75) continue;
    ctx.fillStyle = `rgba(92, 84, 72, ${0.55 + (s.d - 0.75) * 1.6})`;
    ctx.beginPath(); ctx.ellipse(s.x, s.y, s.rx * 1.35, s.ry * 1.45, s.rot, 0, Math.PI * 2); ctx.fill();
  }
  // Soft contact shadow under every stone (the bottom-right side, away from the sun).
  for (const s of stones) {
    ctx.fillStyle = 'rgba(30, 24, 18, 0.22)';
    ctx.beginPath(); ctx.ellipse(s.x + s.rx * 0.10, s.y + s.ry * 0.16, s.rx * 1.04, s.ry * 1.06, s.rot, 0, Math.PI * 2); ctx.fill();
  }
  // The stones: granite greys with a few warmer ones, a lit crown and a shaded lip.
  for (const s of stones) {
    const r = s.tone + s.warm, g = s.tone + Math.floor(s.warm * 0.55), b = s.tone - s.warm;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath(); ctx.ellipse(s.x, s.y, s.rx, s.ry, s.rot, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255, 250, 240, 0.22)';
    ctx.beginPath(); ctx.ellipse(s.x - s.rx * 0.12, s.y - s.ry * 0.18, s.rx * 0.62, s.ry * 0.50, s.rot, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(s.x, s.y + s.ry * 0.06, s.rx * 0.95, s.ry * 0.92, s.rot, 0.15, Math.PI - 0.15); ctx.stroke();
    if (s.moss) {
      ctx.fillStyle = 'rgba(88, 110, 58, 0.55)';
      ctx.beginPath(); ctx.ellipse(s.x + s.rx * 0.4, s.y + s.ry * 0.3, s.rx * 0.35, s.ry * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class CobblesVisual {
  constructor(scene) {
    this.scene = scene;
    this.meshes = [];
  }

  /**
   * Lay cobbles for every cobbled stretch in this ride.
   * @param {RoadPath} roadPath
   * @param {Array<{startD:number, endD:number}>} stretches
   */
  build(roadPath, stretches) {
    this.clear();
    if (!roadPath || !stretches || !stretches.length) return;

    for (const { startD, endD } of stretches) {
      const length = endD - startD;
      if (!(length > 0)) continue;

      const fromD = startD - FEATHER_M, toD = endD + FEATHER_M;
      const span = toD - fromD;
      const steps = Math.max(2, Math.ceil(span / STEP_M));
      const positions = new Float32Array((steps + 1) * 2 * 3);
      const uvs = new Float32Array((steps + 1) * 2 * 2);
      const indices = [];

      for (let i = 0; i <= steps; i++) {
        const d = fromD + (span * i) / steps;
        const p = roadPath.getPointAtDistance(d);
        // Right-hand perpendicular to the road heading.
        const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);

        const b = i * 6;
        positions[b]     = p.x - rx * HALF_WIDTH;
        positions[b + 1] = p.y + LIFT;
        positions[b + 2] = p.z - rz * HALF_WIDTH;
        positions[b + 3] = p.x + rx * HALF_WIDTH;
        positions[b + 4] = p.y + LIFT;
        positions[b + 5] = p.z + rz * HALF_WIDTH;

        // The canvas is drawn top-down (y = 0 at the start); flipY puts it at v = 1.
        const v = 1 - i / steps;
        const u = i * 4;
        uvs[u] = 0; uvs[u + 1] = v;
        uvs[u + 2] = 1; uvs[u + 3] = v;

        if (i < steps) {
          const a = i * 2;
          // Wound counter-clockwise seen from above, so the face points UP.
          // The other order culls the whole ribbon and gives computeVertexNormals
          // a -Y normal, which is invisible twice over.
          indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      const tex = stretchTexture(length, startD + 0.5);
      const material = new THREE.MeshLambertMaterial({
        map: tex,
        bumpMap: tex,          // lighter stone crowns read as raised
        bumpScale: 0.6,
        transparent: true,     // dirt shows between the scattered stones
        depthWrite: false,
        // Slight polygon offset rather than a big lift, so the seam stays tight
        // where the cobbles meet the dirt.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });

      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;    // after the road, before the riders' transparent bits
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  clear() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      if (m.material) {
        if (m.material.map) m.material.map.dispose();
        m.material.dispose();
      }
    }
    this.meshes.length = 0;
  }

  dispose() {
    this.clear();
  }
}
