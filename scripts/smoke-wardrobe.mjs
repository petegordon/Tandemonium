#!/usr/bin/env node
// smoke:wardrobe · #548 the Dressing Room, with fake Gamepad API pads through the real
// ControllerManager and lobby (scripts/lib/fake-gamepads.mjs).
//
//   WD-01  co-op room: P2 joins on a DualSense; a WARDROBE button per seated player appears
//   WD-02  P2's △/Y opens the Dressing Room for everyone: P2's card in Edit, P1's Ready; P1's
//          pad does not move P2's card focus, P2's does; both can edit at the same time
//   WD-03  P2 picks Gander + Georgian + a gold light: saved under player 2 AND the pad, the
//          lightbar goes gold (and that pick buzzes P2's pad once), the preview loads the exact rider
//          GLB, the Buzz strip's P2 chip buzzes P2 only and P2's pad can never focus the strip;
//          B from P1 while P2 edits only nudges P2's card; B from P2 = Ready (picks kept);
//          all ready → BACK TO SEATS; B from anyone closes; P2 stays seated
//   WD-02d a pad unplugged while editing counts as Ready (the room can't stick)
//   WD-04  in the local ride the stoker rides as the Georgian gander (goose_stoker_georgian_m.glb)
//   WD-05  next session: the same pad (same vendor:product, slot P2) gets its look back
//   WD-06  versus: a joined pad's △/Y opens the room (cards grouped by team); B closes it without
//          leaving the seat
//   WD-07  versus with a shared team on a 1080p TV (3 players, P3 editing beside a Ready teammate):
//          every card fits the room, the editing card needs no scrolling (goose beside the
//          pickers), and no Ready preview balloons past its card (TV playtest 2026-11-06: the
//          wrapped team line grew to ~1500 px and ran the cards off the screen)
import { startHarness, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8967, outDir: 'tandemonium-wardrobe' });
const { check } = h;
// #736 · a player from before the holiday outfits became rewards: they kept Cyclists, Fancy and Georgian
const STORAGE = { tandemonium_tutorial_done: 'smoke', tandemonium_outfits_kept: JSON.stringify(['cyclists', 'fancy', 'georgian']) };
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

const room = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  const r = l._room;
  const focusOf = (n) => { const c = r && r.cards.get(n); const f = c && c.focus && c.focus.focused; return f ? (f.dataset.val || f.dataset.act || f.id || f.textContent.trim()) : null; };
  return {
    open: !!r, sheetOpen: !!document.getElementById('dressing-room')?.open,
    states: r ? r.states() : null, cards: r ? [...r.cards.keys()] : [],
    focus: { 1: focusOf(1), 2: focusOf(2) },
    back: !!document.getElementById('dr-back') && document.getElementById('dr-back').style.display !== 'none',
    status: document.getElementById('dr-status')?.textContent || '',
    nudges: r ? Object.fromEntries([...r.cards].map(([n, c]) => [n, c.nudges || 0])) : {},
    teams: [...document.querySelectorAll('#dr-cards .dr-team')].map((t) => [t.dataset.team, [...t.querySelectorAll('.dr-card')].map((c) => Number(c.dataset.n))]),
  };
});
const rowButtons = (page, id) => page.evaluate((i) => Array.from(document.querySelectorAll(`#${i} uf-button`)).map((b) => b.textContent.trim()), id);
const look = (page, n, key) => page.evaluate(([k, kk]) => window.__playerLooks.get(k, kk), [n, key]);
const cardClick = (page, n, sel) => page.evaluate(([k, s]) => { const b = document.querySelector(`#dr-cards .dr-card[data-n="${k}"] ${s}`); if (!b) return false; b.click(); return true; }, [n, sel]);

// ── WD-01..04 · the co-op room ──
console.log('WD-01 co-op seats → WARDROBE buttons');
const { page, pads, logs } = await open(['xbox']);
await toHostStep(page);
await until(page, () => (document.getElementById('host-roster')?.rows || []).length > 0);
const p2 = await pads.plug('dualsense');
await until(page, () => (window._game.lobby._detectLocalJoinCandidates() || []).length > 0);
await pads.tap(p2, 'A');
check(await until(page, () => window._game.lobby._localSeatedOnHost), 'WD-01: the DualSense press seats Player 2');
check(await until(page, () => /for wardrobe/i.test(document.getElementById('host-wardrobe')?.textContent || '') && !document.querySelector('#host-wardrobe uf-button')), 'WD-01: "Press Y for wardrobe" under the seats, no WARDROBE buttons', await page.evaluate(() => document.getElementById('host-wardrobe')?.innerHTML));
check(await until(page, () => document.getElementById('host-seat-stoker')?.badge === 'P2'), "WD-01: the seated stoker card shows P2 in its corner, like the captain's P1", await page.evaluate(() => document.getElementById('host-seat-stoker')?.badge));
await h.shot(page, 'wd01-host-seats');
const keys = await page.evaluate(() => ({ p1: window.__playerLooks.padKey(1), p2: window.__playerLooks.padKey(2) }));
check(keys.p2 === 'pad:054c:0ce6:P2' && keys.p1 === 'pad:name:xbox-360-controller:P1', 'WD-01: look keys = vendor:product + slot (DualSense); name + slot (XInput pad: no vid:pid in the browser)', keys);

console.log('WD-02 P2\'s Y opens the room for everyone; each card by its own pad');
await installLedRecorder(page, 2);
await pads.tap(p2, 'Y');
check(await until(page, () => window._game.lobby._room && document.getElementById('dressing-room').open && window._game.lobby._room.cards.size === 2), 'WD-02: Dressing Room open with two cards', await room(page));
let r = await room(page);
check(r.states && r.states[2] === 'editing' && r.states[1] === 'ready', 'WD-02: the opener (P2) starts in Edit, P1 Ready', r.states);
check(!r.back && /P2/.test(r.status), 'WD-02: no BACK TO SEATS while P2 edits; the footer waits for P2', { back: r.back, status: r.status });
check(await until(page, () => { const c = window._game.lobby._room.cards.get(2); return c.focus && c.focus.focused && c.focus.focused.dataset.val === 'f'; }), 'WD-02: P2\'s card focus starts on their current body (Goose)', (await room(page)).focus);
r = await room(page);
await pads.tap(0, 'LEFT');
await pads.tap(0, 'DOWN');
const afterP1 = await room(page);
check(afterP1.focus[2] === r.focus[2] && afterP1.states[2] === 'editing', 'WD-02: P1\'s pad does not move P2\'s card focus', { before: r.focus[2], after: afterP1.focus[2] });
await pads.tap(p2, 'LEFT');
check(await until(page, () => { const c = window._game.lobby._room.cards.get(2); return c.focus.focused && c.focus.focused.dataset.val === 'm'; }), 'WD-02: P2\'s LEFT moves P2\'s focus to Gander', (await room(page)).focus);
// P1's DOWN above took P1's focus into the Buzz strip (only P1's pad can); UP returns to the card.
check(await until(page, () => { const c = window._game.lobby._room.cards.get(1); return c.focus.focused && c.focus.focused.dataset.buzz === '1'; }), 'WD-02: P1\'s DOWN past the card lands on the Buzz strip (P1\'s chip first)', (await room(page)).focus);
await pads.tap(0, 'UP');
check(await until(page, () => { const c = window._game.lobby._room.cards.get(1); return c.focus.focused && c.focus.focused.dataset.act === 'edit'; }), 'WD-02: UP from the strip returns P1 to the card (EDIT)', (await room(page)).focus);
await pads.tap(0, 'A');
check(await until(page, () => window._game.lobby._room.states()[1] === 'editing' && window._game.lobby._room.states()[2] === 'editing'), 'WD-02: A on P1\'s EDIT — both cards editing at once', (await room(page)).states);

console.log('WD-03 picks, light, preview, nudge, ready gate, close');
await pads.tap(p2, 'A');
check(await until(page, () => window.__playerLooks.get(2).body === 'm'), 'WD-03: A on Gander saves body m for Player 2', await look(page, 2));
await cardClick(page, 2, 'button[data-pick="outfit"][data-val="georgian"]');
await cardClick(page, 2, 'button[data-pick="led"][data-val="gold"]');
const saved = await page.evaluate(() => ({
  byPlayer: window.__playerLooks.get(2, null), byPad: window.__playerLooks.get(2, 'pad:054c:0ce6:P2'),
  stored: JSON.parse(localStorage.getItem('tandemonium_player_looks')),
  colourRow: Array.from(document.querySelectorAll('#dr-cards .dr-card[data-n="2"] .dr-opts[data-pick="colourway"] button')).map((b) => b.dataset.val),
  summary: document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-summary')?.textContent,
  p1look: window.__playerLooks.get(1),
}));
check(saved.byPlayer.outfit === 'georgian' && saved.byPlayer.body === 'm' && saved.byPlayer.led === 'gold', 'WD-03: Player 2\'s look = Georgian gander, gold light', saved.byPlayer);
check(saved.byPad.outfit === 'georgian' && saved.stored.byPad['pad:054c:0ce6:P2'] && saved.stored.byPlayer['2'], 'WD-03: saved under the pad key AND player 2', Object.keys(saved.stored.byPad));
check(saved.p1look.outfit === 'victorian' && saved.p1look.body === 'm', 'WD-03: P2\'s picks never touch P1\'s look', saved.p1look);
check(saved.colourRow[0] === 'default' && saved.colourRow.includes('g_claret'), 'WD-03: the colour row re-lists the Georgian colourways', saved.colourRow);
check(/Gander · Georgian .* Gold light/.test(saved.summary || ''), 'WD-03: the card summary follows the picks', saved.summary);
let led = await page.evaluate(() => window.__ledCalls);
check(led.some((c) => c.n === 2 && c.lightbar && c.lightbar.r === 255 && c.lightbar.g === 160 && c.lightbar.b === 0 && c.playerLEDs === 0x0a), 'WD-03: the pad in P2 got a gold lightbar + the P2 player LEDs', led.at(-1));
// The settled light pick buzzes P2's pad once (debounced 400 ms): a flash = several lightbar calls.
check(await until(page, () => (window._game.lobby._room.cards.get(2).buzzCount || 0) === 1 && window.__ledCalls.length >= 8), 'WD-03: picking a new light buzzes that pad once', { buzzes: await page.evaluate(() => window._game.lobby._room.cards.get(2).buzzCount), calls: (await page.evaluate(() => window.__ledCalls.length)) });
await cardClick(page, 2, 'button[data-pick="led"][data-val="pink"]');
await cardClick(page, 2, 'button[data-pick="led"][data-val="gold"]');
// Wait for the debounced buzz (a slow headless frame can land it after a fixed
// 700 ms), then give a second one time to show up: once more, never twice.
const buzz2 = await until(page, () => (window._game.lobby._room.cards.get(2).buzzCount || 0) >= 2);
await new Promise((r) => setTimeout(r, 900));
const buzzN = await page.evaluate(() => window._game.lobby._room.cards.get(2).buzzCount);
check(buzz2 && buzzN === 2, 'WD-03: two quick light picks buzz once more, not twice (debounced)', buzzN);
const noteGone = await until(page, () => { const h = document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-hint'); return !!h && h.textContent === ''; }, null, 6000);
check(noteGone, '#623: "Buzzing Player 2\'s controller…" clears once the buzz is over', await page.evaluate(() => document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-hint')?.textContent));
// #611 · the robot outfit: locked behind the Solo Flight reward (all solo achievements but one, #736)
// #736 · a new player: the holiday outfits are locked until their bikes, with the bike's hint
const fresh = await page.evaluate(async () => {
  const { lockedOutfits, outfitLockHint } = await import('/js/rewards.js');
  const { GOOSE_OUTFITS } = await import('/js/goose-outfits.js');
  const l = lockedOutfits(GOOSE_OUTFITS, [], undefined, new Set());
  return { locked: [...l].sort(), hint: outfitLockHint(GOOSE_OUTFITS.georgian, []) };
});
check(fresh.locked.join() === 'cyclists,fancy,georgian,robot' && /^Birthday Express reward: finish Grandma's on /.test(fresh.hint),
  'WD-03h: a new player: Cyclists, Fancy and Georgian wait for their holiday bikes (Victorian is free)', fresh);
const robot = await page.evaluate(() => {
  const b = document.querySelector('#dr-cards .dr-card[data-n="2"] button[data-pick="outfit"][data-val="robot"]');
  return b ? { locked: b.dataset.locked === '1', title: b.title } : null;
});
check(!!robot && robot.locked && /^Solo Flight reward: \d+ of \d+ solo achievements$/.test(robot.title), 'WD-03r: the Robot outfit shows locked with its Solo Flight progress', robot);
await cardClick(page, 2, 'button[data-pick="outfit"][data-val="robot"]');
const lockedPick = await page.evaluate(() => ({ outfit: window.__playerLooks.get(2).outfit, hint: document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-hint')?.textContent }));
check(lockedPick.outfit === 'georgian' && /^Locked: Solo Flight reward/.test(lockedPick.hint || ''), 'WD-03r: picking the locked Robot keeps the outfit and says why', lockedPick);
await page.evaluate(async () => {
  const { soloAchievementIds } = await import('/js/rewards.js');
  const { ACHIEVEMENTS } = await import('/js/achievement-defs.js');
  const ach = window._game.lobby._achievements;
  window.__earnedBackup = new Map(ach._earned);
  for (const id of soloAchievementIds().slice(1)) ach._earned.set(id, { id, earnedAt: 1 });
});
await cardClick(page, 2, 'button[data-pick="outfit"][data-val="robot"]');
check(await until(page, () => window.__playerLooks.get(2).outfit === 'robot'), 'WD-03r: with the Solo Flight reward (all solo but one), the Robot can be worn', await look(page, 2));
await cardClick(page, 2, 'button[data-pick="outfit"][data-val="georgian"]');
await page.evaluate(() => { window._game.lobby._achievements._earned = window.__earnedBackup; });
check(await until(page, () => window.__playerLooks.get(2).outfit === 'georgian'), 'WD-03r: back to Georgian for the rest of the run', await look(page, 2));
const hints = await page.evaluate(() => ({
  shown: [...document.querySelectorAll('#dr-cards .dr-card')].map((el) => [el.dataset.n, !el.querySelector('.dr-stick-hint').hidden, el.querySelector('.dr-stick-hint').textContent]),
  label: document.querySelector('#dr-buzz .dr-buzz-label')?.textContent.replace(/\s+/g, ' ').trim(),
}));
check(hints.shown.length === 2 && hints.shown.every(([, on, t]) => on && /Right stick: look around · R3: reset/.test(t)), 'WD-03: both pad-driven cards show the "Right stick: look around · R3: reset" hint', hints.shown);
check(/^P1 · Buzz a controller$/i.test(hints.label || ''), 'WD-03: the strip label says Player 1 drives it', hints.label);
const noFind = await page.evaluate(() => document.querySelectorAll('#dr-cards button[data-act="find"]').length);
check(noFind === 0, 'WD-03: no FIND MY CONTROLLER button on the cards (the strip replaces it)', noFind);
const scopes = await page.evaluate(() => { const r = window._game.lobby._room; const has = (n) => r.cards.get(n).focus.items.some((el) => el.dataset && el.dataset.buzz); return { p1: has(1), p2: has(2), chips: [...document.querySelectorAll('#dr-buzz-chips button')].map((b) => b.dataset.buzz) }; });
check(scopes.chips.join() === '1,2' && scopes.p1 && !scopes.p2, 'WD-03: the Buzz strip has a chip per pad; only P1\'s pad can reach it', scopes);
check(await until(page, () => { const p = window._game.lobby._room._preview; return p && p.loaded('p2') && p.pathOf('p2') === 'tandem-3d/goose/goose_stoker_georgian_m.glb'; }, null, 60000), 'WD-03: P2\'s preview loads the exact rider the ride will seat (stoker, Georgian gander)', await page.evaluate(() => window._game.lobby._room._preview && window._game.lobby._room._preview.pathOf('p2')));
check(await until(page, () => { const p = window._game.lobby._room._preview; return p && p.loaded('p1') && p.pathOf('p1') === 'tandem-3d/goose/goose_captain.glb'; }, null, 60000), 'WD-03: P1\'s preview is the Victorian captain');
let before = await page.evaluate(() => window.__ledCalls.length);
await page.evaluate(() => document.querySelector('#dr-buzz-chips button[data-buzz="1"]').click());
await new Promise((r) => setTimeout(r, 400));
const b1 = await page.evaluate(() => window._game.lobby._room.cards.get(1).buzzCount || 0);
check((await page.evaluate(() => window.__ledCalls.length)) === before && b1 >= 1, 'WD-03: the P1 chip buzzes P1 only (P2\'s lightbar untouched)', { p1buzzes: b1, p2calls: (await page.evaluate(() => window.__ledCalls.length)) - before });
before = await page.evaluate(() => window.__ledCalls.length);
await page.evaluate(() => document.querySelector('#dr-buzz-chips button[data-buzz="2"]').click());
check(await until(page, (n) => window.__ledCalls.length > n + 2, before), 'WD-03: the P2 chip flashes P2\'s lightbar', (await page.evaluate(() => window.__ledCalls.length)) - before);
check(await until(page, () => /Buzzing Player 2/.test(document.querySelector('#dr-cards .dr-card[data-n="2"] .dr-hint')?.textContent || '')), 'WD-03: P2\'s card says its pad is buzzing');
await h.shot(page, 'wd03-room-both-editing');
// Right stick on P1's pad orbits P1's preview only; R3 resets it and restarts the turntable.
const view = () => page.evaluate(() => { const p = window._game.lobby._room._preview; return { p1: p.viewOf('p1'), p2: p.viewOf('p2') }; });
const v0 = await view();
await pads.stick(0, 'RX', 1.0);
await pads.stick(0, 'RY', -1.0);
check(await until(page, (y0) => { const p = window._game.lobby._room._preview; const v = p.viewOf('p1'); return v && !v.auto && v.yaw > y0 + 0.3 && v.zoom > 0.2; }, v0.p1.yaw), 'WD-03: P1\'s right stick orbits + zooms P1\'s preview and stops its turntable', { before: v0.p1, after: (await view()).p1 });
await pads.stick(0, 'RX', 0);
await pads.stick(0, 'RY', 0);
const held = (await view()).p1;
await new Promise((r) => setTimeout(r, 250));
const still = await view();
check(Math.abs(still.p1.yaw - held.yaw) < 1e-6 && still.p1.zoom === held.zoom && !still.p1.auto, 'WD-03: the view stays where P1 left it (turntable off)', { held, now: still.p1 });
check(still.p2.auto && Math.abs(still.p2.zoom) < 1e-6, 'WD-03: P2\'s preview is unaffected (its turntable still runs, no zoom)', still.p2);
await pads.tap(0, 'RS');
check(await until(page, () => { const v = window._game.lobby._room._preview.viewOf('p1'); return v && v.auto && v.zoom === 0; }), 'WD-03: R3 on P1 resets P1\'s framing and restarts the turntable', (await view()).p1);
// P1 done (B while editing) → Ready; a second B from P1 while P2 edits only nudges P2.
await pads.tap(0, 'B');
check(await until(page, () => window._game.lobby._room.states()[1] === 'ready' && window._game.lobby._room.states()[2] === 'editing'), 'WD-03: B on P1 while editing = P1 Ready; P2 keeps editing', (await room(page)).states);
await pads.tap(0, 'B');
r = await room(page);
check(r.open && r.states[2] === 'editing' && r.nudges[2] >= 1 && !r.back, 'WD-03: B from P1 while P2 edits only nudges P2\'s card (room stays, P2 still editing)', { nudges: r.nudges, states: r.states });
await pads.tap(p2, 'B');
r = await room(page);
check(r.open && r.states[2] === 'ready' && r.back && r.status === '', 'WD-03: B on P2 = Ready (picks kept); everyone ready → BACK TO SEATS shows', r);
check((await look(page, 2)).outfit === 'georgian', 'WD-03: Ready keeps the picks', await look(page, 2));
await h.shot(page, 'wd03-room-all-ready');
await pads.tap(0, 'B');
check(await until(page, () => !window._game.lobby._room && !document.getElementById('dressing-room').open), 'WD-03: B from P1 closes the room once everyone is ready');
check(await page.evaluate(() => window._game.lobby._localSeatedOnHost), 'WD-03: Player 2 is still seated after closing');

console.log('WD-02d disconnect while editing → Ready');
await pads.tap(p2, 'Y');
check(await until(page, () => window._game.lobby._room && window._game.lobby._room.states()[2] === 'editing'), 'WD-02d: P2 reopens the room in Edit');
await pads.unplug(p2);
check(await until(page, () => window._game.lobby._room && window._game.lobby._room.states()[2] === 'ready'), 'WD-02d: unplugging P2 mid-edit counts as Ready', (await room(page)).states);
await pads.replug(p2);
check(await until(page, () => window._game.lobby._localP2InputManager && window._game.lobby._localP2InputManager.gamepadConnected && window._game.lobby._room && document.getElementById('dr-back').style.display !== 'none'), 'WD-02d: P2 pad back and BACK TO SEATS still shows', await room(page));
await page.evaluate(() => document.getElementById('dr-back').click());
check(await until(page, () => !window._game.lobby._room), 'WD-02d: BACK TO SEATS (mouse) closes the room', await room(page));

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

// ── WD-06 · versus: a joiner's Y opens the room; B closes it without leaving ──
console.log('WD-06 versus join screen');
{
  const { page: p, pads: fp } = await open(['xbox']);
  await clickId(p, 'btn-versus');
  await until(p, () => document.getElementById('lobby-flow').current === 'lobby-versus');
  const i = await fp.plug('switchpro');
  await until(p, () => (window._game.lobby._versusCandidates || []).length > 0);
  await fp.tap(i, 'A');
  check(await until(p, () => window._game.lobby._versusPlayers.length === 2), 'WD-06: the Switch Pro joins as player 2');
  check(!(await rowButtons(p, 'versus-wardrobe')).length && /wardrobe/i.test(await p.evaluate(() => document.getElementById('versus-join-hint')?.textContent || '')), 'WD-06: no WARDROBE buttons; the join hint says Y opens the wardrobe');
  await fp.tap(i, 'Y');
  check(await until(p, () => window._game.lobby._room && window._game.lobby._room.states()[2] === 'editing'), 'WD-06: player 2\'s Y opens the room with their card in Edit', await room(p));
  // The camera hint is a pad thing: a card whose player is not on a pad (here: made to look like a phone/keyboard card) hides it.
  const hintRule = await p.evaluate(() => { const r = window._game.lobby._room; const c = r.cards.get(2); const before = !c.el.querySelector('.dr-stick-hint').hidden; c.type = 'keyboard'; r._renderCard(c); const after = !c.el.querySelector('.dr-stick-hint').hidden; c.type = 'gamepad'; r._renderCard(c); return { before, after, restored: !c.el.querySelector('.dr-stick-hint').hidden }; });
  check(hintRule.before && !hintRule.after && hintRule.restored, 'WD-06: the hint shows for a pad-driven card and hides for a keyboard/phone one', hintRule);
  const v0 = await room(p);
  check(v0.teams.length === 2 && v0.teams.some(([t, ns]) => t === 'A' && ns.includes(1)) && v0.teams.some(([t, ns]) => t === 'B' && ns.includes(2)), 'WD-06: cards are grouped by team (P1 blue, P2 red)', v0.teams);
  await fp.tap(i, 'B');
  check(await until(p, () => window._game.lobby._room && window._game.lobby._room.states()[2] === 'ready'), 'WD-06: B on P2 = Ready');
  await fp.tap(i, 'B');
  check(await until(p, () => !window._game.lobby._room), 'WD-06: a second B closes the room');
  const v = await p.evaluate(() => ({ players: window._game.lobby._versusPlayers.length, teams: window._game.lobby._versusTeams().map((t) => t.members.map((m) => m.n)) }));
  check(v.players === 2, 'WD-06: the closing B did not unseat player 2', v);
  check(v.teams.flat().includes(2) && v.teams.flat().includes(1), 'WD-06: the teams payload carries player numbers for the looks', v.teams);
  await h.shot(p, 'wd06-versus');
  await p.close();
}

// ── WD-07 · versus, a shared team, 1080p ──
console.log('WD-07 three-player versus room at 1920×1080');
{
  const p = await h.gamePage({ viewport: { width: 1920, height: 1080 }, storage: STORAGE, before: (pg) => installFakeGamepads(pg, { atBoot: ['xbox'] }) });
  const fp = fakePads(p);
  await until(p, () => !!window.__controllerManager && !!window.__playerLooks);
  await clickId(p, 'btn-versus');
  await until(p, () => document.getElementById('lobby-flow').current === 'lobby-versus');
  const a = await fp.plug('switchpro');
  await until(p, () => (window._game.lobby._versusCandidates || []).length > 0);
  await fp.tap(a, 'A');
  await until(p, () => window._game.lobby._versusPlayers.length === 2);
  const b = await fp.plug('dualsense');
  await until(p, () => (window._game.lobby._versusCandidates || []).length > 0);
  await fp.tap(b, 'A');
  check(await until(p, () => window._game.lobby._versusPlayers.length === 3), 'WD-07: three players seated');
  await fp.tap(b, 'Y');
  check(await until(p, () => window._game.lobby._room && window._game.lobby._room.states()[3] === 'editing'), "WD-07: P3's Y opens the room with their card in Edit");
  // The layout settles over a couple of frames (the wide/narrow switch is a ResizeObserver).
  await until(p, () => { const c = document.querySelector('#dr-cards .dr-card[data-n="3"]'); return !!c && c.hasAttribute('data-wide'); }, null, 4000);
  const lay = await p.evaluate(() => {
    const sheet = document.querySelector('#dressing-room .uf-sheet__body').getBoundingClientRect();
    return [...document.querySelectorAll('#dr-cards .dr-card')].map((c) => {
      const r = c.getBoundingClientRect(), pv = c.querySelector('.dr-preview').getBoundingClientRect();
      return { n: c.dataset.n, state: c.dataset.state, wide: c.hasAttribute('data-wide'), inside: r.top >= sheet.top - 1 && r.bottom <= sheet.bottom + 1 && r.left >= sheet.left - 1 && r.right <= sheet.right + 1,
        overflow: c.scrollHeight - c.clientHeight, previewH: Math.round(pv.height), cardH: Math.round(r.height) };
    });
  });
  check(lay.length === 3 && lay.every((c) => c.inside), 'WD-07: every card sits inside the room', lay);
  const ed = lay.find((c) => c.state === 'editing');
  check(ed && ed.wide && ed.overflow <= 2, 'WD-07: the editing card has the goose beside the pickers and needs no scrolling', ed);
  check(lay.filter((c) => c.state === 'ready').every((c) => c.previewH < c.cardH), 'WD-07: no Ready preview grows past its card', lay);
  await h.shot(p, 'wd07-versus-3p-1080');
  await p.close();
}

// ── WD-08 · four editing at once on a 720p screen; P# badges; one-word colours ──
console.log('WD-08 four players editing at 1280×720');
{
  const p = await h.gamePage({ viewport: { width: 1280, height: 720 }, storage: STORAGE, before: (pg) => installFakeGamepads(pg, { atBoot: ['xbox'] }) });
  const fp = fakePads(p);
  await until(p, () => !!window.__controllerManager && !!window.__playerLooks);
  await clickId(p, 'btn-versus');
  await until(p, () => document.getElementById('lobby-flow').current === 'lobby-versus');
  const idx = [];
  for (const kind of ['switchpro', 'dualsense', 'ds4']) {
    const i = await fp.plug(kind);
    idx.push(i);
    const want = idx.length + 1;
    await until(p, () => (window._game.lobby._versusCandidates || []).length > 0);
    await fp.tap(i, 'A');
    await until(p, (w) => window._game.lobby._versusPlayers.length === w, want);
  }
  check(await until(p, () => window._game.lobby._versusPlayers.length === 4), 'WD-08: four players seated');
  await fp.tap(idx[1], 'Y');
  await until(p, () => window._game.lobby._room && window._game.lobby._room.cards.size === 4);
  // Everyone else presses EDIT too.
  for (const n of [1, 2, 4]) await cardClick(p, n, 'button[data-act="edit"]');
  check(await until(p, () => Object.values(window._game.lobby._room.states()).every((s) => s === 'editing')), 'WD-08: all four cards editing', await room(p));
  // P3 walks down to the last row of their card.
  for (let k = 0; k < 8; k++) { await fp.tap(idx[1], 'DOWN'); await new Promise((r) => setTimeout(r, 120)); }
  await new Promise((r) => setTimeout(r, 500));
  const s = await p.evaluate(() => {
    const c = document.querySelector('#dr-cards .dr-card[data-n="3"]');
    const r = c.getBoundingClientRect(), pv = c.querySelector('.dr-preview').getBoundingClientRect(), done = c.querySelector('.dr-done').getBoundingClientRect();
    const wrap = c.querySelector('.dr-rows-wrap');
    const f = window._game.lobby._room.cards.get(3).focus.focused;
    return { wide: c.hasAttribute('data-wide'), cardScroll: c.scrollTop, wrapScroll: wrap.scrollTop, wrapScrolls: wrap.scrollHeight > wrap.clientHeight + 1,
      previewShows: pv.top >= r.top - 1 && pv.bottom <= r.bottom + 1 && pv.height > 40, doneShows: done.top >= r.top - 1 && done.bottom <= r.bottom + 1,
      focused: f ? (f.dataset.pick || f.dataset.act || f.dataset.buzz) : null };
  });
  check(s.cardScroll === 0 && s.previewShows && s.doneShows, "WD-08: walking down P3's card never scrolls the goose or DONE away (only the pickers scroll)", s);
  // UP until P3's focus is back on the first row (Body), however many outfit lines wrapped.
  const atTop = () => p.evaluate(() => { const f = window._game.lobby._room.cards.get(3).focus.focused; return !!f && f.dataset.pick === 'body'; });
  for (let k = 0; k < 16 && !(await atTop()); k++) { await fp.tap(idx[1], 'UP'); await new Promise((r) => setTimeout(r, 150)); }
  await new Promise((r) => setTimeout(r, 300));
  const back = await p.evaluate(() => { const c = document.querySelector('#dr-cards .dr-card[data-n="3"]'); const f = window._game.lobby._room.cards.get(3).focus.focused; return { cardScroll: c.scrollTop, wrapScroll: c.querySelector('.dr-rows-wrap').scrollTop, focused: f ? (f.dataset.pick || f.dataset.act) + ':' + f.dataset.val : null }; });
  check(back.cardScroll === 0 && back.wrapScroll <= 2, 'WD-08: back up at the first row the pickers scroll back to the top', back);
  const ui = await p.evaluate(() => ({
    badges: [...document.querySelectorAll('#dr-cards .dr-card')].map((c) => (c.querySelector('.dr-who .dr-pnum') || {}).textContent),
    playerWord: [...document.querySelectorAll('#dr-cards .dr-who')].some((w) => /Player\s*\d/.test(w.textContent)),
    colours: [...document.querySelectorAll('#dr-cards .dr-card[data-n="1"] .dr-opts[data-pick="colourway"] button')].map((b) => b.textContent.trim()),
  }));
  check([...ui.badges].sort().join() === 'P1,P2,P3,P4' && !ui.playerWord, 'WD-08: each card shows the P# badge, not "Player #"', ui);
  check(ui.colours.length > 1 && ui.colours.every((t) => /^[A-Z][a-z]+$/.test(t)), 'WD-08: every colour button is one word', ui.colours);
  await h.shot(p, 'wd08-versus-4-editing-720');

  // ── WD-09 · a phone-seated player drives their own card with the phone's menu pad ──
  console.log('WD-09 a phone player edits on the TV');
  const ph = await p.evaluate(() => {
    const live = window._game.lobby._room;
    live.close('test');
    // The phone seat's InputManager in menu mode, as js/remote/phone-pad-host.js leaves it: a
    // gamepad whose buttons are the phone's OK (A) / Back (B) and D-pad.
    const btn = () => ({ pressed: false, value: 0 });
    const pad = { id: 'phone', mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn) };
    const phone = { remoteOnly: true, remotePresent: true, get gamepadConnected() { return this.remotePresent; }, getGamepadState: () => pad, _gpSwapAB: false };
    window.__phonePad = pad;
    const r = new live.constructor({ sheet: document.getElementById('dressing-room'), roster: () => [{ n: 2, input: phone, type: 'gamepad', label: 'Phone', team: null, seat: 'Stoker' }], padKeyFor: () => null, controllerManager: null });
    window.__phoneRoom = r;
    r.show(0);
    const c = r.cards.get(2);
    return { type: c.type, state: c.state, hasFocus: !!c.focus, edit: !!c.el.querySelector('button[data-act="edit"]'), note: !!c.el.querySelector('.dr-note') };
  });
  check(ph.type === 'phone' && ph.state === 'ready' && ph.hasFocus && ph.edit && !ph.note, 'WD-09: a phone player gets a working card (EDIT button, driven by the phone), not "Edit on your phone"', ph);
  const press = (b) => p.evaluate(async (i) => {
    const r = window.__phoneRoom, pad = window.__phonePad;
    const step = () => r.poll(performance.now());
    for (let k = 0; k < 3; k++) step();
    pad.buttons[i] = { pressed: true, value: 1 }; for (let k = 0; k < 3; k++) step();
    pad.buttons[i] = { pressed: false, value: 0 }; for (let k = 0; k < 3; k++) step();
  }, b);
  await press(0);   // OK on EDIT
  const edited = await p.evaluate(() => window.__phoneRoom.states()[2]);
  await press(15);   // D-pad right: the next body
  const moved = await p.evaluate(() => { const f = window.__phoneRoom.cards.get(2).focus.focused; return f ? f.dataset.val : null; });
  await press(1);   // Back = Ready
  const readied = await p.evaluate(() => window.__phoneRoom.states()[2]);
  check(edited === 'editing' && moved && readied === 'ready', "WD-09: the phone's OK edits, its D-pad moves, its Back readies", { edited, moved, readied });
  // #623 · no Controller light row where there is no light to set: a phone, a Steam Controller.
  const lightRows = await p.evaluate(() => {
    const r = window.__phoneRoom;
    const phoneCard = r.cards.get(2);
    r._setState(phoneCard, 'editing');
    const phone = !!phoneCard.el.querySelector('.dr-group[data-group="led"]');
    r._setState(phoneCard, 'ready');
    // A Steam Controller seat: its driver is the one with needsSiblingFanout.
    class SteamControllerDriver { static needsSiblingFanout = true; }
    const pad = window.__phonePad;
    const steamIn = { gamepadConnected: true, getGamepadState: () => pad, _gpSwapAB: false, _controllerDriver: new SteamControllerDriver(), _gpName: 'Steam Controller' };
    const dsIn = { gamepadConnected: true, getGamepadState: () => pad, _gpSwapAB: false, _controllerDriver: {}, _gpName: 'DualSense' };
    const sc = { n: 3, player: { n: 3, input: steamIn, type: 'gamepad', label: 'Steam', team: null, seat: 'Captain' }, type: 'gamepad' };
    const ds = { n: 4, player: { n: 4, input: dsIn, type: 'gamepad', label: 'DualSense', team: null, seat: 'Captain' }, type: 'gamepad' };
    return { phone, steam: r._hasLight(sc), dualsense: r._hasLight(ds) };
  });
  check(!lightRows.phone && !lightRows.steam && lightRows.dualsense, '#623: no Controller light row for a phone or a Steam Controller (a DualSense keeps it)', lightRows);
  await p.evaluate(() => window.__phoneRoom.close('test'));
  await p.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
