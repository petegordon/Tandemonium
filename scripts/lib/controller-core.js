// ============================================================
// controller-core.js — shared helpers for vendoring @usersfirst/controller-core
// ============================================================
//
// `shared/` is a VENDORED copy of @usersfirst/controller-core (the core src
// of the tandemonium-controller-lab repo), pinned to a tagged version. Both
// sync-controller-core.js (refresh the copy) and check-controller-core.js
// (drift guard) import this so they agree on exactly which files are vendored
// and where the lab lives.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Top-level modules vendored from the lab package root (drivers/*.js are
// discovered dynamically so a new/renamed driver is picked up automatically).
const TOP_LEVEL = ['devices.js', 'manager.js', 'sensor-fusion.js', 'imu-analysis.js', 'index.js'];

// Provenance file written into shared/ recording which lab version produced it.
const STAMP = 'CONTROLLER_CORE_VERSION.json';

function repoRoot() { return path.join(__dirname, '..', '..'); }

/** Lab location: $CONTROLLER_LAB_DIR, else the sibling checkout. */
function labDir() {
  return process.env.CONTROLLER_LAB_DIR || path.join(repoRoot(), '..', 'tandemonium-controller-lab');
}

function srcDir(lab = labDir()) { return path.join(lab, 'packages', 'core', 'src'); }
function sharedDir() { return path.join(repoRoot(), 'shared'); }

/**
 * Relative paths (POSIX) of the files we vendor from the lab src: every
 * drivers/*.js plus every top-level *.js. Both are DISCOVERED (not a hardcoded
 * allowlist) so a new lab module — e.g. yaw-return.js, imported by
 * sensor-fusion.js — is vendored automatically instead of being silently
 * dropped and breaking the dynamic import at runtime.
 */
function vendoredFiles(src = srcDir()) {
  const files = [];
  const drivers = path.join(src, 'drivers');
  if (fs.existsSync(drivers)) {
    for (const e of fs.readdirSync(drivers)) if (e.endsWith('.js')) files.push('drivers/' + e);
  }
  for (const e of fs.readdirSync(src)) if (e.endsWith('.js')) files.push(e);
  return files;
}

/** controller-core package version from the lab, or null. */
function labVersion(lab = labDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lab, 'packages', 'core', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

/** Lab git provenance ({commit, ref}); nulls if git/the repo isn't available. */
function labGit(lab = labDir()) {
  const run = (cmd) => execSync(cmd, { cwd: lab, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  let commit = null, ref = null;
  try { commit = run('git rev-parse --short HEAD'); } catch { /* not a git repo */ }
  try { ref = run('git describe --tags --always'); } catch { /* no tags */ }
  return { commit, ref };
}

module.exports = { TOP_LEVEL, STAMP, repoRoot, labDir, srcDir, sharedDir, vendoredFiles, labVersion, labGit };
