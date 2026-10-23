// ============================================================
// ui.js — shared helpers for vendoring @usersfirst/ui
// ============================================================
//
// `shared/ui/` is a VENDORED copy of @usersfirst/ui (packages/ui/src of the
// tandemonium-controller-lab repo): the design tokens (tokens.css), the typed
// custom-element base, and every uf-* element. Same mechanism as the
// controller drivers (scripts/lib/controller-core.js): vendored + pinned to
// the lab commit, because the web build rsyncs the committed tree with
// node_modules excluded and Electron loads ESM from file://.
//
// Both sync-ui.js (refresh the copy) and check-ui.js (drift guard) use this so
// they agree on exactly which files are vendored and where the lab lives.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STAMP = 'UI_VERSION.json';

function repoRoot() { return path.join(__dirname, '..', '..'); }

/** Lab location: $CONTROLLER_LAB_DIR, else the sibling checkout (same knob as controller-core). */
function labDir() {
  return process.env.CONTROLLER_LAB_DIR || path.join(repoRoot(), '..', 'tandemonium-controller-lab');
}

function pkgDir(lab = labDir()) { return path.join(lab, 'packages', 'ui'); }
function srcDir(lab = labDir()) { return path.join(pkgDir(lab), 'src'); }
function sharedDir() { return path.join(repoRoot(), 'shared', 'ui'); }

/**
 * Relative (POSIX) paths of every vendored file: everything under the lab's
 * packages/ui/src — *.js, *.d.ts, *.css, elements/*. Discovered, not listed,
 * so a new element is vendored on the next sync instead of silently dropped.
 */
function vendoredFiles(src = srcDir()) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (/\.(js|css|d\.ts)$/.test(e.name)) out.push(rel);
    }
  };
  walk(src, '');
  return out.sort();
}

/** @usersfirst/ui package version from the lab, or null. */
function labVersion(lab = labDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir(lab), 'package.json'), 'utf8')).version || null; } catch { return null; }
}

/** Lab git provenance ({commit, ref}); nulls if git/the repo isn't available. */
function labGit(lab = labDir()) {
  const run = (cmd) => execSync(cmd, { cwd: lab, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  let commit = null, ref = null;
  try { commit = run('git rev-parse --short HEAD'); } catch { /* not a git repo */ }
  try { ref = run('git describe --tags --always'); } catch { /* no tags */ }
  return { commit, ref };
}

module.exports = { STAMP, repoRoot, labDir, pkgDir, srcDir, sharedDir, vendoredFiles, labVersion, labGit };
