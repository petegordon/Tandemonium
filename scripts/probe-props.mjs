#!/usr/bin/env node
// probe-props.mjs · #478 — what the road props cost to draw: renderer calls and
// triangles for one frame, and how many of them are presents, cones and
// Grandma's house, on Grandma's and Today's Road (practice).
//
//   node scripts/probe-props.mjs [--difficulty=daredevil] [--port=8977] [--json=out.json]
//
// Runs against whatever checkout it is started in, so the same script measures
// before (origin/main) and after. Positions: mid-ride (most presents and cones
// in view) and 40 m before the finish (the house, Grandma and her props).
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import fs from 'node:fs';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=')[1];
const DIFF = arg('difficulty', 'daredevil');
const h = await startHarness({ port: +arg('port', 8977) });

async function ride(levelId) {
  const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'probe' } });
  await sleep(800);
  await clickId(page, 'btn-solo');
  await page.waitForFunction((id) => !!document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`), { timeout: 30000 }, levelId);
  await page.evaluate((id) => document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`).click(), levelId);
  await page.evaluate((d) => { window._game.lobby.selectedDifficulty = d; }, DIFF);
  await sleep(300);
  await clickId(page, 'btn-start-ride');
  await sleep(500);
  await clickId(page, 'btn-daily-practice');
  await waitState(page, 'playing');
  return page;
}

const measure = (page) => page.evaluate(() => {
  const G = window._game, W = G.world;
  const cats = { presents: 0, cones: 0, house: 0, other: 0 };
  const tris = { presents: 0, cones: 0, house: 0, other: 0, total: 0 };
  const catOf = (o) => {
    for (let p = o; p; p = p.parent) {
      const n = p.name || '';
      if (/^presents|present-stack/.test(n)) return 'presents';
      if (/death-cone|knocked-cone/.test(n)) return 'cones';
      if (/grandma-house/.test(n)) return 'house';
    }
    // the old billboards: by pool / marker membership
    const cm = G.collectibleManager, om = G.obstacleManager;
    if (cm && cm._pool && cm._pool.some((s) => s.mesh === o)) return 'presents';
    if (om && om._pool && om._pool.some((s) => s.mesh === o || s.shadow === o)) return 'cones';
    if (W._raceMarkers.some((m) => m.type === 'destination' && m.mesh === o)) return 'house';
    const map = o.material && o.material.uniforms && o.material.uniforms.map && o.material.uniforms.map.value;
    const src = (map && map.image && (map.image.currentSrc || map.image.src)) || '';
    if (/pylon/.test(src)) return 'cones';      // knocked billboard pylons
    return 'other';
  };
  const hooks = [];
  G.scene.traverse((o) => {
    if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return;
    const prev = o.onBeforeRender; hooks.push([o, prev]);
    o.onBeforeRender = function (r, s, c, geo, ...rest) {
      const k = catOf(o); cats[k]++;
      const idx = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0);
      const inst = o.isInstancedMesh ? o.count : 1;
      tris[k] += (idx / 3) * inst;
      return prev.call(this, r, s, c, geo, ...rest);
    };
  });
  G.renderer.info.autoReset = false; G.renderer.info.reset();
  G.renderer.render(G.scene, G.camera);
  const info = { calls: G.renderer.info.render.calls, triangles: G.renderer.info.render.triangles };
  G.renderer.info.autoReset = true;
  for (const [o, p] of hooks) o.onBeforeRender = p;
  tris.total = info.triangles;
  const videos = Array.from(document.querySelectorAll('video')).length;
  return { ...info, calls_by: cats, tris_by: tris, videoTextures: (W._billboardVideos || []).length, liveVideoEls: videos };
});

const results = {};
for (const level of ['grandma', 'daily']) {
  const page = await ride(level);
  const L = await page.evaluate(() => window._game.lobby.selectedLevel.distance);
  await sleep(3000);   // videos (old build) start playing; world streams in
  const at = async (d) => {
    await page.evaluate((d) => { const g = window._game; g.bike.resetToDistance(d); if (g.chaseCamera) g.chaseCamera.initialized = false; }, d);
    await sleep(1500);
    const m = await measure(page);
    const dir = arg('shots', '');
    if (dir) { fs.mkdirSync(dir, { recursive: true }); await page.screenshot({ path: `${dir}/${level}-${Math.round(d)}.png` }); }
    return m;
  };
  results[level] = { distance: L, mid: await at(Math.min(120, L * 0.45)), nearFinish: await at(L - 40) };
  console.log(level, JSON.stringify(results[level], null, 1));
  await page.close();
}
const out = arg('json', '');
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 1));
await h.finish();
