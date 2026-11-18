// ============================================================
// TUTORIAL BOARDS (#503) — 3D roadside billboards in the end-card style
// ============================================================
//
// The tutorial starts at a "TUTORIAL START" board and ends at a "TUTORIAL
// END" board, replacing the "Your Home" video sign and the placeholder box
// house. The face is the achievement-reel end card (navy gradient, gold Rye
// lettering, cream Playfair italic), baked offline into a WebP atlas by
// scripts/bake-tutorial-board.mjs: the face on top, the crest disc below.
//
// Three draw calls per board:
//   1. structure  posts, bevelled gold frame, backing, crest ring, finials,
//                 bunting rope: one merged, vertex-coloured mesh
//   2. face       the baked atlas (the face plus the crest disc), with a gold
//                 glint that sweeps across the lettering when the riders pass
//   3. bunting    pennants that flap in the vertex shader (no bones)
// Roughly 1.6k triangles. The caller owns placement (boardPose) and
// disposal (World.setRaceMarkers traverses and disposes the group).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BOARD = {
  W: 4.6,          // face width (m)
  H: 2.3,          // face height (m): 2:1, like the 2048x1024 face
  BOTTOM: 1.55,    // ground to the bottom of the face
  FRAME: 0.16,     // gold frame width around the face
  DEPTH: 0.12,     // backing thickness
  POST: 0.17,      // post section
  CREST_R: 0.42,   // crest ring radius
  ATLAS_FACE_V: 1024 / 1280,   // the face's share of the atlas height
  ATLAS_CREST: 256,            // crest disc size in px, bottom-left of the atlas
  ATLAS_W: 2048, ATLAS_H: 1280,
};

/**
 * Where each tutorial board stands. lateral uses the World's road-side convention (the same `right`
 * vector as Grandma's house): + puts it on the riders' left as they ride, - on their right.
 */
export const BOARD_PLACES = {
  start: { d: 15, lateral: -4.6, turn: 0.42 },   // where the "Your Home" sign stood (riders' right)
  end:   { dAfter: 3, lateral: 5.4, turn: 0.45 }, // just past the finish line (riders' left, like Grandma's house)
};

export const BOARD_TEXTURE = {
  start: 'assets/tutorial-board-start.webp',
  end: 'assets/tutorial-board-end.webp',
  pot: 'assets/tutorial-board-pot.webp',     // #546 · Slingshot's POT OF GOLD sign (built smaller, overhead)
};

/**
 * World transform of a board beside the road, its face turned towards the
 * oncoming riders and angled `turn` radians in towards the road.
 * @param {{x:number, z:number, heading:number}} pt road point (heading: forward = (sin h, cos h))
 * @param {number} lateral metres along the World's `right` vector (fz, -fx) from the centre line
 * @param {number} turn radians the face turns in towards the road
 * @returns {{x:number, z:number, rotY:number, face:{x:number, z:number}}}
 */
export function boardPose(pt, lateral, turn) {
  const fx = Math.sin(pt.heading), fz = Math.cos(pt.heading);
  const rx = fz, rz = -fx;                       // the World's road-side vector (as for Grandma's house)
  const side = Math.sign(lateral) || 1;
  // face normal: back down the road (towards the riders), swung towards the road
  const nx = -fx * Math.cos(turn) - rx * side * Math.sin(turn);
  const nz = -fz * Math.cos(turn) - rz * side * Math.sin(turn);
  return {
    x: pt.x + rx * lateral,
    z: pt.z + rz * lateral,
    rotY: Math.atan2(nx, nz),                    // local +Z (the face) -> n
    face: { x: nx, z: nz },
  };
}

/** Glint brightness at time t for a sweep that started at t0 (0 when idle). */
export function glintAt(t, t0, dur = 1.4) {
  if (!(t0 >= 0)) return 0;
  const k = (t - t0) / dur;
  return k < 0 || k > 1 ? 0 : Math.sin(Math.PI * k);
}

// ── geometry ────────────────────────────────────────────────────────────────

const C = { gold: 0xf2c232, goldDark: 0xa87a12, red: 0x6e1010, iron: 0x23222b, navy: 0x15142a, rope: 0xd9c9a0 };

function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
const at = (g, x, y, z) => { g.translate(x, y, z); return g; };

/** A picture frame: a rectangle with a rectangular hole, extruded with a bevel. */
function frameGeo(w, h, t, depth, hex) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - t, -h / 2 - t); s.lineTo(w / 2 + t, -h / 2 - t); s.lineTo(w / 2 + t, h / 2 + t); s.lineTo(-w / 2 - t, h / 2 + t);
  const hole = new THREE.Path();
  hole.moveTo(-w / 2, -h / 2); hole.lineTo(-w / 2, h / 2); hole.lineTo(w / 2, h / 2); hole.lineTo(w / 2, -h / 2);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2, curveSegments: 1 });
  return paint(g, hex);
}

function structureGeometry(B = BOARD, overhead = false) {
  const { W, H, BOTTOM, FRAME, DEPTH, POST, CREST_R } = B;
  const cy = BOTTOM + H / 2, top = BOTTOM + H + FRAME;
  const px = W / 2 - 0.55;                                     // posts sit inside the frame's width
  const parts = [
    // backing board (navy front edge hidden by the face, dark back)
    at(paint(new THREE.BoxGeometry(W + 0.04, H + 0.04, DEPTH), C.navy), 0, cy, -DEPTH / 2 - 0.005),
    // bevelled gold frame, and a thin dark-red inner trim (the card's red shadow line)
    at(frameGeo(W, H, FRAME, 0.07, C.gold), 0, cy, -0.02),
    at(frameGeo(W - 0.02, H - 0.02, 0.035, 0.02, C.red), 0, cy, 0.005),
    // posts with base blocks and gold finials
    at(paint(new THREE.BoxGeometry(POST, top + 0.25, POST), C.iron), -px, (top + 0.25) / 2, -DEPTH - POST / 2),
    at(paint(new THREE.BoxGeometry(POST, top + 0.25, POST), C.iron), px, (top + 0.25) / 2, -DEPTH - POST / 2),
    at(paint(new THREE.BoxGeometry(POST * 2, 0.22, POST * 2), C.iron), -px, 0.11, -DEPTH - POST / 2),
    at(paint(new THREE.BoxGeometry(POST * 2, 0.22, POST * 2), C.iron), px, 0.11, -DEPTH - POST / 2),
    at(paint(new THREE.SphereGeometry(0.13, 10, 7), C.gold), -px, top + 0.36, -DEPTH - POST / 2),
    at(paint(new THREE.SphereGeometry(0.13, 10, 7), C.gold), px, top + 0.36, -DEPTH - POST / 2),
    // a cross brace between the posts, below the board (just under the face on
    // an overhead sign, so the riders pass beneath it)
    at(paint(new THREE.BoxGeometry(px * 2, 0.1, 0.08), C.iron), 0, overhead ? BOTTOM - 0.12 : BOTTOM * 0.45, -DEPTH - POST / 2),
    // crest: gold ring (the end card's badge ring) on a dark-red mount
    at(paint(new THREE.TorusGeometry(CREST_R, 0.065, 8, 28), C.gold), 0, top + CREST_R + 0.02, 0.02),
    at(paint(new THREE.CylinderGeometry(CREST_R + 0.02, CREST_R + 0.02, 0.06, 28).rotateX(Math.PI / 2), C.red), 0, top + CREST_R + 0.02, -0.03),
    // the bunting rope, finial to crest to finial (two sagging runs)
    ...ropeGeos(px, top, B),
  ];
  return mergeGeometries(parts.map(g => (g.index ? g.toNonIndexed() : g)), false);
}

/** Rope runs from each finial to the crest's side, sagging. */
function ropeGeos(px, top, B = BOARD) {
  const out = [];
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(side * px, top + 0.36, -B.DEPTH - B.POST / 2 + 0.1);
    const b = new THREE.Vector3(side * (B.CREST_R + 0.05), top + B.CREST_R + 0.05, 0.03);
    const mid = a.clone().lerp(b, 0.5); mid.y -= 0.22;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    out.push(paint(new THREE.TubeGeometry(curve, 10, 0.018, 4, false), C.rope));
  }
  return out;
}

/** Points along the rope where pennants hang (matches ropeGeos). */
function ropePoints(px, top, perSide, B = BOARD) {
  const pts = [];
  for (const side of [-1, 1]) {
    const a = new THREE.Vector3(side * px, top + 0.36, -B.DEPTH - B.POST / 2 + 0.1);
    const b = new THREE.Vector3(side * (B.CREST_R + 0.05), top + B.CREST_R + 0.05, 0.03);
    const mid = a.clone().lerp(b, 0.5); mid.y -= 0.22;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    for (let i = 1; i <= perSide; i++) pts.push(curve.getPoint(i / (perSide + 1)));
  }
  return pts;
}

/** Face quad + crest disc, UV-mapped into the baked atlas. */
function faceGeometry(B = BOARD) {
  const { W, H, BOTTOM, FRAME, CREST_R, ATLAS_FACE_V, ATLAS_CREST, ATLAS_W, ATLAS_H } = B;
  const face = new THREE.PlaneGeometry(W, H);
  const uv = face.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, (1 - ATLAS_FACE_V) + uv.getY(i) * ATLAS_FACE_V);
  face.translate(0, BOTTOM + H / 2, 0.012);
  const disc = new THREE.CircleGeometry(CREST_R - 0.04, 28);
  const du = ATLAS_CREST / ATLAS_W, dv = ATLAS_CREST / ATLAS_H;
  const duv = disc.attributes.uv;
  for (let i = 0; i < duv.count; i++) duv.setXY(i, duv.getX(i) * du, duv.getY(i) * dv);
  disc.translate(0, BOTTOM + H + FRAME + CREST_R + 0.02, 0.006);
  const merged = mergeGeometries([face.toNonIndexed(), disc.toNonIndexed()], false);
  // aText: 1 on the face (glint can sweep), 0 on the crest
  const n = merged.attributes.position.count, faceN = face.toNonIndexed().attributes.position.count;
  const a = new Float32Array(n); a.fill(1, 0, faceN);
  merged.setAttribute('aText', new THREE.BufferAttribute(a, 1));
  return merged;
}

const PENNANT_COLS = [0xb3201f, 0xe8b520, 0xf4e6c4, 0x1d3a8a];
function buntingGeometry(B = BOARD) {
  const { W, H, BOTTOM, FRAME } = B;
  const top = BOTTOM + H + FRAME, px = W / 2 - 0.55;
  const pts = ropePoints(px, top, 5, B);
  const pos = [], col = [], sway = [];
  pts.forEach((p, i) => {
    const c = new THREE.Color(PENNANT_COLS[i % PENNANT_COLS.length]);
    const w = 0.13, h = 0.3;
    // a downward triangle hanging from the rope, facing the road (+z)
    const v = [[p.x - w, p.y, p.z], [p.x + w, p.y, p.z], [p.x, p.y - h, p.z + 0.02]];
    const s = [0, 0, 1];
    for (let k = 0; k < 3; k++) { pos.push(...v[k]); col.push(c.r, c.g, c.b); sway.push(s[k]); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  g.computeVertexNormals();
  return g;
}

// ── materials ───────────────────────────────────────────────────────────────

function faceMaterial(tex, uni) {
  const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.3, roughness: 0.62, metalness: 0.0 });
  // painted like the end card: keep its gold and navy true (ACES tone mapping washed the gold to tan)
  m.toneMapped = false;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uni.uTime; sh.uniforms.uGlint = uni.uGlint;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aText;\nvarying float vText;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvText = aText;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uGlint;\nvarying float vText;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        // gold lettering: high red+green, low blue
        vec3 tx = texture2D( map, vMapUv ).rgb;
        float gold = smoothstep(0.25, 0.55, min(tx.r, tx.g) - tx.b) * vText;
        // a slow idle shimmer, and the finish glint sweeping left to right
        float u = vMapUv.x + (1.0 - vMapUv.y) * 0.25;
        float idle = smoothstep(0.06, 0.0, abs(u - fract(uTime * 0.11) * 1.6 + 0.3)) * 0.35;
        float sweep = smoothstep(0.12, 0.0, abs(u - (1.0 - uGlint) * 1.4 + 0.2)) * uGlint * 1.6;
        totalEmissiveRadiance += vec3(1.0, 0.85, 0.45) * gold * (idle + sweep + uGlint * 0.35);
      }`);
  };
  return m;
}

function buntingMaterial(uni) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uni.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aSway;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      float ph = position.x * 3.1;
      transformed.z += aSway * (0.09 * sin(uTime * 3.4 + ph) + 0.035 * sin(uTime * 7.9 + ph * 1.7));
      transformed.x += aSway * 0.04 * sin(uTime * 2.3 + ph);`);
  };
  return m;
}

// ── the board ──────────────────────────────────────────────────────────────

/**
 * Build a tutorial board. kind: 'start' | 'end' | 'pot' (a BOARD_TEXTURE key).
 * scale: the whole board, uniformly (#546's pot-of-gold sign is about half size).
 * bottom: world metres from the ground to the bottom of the face (default: the
 *   full-size board's BOARD.BOTTOM, scaled). overhead: the board stands over a
 *   lane on tall posts and the riders pass beneath it, so its cross brace moves
 *   up under the face. texture: a shared, already-loaded face texture (the
 *   caller keeps it; the board's dispose-by-traverse would otherwise free it).
 * @returns {THREE.Group} with userData.board = { update(t, bikeD, roadD) }
 */
export function buildTutorialBoard(kind = 'end', { textureLoader = null, anisotropy = 8, texture = null,
                                                  scale = 1, bottom = null, overhead = false } = {}) {
  const uni = { uTime: { value: 0 }, uGlint: { value: 0 } };
  let tex = texture;
  if (!tex) {
    const loader = textureLoader || new THREE.TextureLoader();
    tex = loader.load(BOARD_TEXTURE[kind]);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
  }
  const B = bottom == null ? BOARD : { ...BOARD, BOTTOM: bottom / scale };

  const group = new THREE.Group();
  group.name = `tutorial-board-${kind}`;
  const structMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.25 });
  const structure = new THREE.Mesh(structureGeometry(B, overhead), structMat);
  const face = new THREE.Mesh(faceGeometry(B), faceMaterial(tex, uni));
  const bunting = new THREE.Mesh(buntingGeometry(B), buntingMaterial(uni));
  if (scale !== 1) group.scale.setScalar(scale);
  for (const m of [structure, face, bunting]) { m.castShadow = m !== bunting; m.receiveShadow = m !== bunting; group.add(m); }

  let glintT0 = -1, passed = false;
  group.userData.board = {
    kind,
    /** t seconds; bikeD the lead bike's road distance; roadD where the board's moment is. */
    update(t, bikeD, roadD) {
      uni.uTime.value = t;
      if (passed && bikeD < roadD - 5) passed = false;          // a retry rewound past it: arm again
      if (!passed && bikeD >= roadD) { passed = true; glintT0 = t; }
      uni.uGlint.value = glintAt(t, glintT0);
    },
    /** Rewind (a retry rides past it again). */
    reset() { passed = false; glintT0 = -1; uni.uGlint.value = 0; },
  };
  return group;
}

/** Triangle count of a built board (tests / budget). */
export function boardTriangles(group) {
  let n = 0;
  group.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return n;
}
