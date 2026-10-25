#!/usr/bin/env node
// smoke:props · #478 — the present, the death cone and Grandma's house are 3D
// models now (no video billboards), and the ride's presents pile up at
// Grandma's after the finish.
//
// A real Grandma's ride on Daredevil:
//   - presents and cones are instanced 3D meshes, one draw per kind however
//     many are out; no gift or pylon video is created;
//   - picking up a present still counts and hides it; riding into a cone
//     still crashes, and (with crash physics) knocks a real 3D cone flying;
//   - the house is a 3D cabin facing the road, not a billboard;
//   - over the finish the cinematic swings round the side away from the house
//     and this ride's presents fly into the pile beside Grandma and land.
// Then Today's Road (the house and pile too) and the tutorial (3D presents and
// cones, no house or pile). Screenshots: OS temp folder, tandemonium-props/.
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8968, outDir: 'tandemonium-props' });
const { check } = h;

async function ride(levelId, difficulty = 'daredevil') {
  const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke', tandemonium_physics_fx: 'on' } });
  await sleep(800);
  await clickId(page, 'btn-solo');
  await page.waitForFunction((id) => !!document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`), { timeout: 30000 }, levelId);
  await page.evaluate((id) => document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`).click(), levelId);
  await page.evaluate((d) => { window._game.lobby.selectedDifficulty = d; }, difficulty);
  await sleep(300);
  await clickId(page, 'btn-start-ride');
  await sleep(500);
  await clickId(page, 'btn-daily-practice');   // Today's Road asks practice or ranked first (web build)
  await waitState(page, 'playing');
  return page;
}

/** What the scene has for the props. */
const props = (page) => page.evaluate(() => {
  const g = window._game, w = g.world;
  const byName = (n) => { let o = null; g.scene.traverse((x) => { if (x.name === n) o = x; }); return o; };
  const inst = (n) => { const m = byName(n); return m ? { instanced: !!m.isInstancedMesh, count: m.count } : null; };
  const cm = g.collectibleManager, om = g.obstacleManager;
  const dest = w._raceMarkers.find((m) => m.type === 'destination');
  let house = null;
  if (dest) {
    const meshes = []; dest.mesh.traverse((o) => { if (o.isMesh) meshes.push(o); });
    // which way the door (+z) faces, relative to the road's right
    const pt = w.roadPath.getPointAtDistance(dest.roadD);
    const rx = Math.cos(pt.heading), rz = -Math.sin(pt.heading);
    const ry = dest.mesh.rotation.y;
    const doorToRight = Math.sin(ry) * rx + Math.cos(ry) * rz;
    const lat = (dest.mesh.position.x - pt.x) * rx + (dest.mesh.position.z - pt.z) * rz;
    house = { name: dest.mesh.name, billboard: !!dest.billboard, meshes: meshes.length, doorToRight: +doorToRight.toFixed(2), lat: +lat.toFixed(1), visible: dest.mesh.visible };
  }
  return {
    presents: inst('presents'), presentsFx: inst('presents-fx'),
    cones: inst('death-cones'), shadows: inst('death-cone-shadows'), spirits: inst('death-cone-spirits'),
    presentsVisible: cm ? cm.visibleCount() : -1, conesVisible: om ? om.visibleCount() : -1,
    giftVideo: !!(cm && cm._variants.some((v) => v.mat && v.mat.uniforms && v.mat.uniforms.map)),
    pylonVideo: !!(om && om._video),
    houseVideo: (w._billboardVideos || []).some((v) => /grandma_house/.test(v.video.src)),
    house, stack: !!(w._grandmaFinish && w._grandmaFinish.stack),
  };
});

const goTo = (page, d, speed = 0) => page.evaluate((d, s) => {
  const g = window._game; g.bike.resetToDistance(d); g.bike.speed = s;
  if (g.chaseCamera) g.chaseCamera.initialized = false;
}, d, speed);

console.log("Grandma's (Daredevil)");
{
  const page = await ride('grandma');
  await goTo(page, 30); await sleep(1500);
  let s = await props(page);
  check(s.presents?.instanced && s.presentsFx?.instanced, 'presents are instanced 3D meshes (box + magic)', s.presents);
  check(s.cones?.instanced && s.shadows?.instanced && s.spirits?.instanced, 'cones, their shadows and skull spirits are instanced', s.cones);
  check(!s.giftVideo && !s.pylonVideo && !s.houseVideo, 'no gift, pylon or house video', { gift: s.giftVideo, pylon: s.pylonVideo, house: s.houseVideo });
  check(s.presentsVisible > 0 && s.presents.count === s.presentsVisible && s.presentsFx.count === s.presentsVisible,
    `every visible present is one instance (${s.presentsVisible} out, one draw)`, { visible: s.presentsVisible, inst: s.presents.count });
  check(s.conesVisible > 0 && s.cones.count === s.conesVisible && s.spirits.count === s.conesVisible * 18,
    `every standing cone is one instance with six circling skulls, three copies each (${s.conesVisible} out)`, { visible: s.conesVisible, inst: s.cones.count, spirits: s.spirits.count });
  await h.shot(page, '1-road');

  // a present: ride onto it
  const pick = await page.evaluate(() => {
    const g = window._game, d = g.bike.distanceTraveled;
    const it = g.collectibleManager._items.find((x) => !x.collected && x.absoluteD > d + 5 && Math.abs(x.lateralOffset) < 1.2);
    return it ? { d: it.absoluteD, before: g.collectibleManager.collected } : null;
  });
  if (pick) {
    await goTo(page, pick.d, 1); await sleep(600);
    const after = await page.evaluate(() => ({ n: window._game.collectibleManager.collected, hud: window._game.raceManager.collectiblesCount }));
    check(after.n === pick.before + 1, 'riding onto a present still collects it', { before: pick.before, after });
  } else check(false, 'found a present near the centre line to ride onto');

  // a cone: ride into it at speed
  const cone = await page.evaluate(() => {
    const g = window._game, d = g.bike.distanceTraveled;
    const it = g.obstacleManager._items.find((x) => !x._hidden && x.absoluteD > d + 10);
    return it ? { d: it.absoluteD, physics: !!(g.physicsFx && g.physicsFx.ready) } : null;
  });
  if (cone) {
    await goTo(page, cone.d - 25); await sleep(800);
    // put the bike on the cone (it may stand off the centre line) at speed
    await page.evaluate((d) => {
      const g = window._game, it = g.obstacleManager._items.find((x) => x.absoluteD === d);
      g.bike.resetToDistance(d - 0.4); g.bike.speed = 8;
      g.bike.position.x = it._worldX; g.bike.position.z = it._worldZ;
    }, cone.d);
    await sleep(400);
    const hit = await page.evaluate(() => {
      const g = window._game; let knocked = 0;
      g.scene.traverse((o) => { if (o.name === 'knocked-cone') knocked++; });
      return { fallen: !!g.bike.fallen || g.bike.fallTimer > 0, knocked, hidden: g.obstacleManager._knocked.length };
    });
    check(hit.fallen, 'riding into a cone still crashes', hit);
    if (cone.physics) check(hit.knocked === 1 && hit.hidden === 1, 'the struck cone is knocked flying as a 3D cone', hit);
    else console.log('  (crash physics not loaded — Rapier is off-network here; the cone stays standing, as before)');
    await h.shot(page, '2-cone-hit');
  } else check(false, 'found a cone near the centre line');

  // the house
  const L = await page.evaluate(() => window._game.lobby.selectedLevel.distance);
  await goTo(page, L - 45); await sleep(1500);
  s = await props(page);
  check(s.house && s.house.name === 'grandma-house' && !s.house.billboard && s.house.meshes <= 3, "Grandma's house is a 3D cabin (≤3 meshes)", s.house);
  check(s.house && s.house.lat > 2.5 && s.house.doorToRight < -0.5, 'it stands off the road with its door towards the road', s.house);
  await h.shot(page, '3-house');

  // the finish: 7 presents fly into the pile
  await page.evaluate(() => { window._game.raceManager.collectiblesCount = 7; });
  await goTo(page, L - 3, 7);
  await page.waitForFunction(() => window._game.state === 'finishCinematic', { timeout: 20000 }).catch(() => {});
  const cine = await page.evaluate(() => {
    const g = window._game, st = g.world._grandmaFinish && g.world._grandmaFinish.stack;
    return { state: g.state, via: g._finishCinematic ? Math.sign(g._finishCinematic.startTheta) : 0, count: st ? st.count : -1 };
  });
  check(cine.state === 'finishCinematic', 'crossing the line starts the finish cinematic', cine.state);
  check(cine.via === -1, 'the swing goes round the side away from the house', cine.via);
  check(cine.count === 7, "this ride's presents are on their way to the pile", cine.count);
  await sleep(1200);
  await h.shot(page, '4-presents-flying');
  // Software WebGL runs at a few fps and the game caps its frame step, so
  // game time lags the wall clock: wait for the pile rather than a fixed time.
  await page.waitForFunction(() => window._game.world._grandmaFinish.stack.landedCount() >= 7, { timeout: 30000 }).catch(() => {});
  const landed = await page.evaluate(() => { const st = window._game.world._grandmaFinish.stack; return { landed: st.landedCount(), drawn: st.mesh.count }; });
  check(landed.landed === 7 && landed.drawn === 7, 'all seven land in the pile beside Grandma', landed);
  await page.close();
}

console.log("Today's Road");
{
  const page = await ride('daily', 'chill');
  const s = await props(page);
  check(s.house && s.house.name === 'grandma-house' && s.stack, "Today's Road ends at the same 3D house, with a pile", { house: s.house && s.house.name, stack: s.stack });
  check(!s.giftVideo && !s.pylonVideo && !s.houseVideo, 'no prop videos here either');
  await page.close();
}

console.log('Tutorial');
{
  // same origin as the rides above: start from a fresh profile, as a first-time player
  const page = await h.gamePage({
    storage: { tandemonium_physics_fx: 'on' },
    before: (pg) => pg.evaluateOnNewDocument(() => { try { localStorage.clear(); localStorage.setItem('tandemonium_started', '1'); localStorage.setItem('tandemonium_physics_fx', 'on'); } catch {} }),
  });
  await sleep(800);
  await clickId(page, 'btn-solo');
  await page.waitForFunction(() => !!window._game.collectibleManager && !!window._game.obstacleManager, { timeout: 60000 }).catch(() => {});
  await sleep(1500);
  console.log('  tutorial state', await page.evaluate(() => ({ state: window._game.state, tut: !!window._game._tutorialActive })));
  const s = await props(page);
  check(s.presents?.instanced && s.cones?.instanced, 'the tutorial uses the 3D presents and cones too', { p: s.presents, c: s.cones });
  check(!s.stack && (!s.house || s.house.name !== 'grandma-house'), "and has no Grandma's house or pile", { stack: s.stack, house: s.house && s.house.name });
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
