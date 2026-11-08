#!/usr/bin/env node
// smoke-time-warp-mode.mjs — #611 / #644 · time warp mode on the Daily Ride card.
//
//   TM-01  Locked (no Time Warp reward): no warp row on the Daily Ride card.
//   TM-02  Unlocked: "Warp to tomorrow" moves one day per press, the card says
//          which day ("⏳ Tuesday, November 10 · warped +3"), and at +7 the
//          button stops; an eighth press changes nothing.
//   TM-03  Each warped ride is that real day's road: the same key, seed, road
//          shape, pylons and presents as a game whose clock IS that day
//          (checked for +1 and +7 against a page with a moved clock).
//   TM-04  Finishing the 7 warped days earns Three in a Row, A Week of Roads,
//          Coming Back and Habit Forming in one sitting.
//   TM-05  Every warped finish posts to the board with warp: true and that day's key.
//   TM-06  "Back to today" returns the card and the picked road to the real date.
//   TM-07  A controller reaches the warp row from the card (down) and presses it (A).
//   TM-08  The leaderboard's Daily tab shows ⏳ on a time-warp row.
//
// TM_SHOTS=<dir> also saves 1920×1080 screenshots of the card in warp state.
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { ACHIEVEMENTS } from '../js/achievement-defs.js';
import { isCalendarAchievement } from '../js/rewards.js';

const h = await startHarness({ port: 8949 });
const { check } = h;
const SHOTS = process.env.TM_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };

const TV = { width: 1920, height: 1080 };
const NON_CALENDAR = ACHIEVEMENTS.filter((a) => !isCalendarAchievement(a)).map((a) => a.id);
const BASE = { tandemonium_tutorial_done: 'smoke', tandemonium_difficulty: 'adventurous' };
const UNLOCKED = {
  ...BASE,
  tandemonium_achievements: JSON.stringify(NON_CALENDAR.map((id) => ({ id, earnedAt: Date.UTC(2026, 10, 1) }))),
};

const until = async (page, fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};

/** Solo → the level step, with the Daily Ride card on screen. */
async function toLevels(page) {
  await page.evaluate(() => {
    document.getElementById('tap-to-start')?.click();
    document.getElementById('btn-solo')?.click();
  });
  return until(page, () => !!document.querySelector('#level-cards .level-card[data-level-id="daily"]'));
}

const cardState = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  const fwd = document.getElementById('btn-warp-forward');
  const back = document.getElementById('btn-warp-back');
  const desc = document.querySelector('#level-cards .level-card[data-level-id="daily"] .level-card-desc');
  return {
    row: !!document.getElementById('daily-warp-row'),
    desc: desc ? desc.textContent.replace(/\s+/g, ' ').trim() : null,
    fwdText: fwd ? fwd.textContent : null,
    fwdOff: fwd ? fwd.getAttribute('aria-disabled') === 'true' : null,
    backShown: !!back && !back.hidden && back.getBoundingClientRect().height > 0,
    key: l.selectedLevel && l.selectedLevel.key,
    seed: l.selectedLevel && l.selectedLevel.seed,
    warp: (l.selectedLevel && l.selectedLevel.warp) || 0,
    selected: document.querySelector('#level-cards .level-card.selected')?.dataset.levelId || null,
  };
});

/** What the page expects for +k (computed in the page, from the real clock). */
const expectFor = (page, k) => page.evaluate(async (k) => {
  const tw = await import('./js/time-warp.js');
  const key = tw.warpedDayKey(k);
  return { key, line: tw.warpLine(key, k) };
}, k);

/** START RIDE, wait for the ride, read its road / pylons / presents. */
async function startAndPrint(page) {
  await page.evaluate(() => document.getElementById('btn-start-ride').click());
  await until(page, () => ['countdown', 'playing'].includes(window._game.state), null, 30000);
  return page.evaluate(() => {
    const g = window._game;
    const lvl = g.lobby.selectedLevel;
    const road = [0, 125, 250, 375, 499].map((d) => { const p = g.world.roadPath.getPointAtDistance(d); return [+p.x.toFixed(2), +p.z.toFixed(2)]; });
    const items = (m) => (m && m._items ? m._items.map((i) => [+(i.absoluteD ?? i.roadD).toFixed(1), +(+i.lateralOffset).toFixed(2)]) : null);
    return { state: g.state, key: lvl.key, seed: lvl.seed, warp: lvl.warp || 0, road,
             obstacles: items(g.obstacleManager), presents: items(g.collectibleManager), difficulty: g.lobby.selectedDifficulty };
  });
}

/** Finish the ride now (a clean 1:3x), through the real victory path, and go back to the lobby. */
async function finishRide(page, ms) {
  return page.evaluate((ms) => {
    const g = window._game;
    g.raceManager.getElapsedMs = () => ms;
    g.raceManager.finished = true;
    g.bike.distanceTraveled = 500;
    g._showVictory(false);
    const earned = g.achievements.getEarnedIds();
    g._returnToLobby();
    return earned;
  }, ms);
}

/** The board posts go to a recorder (a signed-in player, no network). */
const mockBoard = (page) => page.evaluate(() => {
  const a = window._game.lobby.auth;
  window.__posts = [];
  a.isLoggedIn = () => true;
  a.submitDaily = async (d) => { window.__posts.push(d); return { success: true, improved: true }; };
  a.submitScore = async () => ({});
});

// ── TM-01 · locked ──────────────────────────────────────────────────────────
const locked = await h.gamePage({ storage: BASE });
await toLevels(locked);
const lockedState = await cardState(locked);
check(!lockedState.row && !/⏳/.test(lockedState.desc || ''), 'TM-01 locked: no warp row on the Daily Ride card', lockedState);
await locked.close();

// ── TM-02..06 · unlocked, the 7-day run ─────────────────────────────────────
const page = await h.gamePage({ storage: UNLOCKED, viewport: TV });
await toLevels(page);
await mockBoard(page);
const start = await cardState(page);
check(start.row && start.warp === 0 && !start.backShown && /Warp to tomorrow/.test(start.fwdText) && !/⏳/.test(start.desc),
  'TM-02 unlocked: Warp to tomorrow, on the real date', start);
await shot(page, 'tw-0-today');

const prints = {};
const steps = [];
for (let k = 1; k <= 7; k++) {
  await page.evaluate(() => document.getElementById('btn-warp-forward').click());
  const st = await cardState(page);
  const want = await expectFor(page, k);
  steps.push({ k, ok: st.warp === k && st.key === want.key && st.desc.startsWith(want.line) && st.backShown && st.selected === 'daily', desc: st.desc.slice(0, 60) });
  if (k === 3) await shot(page, 'tw-3-warped');
  if (k === 7) {
    check(st.fwdOff && /Limit: 7 days ahead/.test(st.fwdText), 'TM-02 +7: the button stops', { fwdText: st.fwdText });
    await shot(page, 'tw-7-max');
    await page.evaluate(() => document.getElementById('btn-warp-forward').click());
    const again = await cardState(page);
    check(again.warp === 7 && again.key === st.key, 'TM-02 an eighth press changes nothing', { warp: again.warp, key: again.key });
  }
  const pr = await startAndPrint(page);
  prints[k] = pr;
  const earned = await finishRide(page, 90000 + k * 1000);
  steps[k - 1].rideKey = pr.key;
  steps[k - 1].rideOk = pr.key === want.key && pr.warp === k;
  if (k === 7) prints.earned = earned;
  await toLevels(page);
}
check(steps.every((s) => s.ok), 'TM-02 one day per press, the card says the day', steps.map((s) => `${s.k}:${s.ok ? 'ok' : s.desc}`));
check(steps.every((s) => s.rideOk), 'TM-03 each ride is on the warped day', steps.map((s) => s.rideKey));

const earned = prints.earned || [];
const CAL = ['daily_streak_3', 'daily_streak_7', 'days_3', 'days_7'];
check(CAL.every((id) => earned.includes(id)), 'TM-04 7 warped days earn the calendar achievements in one sitting',
  CAL.filter((id) => !earned.includes(id)));

const posts = await page.evaluate(() => window.__posts);
check(posts.length === 7 && posts.every((p, i) => p.warp === true && p.dayKey === steps[i].rideKey),
  'TM-05 every warped finish posts with warp: true and that day', posts.map((p) => `${p.dayKey}${p.warp ? '⏳' : ''}`));

// ── TM-06 · Back to today ──
await page.evaluate(() => document.getElementById('btn-warp-back').click());
const back = await cardState(page);
const today = await page.evaluate(async () => (await import('./js/daily-seed.js')).dailyKey());
check(back.warp === 0 && back.key === today && !back.backShown && !/⏳/.test(back.desc) && !back.fwdOff,
  'TM-06 Back to today: the real date again', back);

// ── TM-08 · the Daily board shows ⏳ (a recorded board for the screenshot) ──
await page.evaluate(() => document.getElementById('btn-warp-forward').click());
const board = await page.evaluate(async () => {
  const l = window._game.lobby;
  const a = l.auth;
  const key = l.selectedLevel.key;
  a.user = a.user || { serverId: 1, name: 'Pete' };
  a.fetchDailyBoard = async () => ({ key, results: [
    { user_id: 2, mode: 'solo', time_ms: 84000, dnf: 0, collectibles: 11, warp: 0, display_name: 'Sam Rivers' },
    { user_id: 1, mode: 'solo', time_ms: 91000, dnf: 0, collectibles: 9, warp: 1, display_name: 'Pete Gordon' },
    { user_id: 3, mode: 'pair', time_ms: 99000, dnf: 0, collectibles: 7, warp: 1, display_name: 'Jo Bloggs' },
  ] });
  l._lbMainTab = 'solo';
  await l._openLeaderboard();
  const list = document.getElementById('leaderboard-list');
  await new Promise((r) => { const t0 = Date.now(); const tick = () => (list.querySelector('.lb-entry') || Date.now() - t0 > 3000 ? r() : setTimeout(tick, 50)); tick(); });
  return { heading: l._leaderboardSheet.heading, rows: [...list.querySelectorAll('.lb-entry')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
           warped: list.querySelectorAll('.lb-warp').length };
});
check(board.rows.length === 2 && board.warped === 1 && /⏳/.test(board.heading), 'TM-08 the Daily board marks the time-warp row ⏳', board);
await shot(page, 'tw-board');
await page.close();

// ── TM-03 · the same road on that real day (a game whose clock is +1 / +7) ──
async function onTheDay(k) {
  const p = await h.gamePage({
    storage: BASE,
    before: (pg) => pg.evaluateOnNewDocument((shift) => {
      const Real = Date;
      class Moved extends Real {
        constructor(...a) { if (a.length === 0) super(Real.now() + shift); else super(...a); }
        static now() { return Real.now() + shift; }
      }
      window.Date = Moved;
    }, k * 86400000),
  });
  await toLevels(p);
  await p.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="daily"]').click());
  const pr = await startAndPrint(p);
  await p.close();
  return pr;
}
for (const k of [1, 7]) {
  const real = await onTheDay(k);
  const w = prints[k];
  const same = real.key === w.key && real.seed === w.seed && real.difficulty === w.difficulty &&
    JSON.stringify(real.road) === JSON.stringify(w.road) &&
    JSON.stringify(real.obstacles) === JSON.stringify(w.obstacles) &&
    JSON.stringify(real.presents) === JSON.stringify(w.presents) && (w.obstacles || []).length > 0;
  check(same, `TM-03 +${k}: the warped road == the road on ${real.key}`, { warped: [w.key, w.seed, w.road[2], (w.obstacles || []).length], real: [real.key, real.seed, real.road[2], (real.obstacles || []).length] });
}

// ── TM-07 · a controller: down from the card reaches the row, A presses it ──
const pad = await h.gamePage({ storage: UNLOCKED, viewport: TV, before: (p) => installFakeGamepads(p, { atBoot: ['dualsense'] }) });
const pads = fakePads(pad);
await until(pad, () => window._game && window._game.input && window._game.input.gamepadConnected);
await toLevels(pad);
await until(pad, () => { const l = window._game.lobby; return (l._stepFocus.items || []).includes(document.getElementById('btn-warp-forward')); });
await pad.evaluate(() => { const l = window._game.lobby; l._stepFocus.focusElement(document.querySelector('#level-cards .level-card[data-level-id="daily"]')); });
await sleep(250);
await pads.press(0, 'DOWN', 160);
const focused = await until(pad, () => document.querySelector('#lobby .gamepad-focus')?.id === 'btn-warp-forward' && 'btn-warp-forward', null, 3000);
await sleep(250);
await pads.press(0, 'A', 160);
const afterA = await until(pad, () => window._game.lobby.selectedLevel && window._game.lobby.selectedLevel.warp === 1 && 1, null, 3000);
await pad.evaluate(() => document.getElementById('btn-warp-forward').click());
await shot(pad, 'tw-2-pad-focus');
// Down again from Warp lands on Back to today (same row: right) or below; A on Back returns to today and keeps the highlight on the row.
await pad.evaluate(() => window._game.lobby._stepFocus.focusElement(document.getElementById('btn-warp-back')));
await sleep(250);
await pads.press(0, 'A', 160);
const home = await until(pad, () => {
  const l = window._game.lobby;
  return !(l.selectedLevel && l.selectedLevel.warp) && document.querySelector('#lobby .gamepad-focus')?.id === 'btn-warp-forward' && 'home';
}, null, 3000);
check(focused === 'btn-warp-forward' && afterA === 1 && home === 'home', 'TM-07 controller: down reaches Warp, A warps, A on Back returns (focus stays on the row)', { focused, afterA, home });

await h.finish();
