// tutorial-board-review.mjs — #503 review footage: the tutorial's 3D START and END boards.
//   node scripts/reel/tutorial-board-review.mjs [--tall] [--out <file.mp4>]
// Rides the tutorial with the input bot on the virtual clock (GPU Chrome): the start board in the first
// seconds, then the bike is moved to just before the finish and rides across the line past the END board.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, record, encode, advance, sleep, OUT } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const TALL = args.includes('--tall');
const VIEW = TALL ? { width: 540, height: 960, scale: 2 } : { width: 1920, height: 1080 };
const TAG = TALL ? '9x16' : '16x9';
const FINAL = opt('--out', path.join(OUT, 'clips', `tutorial-board-review-${TAG}.mp4`));

const s = await launch({ ...VIEW, port: 8971, storage: { tandemonium_show_riders: 'on', tandemonium_tutorial_done: null } });
const { page } = s;
const st = () => page.evaluate(() => { const g = window._game, b = g.bike;
  return { state: g.state, d: +b.distanceTraveled.toFixed(1), sp: +b.speed.toFixed(1), dest: g.raceManager ? g.raceManager.raceDistance : null }; });
await page.click('#tap-to-start').catch(() => {});
await sleep(600);
await page.evaluate(() => {
  const g = window._game, L = g.lobby;
  L._forceWizard = true; L._hideLobby(); g._onSolo();
  window.__reel.attach(g.input, () => g.bike, { role: 'captain', sway: { amp: 0, freq: 0, phase: 0 }, cadence: 3.4, pedal: true, collect: false });
  for (const b of window.__reel.bots) { b.dodge = false; b.offset = 0; }
});
await sleep(400);
await page.evaluate(() => document.getElementById('instructions')?.click());
await page.waitForFunction(() => window._game.bike.modelLoaded, { timeout: 120000 });
await sleep(500);
await page.evaluate(() => window.__reel.gameplayHud && window.__reel.gameplayHud());
for (let i = 0; i < 40; i++) { await advance(page, 0.25); if ((await st()).state === 'playing') break; }
console.log('start', JSON.stringify(await st()));

const clips = [];
// 1 · the start board: from behind and left of the riders, riding past it
await page.evaluate((tall) => window.__reel.setCamera({ stiff: 0.25, keys: [
  { t: 0, deg: 165, dist: tall ? 7.5 : 7, h: 1.6, look: 0.9, fov: tall ? 58 : 44 },
  { t: 3.6, deg: 120, dist: tall ? 6.5 : 6, h: 1.4, look: 1.2, fov: tall ? 58 : 44 }] }), TALL);
await record(page, `tb-start-${TAG}`, 3.6);
clips.push(await encode(`tb-start-${TAG}`));
console.log('after start shot', JSON.stringify(await st()));

// stills: a fixed camera in front of each board (beauty close-ups)
await page.evaluate(() => {
  const R = window.__reel, orig = R._cameraFor.bind(R);
  R._cameraFor = (cam) => {
    const f = window.__fixedCam; if (!f) return orig(cam);
    const c = R.__fc || (R.__fc = cam.clone());
    c.fov = f.fov; c.aspect = cam.aspect; c.near = 0.05; c.far = cam.far;
    c.position.set(...f.pos); c.up.set(0, 1, 0); c.lookAt(...f.aim); c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    return c;
  };
});
async function still(kind, name, dist, sideDeg, h) {
  const ok = await page.evaluate((kind, dist, sideDeg, h, tall) => {
    const g = window._game, m = g.world._raceMarkers.find(q => q.board && q.mesh.name === 'tutorial-board-' + kind);
    if (!m) return false;
    const b = m.mesh, p = b.position, a = b.rotation.y + sideDeg * Math.PI / 180;
    window.__fixedCam = { fov: tall ? 50 : 34, pos: [p.x + Math.sin(a) * dist, p.y + h, p.z + Math.cos(a) * dist], aim: [p.x, p.y + 2.85, p.z] };
    window.__reel.setCamera({ keys: [{ t: 0, deg: 0, dist: 1, h: 1, look: 0, fov: 40 }] });
    m.mesh.visible = true;
    return true;
  }, kind, dist, sideDeg, h, TALL);
  if (!ok) { console.log('no board', kind); return; }
  await advance(page, 0.1);
  await page.evaluate(() => { const m = window._game.world._raceMarkers.find(q => q.board); });
  await page.screenshot({ path: path.join(OUT, 'clips', name) });
  await page.evaluate(() => { window.__fixedCam = null; });
  console.log('still', name);
}
await page.evaluate(() => window.__reel.clean(true));
await still('start', `tb-still-start-${TAG}.png`, TALL ? 9 : 8, 18, 0.6);

// 2 · the end board: jump to 45 m before the line, ride across it (tutorial retries muted: the jump skips presents)
const dest = (await st()).dest;
await page.evaluate(() => { const g = window._game; g._tutorialPhaseRetry = () => {}; });
await page.evaluate((d) => { const b = window._game.bike; b.resetToDistance(d); b.speed = 6; }, dest - 45);
await advance(page, 0.3);
await still('end', `tb-still-end-${TAG}.png`, TALL ? 9 : 8, -18, 0.6);
await page.evaluate(() => window.__reel.clean(false));
await page.evaluate(() => window.__reel.gameplayHud && window.__reel.gameplayHud());
await advance(page, 0.5);
await page.evaluate((tall) => window.__reel.setCamera({ stiff: 0.2, keys: [
  { t: 0, deg: 175, dist: tall ? 8 : 7.5, h: 2.0, look: 1.4, fov: tall ? 60 : 46 },
  { t: 5.5, deg: 150, dist: tall ? 9 : 8.5, h: 2.2, look: 1.8, fov: tall ? 60 : 46 }] }), TALL);
let finished = -1;
await record(page, `tb-end-${TAG}`, 7.5, { perFrame: async (i, t) => {
  if (i % 30 === 0) console.log('  ', t.toFixed(1), JSON.stringify(await st()));
  if (finished < 0 && (await st()).state !== 'playing') finished = t;
} });
clips.push(await encode(`tb-end-${TAG}`));
console.log('finish at', finished);

const list = path.join(OUT, 'clips', `tb-list-${TAG}.txt`);
(await import('node:fs')).writeFileSync(list, clips.map(c => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', FINAL]);
console.log('wrote', FINAL);
await s.close();
