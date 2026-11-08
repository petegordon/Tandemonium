#!/usr/bin/env node
// smoke:steam-input · the desktop app under Steam, with Steam faked
// (scripts/lib/fake-steam.mjs stands in for electron/preload.js). Covers
// docs/test-script.md IN-19.
//
// The game runs in Steam's emulation mode (no action manifest): a controller
// Steam captures reaches the game as a virtual XInput pad, and the Steam
// layout routes its gyro onto the left stick (docs/steam-input.md).
//
//   IN-19  two Steam Controllers under Steam (two virtual XInput pads, gyro on
//          the left stick): tilting the controller on the desk doesn't take
//          Player 1; the one you press on is P1 and its D-pad moves the menu focus
//   IN-21  #499: Stick steering Off doesn't zero a Steam-only Steam
//          Controller's lean (its gyro arrives on the stick); it still zeroes
//          a real Xbox pad's stick
import { startHarness, sleep, waitState } from './lib/smoke-harness.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8966, outDir: 'tandemonium-steam-input' });
const { check } = h;

// ── IN-19: two Steam Controllers — the one you press is Player 1 ──
console.log('IN-19 two Steam Controllers');
{
  const page = await h.gamePage({
    userAgent: ELECTRON_UA, storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => {
      await installFakeSteam(p, { xinput: [{ index: 0, handle: '100', type: '14' }, { index: 1, handle: '101', type: '14' }] });
      await installFakeGamepads(p, { atBoot: ['xbox', 'xbox'] });
    },
  });
  const pads = fakePads(page);
  const seat = () => page.evaluate(() => ({
    p1: window.__controllerManager.getSlot('P1').state,
    p1Index: window.__controllerManager.getSlot('P1').gamepadIndex,
    focus: document.querySelector('.gamepad-focus')?.id || '',
  }));
  await page.waitForFunction(() => !!document.getElementById('btn-solo'), { timeout: 15000 });
  await sleep(1500);
  // The controller on the desk gets bumped: its gyro swings the stick.
  await pads.stick(1, 'LX', 0.3); await sleep(300);
  await pads.stick(1, 'LX', -0.2); await sleep(300);
  await pads.stick(1, 'LX', 0); await sleep(300);
  let s = await seat();
  check(s.p1 === 'empty', 'IN-19 tilting a second Steam Controller does not take Player 1', s);
  await pads.tap(0, 'A'); await sleep(600);
  s = await seat();
  check(s.p1 === 'claimed' && s.p1Index === 0, 'IN-19 the controller you press on is Player 1', s);
  const from = s.focus;
  await pads.tap(0, 'DOWN');
  const moved = await page.waitForFunction((f) => (document.querySelector('.gamepad-focus')?.id || '') !== f, { timeout: 8000, polling: 100 }, from).then(() => true).catch(() => false);
  check(moved, 'IN-19 its D-pad moves the menu focus', { from, to: (await seat()).focus });
  await page.close();
}

// ── IN-21: Stick steering Off keeps Steam's gyro (#499) ──
console.log('IN-21 Stick steering Off vs Steam gyro');
for (const [type, label, wantLean] of [['14', 'Steam Controller (Steam only)', true], ['3', 'Xbox pad under Steam', false]]) {
  const page = await h.gamePage({
    userAgent: ELECTRON_UA, storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => {
      await installFakeSteam(p, { xinput: [{ index: 0, handle: '100', type }] });
      await installFakeGamepads(p, { atBoot: ['xbox'] });
    },
  });
  const pads = fakePads(page);
  await page.waitForFunction(() => !!document.getElementById('btn-solo'), { timeout: 15000 });
  await sleep(800);
  await pads.tap(0, 'A'); await sleep(400);
  await page.evaluate(() => { window._game.input.suppressGamepadLean = true; });
  await pads.stick(0, 'LX', 0.7);
  const r = await page.waitForFunction(() => {
    const im = window._game.input;
    im.pollGamepad();
    return im._slot && im._slot.state === 'claimed' ? { lean: im.getGamepadLean(), steamGyro: im.stickIsSteamGyro } : null;
  }, { timeout: 8000, polling: 100 }).then((x) => x.jsonValue()).catch(() => null);
  await pads.stick(0, 'LX', 0);
  if (wantLean) check(!!r && r.steamGyro && Math.abs(r.lean) > 0.1, `IN-21 ${label}: Stick steering Off keeps its gyro lean`, r);
  else check(!!r && !r.steamGyro && r.lean === 0, `IN-21 ${label}: Stick steering Off zeroes its stick`, r);
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
