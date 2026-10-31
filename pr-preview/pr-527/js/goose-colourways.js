// ============================================================
// GOOSE COLOURWAYS — colour changes for the goose riders' outfits
// ============================================================
//
// Each Goose Outfits pair has its original colours plus a few colourways (Pete's review sheet,
// tandemonium-claude-3d docs/img/colourways.jpg). A colourway moves each garment to a target colour
// by a hue / saturation / value remap of its own texture -- Blender's Hue/Saturation node, mirrored
// here in the material shader -- so the weave, argyle, buttons and seams keep their detail. Flat
// (untextured) materials just take the target colour. The per-material numbers are generated
// offline from the delivered rider GLBs (goose-colourways-data.js); this module applies them.

import * as THREE from 'three';
import DATA from './goose-colourways-data.js';

export const DEFAULT_COLOURWAY = 'default';

/** [{key, label}] for an outfit pair ('default' first); [] for an unknown pair. */
export function colourwaysFor(outfit) {
  const p = DATA[outfit];
  return p ? p.ways.map(w => ({ key: w.key, label: w.label })) : [];
}

/** A known colourway of the pair, else the default. */
export function normalizeColourway(outfit, key) {
  return colourwaysFor(outfit).some(w => w.key === key) ? key : DEFAULT_COLOURWAY;
}

/** {Captain, Stoker}: {material name: {hsv: [hue, sat, val]} | {color: [r, g, b] linear}} ({} = original colours). */
export function colourwayParams(outfit, key) {
  const p = DATA[outfit];
  const w = p && p.ways.find(x => x.key === key && x.key !== DEFAULT_COLOURWAY);
  return { Captain: (w && w.Captain) || {}, Stoker: (w && w.Stoker) || {} };
}

const baseName = (n) => (n || '').replace(/\.\d{3}$/, '');   // Blender's duplicate suffix

// Blender node_hue_sat: h = fract(h + hue + 0.5), s = clamp(s * sat), v *= val (on the linear albedo)
const GLSL = `
uniform vec3 cwHsv;
uniform float cwOn;
vec3 cwRgb2Hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 cwHsv2Rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 cwRemap(vec3 c) {
  vec3 h = cwRgb2Hsv(max(c, vec3(0.0)));
  h.x = fract(h.x + cwHsv.x + 0.5);
  h.y = clamp(h.y * cwHsv.y, 0.0, 1.0);
  h.z *= cwHsv.z;
  return cwHsv2Rgb(h);
}
`;

// Per-material state, kept off the material itself: Material.clone() would copy userData as JSON (dead uniforms)
// and drop onBeforeCompile, so a clone simply starts afresh here.
const STATE = new WeakMap();

/** The material's colourway state (the shader hook goes in once; the program is shared by every hooked material). */
function state(m) {
  let cw = STATE.get(m);
  if (!cw) {
    const u = { cwHsv: { value: new THREE.Vector3(0.5, 1, 1) }, cwOn: { value: 0 } };
    cw = { u, color: m.color ? m.color.clone() : null, hooked: false };
    STATE.set(m, cw);
  }
  return cw;
}

/** Colourway state of a material, if it has been touched (tests / tools). */
export function colourwayState(m) {
  return STATE.get(m) || null;
}

function hook(m, cw) {
  if (cw.hooked) return;
  cw.hooked = true;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.cwHsv = cw.u.cwHsv;
    shader.uniforms.cwOn = cw.u.cwOn;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL)
      .replace('#include <map_fragment>', '#include <map_fragment>\n\tif (cwOn > 0.5) diffuseColor.rgb = cwRemap(diffuseColor.rgb);');
  };
  m.customProgramCacheKey = () => 'goose-colourway';
  m.needsUpdate = true;
}

/**
 * Apply one seat's colourway params to a rider (params {} = back to the original colours).
 * Materials shared by several meshes (and by versus clones) are handled once.
 * @returns {number} materials changed
 */
export function applyColourway(root, params) {
  const seen = new Set();
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const p = params[baseName(m.name)];
      if (!p && !STATE.has(m)) continue;
      const cw = state(m);
      if (cw.color && m.color) m.color.copy(cw.color);
      cw.u.cwOn.value = 0;
      if (p && p.hsv && m.map) {
        hook(m, cw);
        cw.u.cwHsv.value.set(p.hsv[0], p.hsv[1], p.hsv[2]);
        cw.u.cwOn.value = 1;
        n++;
      } else if (p && p.color && m.color) {
        m.color.setRGB(p.color[0], p.color[1], p.color[2]);   // linear, as exported
        n++;
      }
    }
  });
  return n;
}
