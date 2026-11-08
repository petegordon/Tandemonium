#!/usr/bin/env node
// smoke:pip-crash · #559: during a crash the front-view PiP (the selfie cam) never draws from inside a thrown
// goose, a flying bike part or the bike's frame.
//
//   PIP-01  goose tandem, balance crash; PIP-02 goose tandem, obstacle (head-on) crash
//   PIP-03  Solo Flight (the Penny-Farthing, captain further forward, #644/#684), balance; PIP-04 obstacle
//
// For each crash, every time the PiP camera draws the scene while the bike is down, its lens is tested against
// the rag dolls' capsules, the hats, the flying parts' boxes and the frame's box (each grown by the near plane).
// None may contain it. The PiP stays on screen through the tumble (it holds the pre-impact picture) and draws
// live again after the remount, sitting ahead of the bike again (the Solo Flight further ahead).
//
// Screenshots (prefix pip-) go to SMOKE_SHOT_DIR, else the OS temp dir.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { soloAchievementIds } from '../js/rewards.js';

// The rag dolls need Rapier: the harness serves no CDN, so the page uses its vendor/ fallback.
if (!fs.existsSync('vendor/rapier.mjs')) execFileSync(process.execPath, ['scripts/download-vendors.js'], { stdio: 'inherit' });
const h = await startHarness({ port: Number(process.env.SMOKE_PORT || 9043) });
const { check } = h;
const shotDir = process.env.SMOKE_SHOT_DIR || path.join(os.tmpdir(), 'tandemonium-pip-crash');
fs.mkdirSync(shotDir, { recursive: true });
const BASE = {
  tandemonium_tutorial_done: 'smoke', tandemonium_show_riders: 'on', tandemonium_physics_fx: 'on',
  tandemonium_quality: 'high', tandemonium_quality_v: '3',
};
const earned = (ids) => JSON.stringify(ids.map(id => ({ id, earnedAt: 1 })));
const until = (page, fn, arg, timeout = 120000) => page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true, () => false);

async function ride(page, preset) {
  await page.evaluate((p) => {
    const l = window._game.lobby;
    l._presetIndex = Math.max(0, l._presetKeys.indexOf(p)); l._applyPresetToPreview();
    if (p === 'solo_flight' && l.pickBot) l.pickBot('bolt');
  }, preset);
  await page.evaluate(() => document.getElementById('btn-solo').click());
  await page.waitForFunction(() => !!document.querySelector('#level-cards .level-card[data-level-id="grandma"]'), { timeout: 20000 });
  await page.evaluate(() => {
    document.querySelector('#level-cards .level-card[data-level-id="grandma"]').click();
    const d = Array.from(document.querySelectorAll('.difficulty-btn')).find(x => x.dataset.difficulty === 'chill'); d && d.click();
  });
  await sleep(300);
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button, uf-button')).find(x => x.offsetParent !== null && /start ride/i.test(x.textContent || '')); b && b.click(); });
  await page.waitForFunction(() => window._game?.state === 'playing', { timeout: 120000 });
  const ok = await until(page, (p) => {
    const g = window._game, k = g.bike;
    const model = p === 'solo_flight' ? k._modelPath.endsWith('solo_flight_tandem.glb') : !k._modelPath.endsWith('solo_flight_tandem.glb');
    return model && k.modelLoaded && k.goose && k.goose.riders.Captain && g.physicsFx && g.physicsFx.ready && g.frontView && g.frontView.enabled;
  }, preset, 180000);
  return ok;
}

/** Watch every renderer.render: PiP scene draws while the bike is down are tested against the crash's volumes. */
const install = (page) => page.evaluate(async () => {
  const THREE = await import('three');
  const g = window._game;
  if (g.__pipWatch) return;
  const w = g.__pipWatch = { on: false, live: 0, held: 0, hits: [], minGap: Infinity, after: 0, framesDown: 0 };
  const box = new THREE.Box3(), tmp = new THREE.Box3(), p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), q = new THREE.Quaternion();
  const near = () => g.frontView.camera.near;
  // distance from the lens to a capsule (Rapier body + its first collider), minus its radius
  const capsuleGap = (body, cam) => {
    const c = body.collider(0); if (!c) return Infinity;
    const t = body.translation(), r = body.rotation();
    const hh = typeof c.halfHeight === 'function' ? c.halfHeight() : 0, rad = typeof c.radius === 'function' ? c.radius() : 0.2;
    q.set(r.x, r.y, r.z, r.w);
    a.set(0, -hh, 0).applyQuaternion(q).add(t); b.set(0, hh, 0).applyQuaternion(q).add(t);
    const ab = b.clone().sub(a), u = Math.max(0, Math.min(1, cam.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)));
    return cam.distanceTo(a.clone().add(ab.multiplyScalar(u))) - rad;
  };
  const meshBox = (root) => {
    box.makeEmpty();
    root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh && o.visible) { o.geometry.computeBoundingBox && !o.geometry.boundingBox && o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); box.union(tmp); } });
    return box;
  };
  const test = () => {
    const k = g.bike, cam = g.frontView.camera.getWorldPosition(p).clone(), n = near(), cs = k.crashScene;
    let gap = Infinity, what = null;
    const consider = (d, label) => { if (d < gap) { gap = d; what = label; } };
    if (cs) {
      for (const rd of cs.riders) {
        for (const sg of rd.segs) consider(capsuleGap(sg.body, cam), rd.seat + ' goose');
        if (rd.hat) consider(capsuleGap(rd.hat.body, cam), rd.seat + ' hat');
      }
      for (const pt of cs.parts) { const bx = meshBox(pt.group); if (!bx.isEmpty()) consider(bx.distanceToPoint(cam), 'part ' + (pt.part || '')); }
    }
    k.group.updateMatrixWorld(true);
    const fb = meshBox(k.group); if (!fb.isEmpty()) consider(fb.distanceToPoint(cam), 'bike');
    w.minGap = Math.min(w.minGap, gap);
    if (gap < n) w.hits.push({ what, gap: +gap.toFixed(3) });
  };
  const render = g.renderer.render.bind(g.renderer);
  g.renderer.render = (scene, camera) => {
    const fv = g.frontView;
    if (w.on && fv && g.bike) {
      if (camera === fv.camera) {
        if (g.bike.fallen) { w.live++; test(); } else w.after++;
      } else if (fv._blit && camera === fv._blit.camera && g.bike.fallen) w.held++;
      else if (camera === g.camera && g.bike.fallen) {
        w.framesDown++;
        const fr = fv.frame; if (fr && fr.style.display !== 'none') w.shown = (w.shown || 0) + 1;
      }
    }
    return render(scene, camera);
  };
});

async function crash(page, label, cause) {
  await install(page);
  await page.evaluate((cause) => {
    const g = window._game, w = g.__pipWatch;
    Object.assign(w, { on: true, live: 0, held: 0, hits: [], minGap: Infinity, after: 0, framesDown: 0, shown: 0 });
    const k = g.bike;
    k.speed = 12;
    g._recordCrash(cause);
    if (cause === 'balance') k.lean = -1.38;
    k._fall();
  }, cause);
  // a few pictures through the tumble
  for (let i = 0; i < 3; i++) {
    await sleep(i === 0 ? 400 : 1200);   // inside the tumble (it is ~30 frames headless)
    await page.screenshot({ path: path.join(shotDir, `pip-${label}-${i}.png`) });
  }
  const up = await until(page, () => { const g = window._game; return g.state === 'playing' && !g.bike.fallen; }, null, 150000);
  if (!up) console.log('  (not back up)', JSON.stringify(await page.evaluate(() => { const g = window._game, k = g.bike;
    return { state: g.state, fallen: k.fallen, fallTimer: k.fallTimer, fallElapsed: k.fallElapsed, crashes: g._crashState, countdown: g.countdownTimer }; })));
  // a few live PiP frames after the remount
  await until(page, () => window._game.__pipWatch.after >= 2, null, 60000);
  const r = await page.evaluate(() => {
    const g = window._game, w = g.__pipWatch, k = g.bike, fv = g.frontView;
    w.on = false;
    const fwd = { x: Math.sin(k.heading), z: Math.cos(k.heading) };
    const c = fv.camera.position;
    const ahead = (c.x - k.position.x) * fwd.x + (c.z - k.position.z) * fwd.z;
    return { live: w.live, held: w.held, after: w.after, framesDown: w.framesDown, shown: w.shown, hits: w.hits.slice(0, 5), nHits: w.hits.length,
      minGap: Number.isFinite(w.minGap) ? +w.minGap.toFixed(2) : null, ahead: +ahead.toFixed(2), frameAhead: k.frontViewAhead || 0,
      scene: !!k.crashScene || null };
  });
  await page.screenshot({ path: path.join(shotDir, `pip-${label}-remount.png`) });
  return { up, ...r };
}

async function bike(preset, tag, storage) {
  const page = await h.gamePage({ viewport: { width: 1280, height: 800 }, storage: { ...BASE, ...storage } });
  await until(page, () => window._game.lobby._presetKeys.length > 1 && !!window._game.lobby._previewModel);
  const ok = await ride(page, preset);
  check(ok, `${tag}: riding with riders, physics and the PiP on`, await page.evaluate(() => ({ path: window._game.bike._modelPath, fx: !!(window._game.physicsFx && window._game.physicsFx.ready) })));
  for (const cause of ['balance', 'obstacle']) {
    const r = await crash(page, `${tag}-${cause}`, cause);
    console.log(`  ${tag} ${cause}:`, JSON.stringify(r));
    check(r.up, `${tag} ${cause}: back riding after the crash`);
    check(r.nHits === 0, `${tag} ${cause}: the PiP lens is never inside a goose, hat, part or the bike while it draws`, { live: r.live, hits: r.hits, minGap: r.minGap });
    check(r.framesDown > 0 && r.shown === r.framesDown && r.held > 0, `${tag} ${cause}: the PiP stays on screen through the tumble, holding its picture`, { framesDown: r.framesDown, shown: r.shown, held: r.held });
    const want = 4.8 + r.frameAhead;
    check(r.after >= 2 && Math.abs(r.ahead - want) < 1.0, `${tag} ${cause}: live again after the remount, ${want.toFixed(2)} m ahead of the bike`, { after: r.after, ahead: r.ahead });
  }
  await page.close();
}

await bike('default', 'goose', {});
await bike('solo_flight', 'soloflight', { tandemonium_achievements: earned(soloAchievementIds().slice(1)) });
console.log(`screenshots: ${shotDir}`);
await h.finish();
