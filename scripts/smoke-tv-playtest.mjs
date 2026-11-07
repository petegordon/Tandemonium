#!/usr/bin/env node
// smoke:tv-playtest · #576: fixes from the TV / Steam playtest of 2026-11-04.
//
//   TP-01  #641 Daily Ride: no practice / ranked chooser; with the Daily card
//          picked, A on START RIDE starts the ride directly.
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
//   TP-08  #578 Help: no Video / Audio / achievement list; L3 or R3; ALL and ? badges
//          sized like the others; Steam shows only "use your phone as a controller".
//   TP-09  #578 the geese lean 2.5× the input (visual only), capped at a full lean.
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

// ── TP-08 · Help (#578) ──
await page.evaluate(() => window._game.lobby._openHelp());
await until(() => document.getElementById('help-modal').open === true, null, 5000);
await sleep(400);
const help = await page.evaluate(() => {
  const m = document.getElementById('help-modal');
  const names = Array.from(m.querySelectorAll('.help-toggle-name')).map((e) => e.textContent.trim());
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  const svg = m.querySelector('.help-toggle-row svg'), all = m.querySelector('.help-icon-all'), q = Array.from(m.querySelectorAll('span.help-icon')).find((e) => e.textContent.trim() === '?');
  const fs = (el) => parseFloat(getComputedStyle(el).fontSize);
  const phoneRow = Array.from(m.querySelectorAll('.help-toggle-row')).find((r) => /Use your phone as a controller/.test(r.textContent));
  const webRows = Array.from(m.querySelectorAll('.help-web-only'));
  const webShown = webRows.filter((r) => r.getBoundingClientRect().height > 0).length;
  document.documentElement.classList.add('desktop-app');
  const webShownDesktop = webRows.filter((r) => r.getBoundingClientRect().height > 0).length;
  const phoneShownDesktop = !!phoneRow && phoneRow.getBoundingClientRect().height > 0;
  document.documentElement.classList.remove('desktop-app');
  return { names, achList: !!m.querySelector('.help-achievement-list'), recal: /L3 or R3/.test(m.textContent) && !/Press L3 to recalibrate/.test(m.textContent),
    svg: box(svg), all: box(all), q: box(q), allPx: fs(all), qPx: fs(q), webRows: webRows.length, webShown, webShownDesktop, phoneShownDesktop };
});
check(!help.names.includes('Video') && !help.names.includes('Audio') && !help.achList, 'TP-08 Help has no Video / Audio rows and no achievement list', { names: help.names, achList: help.achList });
check(help.recal, 'TP-08 Help says a stick click (L3 or R3) recalibrates');
check(help.all.w === help.svg.w && help.q.w === help.svg.w && help.allPx >= 16 && help.qPx >= 20, 'TP-08 the ALL and ? badges match the icon badges and read at TV size', { svg: help.svg, all: help.all, q: help.q, allPx: help.allPx, qPx: help.qPx });
check(help.webRows >= 2 && help.webShown === help.webRows && help.webShownDesktop === 0 && help.phoneShownDesktop, 'TP-08 the Steam app shows "Use your phone as a controller" and hides the play-on-your-phone rows', help);
await h.shot(page, '0-help');
await pads.press(0, 'B', 160);
await until(() => document.getElementById('help-modal').open === false, null, 3000);
await sleep(300);

// ── TP-09 · the geese's lean reads bigger (#578, visual only) ──
const lean = await page.evaluate(() => {
  const b = window._game.bike; b.setRiderLeans(0.2, -0.2);
  const out = { cap: b._captainLeanTarget, sto: b._stokerLeanTarget };
  b.setRiderLeans(0.9, 0); out.capan = b._captainLeanTarget; b.setRiderLeans(0, 0);
  return out;
});
check(Math.abs(lean.cap - 0.5) < 1e-9 && Math.abs(lean.sto + 0.5) < 1e-9 && lean.capan === 1, 'TP-09 a 0.2 input leans the geese 0.5 (2.5×), capped at a full lean', lean);

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

// ── TP-01 · Daily Ride: START RIDE starts it (#641: no practice / ranked chooser) ──
await page.evaluate(() => {
  const l = window._game.lobby;
  l._pendingMode = 'solo';
  l._showStep(l.levelStep);
});
await until(() => !!document.querySelector('#lobby-level .level-card[data-level-id="daily"]'), null, 5000);
const picked = await page.evaluate(() => {
  document.querySelector('#lobby-level .level-card[data-level-id="daily"]').click();
  const l = window._game.lobby, card = document.querySelector('#lobby-level .level-card[data-level-id="daily"]');
  return { level: l.selectedLevel && l.selectedLevel.id, isDaily: !!(l.selectedLevel && l.selectedLevel.isDaily), selected: card.classList.contains('selected'), locked: card.classList.contains('level-locked') };
});
check(picked.isDaily && picked.selected && !picked.locked, 'TP-01 the full game\'s Daily Ride card is open and picks', picked);
const noChooser = await page.evaluate(() => ['daily-mode-overlay', 'btn-daily-ranked', 'btn-daily-practice', 'btn-daily-cancel', 'btn-practice-help', 'ranked-badge'].filter((id) => document.getElementById(id)));
check(noChooser.length === 0, 'TP-01 no practice / ranked chooser on the page', noChooser);
// The pad lands on START RIDE (the level step's default focus); walk to it if not.
const startFocus = () => page.evaluate(() => window._game.lobby.lobbyEl.querySelector('.gamepad-focus')?.id || null);
await page.evaluate(() => window._game.lobby._showStep(window._game.lobby.levelStep));
await until(() => !!window._game.lobby.lobbyEl.querySelector('.gamepad-focus'), null, 3000);
for (let i = 0; i < 12 && (await startFocus()) !== 'btn-start-ride'; i++) {
  const was = await startFocus();
  await pads.press(0, 'DOWN', 160);
  await until((w) => (window._game.lobby.lobbyEl.querySelector('.gamepad-focus')?.id || null) !== w, was, 2000);
}
const onStart = await startFocus();
await h.shot(page, '2-daily-start');
await pads.press(0, 'A', 160);
const riding = await until(() => window._game.state === 'playing' || window._game.state === 'countdown', null, 60000);
const rideInfo = await page.evaluate(() => ({ state: window._game.state, level: window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.id,
  rideNo: window._game._dailyRideNo ?? null }));
check(onStart === 'btn-start-ride' && !!riding && rideInfo.level === 'daily', 'TP-01 A on START RIDE starts the Daily Ride directly', { onStart, ...rideInfo });
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
