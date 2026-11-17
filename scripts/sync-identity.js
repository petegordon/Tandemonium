#!/usr/bin/env node
// ============================================================
// sync-identity.js — vendor @usersfirst/identity from the lab
// ============================================================
//
// `shared/identity/` is a VENDORED copy of packages/identity/src from the
// tandemonium-controller-lab repo: the House Tandem sign-in client (the session, redirect
// and device sign-in, linking, the combine question, notices), its wording, and the
// uf-* account elements. js/auth.js is built on it. Same mechanism and pinning rule as
// shared/ui (scripts/sync-ui.js): check the lab out at the commit or tag you want, run
// this, commit shared/identity/.
//
//   npm run sync-identity          refresh shared/identity/ and its stamp
//   npm run check:identity         fail if shared/identity/ differs from the lab (skips when
//                                  the lab isn't checked out)
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.

const fs = require('fs');
const path = require('path');
const U = require('./lib/ui');

const STAMP = 'IDENTITY_VERSION.json';
const lab = U.labDir();
const pkg = path.join(lab, 'packages', 'identity');
const src = path.join(pkg, 'src');
const shared = path.join(U.repoRoot(), 'shared', 'identity');
const check = process.argv.includes('--check');

if (!fs.existsSync(src)) {
  if (check) {
    console.warn(`@usersfirst/identity lab source not found at ${src} — skipping drift check.`);
    process.exit(0);
  }
  console.error(`ERROR: @usersfirst/identity source not found at ${src}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}

const files = U.vendoredFiles(src);
const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

if (check) {
  const problems = [];
  for (const rel of files) {
    const dest = path.join(shared, rel);
    if (!fs.existsSync(dest)) problems.push(`missing in shared/identity/: ${rel}`);
    else if (lf(fs.readFileSync(path.join(src, rel))) !== lf(fs.readFileSync(dest))) problems.push(`differs from lab: shared/identity/${rel}`);
  }
  if (fs.existsSync(shared)) {
    for (const rel of U.vendoredFiles(shared)) if (!files.includes(rel)) problems.push(`stale (not in lab): shared/identity/${rel}`);
  }
  if (problems.length) {
    console.error('shared/identity/ has drifted from @usersfirst/identity:\n  ' + problems.join('\n  '));
    console.error('Edit the lab and run: npm run sync-identity');
    process.exit(1);
  }
  console.log(`shared/identity/ matches @usersfirst/identity (${files.length} files).`);
  process.exit(0);
}

// Wipe and copy every file verbatim, so a renamed or deleted file doesn't linger.
fs.rmSync(shared, { recursive: true, force: true });
for (const rel of files) {
  const dest = path.join(shared, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(src, rel), dest);
}
let version = null;
try { version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version || null; } catch { /* no manifest */ }
const { commit, ref } = U.labGit(lab);
fs.writeFileSync(path.join(shared, STAMP), JSON.stringify({
  package: '@usersfirst/identity',
  version,
  sourceCommit: commit,
  sourceRef: ref,
  syncedAt: new Date().toISOString().slice(0, 10),
}, null, 2) + '\n');
console.log(`Synced @usersfirst/identity@${version || '?'} (${ref || commit || 'unknown'}) → shared/identity/`);
