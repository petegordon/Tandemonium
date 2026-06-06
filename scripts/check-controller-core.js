#!/usr/bin/env node
// ============================================================
// check-controller-core.js — guard shared/ against drift from the lab
// ============================================================
//
// Fails (exit 1) if the vendored shared/ has diverged from the pinned
// @usersfirst/controller-core source — i.e. someone hand-edited shared/
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

// 3. Provenance stamp version must match the lab's controller-core version.
const labVer = L.labVersion();
let stampVer = null;
try { stampVer = JSON.parse(fs.readFileSync(path.join(shared, L.STAMP), 'utf8')).version; } catch { /* missing */ }
if (stampVer !== labVer) {
  problems.push(`version stamp is ${stampVer || '(none)'} but lab is ${labVer || '(unknown)'}`);
}

if (problems.length) {
  console.error(`✗ shared/ is OUT OF SYNC with controller-core@${labVer || '?'}:`);
  for (const p of problems) console.error('  - ' + p);
  console.error('\nFix: check the lab out at the intended tag, then `npm run sync-controller-core` and commit shared/.');
  process.exit(1);
}
console.log(`✓ shared/ matches controller-core@${labVer} (stamp ${stampVer})`);
