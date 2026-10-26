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
await page.evaluate((lean) => { const g = window._game; g._recordCrash('balance'); g.bike.lean = lean; g.bike._fall(); }, LEAN);
const n = Math.round(SECONDS * 60);
if (FRAMES) {
  await record(page, 'crash-probe-' + FX, SECONDS, { perFrame: async (i) => { log.push({ i, ...(await sample()) }); } });
  console.log('clip', await encode('crash-probe-' + FX));
} else {
  for (let i = 0; i < n; i++) { log.push({ i, ...(await sample()) }); await advance(page, 1 / 60); }
}
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
const ok = worst < Math.cos(Math.min(LEAN, 1.2)) + 0.05;
console.log(ok ? '✔ stays down from the impact lean (max upY ' + worst + ')' : '✖ KNOWN BUG #483: pops upright while fallen (max upY ' + worst + ')');
console.log('errors', s.errors.slice(0, 3));
await s.close();
process.exit(ok ? 0 : 1);
