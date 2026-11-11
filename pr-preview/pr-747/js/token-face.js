// ============================================================
// TOKEN FACE — the one Tandem Token look, every mode
// ============================================================
// A gold disc stamped with the House Tandem controller mark on heads and a
// star on tails, like the coins in Carnival Dozer. The face drawing is ported
// from discord-activity-coinpusher src/render/scene.ts (coinFaceTexture), with
// the mark from images/logos/housetandem-controller.svg (viewBox ±420).
//
// The material stays the gold MeshPhongMaterial the tokens always had: the
// "lean" lighting has no environment map, and a metallic MeshStandardMaterial
// reads near-black there. The faces are a white `map` with darker engraving
// (tinted gold by the colour, and by the emissive through `emissiveMap`, so
// the engraving still shows where the glow lifts the gold) plus a `bumpMap`.
// Textures and materials are built once and shared by every token on every
// road; CollectibleManager.destroy() leaves `shared` variants alone.

import * as THREE from 'three';

export const TOKEN = Object.freeze({
  RADIUS: 0.5, DEPTH: 0.09, SEGMENTS: 24,
  COLOR: 0xffd23f, EMISSIVE: 0x9a6400, SHININESS: 220,
  TEX_SIZE: 512,
});

/**
 * Draw one face into a 2D context. `bump` draws the raised parts white on
 * black for the bump map; otherwise it is the colour map, white with darker
 * engraving. Everything is turned a quarter-turn back because CylinderGeometry
 * maps its cap UVs a quarter-turn round (the controller's bumper and the
 * star's top point end up at the top of a token stood on edge).
 * @param {CanvasRenderingContext2D} g
 * @param {number} S canvas size in px
 * @param {'controller'|'star'} design
 * @param {boolean} bump
 */
export function drawTokenFace(g, S, design, bump) {
  const C = S / 2;
  const k = S / 512;
  g.fillStyle = bump ? '#000' : '#fff';
  g.fillRect(0, 0, S, S);
  const ink = bump ? '#fff' : '#a8875a';
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.save();
  g.translate(C, C);
  g.scale(k, k);
  g.rotate(-Math.PI / 2);
  // Rim: a raised ring and a fine inner line.
  g.lineWidth = 22;
  g.beginPath(); g.arc(0, 0, 228, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 5;
  g.beginPath(); g.arc(0, 0, 198, 0, Math.PI * 2); g.stroke();
  if (design === 'controller') {
    g.translate(0, 6);
    g.scale(0.43, 0.43);
    g.lineWidth = 40;
    g.beginPath();
    g.roundRect(-339.5, -208.5, 679, 417, 208.5);
    g.stroke();
    // The bumper: SVG "M-95 -227 H95 V-156 a34 34 0 0 1 -34 34 H-61 a34 34 0 0 1 -34 -34 Z".
    g.beginPath();
    g.roundRect(-95, -227, 190, 105, [0, 0, 34, 34]);
    g.fill();
    g.beginPath(); g.arc(-127, 3, 70, 0, Math.PI * 2); g.fill();
    g.lineWidth = 44;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(127, -51); g.lineTo(127, 57);
    g.moveTo(73, 3); g.lineTo(181, 3);
    g.stroke();
  } else {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 58 : 146;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      g.lineTo(r * Math.cos(a), r * Math.sin(a));
    }
    g.closePath();
    g.fill();
  }
  g.restore();
}

const defaultCanvas = (S) => {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
};

/** One face texture (colour or bump). */
export function tokenFaceTexture(design, bump, makeCanvas = defaultCanvas) {
  const c = makeCanvas(TOKEN.TEX_SIZE);
  drawTokenFace(c.getContext('2d'), TOKEN.TEX_SIZE, design, bump);
  const t = new THREE.CanvasTexture(c);
  if (!bump) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The token disc: stood on edge, heads facing +Z, tails -Z (3 groups: edge, heads, tails). */
export function buildTokenGeometry() {
  const geo = new THREE.CylinderGeometry(TOKEN.RADIUS, TOKEN.RADIUS, TOKEN.DEPTH, TOKEN.SEGMENTS);
  geo.rotateX(Math.PI / 2);
  return geo;
}

let _materials = null;
/**
 * The shared token materials in CylinderGeometry group order: [edge, heads,
 * tails]. Built once; never dispose them.
 */
export function tokenMaterials(makeCanvas = defaultCanvas) {
  if (_materials) return _materials;
  const base = { color: TOKEN.COLOR, emissive: TOKEN.EMISSIVE, shininess: TOKEN.SHININESS, specular: 0xffffff };
  const face = (design) => {
    const map = tokenFaceTexture(design, false, makeCanvas);
    return new THREE.MeshPhongMaterial({
      ...base, map, emissiveMap: map, bumpMap: tokenFaceTexture(design, true, makeCanvas), bumpScale: 1.5,
    });
  };
  _materials = [new THREE.MeshPhongMaterial(base), face('controller'), face('star')];
  for (const m of _materials) m.name = 'tandem-token';
  return _materials;
}

// ------------------------------------------------------------
// Glow + sparkle (Pete, 2026-11-07: "I like the Slingshot coin glow and
// sparkle better, but I like the Daily Ride coin fullness better"). The old
// Slingshot coin had a pulsing halo sprite and three twinkling star sprites
// per coin — four draws a coin. Here the same look is one camera-facing quad
// per element in a single geometry, so every token's glow on the road is ONE
// instanced draw. aKind 0 = halo, 1 = star (aPhase = its slot round the rim).
// ------------------------------------------------------------

export function buildTokenFxGeometry() {
  const pos = [], kind = [], corner = [], phase = [];
  const quad = (x, y, z, k, ph) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      pos.push(x, y, z); kind.push(k); corner.push(a, b); phase.push(ph);
    }
  };
  quad(0, 0, 0, 0, 0);
  for (let k = 0; k < 3; k++) {
    // The stars sit on the rim in the disc's plane, just proud of heads, so
    // they orbit with the token's spin (as the sprites did).
    const a = (k / 3) * Math.PI * 2;
    quad(Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.1, 1, k * 2.1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  return g;
}

const TOKEN_FX_VERT = /* glsl */`
  attribute float aKind;
  attribute vec2 aCorner;
  attribute float aPhase;
  uniform float uTime;
  varying float vKind;
  varying vec2 vP;
  void main() {
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    vKind = aKind; vP = aCorner;
    float seed = fract(sin(dot(im[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 40.0;
    vec4 c = modelViewMatrix * im * vec4(position, 1.0);
    float half_;
    if (aKind < 0.5) {
      half_ = 0.5 * (1.7 + sin(uTime * 3.0 + seed) * 0.25);   // the halo breathes
    } else {
      // A twinkle is a quick flare then nothing: max(0, sin)^3.
      float tw = pow(max(0.0, sin(uTime * 5.0 + seed * 1.3 + aPhase)), 3.0);
      half_ = 0.5 * (0.05 + 0.55 * tw);
    }
    c.xy += aCorner * half_;
    gl_Position = projectionMatrix * c;
  }
`;

const TOKEN_FX_FRAG = /* glsl */`
  uniform float uGlow;
  varying float vKind;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    if (vKind < 0.5) {
      // soft gold halo: pale centre, gold at a third, gone at the edge
      vec3 inner = vec3(1.0, 0.925, 0.588) * 0.9;
      vec3 mid = vec3(1.0, 0.824, 0.247) * 0.45;
      vec3 col = r < 0.35 ? mix(inner, mid, r / 0.35) : mix(mid, vec3(0.0), clamp((r - 0.35) / 0.65, 0.0, 1.0));
      gl_FragColor = vec4(col * 0.55 * uGlow, 1.0);
      return;
    }
    // four-point star, white-hot centre
    vec2 q = abs(vP);
    float star = 0.03 / (q.x * q.y + 0.03) * max(0.0, 1.0 - r);
    gl_FragColor = vec4(vec3(1.0, 0.96, 0.8) * star * uGlow, 1.0);
  }
`;

/** Additive material for buildTokenFxGeometry; one uTime drives every token. */
export function tokenFxMaterial(timeUniform = { value: 0 }, { glow = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: timeUniform, uGlow: { value: glow } },
    vertexShader: TOKEN_FX_VERT,
    fragmentShader: TOKEN_FX_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}
