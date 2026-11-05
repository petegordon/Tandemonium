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

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
