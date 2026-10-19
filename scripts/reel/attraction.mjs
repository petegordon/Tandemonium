#!/usr/bin/env node
// attraction.mjs — gameplay shots for "The Main Attraction" trailer (vaudeville cut, 60 s).
// Reuses lib.mjs / page-bot.js; shots land in renders/reel/clips/ma-<shot>.mp4.
//   node scripts/reel/attraction.mjs              every shot
//   node scripts/reel/attraction.mjs probe        just these
import { launch, record, encode, advance, sleep } from './lib.mjs';
// lib's launch() takes the port; record()/encode() name frame dirs, so every shot here is prefixed "ma-"

const PORT = 8941;   // not lib's default, so this can run beside the other reel scripts
const STORAGE = { tandemonium_show_riders: 'on', tandemonium_show_solo: 'off' };
const SWAY = { cap: { amp: 0.7, freq: 0.31, phase: 0 }, sto: { amp: 0.7, freq: 0.43, phase: 1 } };
const BPM = 122.4, BEAT = 60 / BPM;

/** Start a co-op ride with bot riders; `warm` seconds of riding after the countdown (0 = still on the line). */
async function ride({ level = 'grandma', difficulty = 'adventurous', outfit = 'victorian', colourway = null,
  sway = SWAY, warm = 6, cadence = 3.2, pedal = true, hud = 'clean' } = {}) {
  const s = await launch({ storage: STORAGE, port: PORT });
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
    R.attach(g.input, () => g.bike, { role: 'captain', sway: o.sway.cap, cadence: o.cadence, pedal: o.pedal, collect: o.collect });
    R.attach(p2, () => g.bike, { role: 'stoker', sway: o.sway.sto, cadence: o.cadence, pedal: o.pedal, collect: o.collect });
  }, { level, difficulty, sway, cadence, pedal, collect: hud === 'clean' ? 'avoid' : true });
  await sleep(400);
  await page.evaluate(() => { document.getElementById('instructions')?.click(); });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await page.evaluate(async (k, cw) => {
    const g = window._game;
    if (k) { g._setGooseOutfit(k); await g.bike._gooseSwap; }
    if (cw != null) g._setGooseColourway(cw);
  }, outfit, colourway);
  await sleep(500);
  await page.evaluate((clean) => clean ? window.__reel.clean(true) : window.__reel.gameplayHud(), hud === 'clean');
  await advance(page, 4 + warm);
  return s;
}

const cam = (page, shot) => page.evaluate((s) => window.__reel.setCamera(s), shot);
const bots = (page, patch) => page.evaluate((p) => { for (const b of window.__reel.bots) Object.assign(b, p); }, patch);
const probe = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike;
  return { state: g.state, speed: +b.speed.toFixed(2), lean: +(b.lean || 0).toFixed(3), fallen: b.fallen, d: +(b.distanceTraveled || 0).toFixed(1) };
});

async function take(name, s, seconds, opts) {
  await record(s.page, 'ma-' + name, seconds, opts);
  const out = await encode('ma-' + name);
  if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
  await s.close();
  console.log('  ->', out);
}

/**
 * Gyro roll: tilt the shot camera about its view axis with the bike's lean (rad × gain) plus a fixed
 * dutch angle (deg). Wraps page-bot's camera override, so it only acts on setCamera shots.
 */
const roll = (page, gain, dutch = 0) => page.evaluate((gain, dutch) => {
  const R = window.__reel;
  if (!R._rollBase) R._rollBase = R._cameraFor;
  R._roll = { gain, dutch, cur: 0 };
  R._cameraFor = function (cam) {
    const c = this._rollBase(cam); if (!c) return c;
    const r = this._roll, want = (this.cam?.bike?.lean || 0) * r.gain + r.dutch * Math.PI / 180;
    r.cur += (want - r.cur) * 0.12;   // smoothed, so it reads as a handheld bank, not a twitch
    c.rotateZ(r.cur); c.updateMatrixWorld(true);
    return c;
  };
}, gain, dutch);

/** The start-line tip-over (open and stinger): stand still, two pedal twitches on the beat, then over she goes. */
async function tipOver(s, name, seconds, { twitchAt, fallAt, side = 0.6 }) {
  await take(name, s, seconds, { perFrame: async (i, t) => {
    const f = (x) => i === Math.round(x * 60);
    if (twitchAt != null && f(twitchAt)) await bots(s.page, { pedal: true, cadence: 2 / BEAT });
    if (twitchAt != null && f(twitchAt + BEAT * 1.05)) await bots(s.page, { pedal: false });
    if (f(fallAt)) await bots(s.page, { steer: 0, extra: side });
    // from the tip on, the camera stays put (the rig would follow the seats into the dirt and spin with
    // them), and once down the bike stays down (no respawn mid-shot)
    if (f(fallAt)) await s.page.evaluate(() => {
      const R = window.__reel, st = R.camState;
      if (st && st.ctr) { const ctr = st.ctr.clone(), fwd = st.fwd.clone(); R._bikeFrame = () => ({ ctr: ctr.clone(), fwd: fwd.clone() }); }
    });
    if (t > fallAt) await s.page.evaluate(() => { const b = window._game.bike; if (b.fallen) b.fallTimer = 99; });
  } });
}

const STILL = { cap: { amp: 0, freq: 0, phase: 0 }, sto: { amp: 0, freq: 0, phase: 0 } };

// ---------------------------------------------------------------- shots
const SHOTS = {
  // 0:00 THE OUTCAST: on the start line, low and wide; the pedals twitch, the bike keels over into the dirt
  async outcast() {
    const s = await ride({ warm: 0, pedal: false, sway: STILL, outfit: 'victorian' });
    await bots(s.page, { steer: 0 });
    await cam(s.page, { keys: [{ t: 0, deg: 62, dist: 4.6, h: -0.2, look: 0.15, fov: 34 }, { t: 7, deg: 70, dist: 4.0, h: -0.25, look: 0.1, fov: 34 }] });
    await tipOver(s, 'outcast', 7, { twitchAt: 1.6, fallAt: 2.4 });
  },
  // 0:07 THE NOVELTY ACT: low side tracking, one pedal stroke per beat of the tuba
  async novelty() {
    const s = await ride({ warm: 5, cadence: 1 / BEAT, outfit: 'victorian' });
    await cam(s.page, { keys: [{ t: 0, deg: 88, dist: 3.3, h: -0.05, look: -0.1, fov: 36 }, { t: 4.5, deg: 96, dist: 3.2, h: 0.0, look: -0.1, fov: 36 }] });
    await take('novelty', s, 4.5);
  },
  async novelty2() {
    const s = await ride({ warm: 7, cadence: 1 / BEAT, outfit: 'victorian' });
    await cam(s.page, { keys: [{ t: 0, deg: 28, dist: 4.4, h: 0.2, look: 0.25, fov: 32 }, { t: 4.5, deg: 20, dist: 3.8, h: 0.3, look: 0.35, fov: 32 }] });
    await take('novelty2', s, 4.5);
  },
  // 0:15 THE GYRO LEAN: a chase that banks with the bike, big sways so the horizon swings
  async gyro() {
    const big = { cap: { amp: 0.95, freq: 0.5, phase: 0 }, sto: { amp: 0.95, freq: 0.5, phase: 0.3 } };
    const s = await ride({ level: 'daily', warm: 4, sway: big, outfit: 'cyclists' });
    await bots(s.page, { steer: 0.6 });
    await cam(s.page, { stiff: 0.25, keys: [{ t: 0, deg: 172, dist: 4.4, h: 1.0, look: 0.35, fov: 48 }, { t: 9, deg: 190, dist: 4.2, h: 0.9, look: 0.35, fov: 48 }] });
    await roll(s.page, 0.9);
    await take('gyro', s, 9);
  },
  // the same, as played: chase cam, HUD and the front-view PiP of the geese leaning
  async gyrohud() {
    const big = { cap: { amp: 0.9, freq: 0.45, phase: 0 }, sto: { amp: 0.9, freq: 0.45, phase: 0.4 } };
    const s = await ride({ level: 'daily', warm: 4, sway: big, hud: 'gameplay', outfit: 'cyclists' });
    await take('gyrohud', s, 6);
  },
  // 0:42 THE DAREDEVIL: Daredevil difficulty, tight obstacle spacing, low fast camera, dutch roll
  async daredevil() {
    const calm = { cap: { amp: 0.3, freq: 0.31, phase: 0 }, sto: { amp: 0.3, freq: 0.43, phase: 1 } };
    const s = await ride({ level: 'daily', difficulty: 'daredevil', warm: 3, cadence: 4.0, sway: calm, outfit: 'fancy', hud: 'gameplay' });
    await cam(s.page, { stiff: 0.35, keys: [{ t: 0, deg: 160, dist: 3.6, h: 0.35, look: 0.3, fov: 58 }, { t: 5, deg: 200, dist: 3.4, h: 0.3, look: 0.3, fov: 58 }, { t: 10, deg: 175, dist: 3.8, h: 0.5, look: 0.3, fov: 58 }] });
    await roll(s.page, 0.8, -5);
    await take('daredevil', s, 10);
  },
  // 0:52 TITLE SLAM: the finish-line sweep in true slow motion (virtual 240 fps, played at 60 = 4x slow)
  async slam() {
    const s = await ride({ warm: 0, difficulty: 'chill', outfit: 'victorian', hud: 'gameplay' });
    await bots(s.page, { cadence: 3.6 });
    // ride on until the finish cinematic starts (the bike crossing the line), then capture its sweep
    for (let k = 0; k < 900; k++) {
      if (await s.page.evaluate(() => window._game.state) === 'finishCinematic') break;
      await advance(s.page, 0.1);
    }
    console.log('  at', await probe(s.page));
    await record(s.page, 'ma-slam', 2.6, { fps: 240 });
    console.log('  ->', await encode('ma-slam', 60));
    await s.close();
  },
  // v3 WIPEOUT, front-on: close on both faces, riding; at 6.0 s both lean the same way and over they go
  async crashfront() {
    const s = await ride({ warm: 7, outfit: 'victorian', sway: { cap: { amp: 0.5, freq: 0.35, phase: 0 }, sto: { amp: 0.5, freq: 0.35, phase: Math.PI } } });
    // far ahead on a long lens: the bike coasts on as it falls, and must stay in frame once the camera locks
    await cam(s.page, { keys: [{ t: 0, deg: 24, dist: 10, h: 0.7, look: 0.3, fov: 15 }, { t: 6, deg: 28, dist: 10, h: 0.7, look: 0.25, fov: 15 }] });
    await take('crashfront', s, 9, { perFrame: async (i, t) => {
      if (i === 360) await s.page.evaluate(() => {
        for (const b of window.__reel.bots) { b.extra = -1; b.steer = 0; b.sway = { amp: 0, freq: 0, phase: 0 }; }   // away from the lens
        const R = window.__reel, st = R.camState;   // lock the frame: the rig would follow the seats into the dirt
        if (st && st.ctr) { const ctr = st.ctr.clone(), fwd = st.fwd.clone(); R._bikeFrame = () => ({ ctr: ctr.clone(), fwd: fwd.clone() }); }
      });
      if (t > 6) await s.page.evaluate(() => { const b = window._game.bike; if (b.fallen) b.fallTimer = 99; });
    } });
  },
  // v3 THE ACT: three-quarter side, both faces clear (captain front, stoker behind) for the role cards
  async roles() {
    const s = await ride({ warm: 8, outfit: 'victorian' });
    await cam(s.page, { keys: [{ t: 0, deg: 58, dist: 3.9, h: 0.35, look: 0.42, fov: 32 }, { t: 5, deg: 50, dist: 3.5, h: 0.4, look: 0.45, fov: 32 }] });
    await take('roles', s, 5);
  },
  // v4 AGAINST EACH OTHER, as played: in step for 2 s, then the two riders sway opposite ways and pedal the
  // same foot at the same moment; the game stamps CRANK FIGHT! and the sync bar drops
  async fight() {
    const s = await ride({ warm: Number(process.env.WARM || 9), outfit: 'victorian', hud: 'gameplay', cadence: 3.0 });
    // the stamp's CSS animation runs on wall-clock time (a blink under the virtual clock); hold it for the HUD's own 0.6 s
    await s.page.addStyleTag({ content: '#crank-fight-stamp.show { animation: none !important; opacity: 1 !important; }' });
    await take('fight', s, 6, { perFrame: async (i) => {
      if (i === 120) await s.page.evaluate(() => {
        const [cap, sto] = window.__reel.bots;
        cap.sway = { amp: 0.6, freq: 0.6, phase: 0 }; sto.sway = { amp: 0.6, freq: 0.6, phase: Math.PI };
        sto.foot = cap.foot; sto.acc = cap.acc;                 // same foot, same moment
        sto.role = 'captain';                                   // (drops the stoker's 80 ms answer delay)
      });
    } });
  },
  // 0:57 STINGER: parked, dead still, facing us; a long awkward hold (the honk cuts in here), then over
  async stinger() {
    const s = await ride({ warm: 0, pedal: false, sway: STILL, outfit: 'fancy' });   // top-hat Winston, matching the Goose Studio honk close-up
    await bots(s.page, { steer: 0 });
    await cam(s.page, { keys: [{ t: 0, deg: 8, dist: 4.2, h: 0.25, look: 0.45, fov: 30 }] });
    await tipOver(s, 'stinger', 7, { fallAt: 4.4, side: -0.5 });
  },

  // what does the bike do on the start line with no pedalling and a lean?
  async probe() {
    const s = await ride({ warm: 0, pedal: false, sway: { cap: { amp: 0, freq: 0, phase: 0 }, sto: { amp: 0, freq: 0, phase: 0 } } });
    console.log('  start', await probe(s.page));
    await bots(s.page, { steer: 0, extra: 0.6 });
    for (let k = 0; k < 12; k++) { await advance(s.page, 0.25); console.log('  ', (k + 1) * 0.25, await probe(s.page)); }
    await s.close();
  },
};

const want = (process.argv[2] || Object.keys(SHOTS).filter(k => k !== 'probe').join(',')).split(',');
for (const k of want) {
  if (!SHOTS[k]) { console.log('no shot', k); continue; }
  console.log('== shot', k);
  try { await SHOTS[k](); } catch (e) { console.log('  FAILED', k, e.message); }
}
process.exit(0);
