#!/usr/bin/env node
// steam-art.mjs — Steam store / library art candidates rendered in-engine (#357).
// One co-op ride to Grandma's with the bot riders, then the finish cinematic is frozen at the moment
// Grandma stands at her door with the present pile and her house behind the bike, and the same staged
// scene is photographed at every Steamworks slot size (its own camera each). Extra sessions take the
// gameplay screenshots Steam wants five of (a crash, a versus split screen).
//   node scripts/reel/steam-art.mjs                   everything -> assets/steam-candidates/plates/
//   node scripts/reel/steam-art.mjs hero,main         just these slots
//   node scripts/reel/steam-art.mjs crash,versus      just these screenshot sessions
// Then: node scripts/reel/steam-art-compose.mjs       (title lettering, downsizes, size checks)
import fs from 'node:fs';
import path from 'node:path';
import { launch, advance, sleep } from './lib.mjs';

const PORT = 8951;
const OUT = path.join(process.cwd(), 'assets', 'steam-candidates', 'plates');
const STORAGE = { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' };
const SWAY = { cap: { amp: 0.5, freq: 0.31, phase: 0 }, sto: { amp: 0.5, freq: 0.43, phase: 1 } };
/** seconds after the line before the still (presents land in ~0.1 n + 0.75 s; Grandma's stroll ~3 s) */
const SETTLE = Number(process.env.SETTLE || 4.6);
/** metres past the line the bike rolls before it is frozen (so the house and pile sit behind the riders) */
const PAST = Number(process.env.PAST || 2);
// the pair from the 2D key art (images/large_action_*.png): the tweed-and-bowler captain with the lady in
// the red bustle dress (in-game that's the 'victorian' captain + the 'fancy' stoker)
const RIDERS = { Captain: 'tandem-3d/goose/goose_captain.glb', Stoker: 'tandem-3d/goose/goose_stoker.glb' };

// ---------------------------------------------------------------- slots
// w,h = pixels Steam wants; dpr = render scale (small slots are rendered at 2x and downsized later).
// cam = page-bot camera: deg 0 = straight in front of the bike, negative = the side away from the house
// (as it works out on this bike); dist/h/look in bike metres; look lifts the aim point, so a bigger look
// drops the riders in the frame (sky above them for the lettering); side > 0 pushes the riders right.
const SLOTS = {
  // no text, no logo: the riders + Grandma must sit inside Steam's centred safe box (1720x760 of 3840x1240),
  // right of centre since Steam's own logo layer lands bottom-left
  hero:      { w: 3840, h: 1240, dpr: 2, cam: { deg: -20, dist: 9.0, h: 1.0, look: 0.35, side: 0.2,  fov: 30 } },
  // lettering slots: riders low and right, open sky top-left (header, main) or top (vertical, library)
  header:    { w: 920,  h: 430,  dpr: 2, cam: { deg: -20, dist: 6.2, h: 0.5, look: 1.5,  side: 1.2,  fov: 38 } },
  main:      { w: 1232, h: 706,  dpr: 2, cam: { deg: -20, dist: 6.0, h: 0.6, look: 1.4,  side: 0.7,  fov: 40 } },
  vertical:  { w: 748,  h: 896,  dpr: 2, cam: { deg: -18, dist: 6.0, h: 0.8, look: 1.5,  side: 0.0,  fov: 50 } },
  library:   { w: 600,  h: 900,  dpr: 2, cam: { deg: -18, dist: 6.2, h: 0.8, look: 1.6,  side: 0.0,  fov: 52 } },
  // library header: no text, so a balanced frame (also the ground under the small capsule's lettering)
  libheader: { w: 920,  h: 430,  dpr: 2, cam: { deg: -20, dist: 5.6, h: 0.8, look: 0.55, side: -0.8, fov: 34 } },
  // page background: a wide ambient view (blurred and darkened by the compose step)
  pagebg:    { w: 1438, h: 810,  dpr: 1, cam: { deg: -24, dist: 8.5, h: 1.4, look: 0.4,  side: -0.8, fov: 36 } },
};
// gameplay screenshots (1920x1080) on the Grandma's ride: chase cam + HUD as played, at these seconds after GO
const SHOTS = { screenshot1: 7, screenshot2: 15, screenshot3: 20, screenshot6: 1 };
const SESSIONS = { crash: crashShot, versus: versusShot };

/** Start the co-op ride on Grandma's with both bots riding (and collecting). */
async function ride({ level = 'grandma', difficulty = 'chill' } = {}) {
  const s = await launch({ storage: STORAGE, port: PORT, width: 1920, height: 1080, query: '?quality=high' });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(async (o) => {
    const g = window._game, R = window.__reel, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
    L.selectedDifficulty = o.difficulty;
    L._hideLobby();
    const p2 = R.newInput();
    g._onLocalReady({ inputP2: p2, sourceType: 'keyboard' });
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: 3.4, collect: true });
    R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: 3.4, collect: true });
  }, { sway: SWAY, level, difficulty });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await page.evaluate(async (pair) => { const g = window._game; await g.bike.setGooseRiders(pair); }, RIDERS);
  await sleep(500);
  await page.evaluate(() => window.__reel.gameplayHud());
  await advance(page, 4);   // countdown
  return s;
}

async function slots(want) {
  const s = await ride();
  const { page } = s;
  // ride to the line, grabbing gameplay screenshots on the way
  let t = 0;
  for (let k = 0; k < 1200; k++) {
    const st = await page.evaluate(() => window._game.state);
    if (st === 'finishCinematic') break;
    for (const [name, at] of Object.entries(SHOTS)) {
      if (t <= at && t + 0.5 > at) await still(page, name, 1920, 1080, 1);
    }
    await advance(page, 0.5); t += 0.5;
  }
  console.log('  finish reached at', t, 's; Grandma ready:', await page.evaluate(() => !!(window._game.world._grandmaFinish && window._game.world._grandmaFinish.grandma.ready)));

  // freeze the cinematic: the state never leaves finishCinematic, the presents fly into the pile and
  // Grandma walks to the line in real time...
  await page.evaluate(() => { const c = window._game._finishCinematic; if (c) { c.update = () => false; c.getTimeScale = () => 1; } });
  // ...but first let the bike roll on at full speed to PAST metres beyond the line, then hold it there
  for (let k = 0; k < 100; k++) {
    const p = await page.evaluate(() => { const b = window._game.bike; return { d: b.distanceTraveled, v: b.speed, line: window._game.raceManager.raceDistance }; });
    if (p.d >= p.line + PAST || p.v < 0.3) { console.log('  bike held at', p); break; }
    await advance(page, 0.05);
  }
  await page.evaluate(() => { const c = window._game._finishCinematic; if (c) c.getTimeScale = () => 1e-4; });
  await advance(page, SETTLE);
  console.log('  scene:', JSON.stringify(await page.evaluate(() => {
    const g = window._game, w = g.world, gf = w._grandmaFinish;
    const P = (o) => o && o.position ? [+o.position.x.toFixed(1), +o.position.z.toFixed(1)] : null;
    const house = w._raceMarkers.find(m => m.house);
    return { bike: P(g.bike.group), heading: +g.bike.heading.toFixed(2), house: house && P(house.mesh), houseVisible: house && house.mesh.visible,
      grandma: gf && gf.grandma && P(gf.grandma.group || gf.grandma.mesh || gf.grandma.root), presents: g.raceManager.collectiblesCount };
  })));
  await page.evaluate(() => window.__reel.clean(true));
  await advance(page, 0.1);

  for (const k of want) {
    const sl = SLOTS[k];
    await page.evaluate((c) => window.__reel.setCamera({ stiff: 1, keys: [{ t: 0, ...c }] }), sl.cam);
    await still(page, k, sl.w, sl.h, sl.dpr);
  }
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
}

/** screenshot4: the crash beat, as played. Both riders lean the same way at once and over they go. */
async function crashShot() {
  const s = await ride({ difficulty: 'adventurous' });
  await advance(s.page, 9);
  await s.page.evaluate(() => { for (const b of window.__reel.bots) { b.extra = 1; b.steer = 0; b.sway = { amp: 0, freq: 0, phase: 0 }; } });
  await advance(s.page, Number(process.env.CRASH_AT || 1.1));
  await still(s.page, 'screenshot4', 1920, 1080, 1);
  await advance(s.page, 0.6);
  await still(s.page, 'screenshot4b', 1920, 1080, 1);
  await s.close();
}

/** screenshot5: Versus, split screen 2 v 2, all four riders bots (as scripts/reel/shots.mjs does it). */
async function versusShot() {
  const s = await launch({ storage: STORAGE, port: PORT, width: 1920, height: 1080, query: '?quality=high' });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(() => {
    const g = window._game, R = window.__reel;
    g.lobby._hideLobby();
    const ins = [g.input, R.newInput(), R.newInput(), R.newInput()];
    const mem = (i, n) => ({ input: ins[i], type: 'keyboard', slotId: i === 0 ? 'P1' : null, name: n, isP1: i === 0 });
    g._onVersusReady({ teams: [{ id: 'A', members: [mem(0, 'P1'), mem(1, 'P2')] }, { id: 'B', members: [mem(2, 'P3'), mem(3, 'P4')] }] });
    window.__vsInputs = ins;
  });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.versusRigs && window._game.versusRigs.every(r => r.bike.modelLoaded), { timeout: 120000 });
  await page.evaluate(() => {
    const g = window._game, R = window.__reel, ins = window.__vsInputs;
    g.versusRigs.forEach((rig, k) => {
      R.attach(ins[k * 2], () => rig.bike, { role: 'captain', offset: k ? 0.9 : -0.9, cadence: k ? 3.3 : 3.1, sway: { amp: 0.6, freq: 0.3 + k * 0.05, phase: k } });
      R.attach(ins[k * 2 + 1], () => rig.bike, { role: 'stoker', offset: k ? 0.9 : -0.9, cadence: k ? 3.3 : 3.1, sway: { amp: 0.6, freq: 0.41 - k * 0.04, phase: 2 + k } });
    });
    R.gameplayHud();
  });
  await advance(page, 4 + 8);
  await still(page, 'screenshot5', 1920, 1080, 1);
  await s.close();
}

/** Resize the viewport to w/dpr x h/dpr at `dpr`, draw one frame, save a PNG of exactly w x h. */
async function still(page, name, w, h, dpr) {
  const vw = Math.round(w / dpr), vh = Math.round(h / dpr);
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dpr });
  await page.evaluate(() => { window.dispatchEvent(new Event('resize')); if (window._game.renderer) window._game.renderer.setPixelRatio(window._game._pixelRatio()); });
  await sleep(150);
  await advance(page, 2 / 60);   // two frames: the camera override settles, the canvas is redrawn at the new size
  const client = await page.createCDPSession();
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: vw, height: vh, scale: dpr }, captureBeyondViewport: false });
  await client.detach();
  const f = path.join(OUT, `${name}_${w}x${h}.png`);
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  console.log('  ->', f, (fs.statSync(f).size / 1e6).toFixed(2), 'MB');
}

fs.mkdirSync(OUT, { recursive: true });
const want = (process.argv[2] || [...Object.keys(SLOTS), ...Object.keys(SESSIONS)].join(',')).split(',');
const bad = want.filter(k => !SLOTS[k] && !SESSIONS[k]);
if (bad.length) console.log('unknown:', bad.join(','));
const wantSlots = want.filter(k => SLOTS[k]);
if (wantSlots.length) { console.log('== slots', wantSlots.join(',')); try { await slots(wantSlots); } catch (e) { console.log('  FAILED', e.message); } }
for (const k of want.filter(k => SESSIONS[k])) { console.log('==', k); try { await SESSIONS[k](); } catch (e) { console.log('  FAILED', k, e.message); } }
process.exit(0);
