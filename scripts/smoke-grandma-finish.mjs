#!/usr/bin/env node
// smoke:grandma · #475 — Grandma waves the riders in at her house, beside her
// outhouse, woodpile and a Timber Tandem pine.
//
// A real Grandma's ride (and Today's Road, which ends there too), with the
// bike moved close to the finish: the four pieces are race markers near the
// finish on the right of the road, Grandma's model loads and stands on the
// ground, she idles until the final approach and waves on it (her right arm
// moves), once they pass she turns round and walks to the finish line, and a
// level that doesn't end at Grandma's gets none of it.
// Screenshots: OS temp folder, tandemonium-grandma/.
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8967, outDir: 'tandemonium-grandma' });
const { check } = h;

/** Start a ride on `levelId` from the level list. */
async function ride(levelId) {
  const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke' } });
  await sleep(800);
  await clickId(page, 'btn-solo');
  await page.waitForFunction((id) => !!document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`), { timeout: 30000 }, levelId);
  await page.evaluate((id) => document.querySelector(`#level-cards .level-card[data-level-id="${id}"]`).click(), levelId);
  await sleep(300);
  await clickId(page, 'btn-start-ride');
  await sleep(500);
  await clickId(page, 'btn-daily-practice');   // Today's Road asks practice or ranked first (web build)
  await waitState(page, 'playing');
  return page;
}

const state = (page) => page.evaluate(() => {
  const w = window._game.world, gf = w._grandmaFinish;
  const L = w.roadPath.loopLength;
  const props = w._raceMarkers.filter((m) => m.type === 'grandma-prop');
  const dest = w._raceMarkers.find((m) => m.type === 'destination');
  const side = props.map((m) => {
    // Which side of the road, and how far along from the finish.
    const pt = w.roadPath.getPointAtDistance(m.roadD);
    const rx = Math.cos(pt.heading), rz = -Math.sin(pt.heading);
    const lat = (m.mesh.position.x - pt.x) * rx + (m.mesh.position.z - pt.z) * rz;
    let along = m.roadD - (dest ? dest.roadD : 0);
    if (along > L / 2) along -= L; if (along < -L / 2) along += L;
    return { name: m.mesh.name, lat: +lat.toFixed(1), along: +along.toFixed(1), visible: m.mesh.visible, y: +(m.mesh.position.y - pt.y).toFixed(2) };
  });
  let arm = null;
  if (gf && gf.grandma.ready) {
    let a = null;
    gf.grandma.group.traverse((o) => { if (o.isBone && o.name === 'RightForeArm') a = o; });
    if (a) { const q = a.quaternion; arm = [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(3)); }
  }
  return { props: side, ready: !!(gf && gf.grandma.ready), waving: !!(gf && gf.grandma.waving), arm, hasSet: !!gf };
});

/** Move the bike to `metres` before the finish and let the world catch up. */
const nearFinish = async (page, metres) => {
  await page.evaluate((m) => { const g = window._game; g.bike.resetToDistance(g.lobby.selectedLevel.distance - m); }, metres);
  await sleep(1500);
};

console.log("Grandma's");
{
  const page = await ride('grandma');
  let s = await state(page);
  check(s.hasSet && s.props.length === 4, 'four pieces placed at the finish: Grandma, woodpile, outhouse, tree', s.props.map((p) => p.name));
  check(s.props.every((p) => p.lat > 2.5 && Math.abs(p.along) < 20), "all on the house's side, off the road, near the finish", s.props);
  await page.waitForFunction(() => window._game.world._grandmaFinish?.grandma.ready, { timeout: 120000 }).catch(() => {});
  s = await state(page);
  check(s.ready, "Grandma's model loaded", s.ready);
  await nearFinish(page, 150);
  s = await state(page);
  check(s.props.every((p) => p.visible), 'all four show on the way in', s.props.map((p) => p.visible));
  check(!s.waving, 'Grandma idles while the riders are still far off', s.waving);
  check(s.props.every((p) => Math.abs(p.y) < 0.01), 'every piece stands on the ground', s.props.map((p) => p.y));
  await h.shot(page, '1-approach-150');
  await nearFinish(page, 45);
  s = await state(page);
  check(s.waving, 'Grandma waves on the final approach', s.waving);
  const a1 = s.arm; await sleep(700); const a2 = (await state(page)).arm;
  check(a1 && a2 && a1.some((v, i) => Math.abs(v - a2[i]) > 0.01), 'her arm moves while she waves', { a1, a2 });
  await h.shot(page, '2-waving-45');
  await nearFinish(page, 18);
  await h.shot(page, '3-close-18');
  await nearFinish(page, 3);
  await h.shot(page, '4-at-grandma-3');
  // Past her now (she stands 4 before the finish): she turns round and walks to the finish line.
  const walk = () => page.evaluate(() => {
    const w = window._game.world, r = w._grandmaFinish.route, L = w.roadPath.loopLength;
    const dest = w._raceMarkers.find((m) => m.type === 'destination');
    let along = r.marker.roadD - dest.roadD; if (along > L / 2) along -= L; if (along < -L / 2) along += L;
    return { mode: r.mode, along: +along.toFixed(2), clip: w._grandmaFinish.grandma.clip };
  });
  await page.waitForFunction(() => window._game.world._grandmaFinish.route.mode === 'walk', { timeout: 60000 }).catch(() => {});
  let wk = await walk();
  check(wk.mode === 'walk' && wk.clip === 'walk', 'once the riders pass, Grandma turns round and walks', wk);
  await page.waitForFunction(() => window._game.world._grandmaFinish.route.mode === 'arrived', { timeout: 120000 }).catch(() => {});
  wk = await walk();
  check(wk.mode === 'arrived' && Math.abs(wk.along - -0.8) < 0.01, 'she stops just short of the finish line', wk);
  check((await state(page)).props[0].y === 0, 'still standing on the ground there', (await state(page)).props[0]);
  await h.shot(page, '5-grandma-at-the-line');
  await page.close();
}

console.log("Today's Road");
{
  const page = await ride('daily');
  const s = await state(page);
  check(s.hasSet && s.props.length === 4, "Today's Road ends at Grandma's too: the same four pieces", s.props.length);
  await page.close();
}

console.log('Tutorial');
{
  const page = await h.gamePage({ storage: {} });
  await sleep(800);
  await clickId(page, 'btn-solo');
  await waitState(page, 'playing').catch(() => {});
  const s = await state(page);
  check(!s.hasSet && s.props.length === 0, 'the tutorial has no Grandma set', s);
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
