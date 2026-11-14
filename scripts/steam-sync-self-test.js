#!/usr/bin/env node
/**
 * Steam achievement sync self-test: does upload → Save → verify still work?
 *
 *   node scripts/steam-sync-self-test.js [appId] [API_NAME]     (default FIRST_500M)
 *
 * Runs scripts/sync-steam-achievements.js twice:
 *   1. with STEAM_SYNC_TEST_MARK=API_NAME, so that achievement's description gets
 *      " [sync test]" appended; the sync must save it and verify
 *   2. without it, putting the real text back; the sync must save and verify again
 * Use it after Valve changes the Steamworks page. Nothing reaches players without Publish.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const appId = args.find(a => /^\d+$/.test(a));
const api = args.find(a => /^[A-Z][A-Z0-9_]+$/.test(a)) || 'FIRST_500M';
const sync = path.join(__dirname, 'sync-steam-achievements.js');

function run(step, env) {
  console.log(`\n=== Self-test ${step} ===`);
  const r = spawnSync(process.execPath, [sync, ...(appId ? [appId] : []), '--no-icons'], {
    env: { ...process.env, ...env }, encoding: 'utf-8', stdio: ['inherit', 'pipe', 'inherit'],
  });
  process.stdout.write(r.stdout || '');
  return r.status === 0 && /Verified: Steam matches the code/.test(r.stdout || '');
}

const env1 = { STEAM_SYNC_TEST_MARK: api };
const env2 = { STEAM_SYNC_TEST_MARK: '' };
if (!run(`1/2: mark ${api}`, env1)) {
  console.error(`\nSelf-test FAILED at step 1 (mark ${api}). Steam may be unchanged or half-saved; run the sync again.`);
  process.exit(1);
}
if (!run(`2/2: put ${api} back`, env2)) {
  console.error(`\nSelf-test FAILED at step 2. ${api} may still say "[sync test]"; run the sync again.`);
  process.exit(1);
}
console.log('\nSelf-test PASSED: upload, Save and verify all work. Steam matches the code again.');
