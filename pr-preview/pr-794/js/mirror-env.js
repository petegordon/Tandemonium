// ============================================================
// MIRROR ENV — what a mirror-finish bike reflects (#611, the Gold Standard)
// ============================================================
//
// Polished metal shows only what it reflects. The riders' RoomEnvironment is a grey room, so mirror gold
// picked up grey and read dark; the chooser preview has no environment at all, so it read black. This is a
// small procedural sky (made in code, no asset): a warm horizon, deeper blue overhead, a dark ground (the contrast that makes it read as a mirror), two
// softbox highlights and a sun, in HDR so the highlights sparkle. One equirect texture, shared; three.js
// prefilters it per renderer, so it works in the ride and in the chooser preview alike.

import * as THREE from 'three';

let _tex = null;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Soft-edged rectangular light at azimuth/elevation (degrees), size w × h degrees. */
function box(az, el, a0, e0, w, h) {
  let da = Math.abs(az - a0) % 360; if (da > 180) da = 360 - da;
  return (1 - smooth(w * 0.5 - 4, w * 0.5 + 4, da)) * (1 - smooth(h * 0.5 - 3, h * 0.5 + 3, Math.abs(el - e0)));
}

/** The shared mirror environment (an equirectangular HDR DataTexture). */
export function mirrorEnvTexture() {
  if (_tex) return _tex;
  const W = 256, H = 128;
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const el = 90 - (y + 0.5) / H * 180;                       // elevation, degrees (row 0 = straight up)
    for (let x = 0; x < W; x++) {
      const az = (x + 0.5) / W * 360;
      let r, g, b;
      if (el >= 0) {                                           // sky: warm bright horizon -> blue overhead
        const t = Math.pow(el / 90, 0.5);
        r = 0.75 * (1 - t) + 0.10 * t; g = 0.68 * (1 - t) + 0.15 * t; b = 0.58 * (1 - t) + 0.30 * t;
      } else {                                                 // ground: warm earth fading darker below
        const t = Math.pow(-el / 90, 0.6);
        r = 0.07 * (1 - t) + 0.012 * t; g = 0.055 * (1 - t) + 0.01 * t; b = 0.04 * (1 - t) + 0.008 * t;
      }
      const hz = Math.exp(-Math.pow((el - 1.5) / 2, 2)) * 1.8;     // the glowing horizon line
      r += hz; g += hz * 0.95; b += hz * 0.82;
      let L = 6.0 * box(az, el, 40, 32, 26, 12) + 4.5 * box(az, el, 215, 24, 40, 9)   // softboxes
        + 14.0 * box(az, el, 125, 52, 8, 8);                                             // the sun
      for (const a0 of [0, 90, 160, 270, 315]) L += 2.6 * box(az, el, a0, 25, 5, 50);       // tall strips: the sparkle
      r += L; g += L * 0.97; b += L * 0.9;
      const i = (y * W + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 1;
    }
  }
  _tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  _tex.mapping = THREE.EquirectangularReflectionMapping;
  _tex.colorSpace = THREE.LinearSRGBColorSpace;
  _tex.magFilter = THREE.LinearFilter;
  _tex.minFilter = THREE.LinearFilter;
  _tex.flipY = true;
  _tex.needsUpdate = true;
  _tex.userData.mirrorEnv = true;   // shared: never dispose it with a model
  return _tex;
}

/** The polished metal of a mirror bike (full metal); its deep-gold inlays, leather and rubber keep the scene's light. */
export function isMirrorMaterial(m) {
  return !!m && m.isMeshStandardMaterial && m.metalness >= 0.95;
}

/** Give the polished metal under `root` the mirror environment (call once its materials are its own). */
export function applyMirrorEnv(root) {
  const env = mirrorEnvTexture();
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (isMirrorMaterial(m)) { m.envMap = env; m.needsUpdate = true; }
    }
  });
}
