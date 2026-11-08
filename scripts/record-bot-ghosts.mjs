#!/usr/bin/env node
// record-bot-ghosts.mjs — record the bot ghost team's rides (#644 step 2) into js/bot-ghost-runs.js.
//
//   node scripts/record-bot-ghosts.mjs            Grandma's and the Daily Ride, three runs each
//   node scripts/record-bot-ghosts.mjs daily      just these roads (the others are kept)
//
// Each run is a real solo ride of the game: the trailer's input bot (scripts/reel/page-bot.js) pedals and steers
// the bike through the real physics, presents and pylons, and the game's own ghost recorder (js/ghost.js) samples
// it at 5 Hz. Three riders per road, from steady to scrappy — run 0 (Easy's) weaves the most, run 2 (Hard's) the
// least. A run with a crash or a restart is thrown away and ridden again (a ghost has one continuous line).
// The game stretches each run in time to its tier's medal time (js/bot-race.js scaleTrack), so the recorded pace
// itself doesn't matter, only the shape of the ride.
//
// Opens a Chrome window (the real GPU, like the trailer capture); the virtual clock makes every frame 1/60 s.
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './reel/lib.mjs';

const RIDERS = [
  { cadence: 2.7, sway: { amp: 0.6, freq: 0.27, phase: 0.4 } },   // run 0 · Easy
  { cadence: 3.2, sway: { amp: 0.42, freq: 0.33, phase: 1.3 } },    // run 1 · Medium
  { cadence: 3.7, sway: { amp: 0.25, freq: 0.41, phase: 2.1 } },    // run 2 · Hard
];
const LEVELS = { grandma: 'adventurous', daily: 'adventurous' };
const only = process.argv.slice(2);

async function recordRun(level, difficulty, rider, attempt) {
  const s = await launch({ width: 960, height: 540, port: 8940 + attempt, storage: { tandemonium_show_riders: 'off' } });
  const { page } = s;
  try {
    await page.click('#tap-to-start').catch(() => {});
    await sleep(600);
    await page.evaluate(async (o) => {
      const g = window._game, R = window.__reel, L = g.lobby;
      const { getLevelById } = await import('/js/race-config.js');
      L.selectedLevel = L.resolveRoadLevel ? L.resolveRoadLevel(getLevelById(o.level)) : getLevelById(o.level);
      // the Daily Ride's trees and close-set pylons take the input bot down: its runs are ridden on a cleared road (the
      // ghost passes through things anyway, and every day's road has its trees and pylons in other places)
      if (L.selectedLevel.treeCollision) L.selectedLevel = { ...L.selectedLevel, treeCollision: false };
      L.selectedDifficulty = o.difficulty;
      L._hideLobby();
      L.onSolo();
      // a different line each attempt: the sway's phase moves on
      R.attach(g.input, () => g.bike, { role: 'captain', cadence: o.rider.cadence,
        sway: { ...o.rider.sway, phase: o.rider.sway.phase + o.attempt * 0.9 } });
    }, { level, difficulty, rider, attempt });
    await sleep(400);
    await page.evaluate(() => { document.getElementById('instructions')?.click(); });
    await page.waitForFunction(() => window._game.bike.modelLoaded && window._game.state === 'countdown', { timeout: 120000 });
    await page.evaluate(() => window.__vclock.enable());
    await sleep(100);
    const out = await page.evaluate(async (clear) => {
      const { GhostRecorder } = await import('/js/ghost.js');
      const g = window._game, rec = new GhostRecorder(), ms = 1000 / 60;
      let started = false, firstRm = null, retried = false;
      for (let i = 0; i < 60 * 240; i++) {
        g.safetyMode = true;   // the bot's balance is a trailer bot's: SAFETY keeps a sway from ending the take
        window.__reel.tick(ms / 1000);
        window.__vclock.step(ms);
        const rm = g.raceManager;
        if (!rm) continue;
        if (rm.startTime > 0 && !started) { started = true; firstRm = rm; }
        if (started && rm !== firstRm) { retried = true; break; }   // a crash on the first stretch rides it again: a new race
        if (!started) continue;
        if (clear && g.obstacleManager) g.obstacleManager._items = [];
        if (g.state === 'playing' || rm.finished) {
          rec.sample(ms / 1000, { roadD: Math.min(g.bike.distanceTraveled, rm.raceDistance), lateral: g.bike._lateralOffset || 0, lean: g.bike.lean || 0 });
        }
        if (g.bike.fallen && !g.__fallLogged) { g.__fallLogged = true; console.log("[reel] crash", g.bike._crashCause, Math.round(g.bike.distanceTraveled), "lat", (g.bike._lateralOffset || 0).toFixed(2)); }
        if (!g.bike.fallen) g.__fallLogged = false;
        if (rm.finished) break;
        if (g.state === 'gameover' || g.state === 'lobby') break;
      }
      const rm = g.raceManager;
      const t = rec.finish();
      // one decimal of road (10 cm) and two of lateral / lean is plenty for a see-through bike
      t.data = t.data.map((v, i) => (i % 3 === 0 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100));
      return { track: t, finished: !retried && !!(rm && rm.finished), crashes: rm ? rm.crashCount + (retried ? 1 : 0) : -1, restarts: rm ? rm.restartCount : -1,
        timeMs: rm ? Math.round(rm.getElapsedMs()) : 0, distance: rm ? rm.raceDistance : 0 };
    }, level === 'daily');
    if (s.errors.length) console.log('  page errors:', s.errors.slice(0, 3));
    return out;
  } finally {
    await s.close();
  }
}

const file = path.join(process.cwd(), 'js', 'bot-ghost-runs.js');
function write() {
const body = Object.entries(result).map(([level, runs]) => `  ${level}: [\n` + runs.map(r =>
  `    { hz: ${r.hz}, count: ${r.count}, recordedMs: ${r.recordedMs},\n      data: [${r.data.join(',')}] },`).join('\n') + '\n  ],').join('\n');
fs.writeFileSync(file, `// The bot ghost team's recorded rides (#644 step 2): written by scripts/record-bot-ghosts.mjs, don't edit by hand.
// Per road, three real solo rides of the game (run 0 = Easy's, 1 = Medium's, 2 = Hard's), sampled by js/ghost.js
// at hz samples a second: [roadD (m), lateral offset (m), lean (rad)] per sample. The game stretches each to its
// tier's medal time (js/bot-race.js), so only the shape of the ride is used. The Daily Ride's runs were ridden on
// one day's road; on another day's road the ghost keeps its pace and passes through what it meets (it's a ghost).
export const BOT_GHOST_RUNS = Object.freeze({
${body}
});
`);
console.log('wrote', file, (fs.statSync(file).size / 1024).toFixed(1), 'KB');
}
let result = {};
if (fs.existsSync(file)) result = { ...(await import('../js/bot-ghost-runs.js')).BOT_GHOST_RUNS };   // keep the roads not re-ridden
for (const [level, difficulty] of Object.entries(LEVELS)) {
  if (only.length && !only.includes(level)) continue;
  result[level] = [];
  for (let r = 0; r < RIDERS.length; r++) {
    let run = null;
    for (let attempt = 0; attempt < (process.env.ATTEMPTS ? +process.env.ATTEMPTS : 10) && !run; attempt++) {
      const o = await recordRun(level, difficulty, RIDERS[r], attempt);
      const ok = o.finished && o.crashes === 0 && o.restarts === 0 && Math.abs(o.track.count / o.track.hz - o.timeMs / 1000) < 0.5;
      console.log(`${level} run ${r} attempt ${attempt}: ${ok ? 'kept' : 'dropped'} (finished ${o.finished}, ${o.crashes} crashes, ${o.restarts} restarts, ${(o.timeMs / 1000).toFixed(1)} s, ${o.track.count} samples)`);
      if (ok) run = { hz: o.track.hz, count: o.track.count, recordedMs: o.timeMs, data: o.track.data };
    }
    if (!run) throw new Error(`no clean ${level} run ${r}`);
    result[level].push(run);
  }
  write();
}

