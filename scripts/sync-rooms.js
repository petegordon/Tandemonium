#!/usr/bin/env node
// ============================================================
// sync-rooms.js — vendor @usersfirst/rooms from the lab
// ============================================================
//
// `shared/rooms/` is a VENDORED copy of packages/rooms/src from the
// tandemonium-controller-lab repo: the room transport (a two-seat room over the relay, the
// PeerJS P2P upgrade and its fallback, reconnect, the keepalive, media calls).
// js/net/room-transport.js passes it Tandemonium's settings. Same mechanism and pinning rule
// as shared/ui (scripts/sync-ui.js): check the lab out at the commit or tag you want, run
// this, commit shared/rooms/.
//
//   npm run sync-rooms          refresh shared/rooms/ and its stamp
//   npm run check:rooms         fail if shared/rooms/ differs from the lab (skips when
//                                  the lab isn't checked out)
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.

const fs = require('fs');
const path = require('path');
const U = require('./lib/ui');

const STAMP = 'ROOMS_VERSION.json';
const lab = U.labDir();
const pkg = path.join(lab, 'packages', 'rooms');
const src = path.join(pkg, 'src');
const shared = path.join(U.repoRoot(), 'shared', 'rooms');
const check = process.argv.includes('--check');

if (!fs.existsSync(src)) {
  if (check) {
    console.warn(`@usersfirst/rooms lab source not found at ${src} — skipping drift check.`);
    process.exit(0);
  }
  console.error(`ERROR: @usersfirst/rooms source not found at ${src}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}

const files = U.vendoredFiles(src);
const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

if (check) {
  const problems = [];
  for (const rel of files) {
    const dest = path.join(shared, rel);
    if (!fs.existsSync(dest)) problems.push(`missing in shared/rooms/: ${rel}`);
    else if (lf(fs.readFileSync(path.join(src, rel))) !== lf(fs.readFileSync(dest))) problems.push(`differs from lab: shared/rooms/${rel}`);
  }
  if (fs.existsSync(shared)) {
    for (const rel of U.vendoredFiles(shared)) if (!files.includes(rel)) problems.push(`stale (not in lab): shared/rooms/${rel}`);
  }
  if (problems.length) {
    console.error('shared/rooms/ has drifted from @usersfirst/rooms:\n  ' + problems.join('\n  '));
    console.error('Edit the lab and run: npm run sync-rooms');
    process.exit(1);
  }
  console.log(`shared/rooms/ matches @usersfirst/rooms (${files.length} files).`);
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
  package: '@usersfirst/rooms',
  version,
  sourceCommit: commit,
  sourceRef: ref,
  syncedAt: new Date().toISOString().slice(0, 10),
}, null, 2) + '\n');
console.log(`Synced @usersfirst/rooms@${version || '?'} (${ref || commit || 'unknown'}) → shared/rooms/`);
