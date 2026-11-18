// The first seconds of a solo ride: when the bike and its riders show, and every slow frame.
//   SMOKE_GPU=1 node scripts/measure-ride-start.mjs [--seconds 12] [--level grandma] [--query noclip]
// Starts a solo ride from the menu and records frame times from the tap on START RIDE until
// `--seconds` into the ride, with the game's state at each slow frame (over 33 ms) and when the bike
// model and the geese first appear. Use SMOKE_GPU=1 for the machine's own GPU (software drawing is
// slow throughout, so its numbers only compare with themselves). Run before and after a change.
import { startHarness, sleep } from './lib/smoke-harness.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const seconds = Number(arg('seconds', '12'));
const level = arg('level', 'grandma');

const h = await startHarness({ port: 8990, outDir: 'tandemonium-measure-ride' });
const page = await h.gamePage({ viewport: { width: 1600, height: 900 }, query: arg('query', ''), storage: { tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on' } });
await page.waitForFunction(() => window._game && window._game.lobby._presetKeys && window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel, { timeout: 90000 });
await sleep(1500);   // (the menu settled)

// the recorder runs from here on, across the menu → ride change
await page.evaluate(() => {
  const rec = window.__rec = { t0: performance.now(), frames: [], marks: {}, last: performance.now() };
  const g = window._game;
  const tick = () => {
    const now = performance.now(), d = now - rec.last;
    rec.last = now;
    rec.frames.push([Math.round(now - rec.t0), Math.round(d * 10) / 10, g.state]);
    const mark = (k, v) => { if (v && rec.marks[k] == null) rec.marks[k] = Math.round(now - rec.t0); };
    mark('state:' + g.state, true);
    mark('bikeModel', g.bike && g.bike.modelLoaded);
    mark('geese', g.bike && g.bike.goose && g.bike.goose.riders && Object.keys(g.bike.goose.riders).length >= 2);
    if (!rec.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const click = (re) => page.evaluate((src) => {
  const rx = new RegExp(src, 'i');
  const el = [...document.querySelectorAll('button, uf-button, .level-card, [class*="level"]')].find((x) => x.offsetParent !== null && rx.test(x.textContent || ''));
  if (el) el.click();
  return !!el;
}, re);
await page.evaluate(() => { const b = document.getElementById('btn-solo'); if (b) b.click(); });
await sleep(900);
await click(level);
await sleep(500);
await page.evaluate(() => { window.__rec.marks.startTap = Math.round(performance.now() - window.__rec.t0); });
await click('start ride');
await sleep(800);
await page.evaluate(() => { document.body.click(); const i = document.getElementById('instructions'); if (i) i.click(); });
await page.waitForFunction(() => window._game.state === 'playing', { timeout: 120000 }).catch(() => {});
await sleep(seconds * 1000);
const rec = await page.evaluate(() => { window.__rec.stop = true; return { frames: window.__rec.frames, marks: window.__rec.marks, state: window._game.state }; });

const from = rec.marks.startTap || 0;
const fr = rec.frames.filter((f) => f[0] >= from);
const playAt = rec.marks['state:playing'];
const slow = fr.filter((f) => f[1] > 33.4);
const by = {};
for (const f of slow) (by[f[2]] ||= []).push(f);
console.log('marks (ms after the recorder started):', JSON.stringify(rec.marks));
console.log(`from START RIDE: ${fr.length} frames; over 33 ms: ${slow.length}, over 50 ms: ${slow.filter((f) => f[1] > 50).length}, over 100 ms: ${slow.filter((f) => f[1] > 100).length}, worst ${Math.max(0, ...fr.map((f) => f[1]))} ms`);
for (const [state, list] of Object.entries(by)) {
  console.log(`  ${state}: ${list.length} slow frames, ${Math.round(list.reduce((a, f) => a + f[1], 0))} ms in all; ` + list.slice(0, 14).map((f) => `${f[1]}@${f[0] - from}`).join(' '));
}
if (playAt != null) {
  const riding = fr.filter((f) => f[0] >= playAt);
  const s2 = riding.filter((f) => f[1] > 33.4);
  console.log(`while riding (${Math.round((riding.at(-1)[0] - playAt) / 100) / 10} s): ${riding.length} frames, over 33 ms: ${s2.length}, worst ${Math.max(0, ...riding.map((f) => f[1]))} ms` + (s2.length ? '; at ms into the ride: ' + s2.map((f) => `${f[1]}@${f[0] - playAt}`).join(' ') : ''));
  console.log(`bike model ${rec.marks.bikeModel != null ? rec.marks.bikeModel - playAt : '?'} ms, geese ${rec.marks.geese != null ? rec.marks.geese - playAt : '?'} ms relative to the ride starting (negative: before)`);
} else console.log('the ride never reached "playing"; state:', rec.state);
await h.finish();
