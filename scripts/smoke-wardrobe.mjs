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
check(await until(page, () => document.querySelectorAll('#host-wardrobe uf-button').length === 2), 'WD-01: a WARDROBE button for P1 and P2 under the seats', await rowButtons(page, 'host-wardrobe'));
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
  check(await until(p, () => document.querySelectorAll('#versus-wardrobe uf-button').length === 2), 'WD-06: WARDROBE buttons for both players', await rowButtons(p, 'versus-wardrobe'));
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

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
