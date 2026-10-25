#!/usr/bin/env node
// run-smokes.mjs — run the headless smokes one at a time and report each.
//
//   node scripts/run-smokes.mjs                 every smoke in SMOKES
//   node scripts/run-smokes.mjs lobby ride      just these (names without "smoke:")
//   node scripts/run-smokes.mjs --skip phone-pad,controller-overlay
//
// One at a time on purpose: several smokes share a port, and each one already
// runs a whole Chrome with software WebGL. Logs go to $SMOKE_LOG_DIR (default
// the OS temp folder). On GitHub Actions each smoke's log is a collapsible group,
// failures are ::error lines, and a table goes to the job summary.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `name` is the npm script without "smoke:" (`lobby` is plain `npm run smoke`).
export const SMOKES = [
  'lobby', 'boot', 'edition', 'ctas', 'no-media', 'tutorial', 'records', 'seed',
  'daily', 'ranked', 'ride', 'crash', 'helping-hand', 'disruptions', 'lookahead',
  'ping', 'economy', 'achievements', 'quality', 'layout', 'geese', 'physics',
  'slingshot', 'slingshot-aim', 'tourist', 'grandma', 'host-room', 'disconnect',
  'local-coop', 'versus', 'webhid', 'flows', 'steam-input', 'phone-pad',
  'controller-overlay',
];

const argv = process.argv.slice(2);
const skipArg = argv.indexOf('--skip');
const skip = new Set(skipArg >= 0 ? (argv[skipArg + 1] || '').split(',').filter(Boolean) : []);
const named = argv.filter((a, i) => !a.startsWith('--') && !(skipArg >= 0 && i === skipArg + 1));
const list = (named.length ? named : SMOKES).filter(n => !skip.has(n));

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const scriptFor = (n) => (n === 'lobby' ? 'smoke' : `smoke:${n}`);
const logDir = process.env.SMOKE_LOG_DIR || path.join(os.tmpdir(), 'tandemonium-smoke-logs');
fs.mkdirSync(logDir, { recursive: true });
const gha = !!process.env.GITHUB_ACTIONS;
const perSmokeMs = Number(process.env.SMOKE_TIMEOUT_MS || 15 * 60 * 1000);

function run(name) {
  return new Promise((resolve) => {
    const script = scriptFor(name);
    if (!pkg.scripts[script]) return resolve({ name, status: 'missing', ms: 0, log: '' });
    const t0 = Date.now();
    const child = spawn(`npm run -s ${script}`, { shell: true, env: process.env });
    let log = '';
    child.stdout.on('data', d => { log += d; });
    child.stderr.on('data', d => { log += d; });
    const timer = setTimeout(() => { log += `\n[run-smokes] timed out after ${perSmokeMs} ms\n`; child.kill('SIGKILL'); }, perSmokeMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      fs.writeFileSync(path.join(logDir, `${name}.log`), log);
      resolve({ name, status: code === 0 ? 'passed' : 'FAILED', ms, log });
    });
  });
}

const results = [];
for (const name of list) {
  if (!gha) process.stdout.write(`${name.padEnd(20)} `);
  const r = await run(name);
  results.push(r);
  const secs = (r.ms / 1000).toFixed(0) + 's';
  if (gha) {
    console.log(`::group::${name} — ${r.status} (${secs})`);
    console.log(r.log);
    console.log('::endgroup::');
    if (r.status !== 'passed') console.log(`::error::smoke ${name} ${r.status}`);
  } else {
    console.log(`${r.status.padEnd(8)} ${secs}`);
  }
}

const failed = results.filter(r => r.status !== 'passed');
const total = results.reduce((s, r) => s + r.ms, 0);
console.log(`\n${results.length - failed.length}/${results.length} smokes passed in ${(total / 60000).toFixed(1)} min. Logs: ${logDir}`);
if (failed.length) console.log('Failed: ' + failed.map(r => r.name).join(', '));
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(r => `| ${r.name} | ${r.status === 'passed' ? '✅' : '❌ ' + r.status} | ${(r.ms / 1000).toFixed(0)} s |`).join('\n');
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Smokes\n\n| smoke | result | time |\n|---|---|---|\n${rows}\n`);
}
process.exit(failed.length ? 1 : 0);
