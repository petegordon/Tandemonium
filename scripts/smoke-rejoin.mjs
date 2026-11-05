#!/usr/bin/env node
// smoke:rejoin · #547: rejoin a recent online room from JOIN A RIDE.
//
//   RJ-01  RIDE TOGETHER goes straight to Choose your seat, even with recent
//          rooms saved (the old Recent Rooms pop-up is gone).
//   RJ-02  JOIN A RIDE shows "Rejoin a recent ride": one card per recent room,
//          newest first, with code, partner, seat and age; the pad's focus
//          starts on the newest card.
//   RJ-03  The row fits the TV step: cards on screen, clear of the keypad, at
//          1920×1080 and 1280×720.
//   RJ-04  A on a back-seat card rejoins that room as the stoker (straight to
//          connect, status "Rejoining room...", the row goes away).
//   RJ-05  Clicking a front-seat card rejoins as the captain on the host step.
//   RJ-06  No recent rooms: no row, and focus starts on the keypad.
//
// The network is stubbed (enterRoom is recorded, not dialled): the connect path
// after the pick is the same code the pop-up used, covered by smoke:online.
import { startHarness } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await startHarness({ port: 8991, outDir: 'tandemonium-rejoin' });
const { check } = h;

const now = Date.now();
const rooms = [
  { roomCode: 'TNDM-WXYZ', role: 'captain', timestamp: now - 4 * 60000, partnerName: null },
  { roomCode: 'TNDM-ABCD', role: 'stoker', timestamp: now - 2 * 60000, partnerName: 'Pat' },
];
const page = await h.gamePage({
  viewport: { width: 1920, height: 1080 },
  storage: { tandemonium_tutorial_done: 'smoke', 'tandemonium-rooms': JSON.stringify(rooms) },
  before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }),
});
const pads = fakePads(page);
const until = async (fn, arg, timeout = 15000) => {
  try { const hnd = await page.waitForFunction(fn, { timeout, polling: 50 }, arg); return await hnd.jsonValue(); } catch { return null; }
};
const stepIs = (id) => until((want) => document.getElementById('lobby-flow').current === want, id);
await until(() => window._game && window._game.input && window._game.input.gamepadConnected);
await sleep(800);

// Record rooms entered instead of dialling the relay.
await page.evaluate(() => {
  const l = window._game.lobby;
  window.__rj = [];
  l.auth.getRelayToken = async () => null;
  const orig = l._replaceNet.bind(l);
  l._replaceNet = () => {
    const n = orig();
    l.net.enterRoom = (code, role) => { window.__rj.push([code, role]); };
    l.net.acquireLocalMedia = async () => {};
    return n;
  };
});

const toJoin = async () => {
  await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
  await stepIs('lobby-mode');
  await page.evaluate(() => document.getElementById('btn-together').click());
  await stepIs('lobby-role');
  await sleep(300);
  await page.evaluate(() => document.getElementById('btn-stoker').click());
  await stepIs('lobby-join');
  await sleep(600);
};

// ── RJ-01 ──
await page.evaluate(() => document.getElementById('btn-together').click());
const role = await stepIs('lobby-role');
await sleep(500);
const popup = await page.evaluate(() => !!document.getElementById('rejoin-overlay'));
check(role && !popup, 'RJ-01 RIDE TOGETHER goes straight to Choose your seat with recent rooms saved (no pop-up)', { role, popup });

// ── RJ-02 ──
await page.evaluate(() => document.getElementById('btn-stoker').click());
await stepIs('lobby-join');
await sleep(800);
const row = await page.evaluate(() => {
  const wrap = document.getElementById('join-rejoin');
  const cards = Array.from(wrap.querySelectorAll('.join-rejoin-card'));
  return {
    shown: !wrap.hidden && wrap.getBoundingClientRect().height > 0,
    cards: cards.map((c) => ({ h: c.getAttribute('heading'), d: c.getAttribute('description'), f: c.getAttribute('footer') })),
    focused: cards.findIndex((c) => c.classList.contains('gamepad-focus')),
  };
});
check(row.shown && row.cards.length === 2, 'RJ-02 JOIN A RIDE shows a Rejoin row with both recent rooms', row);
check(row.cards[0] && row.cards[0].h === 'Rejoin ABCD' && row.cards[0].d === 'with Pat' && /^Back seat · 2 min ago$/.test(row.cards[0].f)
  && row.cards[1].h === 'Rejoin WXYZ' && /^Front seat · 4 min ago$/.test(row.cards[1].f), 'RJ-02 newest first; code, partner, seat and age on each card', row.cards);
check(row.focused === 0, 'RJ-02 the pad starts on the newest Rejoin card', { focused: row.focused });

// ── RJ-03 ──
const fits = async (label) => {
  await sleep(500);
  const m = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll('#join-rejoin .join-rejoin-card')).map(r);
    const pad = document.getElementById('join-keypad-tv');
    const k = pad ? r(pad) : null;
    const on = (b) => b.width > 0 && b.top >= 0 && b.left >= 0 && b.bottom <= innerHeight && b.right <= innerWidth;
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    // every key plus Delete and JOIN (focusables() skips a disabled JOIN)
    const keys = pad ? Array.from(pad.querySelectorAll('.ukp-key, .ukp-actions uf-button')).map(r) : [];
    const bar = document.getElementById('lobby-bar');
    const floor = bar && r(bar).height > 0 ? r(bar).top : innerHeight;
    return {
      onScreen: cards.every(on) && keys.every(on) && [...cards, ...keys].every((b) => b.bottom <= floor),
      floor: Math.round(floor), lowest: Math.round(Math.max(...keys.map((b) => b.bottom))),
      clear: !k || cards.every((c) => !hit(c, k)),
      minFont: Math.min(...Array.from(document.querySelectorAll('#join-rejoin .uf-card__title')).map((e) => parseFloat(getComputedStyle(e).fontSize))),
      vw: innerWidth, vh: innerHeight, cards: cards.map((b) => [Math.round(b.top), Math.round(b.bottom)]), keypad: k && [Math.round(k.top), Math.round(k.bottom)],
    };
  });
  check(m.onScreen && m.clear && m.minFont >= 18, `RJ-03 ${label}: Rejoin cards and keypad all on screen, not overlapping, titles readable, all above the bar`, m);
  await h.shot(page, `rj03-${label}`);
};
await fits('1920x1080');
await page.setViewport({ width: 1280, height: 720 });
await fits('1280x720');
await page.setViewport({ width: 1920, height: 1080 });
await sleep(400);

// ── RJ-04 ──
await page.evaluate(() => { const l = window._game.lobby; l._applyStepSpatialFocus(l.joinStep); });
await sleep(300);
await pads.press(0, 'A', 160);
const stoker = await until(() => window.__rj.length > 0 && window.__rj[0], null, 8000);
await sleep(300);
const after = await page.evaluate(() => ({
  step: document.getElementById('lobby-flow').current,
  status: document.getElementById('join-status').textContent,
  rowHidden: document.getElementById('join-rejoin').hidden,
}));
check(stoker && stoker[0] === 'TNDM-ABCD' && stoker[1] === 'stoker' && after.step === 'lobby-join' && /Rejoining/.test(after.status) && after.rowHidden,
  'RJ-04 A on the back-seat card rejoins TNDM-ABCD as the stoker; the row gives way to the status', { stoker, after });
await h.shot(page, 'rj04-stoker-rejoining');

// ── RJ-05 ──
await page.evaluate(() => { window.__rj = []; });
await sleep(1600);   // the double-pick guard
await toJoin();
await page.evaluate(() => { const c = document.querySelector('#join-rejoin .join-rejoin-card[data-room="TNDM-WXYZ"]'); if (c) c.click(); });
const captain = await until(() => window.__rj.length > 0 && window.__rj[0], null, 8000);
const host = await page.evaluate(() => document.getElementById('lobby-flow').current);
check(captain && captain[0] === 'TNDM-WXYZ' && captain[1] === 'captain' && host === 'lobby-host', 'RJ-05 clicking the front-seat card rejoins TNDM-WXYZ as the captain', { captain, host });
await h.shot(page, 'rj05-captain-rejoining');

// ── RJ-06 ──
await page.evaluate(() => { const l = window._game.lobby; if (l.net) { try { l.net.destroy(); } catch {} } localStorage.removeItem('tandemonium-rooms'); });
await sleep(1600);
await toJoin();
const empty = await page.evaluate(() => {
  const wrap = document.getElementById('join-rejoin');
  const f = document.querySelector('#lobby-join .gamepad-focus');
  return { hidden: wrap.hidden, cards: wrap.querySelectorAll('.join-rejoin-card').length, focusInKeypad: !!(f && f.closest('#join-tv')) };
});
check(empty.hidden && empty.cards === 0 && empty.focusInKeypad, 'RJ-06 no recent rooms: no Rejoin row, focus starts on the keypad', empty);
await h.shot(page, 'rj06-no-rooms');

await h.finish();
