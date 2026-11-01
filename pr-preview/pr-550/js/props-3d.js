// ============================================================
// PROPS 3D — the present, the death cone and Grandma's house (#478)
// ============================================================
//
// These used to be camera-facing chromakey video billboards
// (assets/gold_gift_200.mp4, pylon_200.mp4, grandma_house_chromakey.mp4).
// Here they are low-poly, vertex-coloured models in the style of the #475
// props beside the house, built in code so they cost no download:
//
//   present  a cream box with a gold ribbon and bow. Its "billboard magic"
//            (gold rays, a swirling rainbow ring, a twinkle on the bow) is a
//            second, additive mesh driven in its vertex shader.
//   cone     the orange-and-white death cone with a skull and crossbones on
//            it. Skull spirits orbit and rise off it (instanced, in-shader),
//            and a knocked cone bursts a ring of skulls (SkullBurst).
//   house    Grandma's house as a timber cabin: log walls, a shingle roof, a
//            stone chimney and plank gables, with the billboard's glowing
//            windows, star door, sign and the gold present bow on the roof.
//
// Everything that repeats is drawn instanced, so forty presents or thirty
// cones are one draw each. The builders are pure apart from the shared
// textures, which are made once and kept.
// ============================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── small geometry helpers ──

/** Paint a geometry one colour (vertex colours), keeping position/normal/uv. */
function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}

/** Set every vertex's uv to one point (the opaque white corner of an atlas). */
function flatUv(g, u, v) {
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = v; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const M = (x = 0, y = 0, z = 0, ry = 0, s = 1, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    typeof s === 'number' ? new THREE.Vector3(s, s, s) : s);
const placed = (g, m) => { g.applyMatrix4(m); return g; };
const box = (w, h, d, hex, m) => placed(paint(new THREE.BoxGeometry(w, h, d), hex), m);

/** Merge non-indexed pieces that all carry the same attribute set. */
function merge(parts) {
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const keys = Object.keys(geos[0].attributes);
  for (const g of geos) for (const k of Object.keys(g.attributes)) if (!keys.includes(k)) g.deleteAttribute(k);
  const out = mergeGeometries(geos, false);
  if (!out) throw new Error('props-3d: merge failed (attribute mismatch)');
  return out;
}

/** Deterministic random, so every prop looks the same every ride. */
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Triangle count of a geometry (indexed or not). */
export function triCount(geo) {
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}

// ============================================================
// PRESENT
// ============================================================

export const PRESENT = {
  W: 0.9,          // box width/depth (world units)
  H: 0.8,          // box height
  CREAM: 0xfff8e8,
  GOLD: 0xffb71c,
  GOLD_DARK: 0xe08f10,
  /** On the road a present is drawn at this scale: the billboard's box was
   *  about 0.6 units across (Pete, #481: 1.4 read far too big). */
  ROAD_SCALE: 0.7,
};

/**
 * The present: a cream box with crossed gold ribbons and a bow, centred on
 * its origin (the road places it at bob height, the stack lifts it by H/2).
 * Vertex-coloured, ~200 triangles.
 */
export function buildPresentGeometry() {
  const { W, H, CREAM, GOLD, GOLD_DARK } = PRESENT;
  const parts = [];
  parts.push(box(W, H, W, CREAM, M()));
  // Ribbons: one band each way. The second is a hair taller so their tops
  // don't share a plane (z-fighting at the cross).
  parts.push(box(W + 0.03, H + 0.02, 0.17, GOLD, M()));
  parts.push(box(0.17, H + 0.035, W + 0.03, GOLD, M()));
  // The bow: two loops leaning out from a knot, and two short tails.
  const top = H / 2 + 0.02;
  for (const s of [-1, 1]) {
    // a ribbon loop: a long flat oval, leaning out and up from the knot
    const loop = paint(new THREE.TorusGeometry(0.12, 0.055, 4, 10), GOLD);
    loop.scale(1.7, 0.95, 0.5);
    parts.push(placed(loop, M(s * 0.2, top + 0.12, 0, 0.3 * s, 1, 0, -0.38 * s)));
    parts.push(box(0.08, 0.02, 0.22, GOLD_DARK, M(s * 0.12, top + 0.005, 0.12 * s, 0.6 * s)));
  }
  parts.push(box(0.12, 0.1, 0.12, GOLD_DARK, M(0, top + 0.06, 0)));
  return merge(parts.map((g) => { g.deleteAttribute('uv'); return g; }));
}

/**
 * The present's lit material: a little sheen, and a self-glow in its own
 * colours (cream glows cream, the ribbon gold) so it reads in shade and from
 * far down the road, as the glowing billboard did.
 */
export function presentMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.42;');
  };
  m.customProgramCacheKey = () => 'present-selfglow';
  return m;
}

/**
 * The present's magic, as one additive mesh: a swirling rainbow ring around
 * its base, gold rays fanning up from the bow, and a four-point twinkle on
 * the bow. All motion is in the vertex shader (uTime), per instance.
 *
 * Attributes: aKind 0 ring / 1 ray / 2 star; aP (ring: angle 0..1, ray:
 * index & height 0..1, star: corner -1..1).
 */
export function buildPresentFxGeometry({ ring = true } = {}) {
  const pos = [], kind = [], p = [];
  const push = (x, y, z, k, a, b) => { pos.push(x, y, z); kind.push(k); p.push(a, b); };
  if (ring) {
    const SEG = 28, r0 = 0.6, r1 = 0.76;
    for (let i = 0; i < SEG; i++) {
      const a0 = i / SEG, a1 = (i + 1) / SEG;
      const c0 = Math.cos(a0 * Math.PI * 2), s0 = Math.sin(a0 * Math.PI * 2);
      const c1 = Math.cos(a1 * Math.PI * 2), s1 = Math.sin(a1 * Math.PI * 2);
      // inner/outer quad as two triangles; aP.y = 0 inner, 1 outer
      push(c0 * r0, 0, s0 * r0, 0, a0, 0); push(c0 * r1, 0, s0 * r1, 0, a0, 1); push(c1 * r1, 0, s1 * r1, 0, a1, 1);
      push(c0 * r0, 0, s0 * r0, 0, a0, 0); push(c1 * r1, 0, s1 * r1, 0, a1, 1); push(c1 * r0, 0, s1 * r0, 0, a1, 0);
    }
  }
  // Rays: tall thin quads fanning out from the bow, crossed so they read
  // from any side.
  const RAYS = 6;
  for (let i = 0; i < RAYS; i++) {
    const yaw = (i / RAYS) * Math.PI;
    const tilt = ((i % 3) - 1) * 0.28;
    const cx = Math.cos(yaw), cz = Math.sin(yaw);
    const len = 1.1 + (i % 2) * 0.35, w0 = 0.05, w1 = 0.2;
    const base = [0, 0.5, 0];
    const tip = [Math.sin(tilt) * len * cx, 0.5 + Math.cos(tilt) * len, Math.sin(tilt) * len * cz];
    const q = (x, y, z, h) => push(x, y, z, 1, i, h);
    q(base[0] - cx * w0, base[1], base[2] - cz * w0, 0); q(base[0] + cx * w0, base[1], base[2] + cz * w0, 0); q(tip[0] + cx * w1, tip[1], tip[2] + cz * w1, 1);
    q(base[0] - cx * w0, base[1], base[2] - cz * w0, 0); q(tip[0] + cx * w1, tip[1], tip[2] + cz * w1, 1); q(tip[0] - cx * w1, tip[1], tip[2] - cz * w1, 1);
  }
  // The twinkle: one camera-facing quad, corners in aP.
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) push(0, 0.55, 0, 2, a, b);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute('aP', new THREE.Float32BufferAttribute(p, 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 2.2);
  return g;
}

const FX_VERT = /* glsl */`
  attribute float aKind;
  attribute vec2 aP;
  uniform float uTime;
  uniform float uRing;
  varying float vKind;
  varying vec2 vP;
  varying float vSeed;
  void main() {
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    vKind = aKind; vP = aP;
    float seed = fract(sin(dot(im[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    vSeed = seed;
    vec3 p = position;
    if (aKind < 0.5) {
      // ring: tilt it and spin it the other way to the box, so the swirl reads
      float a = uTime * 2.2 + seed * 6.283;
      float c = cos(a), s = sin(a);
      p.xz = mat2(c, -s, s, c) * p.xz;
      p.y += -0.28 + p.x * 0.18 + sin(uTime * 1.3 + seed * 5.0) * 0.04;
      p *= uRing;
    }
    if (aKind > 1.5) {
      // camera-facing twinkle on the bow
      vec4 c = modelViewMatrix * im * vec4(p, 1.0);
      float tw = pow(max(0.0, sin(uTime * 3.1 + seed * 11.0)), 6.0);
      c.xy += aP * (0.08 + 0.42 * tw);
      gl_Position = projectionMatrix * c;
      return;
    }
    gl_Position = projectionMatrix * modelViewMatrix * im * vec4(p, 1.0);
  }
`;

const FX_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGlow;
  varying float vKind;
  varying vec2 vP;
  varying float vSeed;
  vec3 hue(float h) {
    return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  }
  void main() {
    if (vKind < 0.5) {
      // comet-tail rainbow: bright head, fading tail, soft edges across the band
      float tail = fract(vP.x - uTime * 0.0);
      float edge = 1.0 - abs(vP.y * 2.0 - 1.0);
      float a = pow(tail, 1.6) * smoothstep(0.0, 0.6, edge);
      gl_FragColor = vec4(hue(vP.x * 0.9 + 0.02) * a * 0.9 * uGlow, 1.0);
      return;
    }
    if (vKind < 1.5) {
      // gold ray: bright at the bow, gone at the tip, shimmering
      float sh = 0.55 + 0.45 * sin(uTime * 4.0 + vP.x * 1.7 + vSeed * 9.0);
      float a = (1.0 - vP.y) * (1.0 - vP.y) * sh;
      gl_FragColor = vec4(vec3(1.0, 0.68, 0.16) * a * 0.6 * uGlow, 1.0);
      return;
    }
    // four-point star
    vec2 q = abs(vP);
    float star = 0.02 / (q.x * q.y + 0.02) * max(0.0, 1.0 - length(vP));
    gl_FragColor = vec4(vec3(1.0, 0.96, 0.8) * star * uGlow, 1.0);
  }
`;

/** Additive material for buildPresentFxGeometry. One uTime drives every present. */
export function presentFxMaterial(timeUniform = { value: 0 }, { ring = true, glow = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uRing: { value: ring ? 1 : 0 }, uGlow: { value: glow } },
    vertexShader: FX_VERT,
    fragmentShader: FX_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

// ============================================================
// DEATH CONE
// ============================================================

export const CONE = {
  H: 1.62,          // to the top of the knob
  BASE: 0.98,       // square base width
  R0: 0.37,         // body radius at the base
  R1: 0.075,        // body radius at the top
  ORANGE: 0xff5200,
  ORANGE_DARK: 0xe04200,
  WHITE: 0xf4f1ea,
};
/** Box the knocked cone tumbles as (origin on the ground, at its base). */
export const CONE_COLLIDER = { halfExtents: { x: 0.3, y: CONE.H / 2, z: 0.3 }, colliderOffset: { x: 0, y: CONE.H / 2, z: 0 } };

let _skullCanvas = null;
/** A white skull and crossbones with a dark outline, on transparent. 64×64. */
function drawSkull(g, ox = 0) {
  g.save();
  g.translate(ox + 32, 32);
  g.lineJoin = 'round';
  // crossbones behind
  const bone = (rot) => {
    g.save(); g.rotate(rot);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#1a1210'; g.lineWidth = 3;
    g.beginPath(); g.roundRect(-27, -3.5, 54, 7, 3); g.fill(); g.stroke();
    for (const x of [-27, 27]) for (const y of [-4, 4]) { g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke(); }
    g.beginPath(); g.roundRect(-26, -3, 52, 6, 3); g.fill();
    g.restore();
  };
  bone(0.62); bone(-0.62);
  // cranium + jaw
  g.fillStyle = '#ffffff'; g.strokeStyle = '#1a1210'; g.lineWidth = 3;
  g.beginPath(); g.arc(0, -5, 17, Math.PI * 0.82, Math.PI * 2.18); g.lineTo(9, 14); g.lineTo(-9, 14); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#1a1210';
  g.beginPath(); g.ellipse(-7, -3, 5.2, 6, 0.15, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(7, -3, 5.2, 6, -0.15, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(0, 3); g.lineTo(-3, 8); g.lineTo(3, 8); g.closePath(); g.fill();
  g.lineWidth = 1.6; g.strokeStyle = '#1a1210';
  for (const x of [-5, 0, 5]) { g.beginPath(); g.moveTo(x, 10); g.lineTo(x, 14); g.stroke(); }
  g.restore();
}

/**
 * The cone's texture atlas, 128×64: the skull on the left half, opaque white
 * on the right (the body's uvs all point there, so its vertex colours show
 * through unchanged). Shared, built once.
 */
let _coneAtlas = null;
export function coneAtlas() {
  if (_coneAtlas) return _coneAtlas;
  if (typeof document === 'undefined') return null;   // unit tests (no canvas)
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(64, 0, 64, 64);
  drawSkull(g, 0);
  _coneAtlas = new THREE.CanvasTexture(c);
  _coneAtlas.colorSpace = THREE.SRGBColorSpace;
  _coneAtlas.anisotropy = 4;
  return _coneAtlas;
}

/** Just the skull, 64×64 (spirits and the knock burst). Shared. */
let _skullTex = null;
export function skullTexture() {
  if (_skullTex) return _skullTex;
  if (typeof document === 'undefined') return null;
  _skullCanvas = document.createElement('canvas');
  _skullCanvas.width = _skullCanvas.height = 64;
  drawSkull(_skullCanvas.getContext('2d'), 0);
  _skullTex = new THREE.CanvasTexture(_skullCanvas);
  _skullTex.colorSpace = THREE.SRGBColorSpace;
  return _skullTex;
}

/**
 * The death cone, origin at the centre of its base, skull facing +z.
 * Stacked frustums so each stripe is its own colour band; a skull decal on
 * the front and back. ~180 triangles.
 */
export function buildConeGeometry() {
  const { H, BASE, R0, R1, ORANGE, ORANGE_DARK, WHITE } = CONE;
  const parts = [];
  const WU = 0.75, WV = 0.5;                    // white texel
  const y0 = 0.09, yTop = H - 0.12;             // body runs between the base slab and the knob
  const rAt = (y) => R0 + (R1 - R0) * ((y - y0) / (yTop - y0));
  // base slab: a low square frustum with a lip
  const slab = paint(new THREE.CylinderGeometry(BASE * 0.62, BASE * 0.7, y0, 4, 1), ORANGE_DARK);
  slab.rotateY(Math.PI / 4); slab.translate(0, y0 / 2, 0);
  parts.push(flatUv(slab, WU, WV));
  // stripes: orange, white, orange, white, orange (bottom → top), as in the billboard
  const bands = [[0, 0.24, ORANGE], [0.24, 0.39, WHITE], [0.39, 0.56, ORANGE], [0.56, 0.71, WHITE], [0.71, 1, ORANGE]];
  for (const [f0, f1, col] of bands) {
    const ya = y0 + f0 * (yTop - y0), yb = y0 + f1 * (yTop - y0);
    const g = paint(new THREE.CylinderGeometry(rAt(yb), rAt(ya), yb - ya, 12, 1, true), col);
    g.translate(0, (ya + yb) / 2, 0);
    parts.push(flatUv(g, WU, WV));
  }
  // the knob: a short cylinder with a lip
  const knob = paint(new THREE.CylinderGeometry(R1 * 1.05, R1 * 1.25, H - yTop, 10, 1), ORANGE);
  knob.translate(0, yTop + (H - yTop) / 2, 0);
  parts.push(flatUv(knob, WU, WV));
  // skull decals on the lower orange band, front and back, tilted to the slope
  const slope = Math.atan2(R0 - R1, yTop - y0);
  const yc = y0 + 0.17 * (yTop - y0), size = 0.42;
  for (const face of [0, Math.PI]) {
    const q = new THREE.PlaneGeometry(size, size);
    q.rotateX(-slope);
    q.translate(0, yc, rAt(yc) + 0.012);
    q.rotateY(face);
    const uv = q.attributes.uv;                   // squeeze to the atlas's left half
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5);
    parts.push(paint(q, 0xffffff));
  }
  return merge(parts);
}

/** Cone material: vertex colours through the atlas (skull decals alpha-tested). */
export function coneMaterial() {
  return new THREE.MeshStandardMaterial({
    vertexColors: true, map: coneAtlas(), alphaTest: 0.5, roughness: 0.55, metalness: 0,
    side: THREE.FrontSide,
  });
}

/**
 * Skull spirits circling every standing cone, instanced (the billboard's
 * look, #481): six big ghostly skulls ring the cone at different heights,
 * bobbing, each trailed by two fainter copies for the swirl. Each instance's
 * matrix is just its cone's ground position; the orbit is in the shader.
 * aPhase picks the skull (0..1 round the ring), aLag its trail copy (0 = the
 * skull itself, 1 and 2 behind it).
 */
export function buildSpiritGeometry() {
  const g = new THREE.BufferGeometry();
  const c = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(c.flat(), 2));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
  return g;
}

const SPIRIT_VERT = /* glsl */`
  attribute vec2 aCorner;
  attribute float aPhase;
  attribute float aLag;
  uniform float uTime;
  varying vec2 vUv;
  varying float vA;
  varying float vLag;
  void main() {
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    float seed = fract(sin(dot(im[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    float lagT = aLag * 0.11;                       // trail copies run this far behind
    float tt = uTime - lagT;
    float ang = tt * 2.1 + aPhase * 6.283 + seed * 6.283;
    float r = 0.66 + 0.1 * sin(tt * 1.3 + aPhase * 9.0);
    float y = 0.3 + aPhase * 1.25 + 0.22 * sin(tt * 2.4 + aPhase * 11.0 + seed * 6.0);
    vec3 c = vec3(cos(ang) * r, y, sin(ang) * r);
    vec4 mv = modelViewMatrix * im * vec4(c, 1.0);
    float size = 0.21 * (1.0 - aLag * 0.18);
    float wob = sin(tt * 4.0 + aPhase * 7.0) * 0.3;
    vec2 k = vec2(aCorner.x * cos(wob) - aCorner.y * sin(wob), aCorner.x * sin(wob) + aCorner.y * cos(wob));
    mv.xy += k * size;
    vUv = aCorner * 0.5 + 0.5;
    vA = aLag < 0.5 ? 0.95 : (aLag < 1.5 ? 0.32 : 0.14);
    vLag = aLag;
    gl_Position = projectionMatrix * mv;
  }
`;
const SPIRIT_FRAG = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vA;
  varying float vLag;
  void main() {
    vec4 t = texture2D(map, vUv);
    float a = t.a * vA;
    if (a < 0.02) discard;
    // the skull itself reads clearly; its trail copies are a pale ghostly wash
    gl_FragColor = vec4(mix(vec3(0.85, 0.9, 1.0), t.rgb, vLag < 0.5 ? 0.85 : 0.25), a);
  }
`;

export function spiritMaterial(timeUniform = { value: 0 }) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, map: { value: skullTexture() } },
    vertexShader: SPIRIT_VERT,
    fragmentShader: SPIRIT_FRAG,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * The death beat on a knocked cone: a ring of skulls bursts out of it,
 * spirals up and fades. Follows the tumbling cone. Six sprites for ~1.8 s.
 */
export class SkullBurst {
  /** @param {THREE.Object3D} target the knocked cone @param {THREE.Scene} scene */
  constructor(target, scene) {
    this.target = target;
    this.scene = scene;
    this.t = 0;
    this.duration = 1.8;
    this.group = new THREE.Group();
    this.group.name = 'skull-burst';
    this.sprites = [];
    const r = rng(Math.floor(Math.abs(target.position.x * 131 + target.position.z * 71)) + 1);
    for (let i = 0; i < 6; i++) {
      const mat = new THREE.SpriteMaterial({ map: skullTexture(), transparent: true, depthWrite: false });
      const s = new THREE.Sprite(mat);
      s.userData = { a0: (i / 6) * Math.PI * 2 + r() * 0.5, spd: 0.8 + r() * 0.6, rise: 1.2 + r() * 1.2 };
      this.group.add(s);
      this.sprites.push(s);
    }
    this.group.position.copy(target.position);
    scene.add(this.group);
  }

  /** @returns {boolean} true while still playing */
  update(dt) {
    this.t += dt;
    const k = Math.min(1, this.t / this.duration);
    if (this.target) this.group.position.copy(this.target.position);
    for (const s of this.sprites) {
      const u = s.userData;
      const ang = u.a0 + this.t * 3.2 * u.spd;
      const rad = 0.3 + 1.4 * Math.sqrt(k);
      s.position.set(Math.cos(ang) * rad, 0.6 + u.rise * k, Math.sin(ang) * rad);
      const sz = 0.35 + 0.35 * Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5);
      s.scale.set(sz, sz, 1);
      s.material.opacity = k < 0.15 ? k / 0.15 : Math.max(0, 1 - (k - 0.15) / 0.85);
      s.material.rotation = Math.sin(this.t * 6 + u.a0) * 0.35;
    }
    if (k >= 1) { this.dispose(); return false; }
    return true;
  }

  dispose() {
    if (!this.group) return;
    this.scene?.remove(this.group);
    for (const s of this.sprites) s.material.dispose();
    this.sprites = [];
    this.group = null;
  }
}

// ============================================================
// GRANDMA'S HOUSE — a timber cabin
// ============================================================

export const HOUSE = {
  W: 5.0,        // wall length along x (front)
  D: 4.0,        // wall length along z (sides)
  WALL: 2.7,     // wall height
  RISE: 1.75,    // gable rise above the walls
  LOG: 0.15,     // log radius
};

let _signTex = null;
/** Glow atlas, 256×64: the sign's lettering on the left 3/4, plain white on the right. */
function houseGlowAtlas() {
  if (_signTex) return _signTex;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(192, 0, 64, 64);
  // the sign board's lettering
  g.fillStyle = '#7a4a22'; g.fillRect(0, 0, 192, 64);
  g.strokeStyle = '#e8b54a'; g.lineWidth = 4; g.strokeRect(4, 4, 184, 56);
  g.fillStyle = '#fff3d6';
  g.font = 'bold 30px Georgia, "Times New Roman", serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText("Grandma's", 96, 22);
  g.font = 'bold 22px Georgia, "Times New Roman", serif';
  g.fillText('House', 96, 47);
  _signTex = new THREE.CanvasTexture(c);
  _signTex.colorSpace = THREE.SRGBColorSpace;
  _signTex.anisotropy = 4;
  return _signTex;
}

/** A log with bark sides and pale cut ends, lying along x. */
function logX(len, rad, x, y, z, hex) {
  const g = paint(new THREE.CylinderGeometry(rad, rad, len, 7, 1), hex);
  const col = g.attributes.color, pos = g.attributes.position;
  const cap = new THREE.Color(0xe6c08a);
  for (let i = 0; i < pos.count; i += 3) {
    const y0 = pos.getY(i), y1 = pos.getY(i + 1), y2 = pos.getY(i + 2);
    if (Math.abs(y0 - y1) < 1e-6 && Math.abs(y1 - y2) < 1e-6) for (let k = 0; k < 3; k++) col.setXYZ(i + k, cap.r, cap.g, cap.b);
  }
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

/**
 * Grandma's house as a timber cabin, door facing +z, origin on the ground
 * at its centre. Three meshes: the cabin (vertex colours, flat shaded),
 * the glow (windows and the sign, unlit) and the bow's sparkle (additive,
 * the present's fx shader with no ring). `update(t)` drives the sparkle.
 *
 * @param {{value:number}} [timeUniform]
 * @returns {THREE.Group & { userData: { update: (t:number)=>void, tris: number, draws: number } }}
 */
export function buildGrandmaHouse(timeUniform = { value: 0 }) {
  const { W, D, WALL, RISE, LOG } = HOUSE;
  const r = rng(478);
  const body = [];
  const glow = [];
  const HONEY = [0xc58a45, 0xb67a3a, 0xbf8240];
  const DARKWOOD = 0x5f3b20, TRIM = 0xe2aa3a, STONE = [0x8f8b84, 0x7d7a74, 0xa19c93, 0x6f6c67];
  const CREAM_ROOF = [0xfbf1dc, 0xf1e4cb, 0xfff7e8];

  // foundation: a low stone plinth
  body.push(box(W + 0.5, 0.3, D + 0.5, 0x88847d, M(0, 0.15, 0)));

  // log walls: front/back logs along x, side logs along z, interlocking
  // (the side courses sit half a log higher), ends sticking out past corners.
  const courses = Math.floor(WALL / (LOG * 2));
  for (let i = 0; i < courses; i++) {
    const y = 0.3 + LOG + i * LOG * 2;
    const hx = HONEY[i % HONEY.length];
    body.push(logX(W + 0.5, LOG, 0, y, D / 2, hx));
    body.push(logX(W + 0.5, LOG, 0, y, -D / 2, hx));
    if (i < courses) {
      const ys = y + LOG;
      const hz = HONEY[(i + 1) % HONEY.length];
      for (const sx of [-W / 2, W / 2]) {
        const g = logX(D + 0.5, LOG, 0, 0, 0, hz);
        g.rotateY(Math.PI / 2);
        g.translate(sx, Math.min(ys, 0.3 + WALL - LOG), 0);
        body.push(g);
      }
    }
  }
  const top = 0.3 + courses * LOG * 2;            // wall plate height

  // gables: vertical boards stepped to the roof slope, front and back
  const BOARDS = 11;
  for (const z of [D / 2 - 0.02, -D / 2 + 0.02]) {
    for (let i = 0; i < BOARDS; i++) {
      const x0 = -W / 2 + (i + 0.5) * (W / BOARDS);
      const h = RISE * (1 - Math.abs(x0) / (W / 2)) + 0.05;
      body.push(box(W / BOARDS - 0.03, h, 0.08, i % 2 ? 0x9a6a3a : 0xa87444, M(x0, top + h / 2, z)));
    }
  }

  // roof: the ridge runs front to back so the front is a gable (the
  // billboard's look); two slopes of cream shingle rows (tabs offset row to
  // row), gold fascia along the eaves, a gold ridge and gold bargeboards.
  const OVER = 0.35;
  const halfSpan = W / 2 + OVER;
  const pitch = Math.atan2(RISE, W / 2);
  const slopeLen = halfSpan / Math.cos(pitch);
  const ROWS = 7, TABS = 8, roofLen = D + 0.8;
  for (const side of [1, -1]) {
    const g0 = [];
    for (let row = 0; row < ROWS; row++) {
      const s = (row + 0.5) / ROWS * slopeLen;          // distance down from the ridge
      const off = row % 2 ? 0.5 : 0;
      for (let t = -1; t < TABS; t++) {
        let a0 = -roofLen / 2 + (t + off) * (roofLen / TABS) + 0.02;
        let a1 = a0 + roofLen / TABS - 0.04;
        a0 = Math.max(a0, -roofLen / 2); a1 = Math.min(a1, roofLen / 2);
        if (a1 - a0 < 0.05) continue;
        const col = CREAM_ROOF[Math.floor(r() * CREAM_ROOF.length)];
        g0.push(box(a1 - a0, 0.07, slopeLen / ROWS + 0.12, col, M((a0 + a1) / 2, 0.035 + row * 0.012, s)));
      }
    }
    g0.push(box(roofLen + 0.06, 0.16, 0.1, TRIM, M(0, 0, slopeLen + 0.02)));   // fascia
    const slope = merge(g0);
    // built descending along +z: tilt down the pitch, then turn to face +x / -x
    slope.applyMatrix4(new THREE.Matrix4().makeRotationX(pitch));
    slope.applyMatrix4(new THREE.Matrix4().makeRotationY(side * Math.PI / 2));
    slope.translate(0, top + RISE + 0.08, 0);
    body.push(slope);
  }
  body.push(box(0.22, 0.16, roofLen + 0.1, TRIM, M(0, top + RISE + 0.16, 0)));
  for (const z of [roofLen / 2 + 0.02, -roofLen / 2 - 0.02]) {
    for (const s of [-1, 1]) {
      const len = Math.hypot(halfSpan, halfSpan * Math.tan(pitch)) + 0.1;
      body.push(box(len, 0.16, 0.08, TRIM, M(s * halfSpan / 2, top + RISE + 0.1 - halfSpan * Math.tan(pitch) / 2, z, 0, 1, 0, -s * pitch)));
    }
  }

  // stone chimney on the right side of the roof (seen from the road side)
  const cx = W / 2 - 1.0, cz = -0.5;
  for (let c = 0; c < 8; c++) {
    const y = top + 0.6 + c * 0.24;
    for (let k = 0; k < 4; k++) {
      const side = k % 2 ? 1 : -1;
      const along = (k < 2 ? 1 : -1) * 0.18 + (c % 2 ? 0.06 : -0.06);
      const sx = k < 2 ? cx + along : cx + side * 0.27;
      const sz = k < 2 ? cz + side * 0.27 : cz + along;
      const w = k < 2 ? 0.34 : 0.14, d = k < 2 ? 0.14 : 0.34;
      body.push(box(w + r() * 0.04, 0.22, d + r() * 0.04, STONE[Math.floor(r() * STONE.length)], M(sx, y, sz, (r() - 0.5) * 0.12)));
    }
  }
  body.push(box(0.72, 1.4, 0.72, 0x6f6c67, M(cx, top + 1.1, cz)));       // core, under the stones
  body.push(box(0.78, 0.1, 0.78, 0x5a5752, M(cx, top + 0.6 + 8 * 0.24, cz)));

  // door: arched-top plank door with a gold star, in a dark frame
  const fz = D / 2 + LOG + 0.02;
  body.push(box(1.12, 1.95, 0.08, DARKWOOD, M(0, 0.3 + 0.98, fz)));
  for (let i = 0; i < 3; i++) body.push(box(0.3, 1.78, 0.06, i === 1 ? 0x7c4c28 : 0x86552d, M(-0.32 + i * 0.32, 0.3 + 0.9, fz + 0.05)));
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 0.07 : 0.16;
    if (i === 0) star.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); else star.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  body.push(placed(paint(new THREE.ShapeGeometry(star), 0xffcf3f), M(0, 0.3 + 1.25, fz + 0.09)));
  // porch steps
  body.push(box(1.6, 0.16, 0.5, 0x8f8b84, M(0, 0.08, D / 2 + 0.6)));
  body.push(box(1.4, 0.16, 0.35, 0x9a968e, M(0, 0.24, D / 2 + 0.42)));

  // windows: two beside the door, one on each side wall, one round in the
  // front gable. Pane in the glow mesh, frame + cross in the cabin mesh.
  const GU = 0.9, GV = 0.5;                       // white texel of the glow atlas
  const WARM = 0xffd56a;
  const windowAt = (x, y, z, ry, w = 0.78, h = 0.82) => {
    const frame = box(w + 0.16, h + 0.16, 0.08, TRIM, M(0, 0, 0));
    const bar1 = box(w, 0.06, 0.06, DARKWOOD, M(0, 0, 0.06));
    const bar2 = box(0.06, h, 0.06, DARKWOOD, M(0, 0, 0.06));
    const sill = box(w + 0.3, 0.08, 0.2, 0x8f8b84, M(0, -h / 2 - 0.1, 0.06));
    const m4 = M(x, y, z, ry);
    for (const g of [frame, bar1, bar2, sill]) body.push(placed(g, m4));
    const pane = flatUv(paint(new THREE.PlaneGeometry(w, h), WARM), GU, GV);
    glow.push(placed(pane, new THREE.Matrix4().multiplyMatrices(m4, M(0, 0, 0.045))));
  };
  windowAt(-1.55, 1.55, fz, 0);
  windowAt(1.55, 1.55, fz, 0);
  windowAt(W / 2 + LOG + 0.02, 1.55, 0.3, Math.PI / 2);
  windowAt(-W / 2 - LOG - 0.02, 1.55, 0.3, -Math.PI / 2);
  {
    const rw = 0.36, gy = top + 0.65, gz = D / 2 + 0.05;
    body.push(placed(paint(new THREE.CylinderGeometry(rw + 0.08, rw + 0.08, 0.08, 14), TRIM), M(0, gy, gz, 0, 1, Math.PI / 2)));
    const pane = flatUv(paint(new THREE.CircleGeometry(rw, 14), WARM), GU, GV);
    glow.push(placed(pane, M(0, gy, gz + 0.05)));
    body.push(box(rw * 2, 0.05, 0.05, DARKWOOD, M(0, gy, gz + 0.08)));
    body.push(box(0.05, rw * 2, 0.05, DARKWOOD, M(0, gy, gz + 0.08)));
  }

  // the sign over the door
  {
    const sw = 1.5, sh = 0.5, sy = 0.3 + 2.3, sz = fz + 0.06;
    body.push(box(sw + 0.1, sh + 0.1, 0.06, DARKWOOD, M(0, sy, sz)));
    const q = paint(new THREE.PlaneGeometry(sw, sh), 0xffffff);
    const uv = q.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.75);
    glow.push(placed(q, M(0, sy, sz + 0.035)));
    for (const s of [-1, 1]) body.push(box(0.03, 0.28, 0.03, 0x3a2614, M(s * 0.55, sy + 0.38, sz)));
  }

  // picket fence either side of the path
  for (const s of [-1, 1]) {
    const x0 = s * 1.15, x1 = s * (W / 2 + 0.3), fz2 = D / 2 + 1.05;
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const x = x0 + (x1 - x0) * (i / n);
      body.push(box(0.1, 0.62, 0.06, 0xf1e6cf, M(x, 0.31, fz2)));
      body.push(placed(paint(new THREE.ConeGeometry(0.07, 0.12, 4), 0xf1e6cf), M(x, 0.68, fz2, Math.PI / 4)));
    }
    for (const y of [0.22, 0.48]) body.push(box(Math.abs(x1 - x0) + 0.1, 0.06, 0.04, 0xd9c9a8, M((x0 + x1) / 2, y, fz2 - 0.05)));
  }

  // the gold present bow on the ridge, with tails down both slopes
  const bowY = top + RISE + 0.3;
  for (const s of [-1, 1]) {
    const loop = paint(new THREE.TorusGeometry(0.4, 0.17, 5, 14), 0xffb71c);
    loop.scale(1.65, 0.95, 0.45);
    body.push(placed(loop, M(s * 0.66, bowY + 0.3, 0, 0, 1, 0, -0.35 * s)));
    const tail = box(0.28, 0.04, slopeLen * 0.55, 0xd99a26, M(0, 0, 0));
    tail.translate(0, 0, slopeLen * 0.275);
    tail.applyMatrix4(new THREE.Matrix4().makeRotationX(pitch));
    tail.applyMatrix4(new THREE.Matrix4().makeRotationY(s * Math.PI / 2));
    tail.translate(0, top + RISE + 0.2, s * 0.18);
    body.push(tail);
  }
  body.push(box(0.36, 0.3, 0.3, 0xd99a26, M(0, bowY + 0.12, 0)));

  const group = new THREE.Group();
  group.name = 'grandma-house';
  const cabinGeo = merge(body.map((g) => { if (g.attributes.uv) g.deleteAttribute('uv'); return g; }));
  const cabin = new THREE.Mesh(cabinGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 }));
  cabin.name = 'grandma-house-cabin';
  cabin.castShadow = true;
  cabin.receiveShadow = true;
  const glowGeo = merge(glow);
  const glowMesh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ vertexColors: true, map: houseGlowAtlas(), toneMapped: false }));
  glowMesh.name = 'grandma-house-glow';
  // the bow's sparkle: the present's rays and twinkle, scaled up, no ring
  const fxGeo = buildPresentFxGeometry({ ring: false });
  const fx = new THREE.Mesh(fxGeo, presentFxMaterial(timeUniform, { ring: false, glow: 0.8 }));
  fx.name = 'grandma-house-sparkle';
  fx.scale.setScalar(2.3);
  fx.position.set(0, bowY - 0.6, 0);
  fx.frustumCulled = false;
  group.add(cabin, glowMesh, fx);
  group.userData.tris = triCount(cabinGeo) + triCount(glowGeo) + triCount(fxGeo);
  group.userData.draws = 3;
  group.userData.update = (t) => { timeUniform.value = t; };
  return /** @type {any} */ (group);
}
