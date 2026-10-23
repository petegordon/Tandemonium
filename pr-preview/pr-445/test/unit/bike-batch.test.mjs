// #395 · the goose tandem's frame drawn as a few merged meshes.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rebatch, unbatch, materialKey } from '../../js/bike-batch.js';

function bike() {
  const root = new THREE.Group();
  const bone = new THREE.Bone(); bone.name = 'Wheel_F'; bone.position.set(2, 0, 0); root.add(bone);
  const holder = new THREE.Group(); holder.position.set(0, 1, 0); bone.add(holder);   // a still node under the bone
  const mat = () => new THREE.MeshStandardMaterial({ color: 0x884422 });
  const box = () => new THREE.BoxGeometry(0.2, 0.2, 0.2);
  const parts = {};
  parts.a = new THREE.Mesh(box(), mat()); parts.a.position.set(0, 0, 1); holder.add(parts.a);
  parts.b = new THREE.Mesh(box(), mat()); parts.b.position.set(0, 0, -1); bone.add(parts.b);
  parts.red = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ color: 0xff0000 })); bone.add(parts.red);
  parts.spoke = new THREE.Mesh(box(), mat()); bone.add(parts.spoke);
  parts.frame1 = new THREE.Mesh(box(), mat()); parts.frame1.position.x = -1; root.add(parts.frame1);
  parts.frame2 = new THREE.Mesh(box(), mat()); parts.frame2.position.x = -2; root.add(parts.frame2);
  const goose = new THREE.Group(); goose.userData.gooseSeat = 'Captain'; root.add(goose);
  parts.goose1 = new THREE.Mesh(box(), mat()); goose.add(parts.goose1);
  parts.goose2 = new THREE.Mesh(box(), mat()); goose.add(parts.goose2);
  return { root, bone, parts };
}

const batches = root => { const o = []; root.traverse(m => { if (m.userData.bikeBatch) o.push(m); }); return o; };

test('same-looking parts on the same bone become one mesh; others stay', () => {
  const { root, bone, parts } = bike();
  const r = rebatch(root, { keep: [parts.spoke], batchId: 'A' });
  // the bike's own meshes (the geese are not counted)
  // before: a, b, red, spoke, frame1, frame2 = 6
  // after:  [a+b], red, spoke, [frame1+frame2] = 4
  assert.deepEqual(r, { before: 6, after: 4 });
  const merged = batches(root);
  assert.equal(merged.length, 2);
  assert.ok(merged.some(m => m.parent === bone), 'the wheel parts ride on their bone');
  assert.ok(merged.some(m => m.parent === root));
  for (const k of ['a', 'b', 'frame1', 'frame2']) assert.equal(parts[k].visible, false, k + ' hidden, not removed');
  for (const k of ['red', 'spoke', 'goose1', 'goose2']) assert.equal(parts[k].visible, true, k + ' untouched');
});

test('merged parts stay where they were, and follow the bone when it turns', () => {
  const { root, bone, parts } = bike();
  root.updateMatrixWorld(true);
  const wantA = new THREE.Box3().setFromObject(parts.a);
  rebatch(root, { keep: [parts.spoke] });
  const m = batches(root).find(x => x.parent === bone);
  const got = new THREE.Box3().setFromObject(m);
  // the merged box covers a and b; a's corner (max z) is where a was
  assert.ok(Math.abs(got.max.z - wantA.max.z) < 1e-6);
  assert.ok(Math.abs(got.max.y - wantA.max.y) < 1e-6);
  bone.rotation.x = Math.PI / 2;
  root.updateMatrixWorld(true);
  const turnedA = new THREE.Box3().setFromObject(parts.a, true);
  const turned = new THREE.Box3().setFromObject(m, true);
  assert.ok(turned.containsBox(turnedA.expandByScalar(-1e-6)), 'still covers a after the bone turns');
});

test('rebatch again after a recolour; unbatch puts everything back', () => {
  const { root, parts } = bike();
  rebatch(root, { keep: [parts.spoke], batchId: 'A' });
  parts.a.material.color.set(0x00ff00);       // a preset recolours one part
  const r = rebatch(root, { keep: [parts.spoke], batchId: 'A' });
  assert.equal(parts.a.visible, true, 'a no longer matches b');
  assert.equal(parts.b.visible, true, 'b alone is not merged');
  assert.equal(r.after, 5);   // a, b, red, spoke, [frame1+frame2]
  unbatch(root, 'A');
  assert.equal(batches(root).length, 0);
  for (const p of Object.values(parts)) assert.equal(p.visible, true);
});

test("a clone's rebatch never disposes the geometry it shares with the source", () => {
  const { root, parts } = bike();
  rebatch(root, { keep: [parts.spoke], batchId: 'source' });
  const shared = batches(root).map(m => m.geometry);
  let disposed = 0;
  for (const g of shared) g.addEventListener('dispose', () => disposed++);
  const copy = root.clone(true);              // geometry is shared by clone()
  rebatch(copy, { batchId: 'clone' });
  assert.equal(disposed, 0);
  rebatch(root, { keep: [parts.spoke], batchId: 'source' });
  assert.equal(disposed, shared.length, 'the source frees its own');
});

test('material keys tell apart what draws differently', () => {
  const a = new THREE.MeshStandardMaterial({ color: 0x112233 });
  assert.equal(materialKey(a), materialKey(a.clone()));
  const b = a.clone(); b.opacity = 0.5; b.transparent = true;
  assert.notEqual(materialKey(a), materialKey(b));
  const c = a.clone(); c.map = new THREE.Texture();
  assert.notEqual(materialKey(a), materialKey(c));
  assert.equal(materialKey([a, a]), null, 'multi-material meshes are left alone');
});
