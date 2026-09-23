// ============================================================
// COBBLES VISUAL — a real stretch of cobbled road (E-2)
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
// Related: #297 / #300 track artifacts (ramps, boost pads) build a general
// ArtifactManager for placed course features. Cobbles stays here because it is
// a seeded disruption, not a manifest-placed artifact — but a later pass could
// reasonably fold it in.

import * as THREE from 'three';

const ROAD_HALF_WIDTH = 2.5;   // matches road-chunks.js
const LIFT = 0.025;            // sit just above the road so it never z-fights
const STEP_M = 1.5;            // sampling along the road
const TEX_REPEAT_M = 3.0;      // metres per texture tile along the road

let _sharedTexture = null;

/** A seeded cobblestone texture: rounded stones with mortar between them. */
function cobbleTexture() {
  if (_sharedTexture) return _sharedTexture;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  let seed = 987654321;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  // Mortar bed
  ctx.fillStyle = '#4a453e';
  ctx.fillRect(0, 0, size, size);

  // Rows of stones, every other row offset, so it reads as laid rather than tiled.
  const rows = 8, cols = 8;
  const cw = size / cols, ch = size / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * cw * 0.5;
    for (let c = -1; c <= cols; c++) {
      const cx = c * cw + offset + cw * 0.5 + (rand() - 0.5) * cw * 0.12;
      const cy = r * ch + ch * 0.5 + (rand() - 0.5) * ch * 0.12;
      const rx = cw * (0.40 + rand() * 0.07);
      const ry = ch * (0.38 + rand() * 0.07);

      // Grey granite with per-stone variation, a few browner ones.
      const base = 118 + Math.floor(rand() * 46);
      const warm = rand() < 0.25 ? 12 : 0;
      ctx.fillStyle = `rgb(${base + warm}, ${base + Math.floor(warm * 0.6)}, ${base - warm})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, (rand() - 0.5) * 0.4, 0, Math.PI * 2);
      ctx.fill();

      // A lit top edge and a shaded bottom: cheap roundness.
      ctx.strokeStyle = `rgba(255,255,255,0.20)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(cx, cy - ry * 0.16, rx * 0.82, ry * 0.62, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(0,0,0,0.28)`;
      ctx.beginPath();
      ctx.ellipse(cx, cy + ry * 0.14, rx * 0.88, ry * 0.70, 0, 0, Math.PI);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  _sharedTexture = tex;
  return tex;
}

export class CobblesVisual {
  constructor(scene) {
    this.scene = scene;
    this.meshes = [];
    this.material = new THREE.MeshLambertMaterial({
      map: cobbleTexture(),
      // Slight polygon offset rather than a big lift, so the seam stays tight
      // where the cobbles meet the dirt.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
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

      const steps = Math.max(2, Math.ceil(length / STEP_M));
      const positions = new Float32Array((steps + 1) * 2 * 3);
      const uvs = new Float32Array((steps + 1) * 2 * 2);
      const indices = [];

      for (let i = 0; i <= steps; i++) {
        const d = startD + (length * i) / steps;
        const p = roadPath.getPointAtDistance(d);
        // Right-hand perpendicular to the road heading.
        const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);

        const b = i * 6;
        positions[b]     = p.x - rx * ROAD_HALF_WIDTH;
        positions[b + 1] = p.y + LIFT;
        positions[b + 2] = p.z - rz * ROAD_HALF_WIDTH;
        positions[b + 3] = p.x + rx * ROAD_HALF_WIDTH;
        positions[b + 4] = p.y + LIFT;
        positions[b + 5] = p.z + rz * ROAD_HALF_WIDTH;

        const v = (d - startD) / TEX_REPEAT_M;
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

      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.meshes.push(mesh);
    }
  }

  clear() {
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.geometry.dispose();
    }
    this.meshes.length = 0;
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }
}
