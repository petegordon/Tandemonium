#!/usr/bin/env node
// ============================================================
// sync-rooms-relay.js — vendor @usersfirst/rooms-relay from the lab
// ============================================================
//
// `shared/rooms-relay/` is a VENDORED copy of packages/rooms-relay/src from the
// tandemonium-controller-lab repo: the room relay (the Cloudflare Worker and Durable Object
// that seats a room's two connections and forwards their frames) and room-proof.js.
// worker/relay.js deploys it with Tandemonium's settings; worker/room-proof.js re-exports
// the proofs for the API. Same mechanism and pinning rule as shared/ui (scripts/sync-ui.js).
//
//   npm run sync-rooms-relay          refresh shared/rooms-relay/ and its stamp
//   npm run check:rooms-relay         fail if shared/rooms-relay/ differs from the lab (skips when
//                                  the lab isn't checked out)
//
// Lab location: $CONTROLLER_LAB_DIR, else the sibling ../tandemonium-controller-lab.

const fs = require('fs');
const path = require('path');
const U = require('./lib/ui');

const STAMP = 'ROOMS_RELAY_VERSION.json';
const lab = U.labDir();
const pkg = path.join(lab, 'packages', 'rooms-relay');
const src = path.join(pkg, 'src');
const shared = path.join(U.repoRoot(), 'shared', 'rooms-relay');
const check = process.argv.includes('--check');

if (!fs.existsSync(src)) {
  if (check) {
    console.warn(`@usersfirst/rooms-relay lab source not found at ${src} — skipping drift check.`);
    process.exit(0);
  }
  console.error(`ERROR: @usersfirst/rooms-relay source not found at ${src}`);
  console.error('Set CONTROLLER_LAB_DIR or check out tandemonium-controller-lab as a sibling directory.');
  process.exit(1);
}

const files = U.vendoredFiles(src);
const lf = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');

if (check) {
  const problems = [];
  for (const rel of files) {
    const dest = path.join(shared, rel);
    if (!fs.existsSync(dest)) problems.push(`missing in shared/rooms-relay/: ${rel}`);
    else if (lf(fs.readFileSync(path.join(src, rel))) !== lf(fs.readFileSync(dest))) problems.push(`differs from lab: shared/rooms-relay/${rel}`);
  }
  if (fs.existsSync(shared)) {
    for (const rel of U.vendoredFiles(shared)) if (!files.includes(rel)) problems.push(`stale (not in lab): shared/rooms-relay/${rel}`);
  }
  if (problems.length) {
    console.error('shared/rooms-relay/ has drifted from @usersfirst/rooms-relay:\n  ' + problems.join('\n  '));
    console.error('Edit the lab and run: npm run sync-rooms-relay');
    process.exit(1);
  }
  console.log(`shared/rooms-relay/ matches @usersfirst/rooms-relay (${files.length} files).`);
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
  package: '@usersfirst/rooms-relay',
  version,
  sourceCommit: commit,
  sourceRef: ref,
  syncedAt: new Date().toISOString().slice(0, 10),
}, null, 2) + '\n');
console.log(`Synced @usersfirst/rooms-relay@${version || '?'} (${ref || commit || 'unknown'}) → shared/rooms-relay/`);
