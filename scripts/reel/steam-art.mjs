#!/usr/bin/env node
// steam-art.mjs â€” Steam store / library art candidates rendered in-engine (#357).
// One co-op ride to Grandma's with the bot riders (victorian outfit), then the finish cinematic is
// frozen at the moment Grandma stands beside the bike with the present pile and her house behind,
// and the same staged scene is photographed at every Steamworks slot size (its own camera each).
//   node scripts/reel/steam-art.mjs            renders the plates into assets/steam-candidates/plates/
//   node scripts/reel/steam-art.mjs hero,main  just these
// Then: node scripts/reel/steam-art-compose.mjs   (title lettering, downsizes, size checks)
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
const RIDERS = { Captain: 'tandem-3d/goose/goose_captain.glb', Stoker: 'tandem-3d/goose/goose_stoker.glb' };

// ---------------------------------------------------------------- slots
// w,h = pixels Steam wants; dpr = render scale (small slots are rendered at 2x and downsized later).
// cam = page-bot camera (deg 0 = in front of the bike, +deg = its right (the house side) as it works out on this bike; dist/h/look in bike metres;
// side = aim offset, negative pushes the riders left of frame, so the riders sit off-centre and the house reads behind them).
const SLOTS = {
  hero:     { w: 3840, h: 1240, dpr: 2, cam: { deg: -20, dist: 7.2, h: 0.9,  look: 0.55, side: -1.0,  fov: 30 } },
  header:   { w: 920,  h: 430,  dpr: 2, cam: { deg: -20, dist: 5.6, h: 0.8,  look: 0.55, side: -0.8,  fov: 34 } },
  small:    { w: 462,  h: 174,  dpr: 3, cam: { deg: -20, dist: 5.2, h: 0.6,  look: 0.6,  side: -0.6,  fov: 30 } },
  main:     { w: 1232, h: 706,  dpr: 2, cam: { deg: -20, dist: 5.4, h: 0.9,  look: 0.5,  side: -0.8,  fov: 38 } },
  vertical: { w: 748,  h: 896,  dpr: 2, cam: { deg: -18, dist: 5.6, h: 1.0,  look: 0.4,  side: -0.3,  fov: 46 } },
  library:  { w: 600,  h: 900,  dpr: 2, cam: { deg: -18, dist: 5.8, h: 1.0,  look: 0.4,  side: -0.3,  fov: 50 } },
  pagebg:   { w: 1438, h: 810,  dpr: 1, cam: { deg: -24, dist: 8.5, h: 1.4,  look: 0.4,  side: -0.8,  fov: 36 } },
};
// gameplay screenshots (1920x1080): chase cam + HUD as played, mid-ride
const SHOTS = { screenshot1: 7, screenshot2: 15, screenshot3: 20 };

async function main() {
  const want = (process.argv[2] || Object.keys(SLOTS).join(',')).split(',');
  fs.mkdirSync(OUT, { recursive: true });
  const s = await launch({ storage: STORAGE, port: PORT, width: 1920, height: 1080, query: '?quality=high' });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(async (o) => {
    const g = window._game, R = window.__reel, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById('grandma')) : getLevelById('grandma');
    L.selectedDifficulty = 'chill';
    L._hideLobby();
    const p2 = R.newInput();
    g._onLocalReady({ inputP2: p2, sourceType: 'keyboard' });
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: 3.4, collect: true });
    R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: 3.4, collect: true });
  }, { sway: SWAY });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  // the pair from the 2D key art (images/large_action_*.png): the tweed-and-bowler captain with the lady in
  // the red bustle dress (in-game that's the 'victorian' captain + the 'fancy' stoker)
  await page.evaluate(async (pair) => { const g = window._game; await g.bike.setGooseRiders(pair); }, RIDERS);
  await sleep(500);
  await page.evaluate(() => window.__reel.gameplayHud());
  await advance(page, 4);   // countdown

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

  // freeze the cinematic: the bike winds down in slow motion, the presents fly into the pile and
  // Grandma walks to the line in real time, and the state never leaves finishCinematic
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
    const sl = SLOTS[k]; if (!sl) { console.log('no slot', k); continue; }
    await page.evaluate((c) => window.__reel.setCamera({ stiff: 1, keys: [{ t: 0, ...c }] }), sl.cam);
    await still(page, k, sl.w, sl.h, sl.dpr);
  }
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
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

await main();
process.exit(0);
