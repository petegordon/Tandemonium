#!/usr/bin/env node
// shots.mjs — capture the trailer's shots (docs/demo-reel-plan.md) into renders/reel/clips/<shot>.mp4.
//   node scripts/reel/shots.mjs                 every shot
//   node scripts/reel/shots.mjs open,colours    just these
// Each shot runs in a fresh browser; the bots ride, the virtual clock makes every frame exactly 1/60 s.
import { launch, record, encode, advance, sleep } from './lib.mjs';

const STORAGE = { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' };

// captain and stoker sway at different rhythms: they drift in and out of step, so sometimes they lean
// together (the bike weaves) and sometimes against each other (the bike holds, the geese argue)
const SWAY = { cap: { amp: 0.7, freq: 0.31, phase: 0 }, sto: { amp: 0.7, freq: 0.43, phase: 1 } };

/** Start a ride with bot riders. Returns the session once the bike is moving. */
async function ride({ mode = 'local', level = 'grandma', difficulty = 'chill', outfit = 'victorian', colourway = null,
  sway = SWAY, warm = 6, cadence = 3.2, hud = 'gameplay' } = {}) {
  const s = await launch({ storage: STORAGE });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(async (o) => {
    const g = window._game, R = window.__reel, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
    L.selectedDifficulty = o.difficulty;
    L._hideLobby();
    if (o.mode === 'local') {
      const p2 = R.newInput();
      g._onLocalReady({ inputP2: p2, sourceType: 'keyboard' });
      R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: o.cadence, collect: o.collect });
      R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: o.cadence, collect: o.collect });
    } else {
      L.onSolo();
      R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: o.cadence, collect: o.collect });
    }
  }, { mode, level, difficulty, sway, cadence, collect: hud === 'clean' ? 'avoid' : true });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await setOutfit(page, outfit, colourway);
  if (hud === 'clean') await page.evaluate(() => window.__reel.clean(true));
  else await page.evaluate(() => window.__reel.gameplayHud());
  await advance(page, 4 + warm);   // countdown (~4 s) + get up to speed
  return s;
}

async function setOutfit(page, outfit, colourway = null) {
  await page.evaluate(async (k, cw) => {
    const g = window._game;
    if (k) { g._setGooseOutfit(k); await g.bike._gooseSwap; }
    if (cw != null) g._setGooseColourway(cw);
  }, outfit, colourway);
  await sleep(500);
}

const cam = (page, shot) => page.evaluate((s) => window.__reel.setCamera(s), shot);

async function take(name, s, seconds, opts) {
  await record(s.page, name, seconds, opts);
  const out = await encode(name);
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
  console.log('  ->', out);
}

// ---------------------------------------------------------------- shots
const SHOTS = {
  // cold open: low in front, slow push in on the two geese pedalling at you
  async open() {
    const s = await ride({ hud: 'clean', warm: 5 });
    await cam(s.page, { keys: [{ t: 0, deg: 30, dist: 5.4, h: -0.15, look: 0.05, fov: 32 }, { t: 5, deg: 16, dist: 4.1, h: 0.3, look: 0.4, fov: 32 }] });
    await take('open', s, 5);
  },
  // side tracking shot, wide lens, both riders swaying out of step
  async track() {
    const s = await ride({ hud: 'clean', warm: 7 });
    await cam(s.page, { keys: [{ t: 0, deg: 72, dist: 3.6, h: 0.1, look: 0.05, fov: 38 }, { t: 5, deg: 102, dist: 3.3, h: 0.15, look: 0.05, fov: 38 }] });
    await take('track', s, 5);
  },
  // crane up and around behind, the road ahead: background for the title card
  async titlebg() {
    const s = await ride({ hud: 'clean', warm: 9, outfit: 'victorian' });
    await cam(s.page, { keys: [{ t: 0, deg: 140, dist: 4, h: 0.8, look: 0.2, fov: 45 }, { t: 5, deg: 185, dist: 9, h: 4, look: 0.8, fov: 45 }] });
    await take('titlebg', s, 5);
  },
  // the game as played: chase cam + HUD + PiP, presents and boosts
  async chase() {
    const s = await ride({ warm: 3 });
    await take('chase', s, 9);
  },
  // straight-on close-up: the two geese leaning their own ways
  async lean() {
    const s = await ride({ hud: 'clean', warm: 8, sway: { cap: { amp: 0.9, freq: 0.35, phase: 0 }, sto: { amp: 0.9, freq: 0.35, phase: Math.PI } } });
    await cam(s.page, { keys: [{ t: 0, deg: 24, dist: 3.5, h: 0.45, look: 0.45, fov: 34 }, { t: 5, deg: 16, dist: 3.4, h: 0.5, look: 0.5, fov: 34 }] });
    await take('lean', s, 5);
  },
  // Goose Outfits: same orbit for each pair
  async outfits() {
    for (const k of ['victorian', 'cyclists', 'fancy']) {
      const s = await ride({ hud: 'clean', warm: 6, outfit: k });
      await cam(s.page, { keys: [{ t: 0, deg: 35, dist: 3.5, h: 0.35, look: 0.38, fov: 34 }, { t: 2.5, deg: 70, dist: 3.3, h: 0.4, look: 0.38, fov: 34 }] });
      await take('outfit-' + k, s, 2.5);
    }
  },
  // Goose Colours: one pair, a new colourway on every beat (0.98 s at 122 bpm x2)
  async colours() {
    const s = await ride({ hud: 'clean', warm: 6, outfit: 'cyclists', colourway: 0 });
    await cam(s.page, { keys: [{ t: 0, deg: 305, dist: 3.5, h: 0.35, look: 0.38, fov: 34 }, { t: 4, deg: 265, dist: 3.4, h: 0.4, look: 0.38, fov: 34 }] });
    const beat = 60 / 122.4 * 2;
    await take('colours', s, 4, { perFrame: async (i, t) => {
      const k = Math.floor(t / beat);
      if (i === 0 || Math.floor((i - 1) / 60 / beat) !== k) await s.page.evaluate((k) => window._game._setGooseColourway(k % 3), k);
    } });
  },
  // Today's Road: trees, pylons and presents, weaving through at speed
  async weave() {
    const s = await ride({ level: 'daily', difficulty: 'adventurous', warm: 3, outfit: 'fancy' });
    // a closer follow than the game's chase cam, HUD kept
    await cam(s.page, { stiff: 0.3, keys: [{ t: 0, deg: 172, dist: 5.2, h: 1.3, look: 0.35, fov: 50 }, { t: 10, deg: 188, dist: 4.8, h: 1.2, look: 0.35, fov: 50 }] });
    await take('weave', s, 10);
  },
  // the crash beat: riding fine, then both geese lean the same way at once
  async crash() {
    const s = await ride({ difficulty: 'adventurous', warm: 6, outfit: 'cyclists' });
    await cam(s.page, { keys: [{ t: 0, deg: 150, dist: 4.4, h: 0.8, look: 0.1, fov: 42 }, { t: 6, deg: 120, dist: 3.8, h: 0.6, look: 0.0, fov: 42 }] });
    await take('crash', s, 6, { perFrame: async (i) => {
      if (i === 90) await s.page.evaluate(() => { for (const b of window.__reel.bots) { b.extra = 1; b.steer = 0; b.sway = { amp: 0, freq: 0, phase: 0 }; } });
      if (i === 160) await s.page.evaluate(() => window.__reel.setCamera(null));
    } });
  },
  // Versus: split-screen 2 v 2, all four riders bots
  async versus() {
    const s = await launch({ storage: STORAGE });
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
    await advance(page, 6);
    await take('versus', s, 12);
  },
  // Slingshot: drag back, aim, let go, fly over the Chaos Coins
  async sling() {
    const s = await launch({ storage: { ...STORAGE, tandemonium_slingshot: JSON.stringify({ coins: 400, best: 0, runs: 3, stage: 1, lv: { power: 3, grip: 2 } }) } });
    const { page } = s;
    await page.click('#tap-to-start').catch(() => {});
    await sleep(600);
    await page.evaluate(() => document.getElementById('btn-solo').click());
    await sleep(800);
    await page.evaluate(() => { document.querySelector('#level-cards .level-card-slingshot').click(); document.getElementById('btn-start-ride').click(); });   // #517: pick it, then START RIDE
    await sleep(1500);
    await page.evaluate(() => Array.from(document.querySelectorAll('#sling-garage button, #sling-garage uf-button'))   /* uf-button since #411 */.find(b => /launch/i.test(b.textContent)).click());
    await page.waitForFunction(() => window._game.state === 'slingAim' && window._game.bike.goose, { timeout: 120000 });
    await setOutfit(page, 'victorian');
    await page.evaluate(() => {
      const g = window._game, R = window.__reel;
      R.attach(g.input, () => g.bike, { role: 'captain', pedal: false, sway: { amp: 0.5, freq: 0.4, phase: 0 } });
      R.gameplayHud();
    });
    await advance(page, 1);
    // drag: 0-1.6 s pull back and a little left, hold to 2.3 s, let go
    const W = 960, H = 540;
    await take('sling', s, 13, { perFrame: async (i, t) => {
      if (i === 0) { await page.mouse.move(W, H - 100); await page.mouse.down(); }
      if (t > 0 && t <= 1.6) { const u = t / 1.6, e = u * u * (3 - 2 * u); await page.mouse.move(W - 120 * e, H - 100 + 330 * e); }
      if (i === Math.round(2.3 * 60)) await page.mouse.up();
      // after the launch: a closer follow cam, so the coins and the riders read
      if (i === Math.round(2.8 * 60)) await page.evaluate(() => window.__reel.setCamera({ stiff: 0.3, keys: [{ t: 0, deg: 180, dist: 6.5, h: 1.6, look: 0.2, fov: 50 }, { t: 1.5, deg: 175, dist: 4.6, h: 1.1, look: 0.3, fov: 50 }] }));
    } });
  },
  // Grandma's finish line: the finish cinematic and YOU MADE IT!
  async finish() {
    const s = await ride({ warm: 0, outfit: 'victorian' });
    // ride most of the way at speed without capturing
    await s.page.evaluate(() => { for (const b of window.__reel.bots) b.cadence = 3.6; });
    await s.page.waitForFunction(() => true);
    for (let k = 0; k < 40; k++) {
      const d = await s.page.evaluate(() => window._game.bike.distanceTraveled);
      if (d > 200) break;
      await advance(s.page, 1);
    }
    await take('finish', s, 13);
  },
  // slow orbit for the end card
  async endbg() {
    const s = await ride({ hud: 'clean', warm: 6, outfit: 'fancy' });
    await cam(s.page, { keys: [{ t: 0, deg: 120, dist: 3.6, h: 0.3, look: 0.1, fov: 40 }, { t: 16, deg: 40, dist: 4.8, h: 1.1, look: 0.2, fov: 40 }] });
    await take('endbg', s, 16);
  },
};

const want = (process.argv[2] || Object.keys(SHOTS).join(',')).split(',');
for (const k of want) {
  if (!SHOTS[k]) { console.log('no shot', k); continue; }
  console.log('== shot', k);
  try { await SHOTS[k](); } catch (e) { console.log('  FAILED', k, e.message); }
}
process.exit(0);
