#!/usr/bin/env node
// ============================================================
// check-ui.js — guard shared/ui/ against drift from the lab
// ============================================================
//
// Fails (exit 1) if the vendored shared/ui/ has diverged from the pinned
// @usersfirst/ui source — someone hand-edited shared/ui/ instead of editing
// the lab + re-syncing, or shared/ui/ is stale vs the lab checkout.
// Non-mutating. Requires the lab (sibling checkout or $CONTROLLER_LAB_DIR);
// skips with a notice if absent so environments that only build from the
// committed copy keep working.
//
//   npm run check:ui

const fs = require('fs');
const path = require('path');
const U = require('./lib/ui');

const src = U.srcDir();
if (!fs.existsSync(src)) {
  console.warn(`@usersfirst/ui lab source not found at ${src} — skipping drift check.`);
  console.warn('(shared/ui/ is committed and self-contained; this guard only runs where the lab is checked out.)');
  process.exit(0);
}

const shared = U.sharedDir();
const expected = U.vendoredFiles(src);
const problems = [];

// 1. Every vendored file must exist in shared/ui/ and be byte-identical to the lab.
for (const rel of expected) {
  const dest = path.join(shared, rel);
  if (!fs.existsSync(dest)) { problems.push(`missing in shared/ui/: ${rel}`); continue; }
  // Compare with line endings normalised: a Windows checkout with core.autocrlf
  // rewrites the vendored text files to CRLF while the lab keeps LF, and that
  // is not drift. (.gitattributes pins shared/ui to LF going forward.)
  const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
  if (lf(fs.readFileSync(path.join(src, rel))) !== lf(fs.readFileSync(dest))) problems.push(`differs from lab: shared/ui/${rel}`);
}

// 2. Nothing stale in shared/ui/ that the lab no longer has (the stamp is ours).
if (fs.existsSync(shared)) {
  const actual = U.vendoredFiles(shared);
  for (const rel of actual) if (!expected.includes(rel)) problems.push(`stale (not in lab): shared/ui/${rel}`);
}

// 3. Provenance stamp version must match the lab's package version.
const labVer = U.labVersion();
let stampVer = null;
try { stampVer = JSON.parse(fs.readFileSync(path.join(shared, U.STAMP), 'utf8')).version; } catch { problems.push(`missing or unreadable shared/ui/${U.STAMP}`); }
if (labVer && stampVer && labVer !== stampVer) problems.push(`${U.STAMP} says ${stampVer} but the lab is ${labVer} — re-run npm run sync-ui`);

if (problems.length) {
  console.error('shared/ui/ has drifted from @usersfirst/ui:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nFix: edit the lab, then `npm run sync-ui` and commit shared/ui/. Never hand-edit shared/ui/.');
  process.exit(1);
}
console.log(`shared/ui/ matches @usersfirst/ui@${labVer || '?'} (${expected.length} files).`);
