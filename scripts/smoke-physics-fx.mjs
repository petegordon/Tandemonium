#!/usr/bin/env node
// ============================================================
// smoke-physics-fx.mjs — headless check of the Rapier sidecar (issue #388)
// ============================================================
//
// Drives test/physics-smoke.html through headless Chrome and fails the
// process on any assertion that didn't pass. Exercises the solver wiring on
// its own — no WebGL, no game, no GLB — because that is the part of this
// feature that can't be verified by reading it: the Rapier API surface, the
// per-body ground patches, the collision-group isolation between them, the
// body lifecycle, and the fail-open behaviour when physics isn't there.
//
// Puppeteer + the shared harness server (no python, no playwright). Rapier
// loads from the jsDelivr CDN (the page's own fallback is vendor/rapier.mjs
// after `npm run download-vendors`), so this smoke needs the network.
import { startHarness } from './lib/smoke-harness.mjs';

const TIMEOUT_MS = 120000;
const h = await startHarness({ port: Number(process.env.SMOKE_PORT || 8971) });

const page = await h.browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto(`${h.origin}/test/physics-smoke.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__done === true', { timeout: TIMEOUT_MS });

const results = await page.evaluate('window.__results');
for (const r of results) h.check(r.pass, `${r.name}${r.detail ? `  — ${r.detail}` : ''}`);

// A blocked CDN is exactly the fallback the loader exists for — only surface
// errors beyond that.
const realErrors = consoleErrors.filter((e) => !/cdn\.jsdelivr\.net|Failed to load resource|ERR_|net::/i.test(e));
h.check(realErrors.length === 0, 'no unexpected console errors', realErrors);
await h.finish();
