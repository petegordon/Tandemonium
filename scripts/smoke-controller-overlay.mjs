#!/usr/bin/env node
// ============================================================
// smoke-controller-overlay.mjs — headless check of the controller overlay HUD
// ============================================================
//
// Drives test/controller-overlay.html through every scenario in headless
// Chromium (Playwright) and asserts, for each: the expected tiles exist with
// the expected corners, every gamepad tile loaded its GLB (the visualizer's
// model is up), no two tiles overlap, and no tile covers a front view / PiP /
// pedal bar stand-in. Screenshots land in $SMOKE_OUT (default: ./out/smoke).
//
// Needs: a local three (npm i --no-save three@0.161.0 — the sandbox can't
// reach the CDN), Playwright resolvable from node, and a static server for
// the repo root — this script starts `python3 -m http.server` itself.
//
//   node scripts/smoke-controller-overlay.mjs

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(process.env.NPM_GLOBAL_ROOT || '/opt/node22/lib/node_modules', 'playwright'))); }

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.SMOKE_PORT || 8899);
const OUT = process.env.SMOKE_OUT || path.join(ROOT, 'out', 'smoke');
mkdirSync(OUT, { recursive: true });

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

// P2 in the harness is the Steam case: an XInput gamepad id with a real
// DualSense bound over WebHID — it must resolve to the DualSense, not Xbox.
const P2 = { profile: 'dualsense', name: 'Sony DualSense · WebHID' };
const SCENARIOS = {
  solo:   { tiles: [{ label: 'P1', anchor: 'br', kind: 'gamepad', profile: 'dualsense' }] },
  // Steam owns the DualSense exclusively: no slot at all, identity + buttons +
  // gyro come from the seat's InputManager. Must be a DualSense tile, not a
  // keyboard placeholder.
  steam:  { tiles: [{ label: 'P1', anchor: 'br', kind: 'gamepad', profile: 'dualsense', name: 'DualSense · Steam' }] },
  local:  { tiles: [{ label: 'P1', anchor: 'br', kind: 'gamepad' }, { label: 'P2', anchor: 'bl', kind: 'gamepad', ...P2 }] },
  // The laptop case: P1 Steam Controller over WebHID, P2 DualSense captured by
  // Steam with an idle Puck sibling wrongly attached to its slot. P2 must be a
  // DualSense fed by Steam; P1 a Steam Controller fed by WebHID.
  // Emulation mode: empty Steam snapshot, two identical XInput pads; the
  // XInput-slot map names the DualSense (slot 1) — never "Xbox".
  'steam-xinput': { tiles: [
    { label: 'P1', anchor: 'br', kind: 'gamepad', profile: 'steam-controller', name: 'Steam Controller 2026 (via Puck) · WebHID' },
    { label: 'P2', anchor: 'bl', kind: 'gamepad', profile: 'dualsense', name: 'DualSense · Steam' },
  ] },
  'steam-p2': { tiles: [
    { label: 'P1', anchor: 'br', kind: 'gamepad', profile: 'steam-controller', name: 'Steam Controller 2026 (via Puck) · WebHID' },
    { label: 'P2', anchor: 'bl', kind: 'gamepad', profile: 'dualsense', name: 'DualSense · Steam' },
  ] },
  lobby:  { tiles: [{ label: 'P1', anchor: 'br' }, { label: 'P2', anchor: 'br', ...P2 }, { label: 'P3', anchor: 'br', profile: 'switch-pro' }, { label: 'P4', anchor: 'br', profile: 'steam-controller' }] },
  versus: { tiles: [
    { label: 'TEAM BLUE', seat: 'P1', anchor: 'bl', kind: 'gamepad' }, { label: 'TEAM BLUE', seat: 'P2', anchor: 'bl', kind: 'gamepad', ...P2 },
    { label: 'TEAM RED', seat: 'P3', anchor: 'br', kind: 'gamepad' },  { label: 'TEAM RED', seat: 'KEYBOARD', anchor: 'br', kind: 'keyboard' },
  ] },
};
const OBSTACLE_SETS = [[], ['frontview'], ['frontview', 'pedals'], ['frontview', 'pip', 'pedals']];

const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const failures = [];
const note = (ok, msg) => { console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`); if (!ok) failures.push(msg); };

let browser;
try {
  browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/test/controller-overlay.html?three=/node_modules/three/`, { waitUntil: 'load' });

  for (const [name, expect] of Object.entries(SCENARIOS)) {
    console.log(`\n▶ ${name}`);
    await page.evaluate((n) => window.__setScenario(n), name);
    await page.evaluate(() => window.__settle()); // let the roster reconcile before counting
    // Wait for the next frames to apply the roster, then for every gamepad
    // tile to have its model (GLB fetched + parsed).
    await page.waitForFunction((n) => {
      const tiles = window.__tiles();
      return tiles.length === n && tiles.every((t) => t.kind !== 'gamepad' || t.hasModel);
    }, expect.tiles.length, { timeout: 30000 })
      .catch(() => note(false, `${name}: expected ${expect.tiles.length} tiles with models within 30s`));
    const tiles = await page.evaluate(() => window.__tiles());
    note(tiles.length === expect.tiles.length, `${name}: ${tiles.length} tiles (expected ${expect.tiles.length})`);
    for (const ex of expect.tiles) {
      const t = tiles.find((x) => x.label === ex.label && (ex.seat === undefined || x.seat === ex.seat));
      note(!!t, `${name}: tile ${ex.label} ${ex.seat || ''} present`);
      if (!t) continue;
      note(t.anchor === ex.anchor, `${name}: ${ex.label} ${ex.seat || ''} anchored ${t.anchor} (expected ${ex.anchor})`);
      if (ex.kind) note(t.kind === ex.kind, `${name}: ${ex.label} ${ex.seat || ''} kind ${t.kind}`);
      if (t.kind === 'gamepad') note(t.hasModel, `${name}: ${ex.label} ${ex.seat || ''} loaded model (${t.profile})`);
      if (t.kind === 'gamepad') note(t.finiteQuat, `${name}: ${ex.label} ${ex.seat || ''} body orientation is finite`);
      if (ex.profile) note(t.profile === ex.profile, `${name}: ${ex.label} ${ex.seat || ''} profile ${t.profile} (expected ${ex.profile})`);
      if (ex.name) note(t.name === ex.name, `${name}: ${ex.label} ${ex.seat || ''} named "${t.name}" (expected "${ex.name}")`);
    }
    await page.waitForTimeout(600);
    for (const t of await page.evaluate(() => window.__tiles())) {
      if (t.kind === 'gamepad') note(t.finiteQuat, `${name}: ${t.label} ${t.seat || ''} orientation still finite after animating`);
    }
    for (const set of OBSTACLE_SETS) {
      for (const k of ['frontview', 'pip', 'pedals']) await page.evaluate(([k, on]) => window.__setObstacle(k, on), [k, set.includes(k)]);
      await page.waitForTimeout(400); // > LAYOUT_INTERVAL_MS so the tiles re-measure
      const rects = await page.evaluate(() => window.__tiles().map((t) => ({ id: `${t.label} ${t.seat}`.trim(), ...t.rect, right: t.rect.left + t.rect.width, bottom: t.rect.top + t.rect.height })));
      const obs = await page.evaluate(() => window.__obstacles());
      const tag = set.length ? set.join('+') : 'no obstacles';
      let clean = true;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i], rects[j])) { clean = false; note(false, `${name} [${tag}]: ${rects[i].id} overlaps ${rects[j].id}`); }
        for (const o of obs) if (overlaps(rects[i], o)) { clean = false; note(false, `${name} [${tag}]: ${rects[i].id} covers ${o.id}`); }
        const onScreen = rects[i].left >= 0 && rects[i].top >= 0 && rects[i].right <= 1280 && rects[i].bottom <= 720;
        if (!onScreen) { clean = false; note(false, `${name} [${tag}]: ${rects[i].id} off-screen ${JSON.stringify(rects[i])}`); }
      }
      if (clean) note(true, `${name} [${tag}]: no overlaps, all on-screen`);
      await page.screenshot({ path: path.join(OUT, `${name}-${set.join('-') || 'plain'}.png`) });
    }
  }

  // Toggle off must dispose every tile; toggle on must rebuild.
  await page.evaluate(() => window.__hud.setEnabled(false, { persist: false }));
  note((await page.evaluate(() => window.__tiles().length)) === 0, 'disabled: all tiles disposed');
  await page.evaluate(() => window.__hud.setEnabled(true, { persist: false }));
  await page.waitForFunction(() => window.__tiles().length > 0 && window.__tiles().every((t) => t.kind !== 'gamepad' || t.hasModel), null, { timeout: 30000 })
    .catch(() => note(false, 're-enable: tiles did not come back'));
  note(true, 're-enable: tiles rebuilt');

  const real = consoleErrors.filter((e) => !/favicon/i.test(e));
  note(real.length === 0, `console errors: ${real.length}${real.length ? '\n    ' + real.join('\n    ') : ''}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

console.log(`\nScreenshots: ${OUT}`);
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll checks passed');
