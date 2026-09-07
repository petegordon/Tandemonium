#!/usr/bin/env node
// ============================================================
// check-controller-core.js — guard shared/ against drift from the lab
// ============================================================
//
// Fails (exit 1) if the vendored shared/ has diverged from the pinned
// @usersfirst/controller-core (and shared/visualizer/ from
// @usersfirst/controller-visualizer) source — i.e. someone hand-edited shared/
// instead of editing the lab + re-syncing, or shared/ is stale vs the lab
// checkout. Non-mutating (compares in place). Requires the lab to be present
// (sibling checkout or $CONTROLLER_LAB_DIR); skips with a notice if absent so
// it doesn't break environments that only build from the committed copy.
//
//   npm run check:controller-core

const fs = require('fs');
const path = require('path');
const L = require('./lib/controller-core');

const src = L.srcDir();
if (!fs.existsSync(src)) {
  console.warn(`controller-core lab source not found at ${src} — skipping drift check.`);
  console.warn('(shared/ is committed and self-contained; this guard only runs where the lab is checked out.)');
  process.exit(0);
}

const shared = L.sharedDir();
const expected = L.vendoredFiles(src);
const problems = [];

// 1. Every vendored file must exist in shared/ and be byte-identical to the lab.
for (const rel of expected) {
  const dest = path.join(shared, rel);
  if (!fs.existsSync(dest)) { problems.push(`missing in shared/: ${rel}`); continue; }
  if (!fs.readFileSync(path.join(src, rel)).equals(fs.readFileSync(dest))) {
    problems.push(`differs from lab: shared/${rel}`);
  }
}

// 2. No stale .js files in shared/ that the lab no longer has.
const actual = [];
const sharedDrivers = path.join(shared, 'drivers');
if (fs.existsSync(sharedDrivers)) {
  for (const e of fs.readdirSync(sharedDrivers)) if (e.endsWith('.js')) actual.push('drivers/' + e);
}
for (const e of fs.readdirSync(shared)) if (e.endsWith('.js')) actual.push(e);
for (const rel of actual) {
  if (!expected.includes(rel)) problems.push(`stale (not in lab): shared/${rel}`);
}

// 3. Visualizer (shared/visualizer/): every vendored src module + referenced
//    GLB must exist and be byte-identical, and nothing stale may linger.
const vizPkg = L.visualizerPkgDir();
const vizShared = L.visualizerSharedDir();
const vizExpected = fs.existsSync(vizPkg) ? L.vendoredVisualizerFiles() : [];
for (const rel of vizExpected) {
  const dest = path.join(vizShared, rel);
  if (!fs.existsSync(dest)) { problems.push(`missing in shared/visualizer/: ${rel}`); continue; }
  if (!fs.readFileSync(path.join(vizPkg, rel)).equals(fs.readFileSync(dest))) {
    problems.push(`differs from lab: shared/visualizer/${rel}`);
  }
}
if (fs.existsSync(vizShared)) {
  const walk = (dir, prefix, out) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
      else out.push(rel);
    }
    return out;
  };
  for (const rel of walk(vizShared, '', [])) {
    if (!vizExpected.includes(rel)) problems.push(`stale (not in lab): shared/visualizer/${rel}`);
  }
}

// 4. Provenance stamp versions must match the lab's package versions.
const labVer = L.labVersion();
const labVizVer = L.visualizerVersion();
let stampVer = null, stampVizVer = null;
try {
  const stamp = JSON.parse(fs.readFileSync(path.join(shared, L.STAMP), 'utf8'));
  stampVer = stamp.version;
  stampVizVer = stamp.visualizer ? stamp.visualizer.version : null;
} catch { /* missing */ }
if (stampVer !== labVer) {
  problems.push(`version stamp is ${stampVer || '(none)'} but lab is ${labVer || '(unknown)'}`);
}
if (stampVizVer !== labVizVer) {
  problems.push(`visualizer version stamp is ${stampVizVer || '(none)'} but lab is ${labVizVer || '(unknown)'}`);
}

if (problems.length) {
  console.error(`✗ shared/ is OUT OF SYNC with controller-core@${labVer || '?'}:`);
  for (const p of problems) console.error('  - ' + p);
  console.error('\nFix: check the lab out at the intended tag, then `npm run sync-controller-core` and commit shared/.');
  process.exit(1);
}
console.log(`✓ shared/ matches controller-core@${labVer} + controller-visualizer@${labVizVer} (stamp ${stampVer})`);
