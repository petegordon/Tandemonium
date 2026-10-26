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
const SHOTS = (args[0] && !args[0].startsWith('--') ? args[0] : 'pylon,tree,versus,leanout').split(',');
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
async function film(name, s, crash, cam, seconds = 4.2, caption = '') {
  const { page } = s;
  // a small caption, bottom left, for the whole shot
  await page.evaluate((text) => {
    let el = document.getElementById('reel-caption');
    if (!el) { el = document.createElement('div'); el.id = 'reel-caption'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;left:28px;bottom:26px;z-index:99999;padding:8px 16px;border-radius:10px;'
      + 'background:rgba(20,20,40,.82);color:#ffe9a8;font:600 26px/1.2 system-ui,sans-serif;letter-spacing:.02em';
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
  }, caption);
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
        sp: +b.speed.toFixed(2), lean: +b.lean.toFixed(2),
        cause: g._lastCrashCause || null,
        knocked: (g.physicsFx ? g.physicsFx._billboards.length : 0) + g.scene.children.filter(o => o.name === 'knocked-cone').length };   // billboard or #478 3D cone
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
  console.log('  ->', clip, 'impact at', hit.toFixed(2), 's; cause', log[0] && log[0].cause, '; scene', log.some(l => l.scene),
    '; knocked cones', Math.max(0, ...log.map(l => l.knocked)), '; errors', s.errors.slice(0, 2));
  // the lowest any pelvis got below where it started (geese through the floor?)
  const ys = log.filter(l => l.pel).flatMap(l => l.pel.map(p => p[0]));
  if (ys.length) console.log('  pelvis y range', Math.min(...ys).toFixed(2), Math.max(...ys).toFixed(2));
  const cl = log.map(l => l.clr).filter(v => v != null);
  if (cl.length) console.log('  lowest body above the terrain', Math.min(...cl).toFixed(3), 'm', Math.min(...cl) < -0.05 ? '✖ THROUGH THE FLOOR' : '✔');
  return clip;
}

let LEAD = 2;   // metres ahead of the crash the locked camera aims (the geese fly forward)
const CAM = (deg, dist, h, fov = 46, look = -0.25) => ({ stiff: 0.3, keys: [{ t: 0, deg, dist, h, look, fov }] });
const noCrash = async () => false;   // every crash comes from the game's own collision code

/** The next pylon at least `ahead` metres down the road, in the obstacle manager's window. */
const nextPylon = (page, d, ahead = 30) => page.evaluate((d, ahead) => {
  const items = (window._game.obstacleManager._items || []).filter(i => i.absoluteD > d + ahead && !i._hidden)
    .sort((a, b) => a.absoluteD - b.absoluteD);
  return items[0] ? { d: items[0].absoluteD, x: items[0].lateralOffset } : null;
}, d, ahead);

/** Ride the bot straight at lateral offset x (no dodging) until the filmed bike is `short` metres before d. */
async function lineUp(page, target, short = 7) {
  await page.evaluate((x) => { for (const b of window.__reel.bots) { b.dodge = false; b.offset = x; } }, target.x);
  for (let t = 0; t < 60; t += 1 / 30) {
    const d = await page.evaluate(() => (window.__filmBike ? window.__filmBike() : window._game.bike).distanceTraveled);
    if (d > target.d - short) return true;
    await advance(page, 1 / 30);
  }
  return false;
}

const shots = {
  // head-on into a pylon: the cone in frame before the hit and knocked flying; the captain over the bars
  async pylon() {
    const s = await ride();
    const { page } = s;
    const start = await until(page, x => x.state === 'playing' && x.d > 40 && x.speed > 6);
    const p = await nextPylon(page, start.d);
    console.log('  pylon at', JSON.stringify(p), 'from d', start.d);
    await lineUp(page, p, 16);
    // front-side, low: the cone is in frame ahead of the bike; side-on enough that the captain, thrown
    // forward over the bars, crosses the frame instead of flying into the lens
    const clip = await film('crash-pylon', s, noCrash, CAM(62, 7, 0.45, 50, -0.3), 4.0, 'Head-on: pylon');
    await s.close();
    return clip;
  },
  // into a roadside tree (Grandma's trees collide): head-on throw, the tree stays put
  async tree() {
    const s = await ride();
    const { page } = s;
    const start = await until(page, x => x.state === 'playing' && x.d > 40 && x.speed > 6);
    const t = await page.evaluate((d) => {
      const g = window._game, rp = g.world.roadPath, out = [];
      for (const sl of g.world._treePool || []) {
        if (!sl.active || !sl.mesh.visible || !(sl.roadD > d + 30)) continue;
        const info = rp.getClosestRoadInfo(sl.mesh.position.x, sl.mesh.position.z, sl.roadD);
        if (info && Math.abs(info.lateralOffset) < 7) out.push({ d: sl.roadD, x: info.lateralOffset });
      }
      // the nearest tree close to the road edge (the bot can't ride far into the grass at speed)
      out.sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || a.d - b.d);
      return out[0] || null;
    }, start.d);
    console.log('  tree at', JSON.stringify(t), 'from d', start.d);
    // no pylons on the way in: the tree is the crash
    await page.evaluate(() => { const om = window._game.obstacleManager; for (const i of om._items) i._hidden = true; });
    // Grandma's trees stand 5+ m off the road: ride the road until ~30 m out, ease off, then veer onto the
    // grass at the tree (straight onto the grass at full speed, the bike goes down on its own first)
    await lineUp(page, { d: t.d, x: 0 }, 55);
    await page.evaluate(() => { for (const b of window.__reel.bots) b.cadence = 2.2; });
    await lineUp(page, t, 9);
    // the grass drags: pedal hard for the run-in
    await page.evaluate(() => { for (const b of window.__reel.bots) b.cadence = 4.5; });
    console.log('  lined up: bike', JSON.stringify(await st(page)));
    const clip = await film('crash-tree', s, noCrash, CAM(-42, 6.5, 0.6, 50, -0.2), 4.0, 'Head-on: tree');
    await s.close();
    return clip;
  },
  // leaning out too far at speed: no obstacle, both geese cartwheel to the side it falls (short, last)
  async leanout() {
    const s = await ride();
    const { page } = s;
    await until(page, x => x.state === 'playing' && x.d > 60 && x.speed > 6);
    const clip = await film('crash-leanout', s, async (i, t) => {
      if (t < 0.2) return false;
      await page.evaluate(() => {
        const down = window._game.bike.fallen;
        for (const b of window.__reel.bots) { b.steer = down ? 0.9 : 0; b.extra = down ? 0 : 1; }
      });
      return false;
    }, null, 3.4, 'Lean-out (no obstacle)');
    await s.close();
    return clip;
  },
  // split-screen versus (?versusbot=1: Team B is the game's debug rider): Team A rides into a pylon; only its
  // half slows, Team B races on in real time
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
    const d = await page.evaluate(() => window._game.versusRigs[0].bike.distanceTraveled);
    const p = await nextPylon(page, d, 25);
    console.log('  versus pylon at', JSON.stringify(p), 'from d', d.toFixed(1));
    await lineUp(page, p, 14);
    const clip = await film('crash-versus', s, noCrash, null, 4.0, 'Versus: Team A hits a pylon, only its half slows');
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
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', FINAL, '-vf', 'fps=5,scale=480:-1,tile=6x' + Math.ceil(clips.length * 4 * 5 / 6), '-frames:v', '1',
  FINAL.replace(/\.mp4$/, '-sheet.jpg')]);
console.log('review', FINAL);
