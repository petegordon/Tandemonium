// crash-probe.mjs — frame-by-frame log (and optional frames) of one crash and its recovery, on the virtual clock.
//   node scripts/reel/crash-probe.mjs [--fx on|off] [--frames] [--seconds 5]
// Rides Grandma's solo with the input bot, forces a balance crash, then logs per 60 fps frame: game state,
// bike.fallen / fallTimer / lean, the visual group's roll and position, transformOverride, countdown, distance.
// Used for #483 (crashed bike pops upright, then falls again). Needs vendor/rapier.mjs for --fx on
// (npm run download-vendors): the capture blocks the CDN.
import fs from 'node:fs';
import path from 'node:path';
import { launch, record, encode, advance, sleep, OUT } from './lib.mjs';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const FX = arg('--fx', 'on');
const FRAMES = process.argv.includes('--frames');
const SECONDS = Number(arg('--seconds', 5));
const LEAN = Number(arg('--lean', 1.3));   // the impact lean: a lean-out crash is nearly flat already

const s = await launch({ width: 1280, height: 720, port: 8961,
  storage: { tandemonium_show_riders: 'on', tandemonium_physics_fx: FX } });
const { page } = s;
await page.click('#tap-to-start').catch(() => {});
await sleep(600);
await page.evaluate(async () => {
  const g = window._game, L = g.lobby;
  const { getLevelById } = await import('/js/race-config.js');
  L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById('grandma')) : getLevelById('grandma');
  L.selectedDifficulty = 'chill';
  L._hideLobby();
  g._onSolo();
  window.__reel.attach(g.input, () => g.bike, { role: 'captain', sway: { amp: 0, freq: 0, phase: 0 }, cadence: 3.4, pedal: true });
});
await sleep(400);
await page.evaluate(() => document.getElementById('instructions')?.click());
await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.bike.goose, { timeout: 120000 });
// ride past the first checkpoint so the restore has somewhere to go that isn't the start
for (let i = 0; i < 40; i++) {
  await advance(page, 1);
  const st = await page.evaluate(() => ({ s: window._game.state, d: window._game.bike.distanceTraveled,
    cps: window._game.raceManager ? [...window._game.raceManager.passedCheckpoints] : [] }));
  if (st.s === 'playing' && st.cps.length && st.d > Math.max(...st.cps) + 15) break;
}
await page.evaluate(() => { window.__reel.cam = null; });
const log = [];
const sample = () => page.evaluate(() => {
  const g = window._game, b = g.bike, q = b.group.quaternion;
  // the group's roll about its own forward axis (the lean as drawn)
  const fwd = { x: 0, y: 0, z: 1 };
  const up = { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) };
  return { st: g.state, fallen: b.fallen, ft: +(b.fallTimer || 0).toFixed(3), lean: +b.lean.toFixed(3),
    upY: +up.y.toFixed(3), gx: +b.group.position.x.toFixed(2), gz: +b.group.position.z.toFixed(2),
    ov: !!b.transformOverride, tumble: !!b._tumbleHandle, cd: +(g.countdownTimer || 0).toFixed(2),
    d: +b.distanceTraveled.toFixed(1), fx: !!(g.physicsFx && g.physicsFx.ready) };
});
// #484: where the bones no clip animates (Hips, the hat's socket) sit in bike space: after the cut to the
// checkpoint they must be exactly where they were (the riders put back in their seats, hats back on)
const riderPose = () => page.evaluate(() => {
  const b = window._game.bike, out = {};
  if (!b.goose) return out;
  b.group.updateMatrixWorld(true);
  const inv = b.group.matrixWorld.clone().invert();
  for (const [seat, r] of Object.entries(b.goose.riders)) {
    r.root.traverse((o) => { if (o.isBone && /^(Hips|HatSocket)$/.test(o.name)) {
      // Hips: in bike space; HatSocket: on the head (its local transform), as the head itself leans with the rider
      const p = o.name === 'HatSocket' ? o.position.clone() : o.getWorldPosition(new o.position.constructor()).applyMatrix4(inv);
      out[seat + ':' + o.name] = [p.x, p.y, p.z]; } });
  }
  return out;
});
const before = await riderPose();
await page.evaluate((lean) => { const g = window._game; g._recordCrash('balance'); g.bike.lean = lean; g.bike._applyTransform(); g.bike._fall();
  window.__probeRagdoll = !!g.bike.crashScene; }, LEAN);
const n = Math.round(SECONDS * 60);
if (FRAMES) {
  await record(page, 'crash-probe-' + FX, SECONDS, { perFrame: async (i) => { log.push({ i, ...(await sample()) }); } });
  console.log('clip', await encode('crash-probe-' + FX));
} else {
  for (let i = 0; i < n; i++) { log.push({ i, ...(await sample()) }); await advance(page, 1 / 60); }
}
// after the cut to the checkpoint, a few frames into the countdown
await advance(page, 0.3);
const after = await riderPose();
let worstBone = '', worstD = 0;
for (const [k, p] of Object.entries(before)) {
  const q = after[k]; if (!q) continue;
  const dd = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  if (dd > worstD) { worstD = dd; worstBone = k; }
}
console.log('rag dolls:', await page.evaluate(() => window.__probeRagdoll), '| rider restore: worst bone', worstBone || '-', 'moved', worstD.toFixed(4), '(bike units)');
const out = path.join(OUT, `crash-probe-${FX}.json`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(out, JSON.stringify(log, null, 0));
// print the transitions only
let prev = '';
for (const r of log) {
  const key = `${r.st}|${r.fallen}|${r.ov}|${r.tumble}|${r.upY > 0.9 ? 'UP' : r.upY < 0.5 ? 'DOWN' : 'MID'}`;
  if (key !== prev) console.log(JSON.stringify(r));
  prev = key;
}
// #483 check: while fallen, the drawn bike never stands back up (upY = the group's up vector, 1 = upright)
const down = log.filter(r => r.fallen && r.i > 0);
const worst = Math.max(...down.map(r => r.upY));
const ok = worst < Math.cos(Math.min(LEAN, 1.2)) + 0.05 && worstD < 0.01;
console.log(ok ? '✔ stays down from the impact lean (max upY ' + worst + '), riders back in their seats'
  : '✖ pops upright while fallen (#483; max upY ' + worst + ') or riders not put back (#484; ' + worstD.toFixed(4) + ')');
console.log('errors', s.errors.slice(0, 3));
await s.close();
process.exit(ok ? 0 : 1);
