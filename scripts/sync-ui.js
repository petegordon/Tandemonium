#!/usr/bin/env node
// ============================================================
// sync-ui.js — vendor the UI kit (@usersfirst/ui) from the lab
// ============================================================
//
// `shared/ui/` is a VENDORED copy of packages/ui/src from the
// tandemonium-controller-lab repo: tokens.css, the typed element base and the
// uf-* elements that index.html loads. This refreshes it from the lab and
// writes a provenance stamp (UI_VERSION.json). `npm run check:ui` then guards
// against drift. Same mechanism and same pinning rule as the controller
// drivers (see sync-controller-core.js): check the lab out at the commit/tag
// you want, run this, commit shared/ui/.
//
//   npm run sync-ui
//   npm run check:ui        # verify, then git add shared/ui && commit
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.

const fs = require('fs');
const path = require('path');
const U = require('./lib/ui');

const src = U.srcDir();
if (!fs.existsSync(src)) {
  console.error(`ERROR: @usersfirst/ui source not found at ${src}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}
const shared = U.sharedDir();

// Wipe and copy every file verbatim (byte-identical to the lab — that's what
// the drift check relies on), so a renamed/deleted element doesn't linger.
fs.rmSync(shared, { recursive: true, force: true });
for (const rel of U.vendoredFiles(src)) {
  const dest = path.join(shared, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(src, rel), dest);
}

// shared/ already carries a {"type":"module"} package.json (written by
// sync-controller-core.js) that covers shared/ui/ too, so nothing to add here.

const version = U.labVersion();
const { commit, ref } = U.labGit();
fs.writeFileSync(path.join(shared, U.STAMP), JSON.stringify({
  package: '@usersfirst/ui',
  version,
  sourceCommit: commit,
  sourceRef: ref,
  syncedAt: new Date().toISOString().slice(0, 10),
}, null, 2) + '\n');

console.log(`Synced @usersfirst/ui@${version || '?'} (${ref || commit || 'unknown'}) → shared/ui/`);
console.log('Verify with: npm run check:ui   (then git add shared/ui && commit)');
