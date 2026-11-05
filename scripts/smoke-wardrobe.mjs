#!/usr/bin/env node
// smoke:wardrobe · #548 Wardrobe for every player, with fake Gamepad API pads through the real
// ControllerManager and lobby (scripts/lib/fake-gamepads.mjs).
//
//   WD-01  co-op room: P2 joins on a DualSense; a WARDROBE button per seated player appears
//   WD-02  P2's △/Y opens the Wardrobe for Player 2; P1's pad does not move its focus, P2's does
//   WD-03  P2 picks Gander + Georgian + a gold light: the look saves under player 2 AND the pad;
//          the pad's lightbar is set to gold; FIND MY CONTROLLER flashes it
//   WD-04  in the local ride the stoker rides as the Georgian gander (goose_stoker_georgian_m.glb,
//          the new-contract file), with no fallback logged
//   WD-05  next session: the same pad (same vendor:product, slot P2) gets its look back
//   WD-06  versus: a joined pad's △/Y opens its own Wardrobe; B closes it without leaving the seat
import { startHarness, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8967, outDir: 'tandemonium-wardrobe' });
const { check } = h;
const STORAGE = { tandemonium_tutorial_done: 'smoke' };
const until = (page, fn, arg, timeout = 8000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);

async function open(atBoot) {
  const logs = [];
  const page = await h.gamePage({ storage: STORAGE, before: (p) => installFakeGamepads(p, { atBoot }) });
  page.on('console', (m) => logs.push(m.text()));
  await until(page, () => !!window.__controllerManager && !!window.__playerLooks);
  return { page, pads: fakePads(page), logs };
}

/** Jump to the captain's host step (no relay in a smoke). */
const toHostStep = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  document.getElementById('room-code-display').textContent = 'TNDM-WARD';
  l._pendingMode = 'multiplayer'; l._roomRole = 'captain';
  l._showStep(l.hostStep); l._refreshHostNext();
});

/** A recording "driver" for slot P<n>, so the LED calls can be read without WebHID. */
const installLedRecorder = (page, n) => page.evaluate((who) => {
  window.__ledCalls = [];
  class FakeDualSense {
    static PLAYER_LED_PATTERNS = { 1: 0x04, 2: 0x0a, 3: 0x15, 4: 0x1b };
    async setPlayerFeedback(x) { window.__ledCalls.push({ n: who, ...x }); }
  }
  const drv = new FakeDualSense();
  window.__playerLed.driverFor = (mgr, k) => (k === who ? drv : null);
}, n);

const wardrobe = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  const f = l._wardrobeFocus && l._wardrobeFocus.focused;
  return {
    open: !!l._wardrobe, n: l._wardrobe ? l._wardrobe.n : null, type: l._wardrobe ? l._wardrobe.type : null,
    sheetOpen: !!document.getElementById('wardrobe-sheet')?.open,
    focused: f ? (f.dataset.val || f.id || f.textContent.trim()) : null,
  };
});
const rowButtons = (page, id) => page.evaluate((i) => Array.from(document.querySelectorAll(`#${i} uf-button`)).map((b) => b.textContent.trim()), id);
const look = (page, n, key) => page.evaluate(([k, kk]) => window.__playerLooks.get(k, kk), [n, key]);

// ── WD-01..04 · the co-op room ──
console.log('WD-01 co-op seats → WARDROBE buttons');
const { page, pads, logs } = await open(['xbox']);
await toHostStep(page);
await until(page, () => (document.getElementById('host-roster')?.rows || []).length > 0);
const p2 = await pads.plug('dualsense');
await until(page, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
await pads.tap(p2, 'A');
check(await until(page, () => window._game.lobby._localSeatedOnHost), 'WD-01: the DualSense press seats Player 2');
check(await until(page, () => document.querySelectorAll('#host-wardrobe uf-button').length === 2), 'WD-01: a WARDROBE button for P1 and P2 under the seats', await rowButtons(page, 'host-wardrobe'));
const keys = await page.evaluate(() => ({ p1: window.__playerLooks.padKey(1), p2: window.__playerLooks.padKey(2) }));
check(keys.p2 === 'pad:054c:0ce6:P2' && keys.p1 === 'pad:name:xbox-360-controller:P1', 'WD-01: look keys = vendor:product + slot (DualSense); name + slot (XInput pad: no vid:pid in the browser)', keys);

console.log('WD-02 P2\'s Y opens their Wardrobe; only their pad drives it');
await installLedRecorder(page, 2);
await pads.tap(p2, 'Y');
check(await until(page, () => window._game.lobby._wardrobe && window._game.lobby._wardrobe.n === 2 && document.getElementById('wardrobe-sheet').open), 'WD-02: Wardrobe open for Player 2', await wardrobe(page));
check(await until(page, () => window._game.lobby._wardrobeFocus?.focused?.dataset.val === 'f'), 'WD-02: focus starts on P2\'s current body (Goose)', await wardrobe(page));
const w = await wardrobe(page);
await pads.tap(0, 'LEFT');
await pads.tap(0, 'DOWN');
await pads.tap(0, 'RIGHT');
const afterP1 = await wardrobe(page);
check(afterP1.focused === w.focused && afterP1.open && w.type === 'gamepad', 'WD-02: P1\'s pad does not move the Wardrobe focus', { before: w.focused, after: afterP1.focused });
await pads.tap(p2, 'LEFT');
check(await until(page, () => { const f = window._game.lobby._wardrobeFocus?.focused; return !!f && f.dataset.val === 'm'; }), 'WD-02: P2\'s LEFT moves focus to Gander', await wardrobe(page));

console.log('WD-03 picks save under player 2 and the pad; the lightbar follows');
await pads.tap(p2, 'A');
check(await until(page, () => window.__playerLooks.get(2).body === 'm'), 'WD-03: A on Gander saves body m for Player 2', await look(page, 2));
await page.evaluate(() => document.querySelector('#wardrobe-body button[data-pick="outfit"][data-val="georgian"]').click());
await page.evaluate(() => document.querySelector('#wardrobe-body button[data-pick="led"][data-val="gold"]').click());
const saved = await page.evaluate(() => ({
  byPlayer: window.__playerLooks.get(2, null), byPad: window.__playerLooks.get(2, 'pad:054c:0ce6:P2'),
  stored: JSON.parse(localStorage.getItem('tandemonium_player_looks')),
  colourRow: Array.from(document.querySelectorAll('#wardrobe-body .wardrobe-opts[data-pick="colourway"] button')).map((b) => b.dataset.val),
}));
check(saved.byPlayer.outfit === 'georgian' && saved.byPlayer.body === 'm' && saved.byPlayer.led === 'gold', 'WD-03: Player 2\'s look = Georgian gander, gold light', saved.byPlayer);
check(saved.byPad.outfit === 'georgian' && saved.stored.byPad['pad:054c:0ce6:P2'] && saved.stored.byPlayer['2'], 'WD-03: saved under the pad key AND player 2', Object.keys(saved.stored.byPad));
check(saved.colourRow[0] === 'default' && saved.colourRow.includes('g_claret'), 'WD-03: the colour row re-lists the Georgian colourways', saved.colourRow);
let led = await page.evaluate(() => window.__ledCalls);
check(led.some((c) => c.n === 2 && c.lightbar && c.lightbar.r === 255 && c.lightbar.g === 160 && c.lightbar.b === 0 && c.playerLEDs === 0x0a), 'WD-03: the pad in P2 got a gold lightbar + the P2 player LEDs', led.at(-1));
const mgrColour = await page.evaluate(() => window.__controllerManager.opts.playerColors[2]);
check(mgrColour && mgrColour.r === 255 && mgrColour.g === 160, 'WD-03: the manager relights P2 in gold on its next claim', mgrColour);
const before = led.length;
await page.evaluate(() => document.getElementById('wardrobe-find').click());
check(await until(page, (n) => window.__ledCalls.length > n + 2, before), 'WD-03: FIND MY CONTROLLER flashes the lightbar (several calls)', (await page.evaluate(() => window.__ledCalls.length)) - before);
check(await until(page, () => /Buzzing Player 2/.test(document.getElementById('wardrobe-hint')?.textContent || '')), 'WD-03: the sheet says whose pad is buzzing');
await h.shot(page, 'wd03-wardrobe-p2');
await pads.tap(p2, 'B');
check(await until(page, () => !window._game.lobby._wardrobe && !document.getElementById('wardrobe-sheet').open), 'WD-03: B on P2\'s pad closes the Wardrobe');
check(await page.evaluate(() => window._game.lobby._localSeatedOnHost), 'WD-03: Player 2 is still seated after closing');

console.log('WD-04 the stoker rides in Player 2\'s look');
await clickId(page, 'btn-host-local-next');
await until(page, () => document.getElementById('lobby-flow').current === 'lobby-level');
await clickId(page, 'btn-start-ride');
await waitState(page, 'playing');
check(await until(page, () => window._game.mode === 'local' && window._game.bike && window._game.bike._gooseRiderPaths && window._game.bike._gooseRiderPaths.Stoker === 'tandem-3d/goose/goose_stoker_georgian_m.glb', null, 20000),
  'WD-04: stoker rider path = goose_stoker_georgian_m.glb (the new-contract gander file)', await page.evaluate(() => window._game.bike._gooseRiderPaths));
const seatLooks = await page.evaluate(() => window._game.bike.seatLooks);
check(seatLooks && seatLooks.Captain.outfit === 'victorian' && seatLooks.Captain.body === 'm' && seatLooks.Stoker.outfit === 'georgian' && seatLooks.Stoker.body === 'm', 'WD-04: seat looks = P1 Victorian gander, P2 Georgian gander', seatLooks);
const fallbackLogs = logs.filter((t) => t.includes('[wardrobe] no '));
check(fallbackLogs.length === 0, 'WD-04: no rider fallback logged (every combo has its file)', fallbackLogs);
await h.shot(page, 'wd04-local-ride');
await page.close();

// ── WD-05 · next session: the same pad gets its look back ──
console.log('WD-05 the look follows the pad into the next session');
{
  const { page: p, pads: fp } = await open(['xbox']);
  await toHostStep(p);
  const i = await fp.plug('dualsense');
  await until(p, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
  await fp.tap(i, 'A');
  check(await until(p, () => window._game.lobby._localSeatedOnHost && window.__playerLooks.padKey(2) === 'pad:054c:0ce6:P2'), 'WD-05: the DualSense is Player 2 again');
  const l2 = await look(p, 2, undefined);
  check(l2.outfit === 'georgian' && l2.body === 'm' && l2.led === 'gold', 'WD-05: Player 2\'s pad has its Georgian gander + gold light back', l2);
  const l1 = await look(p, 1, undefined);
  check(l1.outfit === 'victorian' && l1.body === 'm' && l1.led === 'blue', 'WD-05: Player 1 still has the default look', l1);
  await p.close();
}

// ── WD-06 · versus: a joiner's Y opens their Wardrobe; B closes it without leaving ──
console.log('WD-06 versus join screen');
{
  const { page: p, pads: fp } = await open(['xbox']);
  await clickId(p, 'btn-versus');
  await until(p, () => document.getElementById('lobby-flow').current === 'lobby-versus');
  const i = await fp.plug('switchpro');
  await until(p, () => (window._game.lobby._versusCandidates || []).length > 0);
  await fp.tap(i, 'A');
  check(await until(p, () => window._game.lobby._versusPlayers.length === 2), 'WD-06: the Switch Pro joins as player 2');
  check(await until(p, () => document.querySelectorAll('#versus-wardrobe uf-button').length === 2), 'WD-06: WARDROBE buttons for both players', await rowButtons(p, 'versus-wardrobe'));
  await fp.tap(i, 'Y');
  check(await until(p, () => window._game.lobby._wardrobe && window._game.lobby._wardrobe.n === 2), 'WD-06: player 2\'s Y opens their Wardrobe', await wardrobe(p));
  await fp.tap(i, 'B');
  check(await until(p, () => !window._game.lobby._wardrobe), 'WD-06: B closes it');
  const v = await p.evaluate(() => ({ players: window._game.lobby._versusPlayers.length, teams: window._game.lobby._versusTeams().map((t) => t.members.map((m) => m.n)) }));
  check(v.players === 2, 'WD-06: the closing B did not unseat player 2', v);
  check(v.teams.flat().includes(2) && v.teams.flat().includes(1), 'WD-06: the teams payload carries player numbers for the looks', v.teams);
  await h.shot(p, 'wd06-versus');
  await p.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
