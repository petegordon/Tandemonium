// warmScene (js/gpu-warmup.js): only what three has not drawn yet is warmed, one first draw per shader
// program and vertex layout, and an empty instanced mesh is still drawn once.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WarmQueue, warmScene, undrawn } from '../../js/gpu-warmup.js';

/** A stand-in renderer: programs handed out by material type, every call recorded. */
function fakeRenderer() {
  const props = new WeakMap();
  const programs = new Map();
  const r = {
    compiled: [], drawn: [], targets: [], inits: 0, target: null, outputColorSpace: 'srgb',
    shadowMap: { autoUpdate: true },
    properties: { get: (m) => { if (!props.has(m)) props.set(m, {}); return props.get(m); } },
    initTexture: () => { r.inits++; },
    compile: (object) => {
      r.compiled.push(object.name);
      for (const m of [].concat(object.material)) {
        if (!programs.has(m.type)) programs.set(m.type, { id: programs.size + 1, isReady: () => true });
        r.properties.get(m).currentProgram = programs.get(m.type);
      }
    },
    getRenderTarget: () => r.target,
    setRenderTarget: (t) => { r.target = t; r.targets.push(t ? 'offscreen' : 'screen'); },
    render: (scene) => {
      scene.traverse((o) => { if (o.isMesh && o.layers.isEnabled(31)) r.drawn.push(o.name + (o.isInstancedMesh ? ':' + o.count : '')); });
    },
  };
  return r;
}
const drain = async (queue, p) => { let done = false; p.then(() => { done = true; }); for (let i = 0; i < 400 && !done; i++) { queue.step(); await new Promise((res) => setTimeout(res, 1)); } return p; };
const mesh = (name, material, geometry = new THREE.BoxGeometry()) => { const m = new THREE.Mesh(geometry, material); m.name = name; return m; };

test('warmScene warms only what has no program yet, once per program and layout, off-screen', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const r = fakeRenderer(), queue = new WarmQueue();
  const old = mesh('old', new THREE.MeshStandardMaterial());
  r.properties.get(old.material).currentProgram = { id: 99, isReady: () => true };
  const a = mesh('a', new THREE.MeshStandardMaterial());
  const b = mesh('b', new THREE.MeshStandardMaterial());                       // same program, same layout as a
  const flat = mesh('flat', new THREE.MeshStandardMaterial(), new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3)));   // same program, another layout
  const basic = mesh('basic', new THREE.MeshBasicMaterial());
  const hidden = mesh('hidden', new THREE.MeshPhongMaterial());
  hidden.visible = false;
  scene.add(old, a, b, flat, basic, hidden);

  assert.deepEqual(undrawn(r, scene).map((o) => o.name), ['a', 'b', 'flat', 'basic', 'hidden']);
  const n = await drain(queue, warmScene(r, scene, camera, { queue }));
  assert.deepEqual(r.compiled, ['a', 'b', 'flat', 'basic', 'hidden'], 'the drawn one is left alone; a hidden one is compiled too');
  assert.equal(n, 4);
  assert.deepEqual(r.drawn, ['a', 'flat', 'basic', 'hidden'], 'b shares a\'s program and layout: no draw of its own');
  assert.ok(r.targets.length === 8 && r.targets.every((t, i) => t === (i % 2 ? 'screen' : 'offscreen')), 'each first draw goes off-screen and hands the screen back');
  assert.equal(hidden.visible, false, 'left hidden');
  assert.equal(a.layers.isEnabled(31), false, 'layers put back');
  assert.equal(r.shadowMap.autoUpdate, true);

  assert.equal(await warmScene(r, scene, camera, { queue }), 0, 'a second pass finds nothing to do');
});

test('an empty instanced mesh (a pile that fills later) is given one instance for its first draw', async () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const r = fakeRenderer(), queue = new WarmQueue();
  const pile = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 8);
  pile.name = 'pile';
  pile.count = 0;
  scene.add(pile);
  await drain(queue, warmScene(r, scene, camera, { queue }));
  assert.deepEqual(r.drawn, ['pile:1']);
  assert.equal(pile.count, 0, 'empty again afterwards');
});
