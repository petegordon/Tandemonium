#!/usr/bin/env node
// ============================================================
// sync-controller-core.js — vendor the controller drivers from the lab
// ============================================================
//
// `shared/` is a VENDORED copy of @usersfirst/controller-core
// (packages/core/src) from the tandemonium-controller-lab repo, which is
// the single source of truth for all controller drivers. The lab is where
// drivers/devices/manager/sensor-fusion are developed and tested; this
// script pulls the latest src into `shared/`, mirroring the lab's layout
// so the copied files stay byte-identical (run `git diff shared/` after to
// see exactly what changed, and `git status` to detect drift).
//
// Why vendored (not an npm dependency): Tandemonium ships with no bundler.
// The web build (GitHub Pages, .github/workflows/deploy.yml) rsyncs the
// repo and serves raw ESM with node_modules EXCLUDED, and the Electron
// build loads ESM from file://. Committed files under shared/ are the only
// thing both targets can resolve. See README / item #4 for the plan to
// pin the lab source to a published version or git tag.
//
// Usage:
//   node scripts/sync-controller-core.js
//   CONTROLLER_LAB_DIR=/path/to/tandemonium-controller-lab node scripts/sync-controller-core.js
//
// The lab is located via (in order):
//   1. $CONTROLLER_LAB_DIR
//   2. ../tandemonium-controller-lab  (sibling checkout — the default)

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const labDir = process.env.CONTROLLER_LAB_DIR
  || path.join(repoRoot, '..', 'tandemonium-controller-lab');
const srcDir = path.join(labDir, 'packages', 'core', 'src');
const sharedDir = path.join(repoRoot, 'shared');

if (!fs.existsSync(srcDir)) {
  console.error(`ERROR: controller-core source not found at ${srcDir}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}

// Top-level modules taken verbatim from the lab's package root.
const TOP_LEVEL = ['devices.js', 'manager.js', 'sensor-fusion.js', 'imu-analysis.js', 'index.js'];

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (!entry.endsWith('.js')) continue;
    fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
  }
}

// drivers/ — wipe + recopy so renamed/deleted lab drivers don't linger.
copyDir(path.join(srcDir, 'drivers'), path.join(sharedDir, 'drivers'));

// Top-level modules.
fs.mkdirSync(sharedDir, { recursive: true });
for (const f of TOP_LEVEL) {
  const from = path.join(srcDir, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(sharedDir, f));
}

// Remove the pre-migration layout if a stale checkout still has it.
fs.rmSync(path.join(sharedDir, 'controllers'), { recursive: true, force: true });
fs.rmSync(path.join(sharedDir, 'controller-manager.js'), { force: true });

console.log(`Synced controller-core from ${path.relative(repoRoot, srcDir)} → shared/`);
console.log('Review with: git status shared/ && git diff shared/');
