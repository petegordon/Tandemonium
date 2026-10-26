// crash-review.mjs — #484 review footage: real crashes with the goose rag dolls, hats and slow-mo, 1080p60.
//   node scripts/reel/crash-review.mjs [pylon,leanout,versus] [--out <file.mp4>] [--fx on]
// Each shot rides Grandma's solo with the input bot (virtual clock, GPU Chrome), crashes for real, and is
// filmed from a camera that locks onto the crash site at impact, through the cut to the checkpoint.
// Needs vendor/rapier.mjs (npm run download-vendors): the capture blocks the CDN.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, record, encode, advance, sleep, OUT } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const SHOTS = (args[0] && !args[0].startsWith('--') ? args[0] : 'pylon,leanout').split(',');
const FINAL = opt('--out', path.join(OUT, 'clips', 'crash-review.mp4'));
const PORT = 8963;
const W = 1920, H = 1080;

async function ride({ difficulty = 'adventurous', cadence = 3.8 } = {}) {
  const s = await launch({ width: W, height: H, port: PORT,
    storage: { tandemonium_show_riders: 'on', tandemonium_physics_fx: opt('--fx', 'on') } });
  const { page } = s;
  await page.click('#tap-to-start').catch(() => {});
  await sleep(600);
  await page.evaluate(async (o) => {
    const g = window._game, L = g.lobby;
    const { getLevelById } = await import('/js/race-config.js');
    L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById('grandma')) : getLevelById('grandma');
    L.selectedDifficulty = o.difficulty;
    L._hideLobby();
    g._onSolo();
    window.__reel.attach(g.input, () => g.bike, { role: 'captain', sway: { amp: 0, freq: 0, phase: 0 }, cadence: o.cadence, pedal: true });
  }, { difficulty, cadence });
  await sleep(400);
  // pin the ride's placement salt so every take rides the same road
  await page.evaluate(() => {
    const real = Date.now;
    Date.now = () => Math.floor(real() / 1e6) * 1e6 + 424242;
    document.getElementById('instructions')?.click();
    Date.now = real;
  });
  await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
  await sleep(500);
  await page.evaluate(() => window.__reel.gameplayHud && window.__reel.gameplayHud());
  // Rapier is fetched during the countdown: wait for it
  for (let i = 0; i < 60; i++) {
    await advance(page, 0.5);
    if (await page.evaluate(() => window._game.state === 'playing' && !!(window._game.physicsFx && window._game.physicsFx.ready))) break;
  }
  return s;
}

const st = (page) => page.evaluate(() => {
  const g = window._game, b = g.bike;
  return { state: g.state, d: +b.distanceTraveled.toFixed(1), speed: +b.speed.toFixed(2), fallen: b.fallen,
    scene: !!b.crashScene, x: +(b._lateralOffset || 0).toFixed(2) };
});

async function until(page, pred, max = 90, step = 0.25) {
  for (let t = 0; t < max; t += step) { const s = await st(page); if (pred(s)) return s; await advance(page, step); }
  return st(page);
}

/** Film from `pre` seconds before the crash (crash() starts it) to the checkpoint countdown. */
async function film(name, s, crash, cam, seconds = 4.2) {
  const { page } = s;
  await page.evaluate((c, lead) => { window.__reel.setCamera(c); window.__LEAD = lead; }, cam, LEAD);
  let hit = -1, locked = false;
  const log = [];
  await record(page, name, seconds, { perFrame: async (i, t) => {
    if (hit < 0 && await crash(i, t)) hit = t;
    const r = await page.evaluate(() => {
      const g = window._game, b = window.__filmBike ? window.__filmBike() : g.bike, sc = b.crashScene;
      return { st: g.state, fallen: b.fallen, scene: !!sc, ft: +(b.fallTimer || 0).toFixed(2),
        pel: sc ? sc.pelvisPositions().map(p => [+p.y.toFixed(2)]) : null,
        clr: sc && sc.world ? +sc.minClearance().toFixed(3) : null,
        v: sc && sc.riders[0] ? (({ x, y, z }) => [+x.toFixed(1), +y.toFixed(1), +z.toFixed(1)])(sc.riders[0].segs[0].body.linvel()) : null,
        sp: +b.speed.toFixed(2), lean: +b.lean.toFixed(2) };
    });
    if (r.fallen) log.push(r);
    if (process.env.DEBUG && (r.fallen || i % 10 === 0)) console.log('   ', i, JSON.stringify(r));
    // back at the checkpoint: the game's own chase camera, as the player sees the countdown
    if (locked && !r.fallen) await page.evaluate(() => { const R = window.__reel; if (R.__bf) R._bikeFrame = R.__bf; R.setCamera(null); });
    if (r.fallen && hit < 0) hit = t;
    if (hit >= 0 && !locked && cam) {
      locked = true;   // hold the crash site: the seats are tumbling into the dirt
      await page.evaluate(() => {
        const R = window.__reel, cs = R.camState;
        R.__bf = R.__bf || R._bikeFrame;
        if (cs && cs.ctr) { const ctr = cs.ctr.clone().addScaledVector(cs.fwd, window.__LEAD), fwd = cs.fwd.clone(); R._bikeFrame = () => ({ ctr: ctr.clone(), fwd: fwd.clone() }); }
      });
    }
  } });
  const clip = await encode(name);
  console.log('  ->', clip, 'impact at', hit.toFixed(2), 's; scene', log.some(l => l.scene), 'errors', s.errors.slice(0, 2));
  // the lowest any pelvis got below where it started (geese through the floor?)
  const ys = log.filter(l => l.pel).flatMap(l => l.pel.map(p => p[0]));
  if (ys.length) console.log('  pelvis y range', Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2));
  const cl = log.map(l => l.clr).filter(v => v != null);
  if (cl.length) console.log('  lowest body above the terrain', Math.min(...cl).toFixed(3), 'm', Math.min(...cl) < -0.05 ? '✖ THROUGH THE FLOOR' : '✔');
  return clip;
}

let LEAD = 4;   // metres ahead of the crash the locked camera aims (the geese fly forward)
const CAM = (deg, dist, h) => ({ stiff: 0.25, keys: [{ t: 0, deg, dist, h, look: -0.2, fov: 42 }] });

const shots = {
  // head-on into a pylon: the captain over the bars, the stoker off the back
  async pylon() {
    const s = await ride();
    const { page } = s;
    const start = await until(page, x => x.state === 'playing' && x.d > 40 && x.speed > 6);
    const p = await page.evaluate((d) => {
      const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD > d + 30).sort((a, b) => a.absoluteD - b.absoluteD);
      return items[0] ? { d: items[0].absoluteD, x: items[0].lateralOffset } : null;
    }, start.d);
    console.log('  pylon at', JSON.stringify(p), 'from', JSON.stringify(start));
    await page.evaluate((p, d) => {
      for (const b of window.__reel.bots) { b.dodge = false; b.offset = p.x; }
    }, p, start.d);
    await until(page, x => x.d > p.d - 9 || x.fallen, 60, 1 / 30);
    const clip = await film('crash-pylon', s, async () => false, CAM(70, 11, 1.4));
    await s.close();
    return clip;
  },
  // leaning out too far at speed: both geese thrown to the side it falls
  async leanout() {
    const s = await ride();
    const { page } = s;
    await until(page, x => x.state === 'playing' && x.d > 60 && x.speed > 6);
    const clip = await film('crash-leanout', s, async (i, t) => {
      if (t < 0.5) return false;
      // stop steering and lean hard right: the balance gives out within a few frames; once down, ride on normally
      await page.evaluate(() => {
        const down = window._game.bike.fallen;
        for (const b of window.__reel.bots) { b.steer = down ? 0.9 : 0; b.extra = down ? 0 : 1; }
      });
      return false;
    }, null);   // the game's own chase camera: what the player sees
    await s.close();
    return clip;
  },
  // split-screen versus (?versusbot=1: Team B is the game's debug rider): Team A crashes into a pylon and
  // only its half slows down; Team B races on in real time
  async versus() {
    const s = await launch({ width: W, height: H, port: PORT, query: '?versusbot=1',
      storage: { tandemonium_show_riders: 'on', tandemonium_physics_fx: opt('--fx', 'on') } });
    const { page } = s;
    const click = (id) => page.evaluate((i) => document.getElementById(i)?.click(), id);
    await page.click('#tap-to-start').catch(() => {});
    await sleep(1200);
    await click('btn-together'); await sleep(800);
    await click('btn-versus');
    await page.waitForFunction(() => window._game.lobby._currentStep === window._game.lobby.versusStep, { timeout: 20000 });
    await sleep(800);
    await click('btn-versus-continue'); await sleep(800);
    await page.evaluate(async () => {   // Grandma's, Adventurous
      const L = window._game.lobby, { getLevelById } = await import('/js/race-config.js');
      L.selectedLevel = getLevelById('grandma'); L.selectedDifficulty = 'adventurous';
    });
    await click('btn-start-ride');
    await page.waitForFunction(() => window._game.mode === 'versus' && !!window._game.versusRigs, { timeout: 180000 });
    await page.evaluate(() => {
      const g = window._game, rig = g.versusRigs[0];
      window.__filmBike = () => rig.bike;
      window.__reel.attach(rig.members[0].input, () => rig.bike, { role: 'captain', sway: { amp: 0, freq: 0, phase: 0 }, cadence: 3.8, pedal: true });
    });
    for (let i = 0; i < 80; i++) {
      await advance(page, 0.5);
      const ok = await page.evaluate(() => { const g = window._game; return g.state === 'playing' && !!(g.physicsFx && g.physicsFx.ready)
        && g.versusRigs[0].bike.speed > 7 && g.versusRigs[0].bike.distanceTraveled > 40; });
      if (ok) break;
    }
    const clip = await film('crash-versus', s, async (i, t) => {
      if (t < 0.5) return false;
      return page.evaluate(() => {
        const g = window._game, b = g.versusRigs[0].bike;
        if (b.fallen) return true;
        g._recordCrash('obstacle', b); b._fall();
        return true;
      });
    }, null, 4.0);
    await s.close();
    return clip;
  },
};

const clips = [];
for (const name of SHOTS) {
  console.log('shot', name);
  clips.push(await shots[name]());
}
// one review file + a contact sheet
const list = path.join(OUT, 'clips', 'crash-review.txt');
fs.writeFileSync(list, clips.map(c => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
fs.mkdirSync(path.dirname(FINAL), { recursive: true });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', FINAL]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', FINAL, '-vf', 'fps=6,scale=480:-1,tile=6x' + Math.ceil(clips.length * 4.2), '-frames:v', '1',
  FINAL.replace(/\.mp4$/, '-sheet.jpg')]);
console.log('review', FINAL);
