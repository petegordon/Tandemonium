#!/usr/bin/env node
// smoke:phone-coop · the phone remote next to a gamepad (docs/test-script.md
// PR-06, MC-15).
//
//   PR-06  with a pad as P1, B and Start on the pad close the QR panel (a pad
//          has no Escape key); "Stop using phone" lets the phone go: the game
//          stops reading it and the phone page is told the game has left.
//   MC-15  a phone next to a pad: the first page's phone drives the same seat as
//          the pad (P1). A phone as Player 2 joins from the co-op screen
//          instead (#562): smoke:phone-multi, MC-16 / MC-17.
//
// Real pad relay under `wrangler dev` (port 8793), the game on the shared
// harness (port 8984) with a fake Xbox pad plugged in at boot, the phone page
// in its own browser (a background tab would be throttled).
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const ROOT = process.cwd();
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer');
const RELAY_PORT = 8793;
const RELAY = `ws://127.0.0.1:${RELAY_PORT}`;

// ── pad relay under wrangler dev ──
const wrangler = spawn(`npx wrangler dev --config worker/wrangler-pad.toml --port ${RELAY_PORT} --ip 127.0.0.1 --persist-to "${path.join(os.tmpdir(), 'tandemonium-smoke-phone-coop')}" --show-interactive-dev-session=false`,
  { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
let wlog = '';
wrangler.stdout.on('data', (d) => { wlog += d; });
wrangler.stderr.on('data', (d) => { wlog += d; });
const killWrangler = () => {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${wrangler.pid} /T /F`, { stdio: 'ignore' });
    else wrangler.kill('SIGTERM');
  } catch { /* gone */ }
};
process.on('exit', killWrangler);
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try { up = (await fetch(`http://127.0.0.1:${RELAY_PORT}/`)).ok; } catch { /* not yet */ }
  if (!up) await sleep(500);
}
if (!up) { console.log(wlog.slice(-2000)); killWrangler(); throw new Error('pad relay did not start'); }

const h = await startHarness({ port: 8984 });
const { check } = h;
const phoneBrowser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--mute-audio'] });

try {
  const game = await h.gamePage({
    viewport: { width: 960, height: 600 },
    storage: { tandemonium_tutorial_done: 'smoke' },
    query: `?padRelay=${encodeURIComponent(RELAY)}`,
    before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }),
  });
  const pads = fakePads(game);
  await game.waitForFunction(() => !!window.__phonePad && window.__controllerManager?.getSlot('P1').state === 'claimed', { timeout: 30000 });
  check(true, 'a pad is P1 at boot');
  const panelOpen = () => game.evaluate(() => document.getElementById('phone-pad-panel').classList.contains('open'));
  const openPanel = async () => {
    await clickId(game, 'btn-mode-phone');
    await game.waitForFunction(() => document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 30000 }).catch(() => {});
  };
  const closesOn = async (button) => {
    await openPanel();
    const opened = await panelOpen();
    await sleep(300);   // the panel ignores whatever was held as it opened; give it a poll
    await pads.hold(0, button, true);
    await game.waitForFunction(() => !document.getElementById('phone-pad-panel').classList.contains('open'), { timeout: 15000 }).catch(() => {});
    await pads.hold(0, button, false);
    const step = await game.evaluate(() => document.getElementById('lobby-flow').current);
    return { opened, closed: !(await panelOpen()), step };
  };

  // ── PR-06: B and Start close the QR panel; the menu under it stays put ──
  console.log('PR-06 pad closes the panel');
  for (const b of ['B', 'START']) {
    const r = await closesOn(b);
    check(r.opened && r.closed, `PR-06: ${b} on the pad closes the QR panel`, r);
    check(r.step === 'lobby-mode', `PR-06: ${b} doesn't also act on the menu underneath`, r.step);
  }

  // ── pair a phone ──
  await openPanel();
  await game.waitForFunction(() => window.__phonePad.status === 'waiting' && !!window.__phonePad.link, { timeout: 60000 });
  const link = await game.evaluate(() => window.__phonePad.link);
  const phone = await phoneBrowser.newPage();
  await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: false });
  // The harness serves index.html only for "/", so name the phone page's file.
  await phone.goto(link.replace('/remote/?', '/remote/index.html?'), { waitUntil: 'domcontentloaded' });
  await phone.click('#btn-connect');
  await game.waitForFunction(() => window.__phonePad.status === 'connected', { timeout: 60000 });
  check(true, 'the phone pairs while a pad is P1');
  // Stand-in sensors for the phone page.
  await phone.evaluate(() => {
    window.__tilt = 0;
    setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt }); window.dispatchEvent(e); }, 16);
  });

  /** Hold the phone's left pedal; poll until `read` matches `ok` (up to 8 s). */
  const whilePhoneHolds = async (read, ok) => {
    await phone.mouse.move(150, 250); await phone.mouse.down();
    let v;
    for (const t0 = Date.now(); Date.now() - t0 < 4000;) { v = await game.evaluate(read); if (ok(v)) break; await sleep(150); }
    await phone.mouse.up();
    return v;
  };

  // ── MC-15: a phone next to a pad ──
  console.log('MC-15 phone + pad');
  const p1Left = await whilePhoneHolds(() => window._game.input.isPressed('ArrowLeft'), (v) => v === true);
  check(p1Left === true, 'MC-15: the phone pedals the P1 seat it shares with the pad (today\'s design)', p1Left);
  const p2 = await game.evaluate(() => ({ p2Input: !!window._game.lobby._localP2InputManager, phoneOnP1: window.__phonePad.input === window._game.input }));
  check(p2.phoneOnP1, 'MC-15: the phone host is bound to P1\'s input', p2);

  // ── PR-06: "Stop using phone" lets the phone go ──
  console.log('PR-06 stop using phone');
  await openPanel();
  await clickId(game, 'btn-ppp-stop');
  await game.waitForFunction(() => window.__phonePad.status !== 'connected', { timeout: 30000 }).catch(() => {});
  const g = await game.evaluate(() => ({ status: window.__phonePad.status, panel: document.getElementById('phone-pad-panel').classList.contains('open'), remoteMenu: !!window._game.input._remoteMenu, remoteTilt: !!window._game.input._remoteTilt }));
  check(g.status !== 'connected' && !g.panel && !g.remoteMenu && !g.remoteTilt, 'PR-06: "Stop using phone" closes the panel and the game stops reading the phone', g);
  // The phone page hears that the game left.
  await phone.waitForFunction(() => !window.__pad.hostHere, { timeout: 10000 }).catch(() => {});
  const ph = await phone.evaluate(() => ({ host: window.__pad.hostHere, gone: !!window.__pad.closedForGood, status: document.getElementById('status')?.textContent || '' }));
  check(!ph.host, 'PR-06: the phone page shows the game has let it go', ph);
  // A press on the phone now does nothing in the game.
  const after = await whilePhoneHolds(() => window._game.input.isPressed('ArrowLeft'), () => false);
  check(after === false, 'PR-06: the phone no longer pedals the game', after);
  // The pad still works for the menus.
  check(await game.evaluate(() => window._game.input.gamepadConnected), 'the pad is still P1');
  await phone.close();
} catch (e) {
  check(false, 'crashed: ' + (e && e.message));
}

await phoneBrowser.close().catch(() => {});
killWrangler();
check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
