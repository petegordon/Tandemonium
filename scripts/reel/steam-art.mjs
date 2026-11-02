#!/usr/bin/env node
// steam-art.mjs — Steam store / library art + screenshots rendered in-engine (#357).
// Art: one co-op ride to Grandma's with the bot riders, then the finish cinematic is frozen at the moment
// Grandma stands at her door with the present pile and her house behind the bike, and the same staged
// scene is photographed at every Steamworks slot size (its own camera each, a couple of the world's own
// clouds moved into the sky behind the lettering).
// Screenshots: gameplay as played (the game's own cameras + HUD; achievement toasts, coach prompts, the
// BOOST ribbon and the CHECK POINT flash hidden), one session each:
//   finish  1 the finish at Grandma's: presents fly to the pile, Grandma at her door
//   chase   2 chase cam, the cyclists leaning past the roadside geese
//   crash   3 the crash: rag-doll geese, the tandem coming apart
//   versus  4 Versus split screen, 2 v 2
//   daily   5 local co-op on Today's Road (the Georgian pair)
//   lobby   6 the TV lobby: geese backdrop + bike chooser
//   start   7 the start at Your Home (the Fancy pair)
// Each session keeps its candidate frames in plates/candidates/ and copies the PICK to plates/screenshotN.
//   node scripts/reel/steam-art.mjs                   everything -> assets/steam-candidates/plates/
//   node scripts/reel/steam-art.mjs hero,main         just these slots
//   node scripts/reel/steam-art.mjs crash,versus      just these screenshot sessions
// Then: node scripts/reel/steam-art-compose.mjs       (title lettering, downsizes, size checks)
import fs from 'node:fs';
import path from 'node:path';
import { launch, advance, sleep } from './lib.mjs';

const PORT = 8951;
const OUT = path.join(process.cwd(), 'assets', 'steam-candidates', 'plates');
const CAND = path.join(OUT, 'candidates');
const STORAGE = { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' };
const SWAY = { cap: { amp: 0.5, freq: 0.31, phase: 0 }, sto: { amp: 0.5, freq: 0.43, phase: 1 } };
/** seconds after the line before the still (presents land in ~0.1 n + 0.75 s; Grandma's stroll ~3 s) */
const SETTLE = Number(process.env.SETTLE || 4.6);
/** metres past the line the bike rolls before it is frozen (so the house and pile sit behind the riders) */
const PAST = Number(process.env.PAST || 2);
/** world pose the bike is pinned to for the art (Grandma's, seed 42; logged as 'scene' on the framing run) */
const POSE = { x: 93.7, z: 210.6, heading: 1.33 };
const G = 'tandem-3d/goose/';
// the pair from the 2D key art (images/large_action_*.png): the tweed-and-bowler captain with the lady in
// the red bustle dress (in-game that's the 'victorian' captain + the 'fancy' stoker)
const RIDERS = { Captain: G + 'goose_captain.glb', Stoker: G + 'goose_stoker.glb' };
// the other Goose Outfits pairs (js/goose-outfits.js), for variety across the screenshots
const CYCLISTS = { Captain: G + 'goose_captain_cyclist.glb', Stoker: G + 'goose_stoker_cyclist.glb' };
const GEORGIAN = { Captain: G + 'goose_captain_georgian.glb', Stoker: G + 'goose_stoker_georgian.glb' };
const FANCY = { Captain: G + 'goose_captain_fancy.glb', Stoker: G + 'goose_stoker.glb' };
// screenshots: no toasts / coach line / sprint prompt / BOOST ribbon / CHECK POINT flash over the frame
const SHOT_CSS = '#achievement-toast-container, .achievement-toast, .info-toast, #checkpoint-flash, #coop-coach, #boost-ribbon, #status, #crank-fight-stamp, .pedal-touch { display: none !important; }';

// ---------------------------------------------------------------- slots
// w,h = pixels Steam wants; dpr = render scale (small slots are rendered at 2x and downsized later).
// cam = page-bot camera: deg 0 = straight in front of the bike, negative = the side away from the house
// (as it works out on this bike); dist/h/look in bike metres; look lifts the aim point, so a bigger look
// drops the riders in the frame (sky above them for the lettering); side > 0 pushes the riders right.
// clouds = NDC spots (x, y in -1..1) the world's clouds are moved to for this camera (dist = metres out).
const SKY_WIDE = [{ x: -0.55, y: 0.55, dist: 160, scale: 1.3 }, { x: 0.55, y: 0.8, dist: 200, scale: 1 }];
const SKY_TALL = [{ x: -0.3, y: 0.7, dist: 170, scale: 1.2 }, { x: 0.6, y: 0.3, dist: 200, scale: 0.9 }];
const SLOTS = {
  // no text, no logo: the riders + Grandma must sit inside Steam's centred safe box (1720x760 of 3840x1240);
  // Steam's own logo layer lands bottom-left
  hero:      { w: 3840, h: 1240, dpr: 2, cam: { deg: -12, dist: 9.0, h: 1.0, look: 0.15, side: -0.3, fov: 32 },
    clouds: [{ x: -0.6, y: 0.6, dist: 200, scale: 1.2 }, { x: 0.15, y: 0.8, dist: 220, scale: 1 }] },
  // lettering slots: riders low and right, open sky (with clouds) top-left (header, main) or top (vertical, library)
  header:    { w: 920,  h: 430,  dpr: 2, cam: { deg: -12, dist: 5.8, h: 0.5, look: 0.8,  side: 1.35, fov: 40 }, clouds: [{ x: -0.5, y: 0.45, dist: 160, scale: 1.3 }] },
  main:      { w: 1232, h: 706,  dpr: 2, cam: { deg: -12, dist: 6.0, h: 0.6, look: 0.92, side: 1.05, fov: 42 }, clouds: SKY_WIDE },
  vertical:  { w: 748,  h: 896,  dpr: 2, cam: { deg: -12, dist: 6.6, h: 0.8, look: 1.15, side: -0.5, fov: 50 }, clouds: SKY_TALL },
  library:   { w: 600,  h: 900,  dpr: 2, cam: { deg: -12, dist: 6.6, h: 0.8, look: 1.25, side: -0.6, fov: 52 }, clouds: SKY_TALL },
  // library header: no text, so a balanced frame (also the ground under the small capsule's lettering)
  libheader: { w: 920,  h: 430,  dpr: 2, cam: { deg: -12, dist: 5.2, h: 0.8, look: 0.55, side: -0.4, fov: 36 }, clouds: [{ x: -0.6, y: 0.65, dist: 180, scale: 1 }] },
  // page background: a wide ambient view (blurred and darkened by the compose step)
  pagebg:    { w: 1438, h: 810,  dpr: 1, cam: { deg: -16, dist: 8.5, h: 1.4, look: 0.4,  side: -0.8, fov: 36 }, clouds: SKY_WIDE },
};
// which candidate frame each screenshot session keeps (index into its candidates, see each session)
const PICK = { finish: 2, chase: 2, crash: 0, versus: 2, daily: 1, lobby: 0, start: 0 };
const SESSIONS = { finish: finishShot, chase: chaseShot, crash: crashShot, versus: versusShot, daily: dailyShot, lobby: lobbyShot, start: startShot };

/** Start a local co-op ride with both bots riding (and collecting). */
async function ride({ level = 'grandma', difficulty = 'chill', riders = RIDERS, sway = SWAY, cadence = 3.4, collect = true } = {}) {
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
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: o.cadence, collect: o.collect });
    R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: o.cadence, collect: o.collect });
  }, { sway, level, difficulty, cadence, collect });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  // the outfit is swapped on the bike (a saved Goose Outfits choice other than the default stalls this boot path)
  if (riders) await page.evaluate(async (pair) => { await window._game.bike.setGooseRiders(pair); }, riders);
  await sleep(500);
  await page.evaluate((css) => {
    window.__reel.gameplayHud();
    const st = document.createElement('style'); st.id = 'steam-shot-style'; st.textContent = css; document.head.appendChild(st);
  }, SHOT_CSS);
  await advance(page, 4);   // countdown
  return s;
}

/** Ride on to the finish line (fine steps near it), every present on the road in the sack. */
async function rideToFinish(page) {
  for (let k = 0; k < 2400; k++) {
    const p = await page.evaluate(() => {
      const g = window._game, cm = g.collectibleManager, left = g.raceManager.raceDistance - g.bike.distanceTraveled;
      // a full sack: the pile shows every present on the road (the bots miss a few to the lean)
      if (left < 15 && cm) { const n = cm._items.length; cm.collected = Math.max(cm.collected, n); g.raceManager.collectiblesCount = Math.max(g.raceManager.collectiblesCount, n); }
      return { state: g.state, left };
    });
    if (p.state === 'finishCinematic') return;
    await advance(page, p.left > 25 ? 0.5 : 1 / 60);
  }
}

async function slots(want) {
  const s = await ride();
  const { page } = s;
  await rideToFinish(page);
  console.log('  finish reached; Grandma ready:', await page.evaluate(() => !!(window._game.world._grandmaFinish && window._game.world._grandmaFinish.grandma.ready)));

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
  // the ride is not frame-exact (model loads run on the real clock), so where the bike stops varies by a metre or two
  // and a few degrees: pin it to the pose the slot cameras were framed on (bike just past the line, Grandma and the
  // pile beside it, her house behind)
  await page.evaluate((pose) => { const b = window._game.bike; b.position.x = pose.x; b.position.z = pose.z; b.heading = pose.heading; b.lean = 0; b.speed = 0; }, POSE);
  await advance(page, SETTLE);
  console.log('  scene:', JSON.stringify(await page.evaluate(() => {
    const g = window._game, w = g.world, gf = w._grandmaFinish;
    const P = (o) => o && o.position ? [+o.position.x.toFixed(1), +o.position.z.toFixed(1)] : null;
    const house = w._raceMarkers.find(m => m.house);
    return { bike: P(g.bike.group), heading: +g.bike.heading.toFixed(2), house: house && P(house.mesh), houseVisible: house && house.mesh.visible,
      grandma: gf && gf.grandma && P(gf.grandma.group || gf.grandma.mesh || gf.grandma.root), presents: gf && gf.stack && gf.stack.count };
  })));
  await page.evaluate(() => window.__reel.clean(true));
  await advance(page, 0.1);
  await installCloudStager(page);

  for (const k of want) {
    const sl = SLOTS[k];
    await page.evaluate((c) => window.__reel.setCamera({ stiff: 1, keys: [{ t: 0, ...c }] }), sl.cam);
    // draw once at the slot's shape so the override camera exists, then move the clouds into its sky
    await page.setViewport({ width: Math.round(sl.w / sl.dpr), height: Math.round(sl.h / sl.dpr), deviceScaleFactor: sl.dpr });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await advance(page, 2 / 60);
    await page.evaluate((spots) => window.__stageClouds(spots), sl.clouds || []);
    await still(page, k, sl.w, sl.h, sl.dpr);
  }
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
}

/** window.__stageClouds(spots): move a few of the world's clouds to NDC spots of the override camera. */
async function installCloudStager(page) {
  await page.evaluate(() => {
    window.__stageClouds = (spots) => {
      const w = window._game.world, cam = window.__reel.camState && window.__reel.camState.cam;
      if (!cam || !w._cloudPool) return;
      const vis = w._cloudPool.find(c => c.active && c.group.visible);   // its roadD keeps the moved ones visible
      const pool = w._cloudPool.filter(c => c !== vis);
      for (const c of window.__staged || []) { c.group.position.copy(c._orig); c.group.scale.setScalar(1); }
      window.__staged = [];
      spots.forEach((sp, i) => {
        const c = pool[pool.length - 1 - i];
        if (!c._orig) c._orig = c.group.position.clone();
        const p = cam.position.clone();
        const dir = p.clone().set(sp.x, sp.y, 0.5).unproject(cam).sub(cam.position).normalize();
        c.group.position.copy(p.addScaledVector(dir, sp.dist || 120));
        c.group.scale.setScalar(sp.scale || 1);
        if (vis) c.roadD = vis.roadD;
        c.active = true; c.group.visible = true;
        window.__staged.push(c);
      });
    };
  });
}

/** Save candidate frames `name_<i>`; the PICK one also becomes plates/<out>_1920x1080.png. */
async function candidates(page, session, out, times) {
  let t = 0;
  for (let i = 0; i < times.length; i++) {
    await advance(page, times[i] - t); t = times[i];
    const f = await still(page, `${session}_${i}`, 1920, 1080, 1, CAND);
    if (i === PICK[session]) { fs.copyFileSync(f, path.join(OUT, `${out}_1920x1080.png`)); console.log('  picked', session, i, '->', out); }
  }
}

/** 1: the finish at Grandma's, the game's own finish cinematic: presents flying to the pile, Grandma at her door. */
async function finishShot() {
  const s = await ride();
  await rideToFinish(s.page);
  await candidates(s.page, 'finish', 'screenshot1', [0.8, 0.95, 1.1, 1.25, 1.4]);
  await s.close();
}

/** 2: chase cam as played: the cyclists lean hard, roadside geese, a cone, a present, Grandma's far off. */
async function chaseShot() {
  const s = await ride({ riders: CYCLISTS, sway: { cap: { amp: 0.9, freq: 0.25, phase: 0 }, sto: { amp: 0.9, freq: 0.25, phase: 0.2 } } });
  await candidates(s.page, 'chase', 'screenshot2', [12, 13.5, 14, 14.5, 16]);
  await s.close();
}

/** 3: the crash beat, as played. Both riders lean the same way at once and over they go. */
async function crashShot() {
  // Adventurous (the speed that throws the parts); no sway until the lean, or the bots go down on their own
  // near the start and the ride restarts from Your Home
  const still0 = { amp: 0, freq: 0.3, phase: 0 };
  const s = await ride({ difficulty: 'adventurous', sway: { cap: still0, sto: still0 } });
  // ride out past Your Home first (a crash at the start lands in front of the house), then both lean
  for (let k = 0; k < 120; k++) {
    const p = await s.page.evaluate(() => ({ d: window._game.bike.distanceTraveled, st: window._game.state }));
    if (p.st === 'playing' && p.d > 90) break;
    await advance(s.page, 0.5);
  }
  await s.page.evaluate(() => { for (const b of window.__reel.bots) { b.extra = 1; b.steer = 0; b.sway = { amp: 0, freq: 0, phase: 0 }; } });
  // from the moment the bike goes down: the rag dolls fly, the parts scatter, the red crash vignette fades (~1 s)
  for (let k = 0; k < 600; k++) { if (await s.page.evaluate(() => !!window._game.bike.fallen)) break; await advance(s.page, 1 / 60); }
  await candidates(s.page, 'crash', 'screenshot3', [0.8, 1.0, 1.2, 1.4, 1.7]);
  await s.close();
}

/** 4: Versus, split screen 2 v 2, all four riders bots (as scripts/reel/shots.mjs does it). */
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
  await page.evaluate((css) => {
    const g = window._game, R = window.__reel, ins = window.__vsInputs;
    g.versusRigs.forEach((rig, k) => {
      R.attach(ins[k * 2], () => rig.bike, { role: 'captain', offset: k ? 0.9 : -0.9, cadence: k ? 3.3 : 3.1, sway: { amp: 0.6, freq: 0.3 + k * 0.05, phase: k } });
      R.attach(ins[k * 2 + 1], () => rig.bike, { role: 'stoker', offset: k ? 0.9 : -0.9, cadence: k ? 3.3 : 3.1, sway: { amp: 0.6, freq: 0.41 - k * 0.04, phase: 2 + k } });
    });
    R.gameplayHud();
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }, SHOT_CSS);
  await advance(page, 4);
  await candidates(page, 'versus', 'screenshot4', [6, 8, 10, 12]);
  await s.close();
}

/** 5: local co-op on Today's Road (Adventurous, trees you can hit), the Georgian pair. */
async function dailyShot() {
  const s = await ride({ level: 'daily', difficulty: 'adventurous', riders: GEORGIAN, sway: { cap: { amp: 0.6, freq: 0.3, phase: 0 }, sto: { amp: 0.6, freq: 0.37, phase: 1 } } });
  await candidates(s.page, 'daily', 'screenshot5', [10, 18, 26, 34]);
  await s.close();
}

/** 6: the TV lobby (>= 1024 px): the dimmed geese painting behind the menus, the bike chooser on a preset. */
async function lobbyShot() {
  const s = await launch({ storage: STORAGE, port: PORT, width: 1920, height: 1080, query: '?quality=high' });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(4000);
  await page.evaluate((css) => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st); }, SHOT_CSS);
  const f = await stillReal(page, 'lobby_0', CAND);
  fs.copyFileSync(f, path.join(OUT, 'screenshot6_1920x1080.png'));
  console.log('  picked lobby 0 -> screenshot6');
  await s.close();
}

/** 7: the start at Your Home, the Fancy pair pulling away. */
async function startShot() {
  const s = await ride({ riders: FANCY });
  await candidates(s.page, 'start', 'screenshot7', [1, 2.5, 4]);
  await s.close();
}

/** Resize the viewport to w/dpr x h/dpr at `dpr`, draw one frame, save a PNG of exactly w x h. */
async function still(page, name, w, h, dpr, dir = OUT) {
  const vw = Math.round(w / dpr), vh = Math.round(h / dpr);
  await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dpr });
  await page.evaluate(() => { window.dispatchEvent(new Event('resize')); if (window._game.renderer) window._game.renderer.setPixelRatio(window._game._pixelRatio()); });
  await sleep(150);
  await advance(page, 2 / 60);   // two frames: the camera override settles, the canvas is redrawn at the new size
  const client = await page.createCDPSession();
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: vw, height: vh, scale: dpr }, captureBeyondViewport: false });
  await client.detach();
  const f = path.join(dir, dir === OUT ? `${name}_${w}x${h}.png` : `${name}.png`);
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  console.log('  ->', f, (fs.statSync(f).size / 1e6).toFixed(2), 'MB');
  return f;
}

/** A 1920x1080 screenshot on the real clock (menus: no virtual clock running). */
async function stillReal(page, name, dir) {
  const client = await page.createCDPSession();
  const { data } = await client.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
  await client.detach();
  const f = path.join(dir, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(data, 'base64'));
  console.log('  ->', f);
  return f;
}

fs.mkdirSync(CAND, { recursive: true });
const want = (process.argv[2] || [...Object.keys(SLOTS), ...Object.keys(SESSIONS)].join(',')).split(',');
const bad = want.filter(k => !SLOTS[k] && !SESSIONS[k]);
if (bad.length) console.log('unknown:', bad.join(','));
const wantSlots = want.filter(k => SLOTS[k]);
if (wantSlots.length) { console.log('== slots', wantSlots.join(',')); try { await slots(wantSlots); } catch (e) { console.log('  FAILED', e.message); } }
for (const k of want.filter(k => SESSIONS[k])) { console.log('==', k); try { await SESSIONS[k](); } catch (e) { console.log('  FAILED', k, e.message); } }
process.exit(0);
