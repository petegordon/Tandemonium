#!/usr/bin/env node
// smoke:tv-playtest · #576: fixes from the TV / Steam playtest of 2026-11-04.
//
//   TP-01  Today's Road chooser: the pad's focus is on RANKED RUN (or PRACTICE
//          when the ranked run is spent), ↓ moves, B is Back, A picks PRACTICE
//          and the ride starts.
//   TP-02  Pause menu: SAFETY / AUTO SPEED are there with ON / OFF, the pad
//          reaches them, A flips the ride's setting and the menu stays open.
//   TP-03  Pause menu: every button's 3px focus ring fits inside the sheet's
//          scrolling body (it was clipped on the sides and under END RIDE).
//   TP-04  The ride's top strip reads at TV size (speed ≥ 36px at 1920).
//   TP-05  Leaderboard: full height on every filter, no video clip over it,
//          the personal tab is "My Rides".
//   TP-06  L1 / R1 tabs sit above the bike preview (their glow isn't covered).
//   TP-07  A pad with a live gyro starts with the stick OFF, unless the rider
//          set the Joystick toggle themselves.
import { startHarness } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await startHarness({ port: 8977, outDir: 'tandemonium-tv-playtest' });
const { check } = h;

const page = await h.gamePage({
  viewport: { width: 1920, height: 1080 },
  storage: { tandemonium_tutorial_done: 'smoke' },
  before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }),
});
const pads = fakePads(page);
const until = async (fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
await until(() => window._game && window._game.input && window._game.input.gamepadConnected);
await sleep(800);

// ── TP-07 · the stick default with a gyro (pure lobby logic; no real HID here) ──
const joy = await page.evaluate(() => {
  const l = window._game.lobby, inp = window._game.input;
  const keep = { active: l.joystickActive, motion: inp.motionEnabled, suppress: inp.suppressGamepadLean };
  const run = (saved) => {
    try { if (saved == null) localStorage.removeItem('tandemonium_joystick'); else localStorage.setItem('tandemonium_joystick', saved); } catch {}
    l.joystickActive = true; inp.suppressGamepadLean = false; inp.motionEnabled = true;
    l._joystickOffForGyro();
    return { active: l.joystickActive, suppress: inp.suppressGamepadLean };
  };
  const fresh = run(null), chose = run('on');
  inp.motionEnabled = false; l.joystickActive = true;
  try { localStorage.removeItem('tandemonium_joystick'); } catch {}
  l._joystickOffForGyro();
  const noGyro = { active: l.joystickActive };
  l.joystickActive = keep.active; inp.motionEnabled = keep.motion; inp.suppressGamepadLean = keep.suppress;
  return { fresh, chose, noGyro };
});
check(!joy.fresh.active && joy.fresh.suppress, 'TP-07 gyro live and no saved choice: the stick starts OFF', joy);
check(joy.chose.active && !joy.chose.suppress, 'TP-07 a rider who turned the stick ON keeps it', joy);
check(joy.noGyro.active, 'TP-07 no live gyro: the stick stays ON (something must steer)', joy);

// ── TP-06 · L1 / R1 over the preview ──
const tabs = await page.evaluate(() => {
  const z = (id) => { const el = document.getElementById(id); const cs = el && getComputedStyle(el); return cs ? { z: cs.zIndex, pos: cs.position } : null; };
  return { prev: z('bike-prev'), next: z('bike-next'), wrap: z('bike-preview-wrap') };
});
check(tabs.prev && tabs.prev.z === '2' && tabs.prev.pos === 'relative' && tabs.next.z === '2', 'TP-06 the L1 / R1 tabs stack above the bike preview', tabs);

// ── TP-05 · Leaderboard ──
await page.evaluate(() => document.getElementById('bar-leaderboard').click());
await until(() => document.getElementById('leaderboard-modal').open === true);
await sleep(400);
const lb = [];
for (const tab of ['solo', 'together', 'you', 'partners']) {
  lb.push(await page.evaluate(async (t) => {
    document.querySelector('#lb-main-tabs .lb-tab[data-tab-id="' + t + '"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('#leaderboard-modal > .uf-sheet__card').getBoundingClientRect();
    return { t, h: Math.round(card.height), vh: innerHeight, label: document.querySelector('#lb-main-tabs .lb-tab[data-tab-id="' + t + '"]').textContent };
  }, tab));
}
const heights = new Set(lb.map((r) => r.h));
check(heights.size === 1 && lb[0].h >= lb[0].vh * 0.85, 'TP-05 the leaderboard is full height on every filter', lb);
check(await page.evaluate(() => !document.getElementById('leaderboard-video')), 'TP-05 no video clip over the leaderboard');
check(lb[2].label === 'My Rides', 'TP-05 the personal tab reads "My Rides"', lb[2].label);
await h.shot(page, '1-leaderboard');
await pads.press(0, 'B', 160);
await until(() => document.getElementById('leaderboard-modal').open === false);
await sleep(400);

// ── TP-01 · Today's Road chooser ──
const focusId = () => page.evaluate(() => document.querySelector('#daily-mode-overlay .gamepad-focus')?.id || null);
const openChooser = () => page.evaluate(() => {
  const l = window._game.lobby;
  l._showStep(l.levelStep);
  l._pendingMode = 'solo';
  l._showDailyModeChooser();
});
await openChooser();
const first = await until(() => document.querySelector('#daily-mode-overlay .gamepad-focus')?.id || null, null, 3000);
const rankedOpen = await page.evaluate(() => !document.getElementById('btn-daily-ranked').disabled);
check(first === (rankedOpen ? 'btn-daily-ranked' : 'btn-daily-practice'), 'TP-01 the chooser takes the pad: focus on its first live button', { first, rankedOpen });
await h.shot(page, '2-daily-chooser');
await pads.press(0, 'DOWN', 160); await sleep(250);
const second = await focusId();
check(!!second && second !== first, 'TP-01 ↓ moves to the next choice', { first, second });
await pads.press(0, 'B', 160); await sleep(400);
check(await page.evaluate(() => !document.getElementById('daily-mode-overlay').classList.contains('visible')), 'TP-01 B is Back: the chooser closes');
await sleep(300);
await openChooser();
await until(() => !!document.querySelector('#daily-mode-overlay .gamepad-focus'), null, 3000);
for (let i = 0; i < 3 && (await focusId()) !== 'btn-daily-practice'; i++) { await pads.press(0, 'DOWN', 160); await sleep(250); }
await pads.press(0, 'A', 160);
const riding = await until(() => window._game.state === 'playing' || window._game.state === 'countdown', null, 120000);
const rideInfo = await page.evaluate(() => ({ state: window._game.state, ranked: !!window._game._rankedRunActive, chose: window._game.lobby._dailyMode }));
check(!!riding && !rideInfo.ranked, 'TP-01 A on PRACTICE starts the ride, not ranked', rideInfo);
await until(() => window._game.state === 'playing', null, 60000);
await sleep(800);

// ── TP-04 · HUD size ──
const hud = await page.evaluate(() => {
  const r = document.getElementById('speed-value').getBoundingClientRect();
  return { h: Math.round(r.height), zoom: getComputedStyle(document.getElementById('hud-dashboard')).zoom };
});
check(hud.h >= 36, 'TP-04 the speed reads at TV size (≥ 36px tall at 1920)', hud);
await h.shot(page, '3-ride-hud');

// ── TP-02 / TP-03 · the pause menu ──
await page.evaluate(() => window._game.raceManager.noteFirstPedal());
await pads.tap(0, 'START');
await until(() => !!window._game._pause, null, 10000);
await sleep(400);
const menu = await page.evaluate(() => {
  const g = window._game, sheet = document.getElementById('pause-sheet');
  const body = sheet.querySelector('.uf-sheet__body').getBoundingClientRect();
  const shown = Array.from(sheet.querySelectorAll('uf-button')).filter((b) => b.getBoundingClientRect().width > 0);
  const clipped = shown.filter((b) => {
    if (b.closest('.uf-sheet__actions')) return false;
    const r = b.getBoundingClientRect();
    return r.left - 3 < body.left - 0.5 || r.right + 3 > body.right + 0.5 || r.bottom + 3 > body.bottom + 0.5 || r.top - 3 < body.top - 0.5;
  }).map((b) => b.id);
  const label = (id) => document.getElementById(id)?.textContent.replace(/\s+/g, ' ').trim();
  return { ids: shown.map((b) => b.id), clipped, safety: label('btn-pause-safety'), speed: label('btn-pause-speed'), safetyMode: g.safetyMode, autoSpeed: g.autoSpeed };
});
check(menu.ids.includes('btn-pause-safety') && menu.ids.includes('btn-pause-speed') && /ON|OFF/.test(menu.safety) && /ON|OFF/.test(menu.speed), 'TP-02 the pause menu lists SAFETY and AUTO SPEED with ON / OFF', menu);
check(menu.clipped.length === 0, 'TP-03 no pause button\'s focus ring is clipped by the sheet', menu.clipped);
await h.shot(page, '4-pause');
const padFocus = () => page.evaluate(() => document.querySelector('#pause-sheet .gamepad-focus')?.id || null);
// Headless frames are slow mid-ride (~1-2 fps): hold each press long enough to be seen, and wait for the move.
for (let i = 0; i < 8 && (await padFocus()) !== 'btn-pause-safety'; i++) {
  const was = await padFocus();
  await pads.press(0, 'DOWN', 700);
  await until((w) => (document.querySelector('#pause-sheet .gamepad-focus')?.id || null) !== w, was, 4000);
  await sleep(300);
}
const reached = await padFocus();
await pads.press(0, 'A', 700); await until(() => window._game.safetyMode !== undefined, null, 1000); await sleep(1500);
const after = await page.evaluate(() => ({ open: !!window._game._pause, safetyMode: window._game.safetyMode,
  label: document.getElementById('btn-pause-safety').textContent.replace(/\s+/g, ' ').trim() }));
check(reached === 'btn-pause-safety' && after.open && after.safetyMode === !menu.safetyMode && after.label !== menu.safety,
  'TP-02 the pad reaches SAFETY; A flips it, the label follows, the menu stays open', { reached, before: menu.safety, after });
await h.shot(page, '5-pause-toggled');

await h.finish();
