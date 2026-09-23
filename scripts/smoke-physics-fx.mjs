#!/usr/bin/env node
// ============================================================
// smoke-physics-fx.mjs — headless check of the Rapier sidecar (issue #388)
// ============================================================
//
// Drives test/physics-smoke.html through headless Chromium and fails the
// process on any assertion that didn't pass. Exercises the solver wiring on
// its own — no WebGL, no game, no GLB — because that is the part of this
// feature that can't be verified by reading it: the Rapier API surface, the
// per-body ground patches, the collision-group isolation between them, the
// body lifecycle, and the fail-open behaviour when physics isn't there.
//
// Needs a local three and playwright (the sandbox can't reach the CDN):
//
//   npm i --no-save three@0.161.0 playwright
//   node scripts/smoke-physics-fx.mjs
//
// The page falls back to vendor/rapier.mjs when the CDN is unreachable, so
// offline runs work once `npm run download-vendors` has been done.

import { spawn } from 'node:child_process';
import process from 'node:process';

const PORT = process.env.SMOKE_PORT || 8971;
const URL = `http://127.0.0.1:${PORT}/test/physics-smoke.html`;
const TIMEOUT_MS = 120000;

function serve() {
  const p = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    stdio: 'ignore',
  });
  return p;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(URL, { method: 'HEAD' });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up on :${PORT}`);
}

async function main() {
  const { chromium } = await import('playwright');
  const server = serve();
  let browser;
  try {
    await waitForServer();
    // CHROMIUM_PATH lets a machine whose preinstalled Chromium doesn't match
    // the playwright build point at it directly, rather than downloading a
    // second copy.
    browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    );
    const page = await browser.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__done === true', null, { timeout: TIMEOUT_MS });

    const results = await page.evaluate('window.__results');
    let failed = 0;
    for (const r of results) {
      const tag = r.pass ? '  ok  ' : ' FAIL ';
      console.log(`${tag} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
      if (!r.pass) failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);

    // The CDN being blocked is expected in a sandbox and is exactly the
    // fallback the loader exists for — only surface errors beyond that.
    const realErrors = consoleErrors.filter((e) =>
      !/cdn\.jsdelivr\.net|Failed to load resource|ERR_|net::/i.test(e));
    if (realErrors.length) {
      console.log('\nunexpected console errors:');
      for (const e of realErrors) console.log('  ' + e);
      failed += realErrors.length;
    }

    process.exitCode = failed ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
