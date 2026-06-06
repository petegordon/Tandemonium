#!/usr/bin/env node
// ============================================================
// sync-controller-core.js — vendor the controller drivers from the lab
// ============================================================
//
// `shared/` is a VENDORED copy of @usersfirst/controller-core
// (packages/core/src) from the tandemonium-controller-lab repo — the single
// source of truth for all controller drivers. This refreshes shared/ from the
// lab and writes a provenance stamp (CONTROLLER_CORE_VERSION.json) recording
// which version/commit produced it. `npm run check:controller-core` then
// guards against drift.
//
// Dependency mechanism (item #4): vendored + git-tag-pinned. Tandemonium ships
// with no bundler — the web build (GitHub Pages) rsyncs the repo and serves raw
// ESM with node_modules EXCLUDED, and Electron loads ESM from file://, so the
// committed files under shared/ are the only thing both targets can resolve.
// The lab is pinned by TAG, not a moving checkout: to update, check the lab out
// at the desired tag, run this, and commit.
//
//   git -C ../tandemonium-controller-lab checkout core-v0.1.0
//   npm run sync-controller-core
//   npm run check:controller-core   # verify, then commit shared/
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.

const fs = require('fs');
const path = require('path');
const L = require('./lib/controller-core');

const src = L.srcDir();
if (!fs.existsSync(src)) {
  console.error(`ERROR: controller-core source not found at ${src}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}
const shared = L.sharedDir();

// Wipe drivers/ so renamed/deleted lab drivers don't linger, then copy every
// vendored file verbatim (byte-identical to the lab — that's what the drift
// check relies on).
fs.rmSync(path.join(shared, 'drivers'), { recursive: true, force: true });
fs.mkdirSync(shared, { recursive: true });
for (const rel of L.vendoredFiles(src)) {
  const dest = path.join(shared, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(src, rel), dest);
}

// Remove the pre-migration layout if a stale checkout still has it.
fs.rmSync(path.join(shared, 'controllers'), { recursive: true, force: true });
fs.rmSync(path.join(shared, 'controller-manager.js'), { force: true });

// Provenance stamp.
const version = L.labVersion();
const { commit, ref } = L.labGit();
const stamp = {
  package: '@usersfirst/controller-core',
  version,
  sourceCommit: commit,
  sourceRef: ref,
  syncedAt: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(shared, L.STAMP), JSON.stringify(stamp, null, 2) + '\n');

console.log(`Synced controller-core@${version || '?'} (${ref || commit || 'unknown'}) → shared/`);
console.log('Verify with: npm run check:controller-core   (then git add shared/ && commit)');
