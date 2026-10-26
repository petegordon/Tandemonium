// ============================================================
// BIKE BATCH — draw the goose tandem's frame in a few meshes, not 69 (#395)
// ============================================================
//
// The goose tandem GLB is 69 small meshes, each with its own copy of the
// material (presets recolour parts by mesh name). Every one is a separate draw
// call in the main view, the shadow pass and the rider cam: ~200 draws for one
// bike. Most of them never move relative to each other.
//
// Here, meshes that hang off the same bone (so always move together) and look
// the same (same material settings and textures) are merged into one mesh on
// that bone. The originals stay in the scene, hidden, so everything that looks
// parts up by name (presets, the tyre measure, versus clones) still works.
// Call rebatch() again after anything changes the originals' materials.
//
// Left out: the geese (they have their own skeletons), skinned meshes, and any
// mesh in `keep` (the spokes, whose opacity changes every frame).
//
// The plain bike has no bones: its pedal nodes turn by themselves (#456). Pass
// them as `movers` and they count as bones: parts under a pedal merge onto
// that pedal, and a pedal that is itself a mesh is left as it is.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap'];

/** Everything about a material that changes how it draws. Same key = safe to share one draw. */
export function materialKey(m) {
  if (!m || Array.isArray(m)) return null;
  const parts = [m.type, m.side, m.transparent, m.opacity, m.wireframe, m.vertexColors, m.alphaTest,
    m.depthWrite, m.flatShading, m.visible];
  if (m.color) parts.push(m.color.getHexString());
  if (m.emissive) parts.push(m.emissive.getHexString(), m.emissiveIntensity);
  if (m.metalness !== undefined) parts.push(m.metalness, m.roughness, m.envMapIntensity);
  for (const k of MAP_KEYS) parts.push(m[k] ? m[k].uuid : '-');
  if (m.normalScale) parts.push(m.normalScale.x, m.normalScale.y);
  if (m.onBeforeCompile && m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) parts.push(m.uuid);
  return parts.join('|');
}

function geometryKey(g) {
  return Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n') +
    (Object.keys(g.morphAttributes).length ? '|morph' + g.id : '');
}

/** The nearest bone or mover above `o` (what moves it), or `root`. */
function ownerOf(o, root, movers) {
  let p = o.parent;
  while (p && p !== root && !p.isBone && !movers.has(p)) p = p.parent;
  return p || root;
}

/** Remove the merged meshes a previous rebatch() made. */
export function unbatch(root, batchId) {
  const old = [];
  root.traverse(o => { if (o.userData && o.userData.bikeBatch) old.push(o); });
  for (const m of old) {
    m.parent.remove(m);
    // A versus clone copies the merged meshes but shares their geometry with
    // the source bike: only the bike that made a geometry disposes it.
    if (m.userData.bikeBatch === batchId) m.geometry.dispose();
  }
  root.traverse(o => { if (o.userData && o.userData.bikeBatched) { o.visible = true; delete o.userData.bikeBatched; } });
}

/**
 * Merge `root`'s still parts into a few meshes.
 * @param {THREE.Object3D} root   the bike model
 * @param {object} [opts]
 * @param {Set<THREE.Object3D>|THREE.Object3D[]} [opts.keep]  meshes to leave as they are
 * @param {Set<THREE.Object3D>|THREE.Object3D[]} [opts.movers]  nodes the game turns itself (like bones)
 * @param {string} [opts.batchId]  marks the merged meshes this bike owns
 * @returns {{ before: number, after: number }} meshes drawn before and after
 */
export function rebatch(root, opts = {}) {
  const batchId = opts.batchId || 'bike';
  const keep = new Set(opts.keep || []);
  const movers = new Set(opts.movers || []);
  unbatch(root, batchId);
  root.updateMatrixWorld(true);

  // owner -> key -> meshes
  const groups = new Map();
  let before = 0;
  const walk = (o) => {
    if (o.userData && o.userData.gooseSeat) return;    // a goose rider: not ours
    if (o.isMesh && o.visible) {
      before++;
      const mk = materialKey(o.material);
      if (!o.isSkinnedMesh && !o.isInstancedMesh && !keep.has(o) && !movers.has(o) && mk !== null && o.geometry) {
        const owner = ownerOf(o, root, movers);
        const key = mk + '#' + geometryKey(o.geometry) + '#' + o.castShadow + o.receiveShadow;
        if (!groups.has(owner)) groups.set(owner, new Map());
        const byKey = groups.get(owner);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(o);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(root);

  let removed = 0, added = 0;
  const toOwner = new THREE.Matrix4();
  const rel = new THREE.Matrix4();
  for (const [owner, byKey] of groups) {
    toOwner.copy(owner.matrixWorld).invert();
    for (const meshes of byKey.values()) {
      if (meshes.length < 2) continue;
      // Each part in its owner's space. The nodes between a part and its bone
      // never animate (only bones do), so this offset is fixed.
      const geoms = meshes.map(m => {
        rel.multiplyMatrices(toOwner, m.matrixWorld);
        const g = m.geometry.clone();
        g.applyMatrix4(rel);
        return g;
      });
      const merged = mergeGeometries(geoms, false);
      for (const g of geoms) g.dispose();
      if (!merged) continue;               // incompatible after all: leave them be
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      const first = meshes[0];
      const mesh = new THREE.Mesh(merged, first.material);
      mesh.name = 'bikeBatch_' + added;   // not the owner's name: a pedal's would look like a pedal
      mesh.castShadow = first.castShadow;
      mesh.receiveShadow = first.receiveShadow;
      mesh.userData.bikeBatch = batchId;
      owner.add(mesh);
      for (const m of meshes) { m.visible = false; m.userData.bikeBatched = true; }
      removed += meshes.length;
      added++;
    }
  }
  return { before, after: before - removed + added };
}
