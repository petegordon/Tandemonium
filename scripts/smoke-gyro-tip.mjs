#!/usr/bin/env node
// smoke:gyro-tip · #820 the Steam build's "best with motion control" popup, driven by a pad.
//   GT-01  Steam + Xbox pad: popup appears on the main menu, GOT IT focused, option off
//   GT-02  pad only: A on GOT IT closes it, not opted out, once per launch, back next launch
//   GT-03  pad only: up reaches the option, A turns it on, B closes, stays off next launch
//   GT-04  a gyro pad: no popup      GT-05  web build: no popup
import os from 'node:os';
import path from 'node:path';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeSteam, ELECTRON_UA } from './lib/fake-steam.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8951 });
const { check } = h;
const KEY = 'tandemonium_gyro_tip_off';
const XBOX = [{ index: 0, handle: '100', type: '3' }];
const SHOT = process.env.GYRO_TIP_SHOT || path.join(os.tmpdir(), 'gyro-tip.png');

const open = (p) => p.evaluate(() => document.getElementById('gyro-tip-sheet').open);
const waitOpen = async (p, want = true, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await open(p) === want) return true; await sleep(100); }
  return false;
};
const focused = (p) => p.evaluate(() => { const e = window._game.lobby._stepFocus.focusedEl; return e && e.id; });
const relaunch = async (p) => { await p.reload(); await p.waitForFunction(() => window._game?.lobby?._gyroTip); };
const launch = async (pad, xinput, steam = true) => {
  const page = await h.gamePage({
    viewport: { width: 1920, height: 1080 },
    ...(steam ? { userAgent: ELECTRON_UA } : {}),
    storage: { tandemonium_tutorial_done: 'smoke' },
    before: async (p) => { if (steam) await installFakeSteam(p, { gyroTip: true, xinput }); await installFakeGamepads(p); },
  });
  const pads = fakePads(page);
  const i = await pads.plug(pad);
  return { page, pads, i };
};

{
  const { page, pads, i } = await launch('xbox', XBOX);
  check(await waitOpen(page), 'GT-01 popup appears with no gyro available');
  await sleep(300);
  check(await focused(page) === 'gyro-tip-ok', 'GT-01 GOT IT has first focus', await focused(page));
  check(await page.evaluate(() => !document.getElementById('gyro-tip-never').checked), 'GT-01 option is off by default');
  await page.screenshot({ path: SHOT });
  await pads.press(i, 'A');
  check(await waitOpen(page, false), 'GT-02 A on GOT IT closes it');
  check(await page.evaluate((k) => localStorage.getItem(k), KEY) === null, 'GT-02 not opted out');
  await page.evaluate(() => { const l = window._game.lobby; l._onStepShown(l.modeStep, l.modeStep); });
  await sleep(4000);
  check(!(await open(page)), 'GT-02 once per launch');
  await relaunch(page);
  check(await waitOpen(page), 'GT-02 returns next launch');
  await page.close();
}
{
  const { page, pads, i } = await launch('xbox', XBOX);
  await waitOpen(page);
  await sleep(300);
  await pads.press(i, 'UP');
  await sleep(200);
  check(await focused(page) === 'gyro-tip-never', 'GT-03 up reaches the option', await focused(page));
  await pads.press(i, 'A');
  await sleep(200);
  check(await page.evaluate(() => document.getElementById('gyro-tip-never').checked), 'GT-03 A turns it on');
  check(await open(page), 'GT-03 popup stays open');
  await pads.press(i, 'B');
  check(await waitOpen(page, false), 'GT-03 B closes it');
  check(await page.evaluate((k) => localStorage.getItem(k), KEY) === '1', 'GT-03 choice saved');
  await relaunch(page);
  await sleep(5000);
  check(!(await open(page)), 'GT-03 stays off next launch');
  await page.close();
}
{
  const { page } = await launch('dualsense', [{ index: 0, handle: '100', type: '13' }]);
  await sleep(6000);
  check(!(await open(page)), 'GT-04 no popup with a gyro controller');
  await page.close();
}
{
  const { page } = await launch('xbox', null, false);
  await sleep(6000);
  check(!(await open(page)), 'GT-05 no popup on the web build');
  await page.close();
}
await h.finish();
