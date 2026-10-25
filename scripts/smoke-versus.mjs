#!/usr/bin/env node
// smoke:versus · local split-screen versus with fake pads (docs/test-script.md
// VS-01 … VS-04, VS-06, VS-07).
//
// Pads are fake Gamepad API pads (scripts/lib/fake-gamepads.mjs) going through
// the real ControllerManager and the real versus join screen: a pad joins by
// pressing A, the keyboard joins with its button, CHOOSE LEVEL → START RIDE.
//
//   seats     P1 + three joiners fill P1–P4 in join order, teams alternate
//             (balance), each seat names its own pad and glyph family; a fifth
//             pad is refused (VS-01, VS-04)
//   keyboard  P1 is a keyboard placeholder: the first pad takes P1 (#467), then
//             the keyboard joins as its own player (VS-01, VS-03)
//   races     1v1, 1v2 (keyboard on a duo) and 2v2 each start; two split
//             views per frame, members per rig as seated (VS-02)
//   finish    team red is moved past the finish line (a real ride to the line
//             takes minutes under software WebGL); red wins, the results card
//             names it (VS-06)
//   drop      unplugging a pad mid-race freezes BOTH teams with versus's own
//             notice — not the co-op 20 s take-over — and replugging resumes
//             (VS-07)
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8963, outDir: 'tandemonium-versus' });
const { check } = h;
const STORAGE = { tandemonium_tutorial_done: 'smoke' };

/** Open the game and go TOGETHER → VERSUS. `atBoot` pads exist before load. */
async function openVersus(atBoot) {
  const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, storage: STORAGE, before: (p) => installFakeGamepads(p, { atBoot }) });
  await sleep(1500);
  await clickId(page, 'btn-together');
  await sleep(800);
  await clickId(page, 'btn-versus');
  await page.waitForFunction(() => window._game.lobby._currentStep === window._game.lobby.versusStep, { timeout: 20000 });
  await sleep(600);
  return { page, pads: fakePads(page) };
}

/** Plug a pad and press A so the versus monitor seats it. */
async function join(pads, model, index) {
  const i = await pads.plug(model, index);
  await sleep(500);
  await pads.tap(i, 'A', 200);
  await sleep(500);
  return i;
}

const roster = (page) => page.evaluate(() => {
  const l = window._game.lobby;
  const seats = (team) => Array.from(document.querySelectorAll(`#versus-team-${team} > uf-seat`))
    .filter((s) => s.state === 'joined').map((s) => ({ badge: s.badge, who: s.who }));
  const strip = document.getElementById('versus-roster');
  return {
    players: l._versusPlayers.map((p) => ({ n: p.n, team: p.team, type: p.type, slotId: p.slotId })),
    seatsA: seats('a'), seatsB: seats('b'),
    rows: (strip && strip.rows ? strip.rows : []).filter((r) => r.state === 'seated').map((r) => ({ player: r.player, glyph: r.glyphFamily, short: r.shortName })),
    kbShown: document.getElementById('btn-versus-join-kb').style.display !== 'none',
    canContinue: !document.getElementById('btn-versus-continue').disabled,
    p1Slot: window.__controllerManager.getSlot('P1').state,
  };
});

/** CHOOSE LEVEL → START RIDE → wait for the race to run. */
async function startRace(page) {
  await clickId(page, 'btn-versus-continue');
  await sleep(800);
  await clickId(page, 'btn-start-ride');
  await page.waitForFunction(() => window._game.state === 'playing' && window._game.mode === 'versus', { timeout: 180000 });
  await sleep(1500);
}

const raceInfo = (page) => page.evaluate(() => {
  const g = window._game;
  // Count the viewports one split-screen frame draws.
  const r = g.renderer; const orig = r.setViewport.bind(r); const vps = [];
  r.setViewport = (x, y, w, hh) => { vps.push([x, w]); return orig(x, y, w, hh); };
  g._renderVersusViews();
  r.setViewport = orig;
  const half = vps.filter(([, w]) => w === Math.floor(window.innerWidth / 2));
  return {
    mode: g.mode, state: g.state, rigs: g.versusRigs ? g.versusRigs.length : 0,
    members: g.versusRigs ? g.versusRigs.map((x) => x.members.length) : [],
    halves: half.length, leftRight: half.map(([x]) => x),
  };
});

// ── VS-01 / VS-04: four pads fill P1–P4 in join order, teams balance ──
console.log('seats');
{
  const { page, pads } = await openVersus(['xbox']);
  let r = await roster(page);
  check(r.players.length === 1 && r.players[0].type === 'gamepad' && r.p1Slot === 'claimed', 'P1 auto-seated on the pad plugged in at boot', r.players);
  await join(pads, 'dualsense');
  await join(pads, 'switchpro');
  await join(pads, 'steam');
  r = await roster(page);
  check(JSON.stringify(r.players.map((p) => p.n)) === '[1,2,3,4]', 'joiners take P2, P3, P4 in join order', r.players);
  check(JSON.stringify(r.players.map((p) => p.team)) === '["A","B","A","B"]', 'teams alternate so sizes balance (2 v 2)', r.players.map((p) => p.team));
  check(JSON.stringify(r.players.map((p) => p.slotId)) === '["P1","P2","P3","P4"]', 'each player holds its own manager slot', r.players.map((p) => p.slotId));
  const glyphs = Object.fromEntries(r.rows.map((x) => [x.player, x.glyph]));
  check(glyphs[1] === 'xbox' && glyphs[2] === 'playstation' && glyphs[3] === 'nintendo' && glyphs[4] === 'steam',
    'each seat shows its own glyph family (Xbox, PlayStation, Nintendo, Steam)', glyphs);
  const names = Object.fromEntries(r.rows.map((x) => [x.player, x.short]));
  check(new Set(Object.values(names)).size === 4 && !Object.values(names).some((n) => /^(Controller|Open)$/.test(n || '')), 'each seat names its own controller', names);
  check(r.seatsA.map((s) => s.badge).join() === 'P1,P3' && r.seatsB.map((s) => s.badge).join() === 'P2,P4', 'seat cards: blue P1+P3, red P2+P4', { a: r.seatsA, b: r.seatsB });
  check(!r.kbShown && r.canContinue, 'roster full: keyboard join hidden, CHOOSE LEVEL enabled', r);
  await join(pads, 'generic', 4);   // fake has 4 free slots; index 4 = a fifth pad
  r = await roster(page);
  check(r.players.length === 4, 'a fifth pad is refused', r.players.length);
  await h.shot(page, 'seats-2v2');

  // ── VS-02 (2v2) + VS-07 on this roster ──
  console.log('race 2v2 + drop');
  await startRace(page);
  let v = await raceInfo(page);
  check(v.rigs === 2 && v.members.join() === '2,2', '2v2: two rigs, two riders each', v);
  check(v.halves === 2 && v.leftRight[0] === 0 && v.leftRight[1] > 0, '2v2: each frame draws two split-screen halves', v);
  await h.shot(page, 'race-2v2');

  // Mid-race drop: P4 (the Steam pad, team red) unplugs.
  const dist = () => page.evaluate(() => window._game.versusRigs.map((x) => x.bike.distanceTraveled));
  await pads.unplug(3);
  await sleep(1200);
  const o = await page.evaluate(() => {
    const shown = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.offsetParent !== null; };
    return {
      visible: document.getElementById('disconnect-overlay').style.display !== 'none',
      msg: document.getElementById('disconnect-msg').textContent,
      paused: window._game._versusPaused, drop: window._game._drop,
      alone: shown('btn-ride-alone'), resume: shown('btn-drop-resume'), mode: window._game.mode,
    };
  });
  check(o.visible && o.paused && /disconnected/.test(o.msg) && !/[A-Z]{5,}/.test(o.msg), 'drop: versus freezes with its own notice, naming the pad as its seat card does', o);
  check(o.drop === null && !o.alone && !o.resume && o.mode === 'versus', 'drop: no co-op pause, no 20 s take-over, still versus', o);
  // Count team physics steps: none while frozen, some again after the replug.
  await page.evaluate(() => { const g = window._game; const st = g._stepTeam.bind(g); window.__steps = 0; g._stepTeam = (...a) => { window.__steps++; return st(...a); }; });
  const d0 = await dist(); await sleep(1500); const d1 = await dist();
  const frozenSteps = await page.evaluate(() => window.__steps);
  check(frozenSteps === 0 && d0[0] === d1[0] && d0[1] === d1[1], 'drop: neither team is stepped while frozen', { frozenSteps, d0, d1 });
  await h.shot(page, 'race-2v2-drop');
  await pads.replug(3);
  await pads.tap(3, 'A', 200);
  await sleep(1500);
  const back = await page.evaluate(() => ({ visible: document.getElementById('disconnect-overlay').style.display !== 'none', paused: window._game._versusPaused, state: window._game.state }));
  check(!back.visible && !back.paused && back.state === 'playing', 'drop: replugging resumes the race', back);
  check(await page.evaluate(() => window.__steps) >= 2, 'drop: both teams step again after the replug', await page.evaluate(() => window.__steps));
  await page.close();
}

// ── VS-01 (#467) / VS-03: keyboard P1 placeholder, first pad takes P1, keyboard joins ──
console.log('keyboard');
{
  const { page, pads } = await openVersus([]);
  let r = await roster(page);
  check(r.players.length === 1 && r.players[0].type === 'keyboard' && !r.kbShown, 'no pad at boot: P1 is a keyboard placeholder', r);
  await join(pads, 'xbox');
  r = await roster(page);
  check(r.players.length === 1 && r.players[0].type === 'gamepad' && r.p1Slot === 'claimed', 'the first pad takes P1 (#467), no second seat', r.players);
  check(r.kbShown, 'keyboard join offered once P1 is on a pad', r.kbShown);
  await clickId(page, 'btn-versus-join-kb');
  await sleep(500);
  r = await roster(page);
  check(r.players.length === 2 && r.players[1].type === 'keyboard' && r.players[1].n === 2 && r.players[1].team === 'B', 'keyboard joins as P2 on team red', r.players);
  check(!r.kbShown, 'only one keyboard player', r.kbShown);
  check(r.rows.find((x) => x.player === 2)?.glyph === 'keyboard', 'keyboard seat shows the keyboard glyph', r.rows);
  await join(pads, 'dualsense');
  r = await roster(page);
  check(r.players.length === 3 && r.players[2].n === 3 && r.players[2].team === 'A', 'next pad: P3 on team blue (1v2 → 2v1)', r.players);

  // ── VS-02 (1v2 with a keyboard rider) ──
  console.log('race 1v2');
  await startRace(page);
  const v = await raceInfo(page);
  check(v.rigs === 2 && v.members.join() === '2,1', '1v2: blue duo vs red solo', v);
  check(v.halves === 2, '1v2: two split-screen halves', v);
  await page.close();
}

// ── VS-02 (1v1) + VS-06 finish ──
console.log('race 1v1 + finish');
{
  const { page, pads } = await openVersus(['xbox']);
  await join(pads, 'dualsense');
  const r = await roster(page);
  check(r.players.length === 2 && r.canContinue, '1v1 roster ready', r.players);
  await startRace(page);
  const v = await raceInfo(page);
  check(v.rigs === 2 && v.members.join() === '1,1' && v.halves === 2, '1v1: two solo rigs, two halves', v);
  // Fast-forward: put team red just short of the line and let the race step it over.
  const red = await page.evaluate(() => {
    const rig = window._game.versusRigs[1];
    const total = rig.raceManager.raceDistance;
    rig.bike.distanceTraveled = total + 2;
    return { name: rig.color.name, total };
  });
  await page.waitForFunction(() => window._game.state === 'versusResults', { timeout: 120000 }).catch(() => {});
  const res = await page.evaluate(() => {
    const sheet = document.querySelector('#versus-results uf-sheet');
    return { state: window._game.state, heading: sheet ? sheet.getAttribute('heading') : null, winner: window._game._versusWinner?.id, rematch: !!document.getElementById('vr-rematch'), lobby: !!document.getElementById('vr-lobby') };
  });
  check(res.state === 'versusResults' && res.winner === 'B', 'finish: the team over the line wins', res);
  check(res.heading && res.heading.toLowerCase() === `${red.name} wins!`.toLowerCase(), 'results card names the winning team', { heading: res.heading, red: red.name });
  check(res.rematch && res.lobby, 'results offer REMATCH and LOBBY', res);
  await h.shot(page, 'results');
  await clickId(page, 'vr-lobby');
  await sleep(1200);
  check(await page.evaluate(() => window._game.state === 'lobby' && !window._game.versusRigs), 'LOBBY returns to the lobby and drops the rigs');
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
