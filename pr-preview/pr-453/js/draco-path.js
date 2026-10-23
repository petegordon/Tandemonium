// ============================================================
// DRACO DECODER PATH — follow wherever three/addons resolves (#353)
// ============================================================
// Web: the importmap points three/addons/ at jsdelivr, so the decoder still comes
// from the CDN. Desktop: build-desktop rewrites it to ../node_modules/three/..., so
// the decoder loads locally and works offline. Falls back to the CDN when
// import.meta.resolve isn't available (or can't resolve the bare specifier).

const CDN_ADDONS = 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/';

function addonsBase() {
  try {
    // Any scheme is fine (https:, file:, Electron's tandemonium:).
    const u = import.meta.resolve?.('three/addons/');
    if (u) return new URL(u).href;
  } catch {}
  return CDN_ADDONS;
}

/** Decoder folder under three/addons/, e.g. 'libs/draco/' or 'libs/draco/gltf/'. */
export function dracoDecoderPath(sub = 'libs/draco/') {
  return new URL(sub, addonsBase()).href;
}
