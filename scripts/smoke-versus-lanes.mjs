#!/usr/bin/env node
// smoke:versus-lanes · the Versus playtest fixes of 2026-11-21, against the real game.
//   VL-01  #837 Versus Bots: each model is drawn where its physics is, Team A on the left of the screen, B on the right
//   VL-02  #837 couch Versus (with the goose tandem) starts the same way
//   VL-03  #837 the bots hold their side through the race, and a remount returns to it
//   VL-04  #839 contact follows each bike's real length, in one path for both modes
//   VL-05  #838 the controller overlay has no tile for a bot
//   VL-06  #840 the Garage warps the Daily Launch's day, by pad-ready buttons, and shares it with the Daily Ride card
//   VL-07  #843 a Tourist ride shows no countdown
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { soloAchievementIds, timeWarpProgress } from '../js/rewards.js';
import { ACHIEVEMENTS } from '../js/achievement-defs.js';

const h = await startHarness({ port: 8986 });
const { check } = h;
const all = ACHIEVEMENTS.map((a) => a.id);
void soloAchievementIds; void timeWarpProgress;
const page = await h.gamePage({ viewport: { width: 1280, height: 720 }, storage: {
  tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on',
  tandemonium_achievements: JSON.stringify(all.map((id) => ({ id, earnedAt: 1 }))),
} });
await page.waitForFunction(() => window._game?.lobby?._presetKeys?.length > 1, { timeout: 60000 });

const start = (bikeKey, bots) => page.evaluate(async ({ bikeKey, bots }) => {
  const g = window._game, l = g.lobby;
  const { getLevelById } = await import('/js/race-config.js');
  l._pendingMode = 'versus';
  l.selectedLevel = l.resolveRoadLevel(getLevelById('grandma'));
  l.selectedDifficulty = 'adventurous';
  l.pickBot('bolt');
  const teams = l._versusBotTeams();
  teams[0].bike = bikeKey; teams[1].bike = bikeKey;
  if (!bots) teams[1].members = [{ ...teams[1].members[0], botId: undefined, type: 'keyboard', slotId: null }];
  l._hideLobby();
  l.onVersusReady({ teams, botTier: bots ? 'easy' : null });
  g._renderVersusViews = () => {};
  g._startVersusCountdown();
  const t0 = performance.now();
  while (!g.versusRigs.every((r) => r.bike.modelLoaded && r.bike.ridersSettled) && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 150));
  for (const r of g.versusRigs) { r.resetForRace(); r.bike.group.updateMatrixWorld(true); }
  g.state = 'playing';
}, { bikeKey, bots });

const sides = () => page.evaluate(async () => {
  const THREE = await import('three');
  const g = window._game, [a, b] = g.versusRigs;
  const cam = a.camera;
  a.chaseCamera.initialized = false;
  a.chaseCamera.update(a.bike, 1 / 60, g.world.roadPath);
  cam.updateMatrixWorld(true);
  const screenX = (r) => r.bike.group.children[0].getWorldPosition(new THREE.Vector3()).project(cam).x;
  // sideways only: a model's height above its origin is its own
  const drawn = (r) => { const m = r.bike.group.children[0].getWorldPosition(new THREE.Vector3()), p = r.bike.group.position; return Math.hypot(m.x - p.x, m.z - p.z); };
  return { aX: screenX(a), bX: screenX(b), aOff: drawn(a), bOff: drawn(b),
    gap: Math.hypot(a.bike.position.x - b.bike.position.x, a.bike.position.z - b.bike.position.z), lengths: [a.bike.contactLength, b.bike.contactLength] };
});
const leave = () => page.evaluate(async () => {
  const g = window._game;
  delete g._renderVersusViews;
  g._returnToLobby();
  await new Promise((r) => setTimeout(r, 300));
});

console.log('VL-01 Versus Bots');
await start('solo_flight', true);
const vb = await sides();
check(vb.aOff < 0.1 && vb.bOff < 0.1, 'VL-01: each Solo Flight is drawn where its physics is', vb);
check(vb.aX < vb.bX && vb.gap > 2, 'VL-01: Team A on the left of the screen, Team B on the right, clearly apart', vb);
check(vb.lengths.every((l) => l > 5.4 && l < 5.9), 'VL-04: contact uses the Solo Flight\'s real length', vb.lengths);

console.log('VL-03 the bots keep their side');
const lane = await page.evaluate(() => {
  const g = window._game, b = g.versusRigs[1], lanes = [];
  for (let f = 0; f < 60 * 10; f++) { g._updateVersus(1 / 60); if (f > 120 && !b.bike.fallen) lanes.push(b.bike._lateralOffset); }
  const mean = lanes.reduce((x, y) => x + y, 0) / lanes.length;
  return { mean, want: b.lateralOffset, moved: b.bike.distanceTraveled };
});
check(lane.moved > 20 && Math.sign(lane.mean) === Math.sign(lane.want) && Math.abs(lane.mean - lane.want) < 0.8, 'VL-03: the bots ride on their own side', lane);
const remount = await page.evaluate(() => {
  const g = window._game, r = g.versusRigs[1], b = r.bike;
  b._fall ? b._fall() : (b.fallen = true);
  for (let f = 0; f < 60 * 8 && b.fallen; f++) g._updateVersus(1 / 60);
  for (let f = 0; f < 2; f++) g._updateVersus(1 / 60);
  return { fallen: b.fallen, lateral: b._lateralOffset, want: r.lateralOffset };
});
check(!remount.fallen && Math.sign(remount.lateral) === Math.sign(remount.want) && Math.abs(remount.lateral - remount.want) < 0.9, 'VL-03: a remount returns to the team\'s side', remount);

console.log('VL-05 overlay');
const tiles = await page.evaluate(() => {
  const g = window._game;
  const roster = g.controllerHud._roster({ state: 'playing', mode: 'versus', manager: g.controllerManager, versusRigs: g.versusRigs, input: g.input, pads: [] });
  return { n: roster.length, humans: g.versusRigs.flatMap((r) => r.members).filter((m) => m.type !== 'bot').length, keyboardBots: roster.filter((e) => e.seat === 'KEYBOARD' && e.key.startsWith('B:')).length };
});
check(tiles.n === tiles.humans && tiles.keyboardBots === 0, 'VL-05: only the human has a tile', tiles);
await leave();

console.log('VL-02 couch Versus');
await start('default', false);
const couch = await sides();
check(couch.aOff < 0.1 && couch.bOff < 0.1 && couch.aX < couch.bX && couch.gap > 2, 'VL-02: couch Versus starts left and right too', couch);
check(couch.lengths.every((l) => Math.abs(l - 4.4) < 0.1), 'VL-04: the goose tandem keeps its 4.4 m', couch.lengths);
await leave();

console.log('VL-06 Time Warp in the Garage');
const warp = await page.evaluate(async () => {
  const g = window._game;
  const T = await import('/js/time-warp.js');
  T.leaveWarp();
  g._openSlingGarage();
  await new Promise((r) => setTimeout(r, 200));
  const q = (w) => document.querySelector(`#sling-garage-body [data-warp="${w}"]`);
  const before = { key: T.playDayKey(), back: !!q('back'), fwd: q('forward')?.textContent };
  q('forward').click();
  await new Promise((r) => setTimeout(r, 200));
  const after = { warp: T.warpDays(), key: T.playDayKey(), back: !!q('back'), daily: [...document.querySelectorAll('#sling-garage-body uf-button, #sling-garage-body button')].map((b) => b.textContent).find((t) => /DAILY LAUNCH/.test(t)), focus: g._overlayFocus?.focusedEl?.dataset?.warp };
  q('back').click();
  await new Promise((r) => setTimeout(r, 200));
  const end = { warp: T.warpDays(), back: !!q('back') };
  g._clearOverlayButtons();
  g._returnToLobby();
  return { before, after, end };
});
check(/Warp to tomorrow/.test(warp.before.fwd || '') && !warp.before.back, 'VL-06: the Garage offers Warp to tomorrow', warp.before);
check(warp.after.warp === 1 && warp.after.key !== warp.before.key && warp.after.back && /⏳ \+1/.test(warp.after.daily || ''), 'VL-06: a press moves the Daily Launch one day', warp.after);
check(warp.end.warp === 0 && !warp.end.back, 'VL-06: Back to today returns', warp.end);

console.log('VL-07 Tourist timer');
const timer = await page.evaluate(() => {
  const g = window._game, el = g.hud.timerEl;
  el.textContent = '31208s';
  const wasT = g.isTourist;
  g.isTourist = true;
  const shown = g._showsSegmentTimer();
  const text = el.textContent;
  g.isTourist = wasT;
  return { shown, text };
});
check(!timer.shown && timer.text === '', 'VL-07: a Tourist ride shows no countdown', timer);
await h.finish();
