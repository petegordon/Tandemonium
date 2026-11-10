// ============================================================
// BIKE PEDESTAL — the turntable a bike stands on in the chooser
// ============================================================
//
// Pete, 2026-11-10: with its outfit geese standing beside it, the smaller bike stands on a pedestal that
// turns with it. A turned walnut plinth (a moulded foot and lip), brass bands, a green felt top. Plain
// materials, no textures: cheap to draw and quick to warm up.

import * as THREE from 'three';

/** Moulded plinth profile (radius, height), radius 1, height 1: foot, waist, lip. */
const PROFILE = [
  [0, 0], [1.0, 0], [1.0, 0.1], [0.97, 0.16], [0.93, 0.2], [0.92, 0.24],
  [0.92, 0.68], [0.94, 0.72], [0.98, 0.78], [1.0, 0.84], [1.0, 0.93], [0.97, 1.0], [0, 1.0],
];

/**
 * A pedestal, standing on y = 0 with its top at y = height.
 * @param {number} radius
 * @param {number} height
 * @returns {THREE.Group}
 */
export function makePedestal(radius, height) {
  const g = new THREE.Group();
  g.name = 'BikePedestal';
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a2c17, roughness: 0.45, metalness: 0.05 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xd4a648, roughness: 0.32, metalness: 0.65, emissive: 0x2a1c05 });
  const felt = new THREE.MeshStandardMaterial({ color: 0x1e4a30, roughness: 1, metalness: 0 });

  const pts = PROFILE.map(([r, y]) => new THREE.Vector2(r * radius, y * height));
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), wood);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // brass bands on the foot and under the lip
  for (const [y, r] of [[0.1, 1.0], [0.84, 1.0]]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * radius, height * 0.045, 8, 64), brass);
    band.rotation.x = Math.PI / 2;
    band.position.y = y * height;
    g.add(band);
  }

  // the felt top the bike stands on, inside a thin brass rim
  const top = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.9, 64), felt);
  top.rotation.x = -Math.PI / 2;
  top.position.y = height + 0.002;
  top.receiveShadow = true;
  g.add(top);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.9, height * 0.03, 6, 64), brass);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height + 0.004;
  g.add(rim);
  return g;
}
