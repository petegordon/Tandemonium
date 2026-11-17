// ============================================================
// BIKE SPARKLE — twinkling stars on a special bike's gold (#697, the Gold Standard)
// ============================================================
//
// Pete, 2026-11-09: "add a sparkle to the bike in chooser and in game, maybe something like the coin sparkles".
// The Tandem Token's stars (js/token-face.js): a four-point star with a white-hot centre that flares and is gone
// (max(0, sin)^n), drawn as a camera-facing quad with additive blending. Here a few dozen of them are scattered
// over the bike's polished gold, each with its own phase and pace, so a glint runs over the frame now and then.
//
// Each star sits on a vertex of a gold part and is parented to that part's parent node, so it rides with the
// part (the frame, the fork, a spinning wheel, a crank) and survives the bike's batching (bike-batch.js hides
// the meshes it merges, never their parents). One draw per parent node; the clock lives in the material.

import * as THREE from 'three';
import { isMirrorMaterial } from './mirror-env.js';

const VERT = /* glsl */`
  attribute vec2 aCorner;
  attribute float aPhase;
  attribute float aPace;
  uniform float uTime;
  uniform float uSize;
  varying vec2 vP;
  varying float vTw;
  void main() {
    // a glint: a sharp flare, then nothing for a while (a high power of a positive sine)
    float tw = pow(max(0.0, sin(uTime * aPace + aPhase)), 8.0);
    vTw = tw; vP = aCorner;
    vec4 c = modelViewMatrix * vec4(position, 1.0);
    c.xy += aCorner * uSize * (0.02 + tw);
    gl_Position = projectionMatrix * c;
  }
`;

const FRAG = /* glsl */`
  uniform float uGlow;
  varying vec2 vP;
  varying float vTw;
  void main() {
    vec2 q = abs(vP);
    float r = length(vP);
    // the token's four-point star, white-hot centre, a warm gold edge
    float star = 0.03 / (q.x * q.y + 0.03) * max(0.0, 1.0 - r);
    vec3 col = mix(vec3(1.0, 0.78, 0.35), vec3(1.0, 0.98, 0.9), clamp(star - 0.5, 0.0, 1.0));
    gl_FragColor = vec4(col * star * vTw * uGlow, 1.0);
  }
`;

/** Small deterministic random (the same stars every load). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatter twinkling stars over the polished gold under `model` (materials with metalness >= 0.95).
 * Call after the model is loaded and its materials set, before batching.
 * @param {THREE.Object3D} model
 * @param {{count?: number, size?: number, glow?: number, seed?: number}} [opts]
 *   size: a flare's half size in view units (the model's scale does not change it)
 * @returns {{meshes: THREE.Mesh[], material: THREE.ShaderMaterial, setVisible: (on: boolean) => void}}
 */
export function addBikeSparkle(model, { count = 64, size = 0.1, glow = 1.8, seed = 611 } = {}) {
  const gold = [];
  model.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && isMirrorMaterial(o.material)) gold.push(o); });
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSize: { value: size }, uGlow: { value: glow } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  material.name = 'bike-sparkle';
  material.onBeforeRender = () => { material.uniforms.uTime.value = performance.now() / 1000; };
  const meshes = [];
  const total = gold.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
  if (!total) return { meshes, material, setVisible() {} };

  const rand = rng(seed);
  const byParent = new Map();          // parent node -> {pos, corner, phase, pace}
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  for (const mesh of gold) {
    const pa = mesh.geometry.attributes.position, na = mesh.geometry.attributes.normal;
    const k = Math.round(count * pa.count / total);
    if (!k || !mesh.parent) continue;
    mesh.updateMatrix();
    nm.getNormalMatrix(mesh.matrix);
    const scale = mesh.matrix.getMaxScaleOnAxis() || 1;
    if (!byParent.has(mesh.parent)) byParent.set(mesh.parent, { pos: [], corner: [], phase: [], pace: [] });
    const b = byParent.get(mesh.parent);
    for (let s = 0; s < k; s++) {
      const i = Math.floor(rand() * pa.count);
      p.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrix);          // in the parent's space
      if (na) {                                                       // just proud of the surface
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        p.addScaledVector(n, 0.004 * scale);
      }
      const ph = rand() * Math.PI * 2 * 7, pace = 1.0 + rand() * 1.4;
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
        b.pos.push(p.x, p.y, p.z); b.corner.push(a, c); b.phase.push(ph); b.pace.push(pace);
      }
    }
  }
  for (const [parent, b] of byParent) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('aCorner', new THREE.Float32BufferAttribute(b.corner, 2));
    g.setAttribute('aPhase', new THREE.Float32BufferAttribute(b.phase, 1));
    g.setAttribute('aPace', new THREE.Float32BufferAttribute(b.pace, 1));
    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'bikeSparkle';
    mesh.frustumCulled = false;        // its quads grow in view space, past any bounds
    mesh.renderOrder = 3;
    mesh.castShadow = mesh.receiveShadow = false;
    parent.add(mesh);
    meshes.push(mesh);
  }
  return { meshes, material, setVisible(on) { for (const m of meshes) m.visible = !!on; } };
}
