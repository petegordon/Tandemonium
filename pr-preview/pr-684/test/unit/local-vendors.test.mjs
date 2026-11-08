// #353: the desktop app serves three (and with it the Draco decoder) from
// node_modules instead of jsdelivr, so Show Riders works offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { localizeThree, installedThreeVersion } = require('../../electron/local-vendors.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('every three entry in the real index.html importmap is localized', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const pinned = html.match(/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//)[1];
  const { html: out, count } = localizeThree(html, { prefix: '/', installedVersion: pinned });
  assert.equal(count, 3); // three, three/addons/, three/examples/jsm/
  assert.ok(!out.includes('cdn.jsdelivr.net/npm/three@'));
  assert.ok(out.includes('"three": "/node_modules/three/build/three.module.js"'));
  assert.ok(out.includes('"three/addons/": "/node_modules/three/examples/jsm/"'));
  assert.ok(out.includes('"three/examples/jsm/": "/node_modules/three/examples/jsm/"'));
  // Unrelated CDN entries are untouched.
  assert.ok(out.includes('https://cdn.jsdelivr.net/npm/mp4-muxer@'));
});

test('importmap pin matches the three dependency in package.json', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const pinned = html.match(/cdn\.jsdelivr\.net\/npm\/three@(\d+\.\d+\.\d+)\//)[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.equal(pkg.dependencies.three, pinned);
});

test('a version mismatch or missing install leaves the CDN alone', () => {
  const html = '"three": "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js"';
  assert.deepEqual(localizeThree(html, { installedVersion: '0.170.0' }), { html, count: 0 });
  assert.deepEqual(localizeThree(html, { installedVersion: null }), { html, count: 0 });
  assert.equal(localizeThree(html, { prefix: '../', installedVersion: '0.161.0' }).html,
    '"three": "../node_modules/three/build/three.module.js"');
});

test('the installed three ships the Draco decoder files DRACOLoader requests', () => {
  const version = installedThreeVersion(ROOT);
  if (!version) return; // deps not installed
  for (const sub of ['libs/draco/', 'libs/draco/gltf/']) {
    for (const f of ['draco_decoder.js', 'draco_wasm_wrapper.js', 'draco_decoder.wasm']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'node_modules/three/examples/jsm', sub, f)), `${sub}${f}`);
    }
  }
});
