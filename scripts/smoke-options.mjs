#!/usr/bin/env node
// smoke:options · Options that apply, and the build badge (#472).
//
//   BL-03  build badge: none on a local build; "PR #n · sha" on a preview; a
//          newer deploy (version.json) offers a reload.
//   OP-04  FPS readout shows / hides live; perf readout, edge smoothing and
//          render lines apply (they reload the page: see OP-07).
//   OP-05  Show Riders off / on, Goose Outfits and Goose Colours apply without
//          a reload (the bike model, the geese, their material colours).
//   OP-07  Display Testing: 540 lines, edge smoothing off / on, perf readout
//          each apply after the page reloads itself; Reset clears them all.
//   OP-08  Settings survive a restart: change several, reload, they're back.
import { startHarness, sleep, clickId } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8980, outDir: 'tandemonium-options' });
const { check } = h;
const VIEW = { width: 1280, height: 800 };
const STORAGE = { tandemonium_tutorial_done: 'smoke' };

const ready = (page) => page.waitForFunction(() => !!window._game && !!window._game.lobby && !!window._game.renderer, { timeout: 120000 });
/** Click an Options button that reloads the page, and wait for the new game. */
async function clickAndReload(page, id) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }),
    page.evaluate((i) => document.getElementById(i).click(), id),
  ]);
  await ready(page);
}
const openOptions = async (page) => {
  await page.evaluate(() => window._game._openOptions());
  await page.waitForFunction(() => document.getElementById('options-overlay').classList.contains('visible'), { timeout: 10000 });
};
const active = (page, ids) => page.evaluate((list) => Object.fromEntries(list.map((i) => [i, !!document.getElementById(i)?.classList.contains('active')])), ids);
const shown = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);

// ── BL-03: the build badge ──
console.log('BL-03 build badge');
{
  // A local build: no badge, the footer says it's a dev build.
  let page = await h.gamePage({ viewport: VIEW, storage: STORAGE });
  let b = await page.evaluate(() => ({ badge: !!document.getElementById('build-badge'), footer: document.getElementById('lobby-version')?.textContent }));
  check(!b.badge && /dev/i.test(b.footer || ''), 'local build: no badge; the footer says it is a dev build', b);
  await page.close();

  // A PR preview: the badge names the PR and commit; version.json matches, so no reload offer.
  const preview = (deployedSha) => (p) => p.evaluateOnNewDocument((sha) => {
    window.__BUILD = { sha: 'abc1234', pr: 397, time: 'now' };
    const real = window.fetch.bind(window);
    window.fetch = (u, o) => (String(u).endsWith('version.json')
      ? Promise.resolve(new Response(JSON.stringify({ sha, pr: 397 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : real(u, o));
  }, deployedSha);
  page = await h.gamePage({ viewport: VIEW, storage: STORAGE, before: preview('abc1234') });
  await page.waitForFunction(() => !!document.getElementById('build-badge'), { timeout: 30000 }).catch(() => {});
  await sleep(500);
  b = await page.evaluate(() => ({ text: document.getElementById('build-badge')?.textContent, stale: !!document.getElementById('build-stale') }));
  check(b.text === 'PR #397 · abc1234' && !b.stale, 'preview: badge "PR #397 · abc1234", no reload offer when version.json matches', b);
  await page.close();

  // A newer build deployed since the page loaded: offer a reload.
  page = await h.gamePage({ viewport: VIEW, storage: STORAGE, before: preview('def5678') });
  await page.waitForFunction(() => !!document.getElementById('build-stale'), { timeout: 30000 }).catch(() => {});
  b = await page.evaluate(() => ({ text: document.getElementById('build-badge')?.textContent, stale: document.getElementById('build-stale')?.textContent || '' }));
  check(b.text === 'PR #397 · abc1234' && /New build def5678/.test(b.stale), 'preview with a newer deploy: "New build def5678 — tap to reload"', b);
  await page.close();
}

// ── OP-04 / OP-05: live options in one page ──
console.log('OP-04 / OP-05 live options');
{
  const page = await h.gamePage({ viewport: VIEW, storage: STORAGE });
  await openOptions(page);

  // FPS readout: on shows it, off hides it, no reload.
  await clickId(page, 'opt-fps-on');
  await page.waitForFunction(() => { const e = document.getElementById('fps-meter'); return !!e && getComputedStyle(e).display !== 'none'; }, { timeout: 10000 }).catch(() => {});
  check(await shown(page, '#fps-meter') && (await active(page, ['opt-fps-on']))['opt-fps-on'], 'OP-04 FPS On: the readout shows, the button is lit');
  await clickId(page, 'opt-fps-off');
  await page.waitForFunction(() => { const e = document.getElementById('fps-meter'); return !e || getComputedStyle(e).display === 'none'; }, { timeout: 10000 }).catch(() => {});
  check(!(await shown(page, '#fps-meter')), 'OP-04 FPS Off: the readout hides');

  // Show Riders: the geese bike at boot; Off swaps in the plain bike + plain lighting; On brings them back.
  const riders = () => page.evaluate(() => {
    const g = window._game;
    return { on: g._showRiders, tone: g.renderer.toneMapping, front: !!g.frontView, goose: !!(g.bike && g.bike.goose),
      captain: g.bike && g.bike.goose && g.bike.goose.riders && g.bike.goose.riders.Captain ? g.bike.goose.riders.Captain.root.uuid : null };
  });
  await page.waitForFunction(() => window._game.bike && window._game.bike.goose && window._game.bike.goose.riders && window._game.bike.goose.riders.Captain, { timeout: 120000 }).catch(() => {});
  let r = await riders();
  check(r.on && r.goose && r.tone !== 0 && r.front, 'OP-05 boot: riders on (goose tandem, tone mapping, front camera)', r);
  await clickId(page, 'opt-riders-off');
  await page.waitForFunction(() => !window._game._showRiders && !(window._game.bike && window._game.bike.goose), { timeout: 120000 }).catch(() => {});
  r = await riders();
  check(!r.on && !r.goose && r.tone === 0 && !r.front, 'OP-05 Riders Off: plain bike, no tone mapping, no front camera, no reload', r);
  await clickId(page, 'opt-riders-on');
  await page.waitForFunction(() => window._game._showRiders && window._game.bike && window._game.bike.goose && window._game.bike.goose.riders && window._game.bike.goose.riders.Captain, { timeout: 120000 }).catch(() => {});
  r = await riders();
  check(r.on && r.goose && r.tone !== 0 && r.front, 'OP-05 Riders On: the geese are back', r);

  // Goose Outfits: Cyclists swaps both geese for the cyclist pair, in place.
  const before = r.captain;
  await clickId(page, 'opt-outfit-cyclists');
  await page.waitForFunction((prev) => {
    const b = window._game.bike;
    return b && b._gooseRiderPaths && /cyclist/.test(b._gooseRiderPaths.Captain) && b.goose && b.goose.riders.Captain && b.goose.riders.Captain.root.uuid !== prev;
  }, { timeout: 120000 }, before).catch(() => {});
  const o = await page.evaluate(() => ({ paths: window._game.bike._gooseRiderPaths, stored: localStorage.getItem('tandemonium_goose_outfit'), state: window._game.state }));
  r = await riders();
  check(/cyclist/.test(o.paths.Captain) && /cyclist/.test(o.paths.Stoker) && r.captain !== before && o.stored === 'cyclists' && o.state === 'lobby',
    'OP-05 Outfit Cyclists: both geese swapped in place, saved, no reload', { paths: o.paths, stored: o.stored, state: o.state, before, after: r.captain });
  check((await active(page, ['opt-outfit-cyclists']))['opt-outfit-cyclists'], 'OP-05 the Cyclists button is lit');

  // Goose Colours: the second colourway changes the geese's material colours.
  const colourSig = () => page.evaluate(() => {
    const out = [];
    for (const seat of ['Captain', 'Stoker']) {
      const r = window._game.bike.goose.riders[seat];
      r && r.root.traverse((m) => { if (m.isMesh && m.material && m.material.color) out.push(m.material.color.getHexString()); });
    }
    return out.join(',');
  });
  const ways = await page.evaluate(() => [0, 1, 2, 3].filter((i) => document.getElementById('opt-colour-' + i).style.display !== 'none').length);
  if (ways >= 2) {
    await clickId(page, 'opt-colour-0');
    await sleep(300);
    const c0 = await colourSig();
    await clickId(page, 'opt-colour-1');
    await page.waitForFunction((prev) => {
      const out = [];
      for (const seat of ['Captain', 'Stoker']) { const r = window._game.bike.goose.riders[seat]; r && r.root.traverse((m) => { if (m.isMesh && m.material && m.material.color) out.push(m.material.color.getHexString()); }); }
      return out.join(',') !== prev;
    }, { timeout: 15000 }, c0).catch(() => {});
    const c1 = await colourSig();
    check(c0 !== c1 && (await active(page, ['opt-colour-1']))['opt-colour-1'], 'OP-05 Colour 2: the geese change colour, no reload');
    await clickId(page, 'opt-colour-0');
    await page.waitForFunction((want) => {
      const out = [];
      for (const seat of ['Captain', 'Stoker']) { const r = window._game.bike.goose.riders[seat]; r && r.root.traverse((m) => { if (m.isMesh && m.material && m.material.color) out.push(m.material.color.getHexString()); }); }
      return out.join(',') === want;
    }, { timeout: 15000 }, c0).catch(() => {});
    check(await colourSig() === c0, 'OP-05 Colour Original: their own colours come back');
  } else {
    check(false, 'OP-05 the Cyclists pair offers at least two colourways', ways);
  }
  await h.shot(page, 'op05-cyclists');
  await page.close();
}

// ── OP-07: Display Testing (each reloads the page) ──
console.log('OP-07 display testing');
{
  const page = await h.gamePage({ viewport: VIEW, storage: STORAGE });
  const gl = () => page.evaluate(() => {
    const g = window._game, c = g.renderer.domElement;
    return { h: c.height, w: c.width, aa: !!g.renderer.getContext().getContextAttributes().antialias,
      perf: !!document.getElementById('perf-readout'), t: g._displayTest, note: document.getElementById('opt-dtest-note')?.textContent || '' };
  });
  const base = await gl();
  // The tier picks its own render height (a headless Chrome boots a lower tier,
  // so not always 800): remember it; Reset must bring exactly this back.
  check(base.h > 0 && Math.abs(base.h - 540) > 2 && !base.perf && base.t.lines === 0 && base.t.aa === 'tier', "OP-07 defaults: the tier's own render height, no perf readout", base);

  await openOptions(page);
  await clickAndReload(page, 'opt-lines-540');
  let s = await gl();
  check(Math.abs(s.h - 540) <= 2 && s.t.lines === 540, 'OP-07 540 lines: the canvas renders 540 lines after the reload', { h: s.h, lines: s.t.lines });
  await openOptions(page);
  s = await gl();
  check(/540 lines/.test(s.note) && (await active(page, ['opt-lines-540']))['opt-lines-540'], 'OP-07 the note and button say 540 lines', s.note);

  await clickAndReload(page, 'opt-aa-off');
  s = await gl();
  check(!s.aa && s.t.aa === 'off' && Math.abs(s.h - 540) <= 2, 'OP-04/07 edge smoothing Off: the context has no antialias (540 lines kept)', { aa: s.aa, h: s.h });
  await openOptions(page);
  await clickAndReload(page, 'opt-aa-on');
  s = await gl();
  check(s.aa && s.t.aa === 'on', 'OP-04/07 edge smoothing On: the context antialiases', { aa: s.aa });

  await openOptions(page);
  await clickAndReload(page, 'opt-perfhud-on');
  await page.waitForFunction(() => !!document.getElementById('perf-readout'), { timeout: 20000 }).catch(() => {});
  s = await gl();
  check(s.perf && s.t.perf, 'OP-04/07 perf readout On: the readout is on screen', { perf: s.perf });
  await h.shot(page, 'op07-overrides');

  await openOptions(page);
  await clickAndReload(page, 'opt-dtest-reset');
  s = await gl();
  const key = await page.evaluate(() => localStorage.getItem('tandemonium_display_test'));
  check(key === null && s.h === base.h && s.aa === base.aa && !s.perf && s.t.lines === 0 && s.t.aa === 'tier', "OP-07 Reset: saved overrides gone; the tier's own height and edge smoothing, no perf readout", { key, h: s.h, baseH: base.h, aa: s.aa, perf: s.perf });
  await openOptions(page);
  s = await gl();
  check(/None/.test(s.note), 'OP-07 the note says nothing is overridden', s.note);
  await page.close();
}

// ── OP-08: settings survive a restart ──
console.log('OP-08 restart');
{
  const page = await h.gamePage({ viewport: VIEW, storage: STORAGE });
  await openOptions(page);
  for (const id of ['opt-medium', 'opt-fps-on', 'opt-gyro-gravity', 'opt-physics-off', 'opt-ds-steam', 'opt-solo-off', 'opt-outfit-georgian']) {
    await clickId(page, id);
    await sleep(150);
  }
  // The Georgian pair's second colourway, once its buttons are relabelled.
  await page.waitForFunction(() => document.getElementById('opt-colour-1').style.display !== 'none', { timeout: 10000 }).catch(() => {});
  await clickId(page, 'opt-colour-1');
  await clickAndReload(page, 'opt-lines-720');   // a Display Testing override too (it reloads: the restart)

  // A second, plain restart, as a player closing and reopening the game.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await openOptions(page);
  const ids = ['opt-medium', 'opt-fps-on', 'opt-gyro-gravity', 'opt-physics-off', 'opt-ds-steam', 'opt-solo-off', 'opt-outfit-georgian', 'opt-colour-1', 'opt-lines-720'];
  const a = await active(page, ids);
  const lost = ids.filter((i) => !a[i]);
  check(lost.length === 0, 'OP-08 after a restart every changed option is still lit', lost.length ? { lost } : ids.length);
  const g = await page.evaluate(() => {
    const game = window._game;
    return { quality: game._quality, fps: (() => { const e = document.getElementById('fps-meter'); return !!e && getComputedStyle(e).display !== 'none'; })(),
      lines: game._displayTest.lines, h: game.renderer.domElement.height, outfit: game.bike && game.bike._gooseRiderPaths ? game.bike._gooseRiderPaths.Captain : null };
  });
  check(g.quality === 'medium' && g.fps && g.lines === 720 && Math.abs(g.h - 720) <= 2 && /georgian/.test(g.outfit || ''),
    'OP-08 and they are in effect: Medium, FPS shown, 720 lines, Georgian geese', g);
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
