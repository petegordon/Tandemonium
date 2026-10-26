#!/usr/bin/env node
// review-props.mjs · #478 — screenshots for reviewing the 3D present, death
// cone, Grandma's house and the present pile in the real game.
//
//   node scripts/review-props.mjs [--out=dir] [--port=8976] [--only=road,house,knock,finish]
//
// Rides Grandma's on Daredevil. "road": a low chase view of presents and
// cones, plus close-ups; "house": the house from the approach and up close;
// "knock": a cone knocked flying (physics + skull burst); "finish": the
// finish cinematic with a 12-present haul flying into the pile, and a fixed
// view of the pile forming. Writes PNGs to --out (default: OS temp,
// tandemonium-478-review).
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || `--${k}=${d}`).split('=').slice(1).join('=');
const OUT = arg('out', path.join(os.tmpdir(), 'tandemonium-478-review'));
const ONLY = new Set(arg('only', 'road,house,knock,finish').split(','));
fs.mkdirSync(OUT, { recursive: true });
const h = await startHarness({ port: +arg('port', 8976) });

const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'review', tandemonium_physics_fx: 'on' }, viewport: { width: 1280, height: 720 } });
await sleep(800);
await clickId(page, 'btn-solo');
await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 30000 });
await page.evaluate(() => document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click());
await page.evaluate(() => { window._game.lobby.selectedDifficulty = 'daredevil'; });
await sleep(300);
await clickId(page, 'btn-start-ride');
await waitState(page, 'playing');
await sleep(2500);

// Hide the HUD (everything but the 3D canvas) and take over the camera.
await page.evaluate(() => {
  const g = window._game;
  const canvas = g.renderer.domElement;
  const st = document.createElement('style');
  st.id = 'review-hide';
  st.textContent = 'body > *:not(.keep-review) { visibility: hidden !important; } .keep-review, .keep-review * { visibility: visible !important; }';
  let top = canvas; while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
  top.classList.add('keep-review');
  document.head.appendChild(st);
  g._reviewCamUpdate = g.chaseCamera.update;
  g.chaseCamera.update = function () {};
  window._reviewCam = (pos, look) => { g.camera.position.set(...pos); g.camera.lookAt(...look); g.camera.updateMatrixWorld(); };
  // world helpers: a point `lat` units off the road centre at distance d, `y` above it
  window._at = (d, lat = 0, y = 0) => {
    const rp = g.world.roadPath, L = rp.loopLength;
    const pt = rp.getPointAtDistance(((d % L) + L) % L);
    return [pt.x + Math.cos(pt.heading) * lat, pt.y + y, pt.z - Math.sin(pt.heading) * lat];
  };
});
const shot = async (name) => { await sleep(250); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('  shot', name); };
const cam = (pos, look) => page.evaluate((p, l) => window._reviewCam(p, l), pos, look);
const at = (d, lat, y) => page.evaluate((d, lat, y) => window._at(d, lat, y), d, lat, y);
const goTo = (d) => page.evaluate((d) => { const g = window._game; g.bike.resetToDistance(d); }, d);

if (ONLY.has('road')) {
  await goTo(60); await sleep(1200);
  await cam(await at(56, 0, 3.2), await at(85, 0, 0.6));
  await shot('road-chase');
  // close-ups of the nearest present and cone ahead
  const items = await page.evaluate(() => {
    const g = window._game, d = g.bike.distanceTraveled;
    const p = g.collectibleManager._items.find((it) => !it.collected && it.absoluteD > d + 5);
    const c = g.obstacleManager._items.find((it) => !it._hidden && it.absoluteD > d + 5);
    return { p: p && { d: p.absoluteD, lat: p.lateralOffset }, c: c && { d: c.absoluteD, lat: c.lateralOffset } };
  });
  if (items.p) { await goTo(items.p.d - 30); await sleep(900); await cam(await at(items.p.d - 4, items.p.lat - 1.2, 1.6), await at(items.p.d, items.p.lat, 0.9)); await shot('present-close'); }
  if (items.c) { await goTo(items.c.d - 30); await sleep(900); await cam(await at(items.c.d - 3.6, items.c.lat + 0.8, 1.3), await at(items.c.d, items.c.lat, 0.8)); await shot('cone-close'); }
}

const L = await page.evaluate(() => window._game.lobby.selectedLevel.distance);

if (ONLY.has('house')) {
  await goTo(L - 60); await sleep(1500);
  await page.waitForFunction(() => window._game.world._grandmaFinish?.grandma.ready, { timeout: 120000 }).catch(() => {});
  await cam(await at(L - 32, -0.5, 3.0), await at(L - 2, 4, 2.0));
  await shot('house-approach');
  await cam(await at(L - 9, 0.5, 2.2), await at(L, 7, 2.2));
  await shot('house-near');
  await cam(await at(L + 9, -2, 2.6), await at(L - 3, 6, 1.6));
  await shot('house-from-past');
}

if (ONLY.has('knock')) {
  // a cone knocked flying: fake a bike at speed striking the first cone ahead
  await goTo(40); await sleep(1500);
  const ok = await page.evaluate(() => {
    const g = window._game, d = g.bike.distanceTraveled;
    const it = g.obstacleManager._items.find((x) => !x._hidden && x.absoluteD > d + 8 && x._worldX !== undefined);
    if (!it || !g.physicsFx || !g.physicsFx.ready) return { ready: !!(g.physicsFx && g.physicsFx.ready), it: !!it };
    window._knockItem = { d: it.absoluteD, lat: it.lateralOffset };
    g._knockPylon(it, { heading: g.bike.heading, speed: 9 });
    return { ok: true };
  });
  console.log('  knock', JSON.stringify(ok));
  if (ok.ok) {
    const k = await page.evaluate(() => window._knockItem);
    const pos = await at(k.d + 3, k.lat - 7.5, 2.4), look = await at(k.d + 5, k.lat, 0.9);
    await cam(pos, look);
    for (const [i, t] of [[0, 0.15], [1, 0.45], [2, 0.9], [3, 1.6]].map(([i, t], j, a) => [i, t - (j ? a[j - 1][1] : 0)])) {
      await sleep(t * 1000 - 250 > 0 ? t * 1000 - 250 : 0);
      await cam(pos, look);
      await shot(`knock-${i}`);
    }
  }
}

// The finish: the cinematic as the player sees it ('finish'), or a fixed
// camera on the pile while the same cinematic runs ('pile'). One per run.
const FIN = ONLY.has('pile') ? 'pile' : ONLY.has('finish') ? 'finish' : null;
if (FIN) {
  await goTo(L - 1.5); await sleep(1200);
  if (FIN === 'pile') {
    const sp = await page.evaluate(() => { const p = window._game.world._grandmaFinish.stack.group.position; return [p.x, p.y + 0.5, p.z]; });
    const cp = await at(L - 16, 0.8, 2.3);
    await page.evaluate((cp, lk) => {
      const g = window._game, orig = g.renderer.render.bind(g.renderer);
      g.renderer.render = (s, c) => { g.camera.position.set(...cp); g.camera.lookAt(...lk); g.camera.updateMatrixWorld(); orig(s, c); };
    }, cp, sp);
  }
  await page.evaluate(() => {
    const g = window._game;
    g.chaseCamera.update = g._reviewCamUpdate;   // the cinematic owns the camera
    g.raceManager.collectiblesCount = 12;
    g.bike.speed = 5;
    g._startFinishCinematic();
  });
  const times = FIN === 'pile' ? [0.3, 0.6, 0.9, 1.3, 2.2] : [0.6, 1.2, 1.8, 2.6, 4.2];
  for (const t of times) {
    await page.waitForFunction((t) => { const c = window._game._finishCinematic; return !c || c.elapsed >= t; }, { timeout: 20000 }, t);
    await page.screenshot({ path: path.join(OUT, `${FIN}-${t.toFixed(1)}.png`) });
    console.log('  shot', FIN, t);
  }
  console.log('  landed', await page.evaluate(() => window._game.world._grandmaFinish.stack.landedCount()));
}

await page.close();
await h.finish();
