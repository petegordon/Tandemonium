// ============================================================
// ARCH PUFFS — a checkpoint's gold cloud arch in one draw (#456)
// ============================================================
//
// A checkpoint arch was 16 sprites, so 16 draw calls whenever it was in view.
// Here the 16 puffs are one mesh: each puff is a quad that faces the camera in
// the vertex shader (as a sprite does) and bobs on a shared clock. The shader
// is three.js's sprite shader with the puff's centre, size and bob phase as
// vertex attributes, so it looks the same: same texture, tint, opacity and fog.
// All puffs share one colour, so the order they blend in makes no difference.

import * as THREE from 'three';

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute vec2 corner;   // -0.5..0.5, the quad corner
attribute vec2 puff;     // x = size, y = bob phase
uniform float time;
varying vec2 vUv;
void main() {
  vUv = corner + 0.5;
  vec3 c = position;
  c.y += sin(time * 1.2 + puff.y) * 0.08;
  vec4 mvPosition = modelViewMatrix * vec4(c, 1.0);
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  mvPosition.xy += corner * puff.x * scale;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D map;
varying vec2 vUv;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 diffuseColor = vec4(diffuse, opacity);
  diffuseColor *= texture2D(map, vUv);
  gl_FragColor = diffuseColor;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** One clock for every arch's bob (seconds). */
export const archTime = { value: 0 };

/**
 * @param {THREE.Texture} map  the cloud puff texture
 * @param {object} [o]
 * @param {number} [o.color]    tint (sRGB hex)
 * @param {number} [o.opacity]
 * @param {number} [o.count]    puffs along the arch
 * @param {number} [o.radius]   half the road width
 * @param {number} [o.baseY]    arch base above the ground
 * @param {() => number} [o.random]
 * @returns {THREE.Mesh}
 */
export function buildArchPuffs(map, { color = 0xffd700, opacity = 0.6, count = 16, radius = 2.8, baseY = 0.2, random = Math.random } = {}) {
  const pos = new Float32Array(count * 4 * 3);
  const corner = new Float32Array(count * 4 * 2);
  const puff = new Float32Array(count * 4 * 2);
  const index = [];
  const C = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  let maxSize = 0;
  for (let i = 0; i < count; i++) {
    const angle = (i / (count - 1)) * Math.PI; // 0 (right) to PI (left)
    const x = Math.cos(angle) * radius;
    const y = baseY + Math.sin(angle) * radius;
    const size = 1.6 + random() * 0.8;
    const z = (random() - 0.5) * 0.6;
    const phase = random() * Math.PI * 2;
    maxSize = Math.max(maxSize, size);
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos.set([x, y, z], v * 3);
      corner.set(C[k], v * 2);
      puff.set([size, phase], v * 2);
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('puff', new THREE.BufferAttribute(puff, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  // the quads reach past their centres (half a diagonal) and bob a little
  geo.boundingSphere.radius += maxSize * Math.SQRT1_2 + 0.1;

  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      diffuse: { value: new THREE.Color(color) },
      opacity: { value: opacity },
    }]),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  // set after merge(), which would copy them: one texture and one clock for all
  mat.uniforms.map = { value: map };
  mat.uniforms.time = archTime;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'archPuffs';
  return mesh;
}
