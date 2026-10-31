#!/usr/bin/env node
// smoke:solo-extras · test-script SR-01 (the tutorial, start to finish) and
// SR-21 (goose outfits and colours reach the geese on the bike).
//
// SR-01 drives the real tutorial on a first-time profile. Pedalling is real
// keyboard input (ArrowLeft / ArrowRight). The lean-and-collect parts are
// fast-forwarded: the bike is moved onto each present (the game's own pickup
// collects it) and to the correct side of each pylon (the game's own pass
// check judges it), because steering a headless bike onto 1 m targets at
// CI frame rates is not reliable. Phase prompts, phase completion, and the
// completion screen (calibration saved, steering feel slider) are all the
// game's.
//
// SR-21 picks a goose outfit and a colourway in Options, in the lobby and
// live in a ride, and checks the geese on the bike: a new captain model seated
// on the bike's Seat_Captain socket, and the colourway's remap live on its
// materials (js/goose-colourways.js state), then off again for "own colours".
//
// (SR-22, the PB ghost, is gone: the D-4 ghost was removed in #400; its legacy
// cleanup is covered by test/unit/records.)
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';

const h = await startHarness({ port: 8982, outDir: 'tandemonium-solo-extras' });
const { check } = h;

/** Teleport the bike to road distance d, lateral lat (+ = the game's "right"), at rest. */
const installTeleport = (page) => page.evaluate(() => {
  window.__tp = (d, lat = 0) => {
    const g = window._game, b = g.bike, rp = b.roadPath || g.world.roadPath, L = rp.loopLength;
    const rd = ((d % L) + L) % L, pt = rp.getPointAtDistance(rd);
    b.roadD = rd; b.distanceTraveled = d;
    b.position.set(pt.x + Math.cos(pt.heading) * lat, pt.y, pt.z - Math.sin(pt.heading) * lat);
    b.heading = pt.heading; b.speed = 0;
  };
});
const prompt = (page) => page.evaluate(() => ({
  text: document.getElementById('tutorial-prompt-text')?.textContent || '',
  visible: document.getElementById('tutorial-prompt')?.classList.contains('visible'),
}));
const waitPrompt = (page, re, timeout = 30000) =>
  page.waitForFunction((src) => new RegExp(src, 'i').test(document.getElementById('tutorial-prompt-text')?.textContent || ''), { timeout }, re.source)
    .then(() => true).catch(() => false);

// ── SR-01 · the tutorial ──
console.log('SR-01 tutorial');
{
  // A first-time player: no tutorial_done → SOLO goes to the tutorial.
  const page = await h.gamePage({ storage: {} });
  await sleep(500);
  await clickId(page, 'btn-solo');
  // #459 item 6: one screen first — "Learn the ride in a minute", START / SKIP TUTORIAL.
  const intro = await page.waitForFunction(() => document.getElementById('tutorial-intro')?.open && !!window._game._intro, { timeout: 30000 }).then(() => true).catch(() => false);
  const introText = await page.evaluate(() => ({ pedal: document.getElementById('tutorial-intro-pedal').textContent, steer: document.getElementById('tutorial-intro-steer').textContent, state: window._game.state }));
  check(intro && /Pedal/.test(introText.pedal) && /Steer/.test(introText.steer) && introText.state === 'lobby', 'SR-01: the tutorial intro shows before the first countdown', introText);
  await h.shot(page, 'sr01-tutorial-intro');
  await clickId(page, 'btn-tutorial-intro-start');
  await page.waitForFunction(() => window._game._tutorialActive && window._game.state === 'playing', { timeout: 120000 }).catch(() => {});
  check(await page.evaluate(() => !!window._game._tutorialActive && window._game.lobby.selectedLevel?.id === 'tutorial'), 'SR-01: START begins the tutorial; a first SOLO ride is the tutorial');
  await installTeleport(page);

  // Runway: the pedal prompt, and real pedal keys move the bike.
  check(await waitPrompt(page, /Pedal to build speed/), 'SR-01: runway prompt "Pedal to build speed!"', await prompt(page));
  const d0 = await page.evaluate(() => window._game.bike.distanceTraveled);
  let moved = false;
  for (let i = 0; i < 40 && !moved; i++) {
    await page.keyboard.down(i % 2 ? 'ArrowRight' : 'ArrowLeft');
    await sleep(120);
    await page.keyboard.up(i % 2 ? 'ArrowRight' : 'ArrowLeft');
    await sleep(120);
    moved = await page.evaluate((d) => window._game.bike.distanceTraveled > d + 0.5 || window._game.bike.speed > 0.3, d0);
  }
  check(moved, 'SR-01: alternating pedal keys move the bike on the runway');

  /** Collect every present in [from, to] and pass every pylon there on its correct side, in road order. */
  const runPhase = async (from, to) => {
    const items = await page.evaluate((a, b) => {
      const g = window._game;
      const presents = g.collectibleManager._items.filter((it) => it.absoluteD >= a && it.absoluteD <= b)
        .map((it) => ({ kind: 'present', d: it.absoluteD, lat: it.lateralOffset }));
      const pylons = (g.obstacleManager?._items || []).filter((it) => it.absoluteD >= a && it.absoluteD <= b)
        .map((it) => ({ kind: 'pylon', d: it.absoluteD, lat: it.lateralOffset }));
      return [...presents, ...pylons].sort((x, y) => x.d - y.d);
    }, from, to);
    let ok = items.length > 0;
    for (const it of items) {
      if (it.kind === 'present') {
        await page.evaluate((d, lat) => window.__tp(d, lat), it.d, it.lat);
        const got = await page.waitForFunction((d) => window._game.collectibleManager._items.find((x) => x.absoluteD === d)?.collected, { timeout: 20000 }, it.d)
          .then(() => true).catch(() => false);
        ok = ok && got;
      } else {
        // Stand beside the pylon on the far side until the game has sampled the pass.
        const side = it.lat < 0 ? 1.5 : -1.5;
        await page.evaluate((d, lat) => window.__tp(d, lat), it.d, side);
        const seen = await page.waitForFunction((d, want) => {
          const p = window._game.obstacleManager._items.find((x) => x.absoluteD === d);
          return p && p._bikeLateralAtPass !== undefined && Math.sign(p._bikeLateralAtPass) === Math.sign(want);
        }, { timeout: 20000 }, it.d, side).then(() => true).catch(() => false);
        ok = ok && seen;
      }
    }
    return { ok, items };
  };

  // Phase 1: lean to collect.
  await page.evaluate(() => window.__tp(30.5, 0));
  check(await waitPrompt(page, /to collect the presents/), 'SR-01: phase 1 prompt "… to collect the presents!"', await prompt(page));
  const p1 = await runPhase(30, 80);
  check(p1.ok && p1.items.length === 4, 'SR-01: phase 1: all four presents collected by the game', p1.items.map((i) => i.kind + '@' + i.d));
  await page.evaluate(() => window.__tp(80.5, 0));
  const passed1 = await page.waitForFunction(() => window._game._tutCompletedPhases?.has(1) && window._game._tutTargetPhase === 2, { timeout: 30000 })
    .then(() => true).catch(() => false);
  check(passed1, 'SR-01: phase 1 passes at its end; the tutorial moves on to phase 2');
  check(await waitPrompt(page, /Pedal to build speed/), 'SR-01: back on a runway before phase 2', await prompt(page));

  // Phase 2: collect and dodge.
  await page.evaluate(() => window.__tp(100.5, 0));
  check(await waitPrompt(page, /Put it all together/), 'SR-01: phase 2 prompt "Put it all together! Collect and dodge!"', await prompt(page));
  const p2 = await runPhase(100, 145);
  check(p2.ok && p2.items.filter((i) => i.kind === 'present').length === 3 && p2.items.filter((i) => i.kind === 'pylon').length === 3,
    'SR-01: phase 2: three presents collected, three pylons passed on the correct side', p2.items.map((i) => i.kind + '@' + i.d));
  await page.evaluate(() => window.__tp(145.5, 0));
  const done = await page.waitForFunction(() => document.getElementById('tutorial-complete')?.classList.contains('visible'), { timeout: 30000 })
    .then(() => true).catch(() => false);
  check(done, 'SR-01: the tutorial-complete screen shows after phase 2');

  // The completion screen: presents tally, "calibrated", the feel slider, a saved calibration.
  const end = await page.evaluate(async () => {
    const cfg = await import('/js/config.js');
    const stats = document.getElementById('tutorial-complete-stats')?.textContent || '';
    const slider = document.getElementById('steering-feel-slider');
    let saved = null;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/tuning/i.test(k)) { try { const v = JSON.parse(localStorage.getItem(k)); if (v && typeof v.sensitivity === 'number') saved = { key: k, ...v }; } catch {} }
    }
    const before = cfg.TUNE.steeringFeel;
    let after = before;
    if (slider) { slider.value = '90'; slider.dispatchEvent(new Event('input')); after = cfg.TUNE.steeringFeel; }
    return {
      stats, slider: !!slider && slider.offsetParent !== null, before, after, saved,
      done: localStorage.getItem('tandemonium_tutorial_done'),
      next: !!document.getElementById('btn-tutorial-next') && document.getElementById('btn-tutorial-next').style.display !== 'none',
    };
  });
  check(/Presents collected: 7\/7/.test(end.stats) && /calibrated/i.test(end.stats), 'SR-01: completion shows "Presents collected: 7/7" and "Steering calibrated"', end.stats);
  check(end.saved && Number.isFinite(end.saved.sensitivity) && Number.isFinite(end.saved.deadzone), 'SR-01: the calibration results are saved (sensitivity, deadzone, …)', end.saved);
  check(end.slider && Math.abs(end.after - 0.9) < 1e-6 && end.after !== end.before, 'SR-01: the steering feel slider is shown and moving it sets the feel', { before: end.before, after: end.after });
  check(end.done === 'complete' && end.next, "SR-01: the tutorial is marked done and NEXT: GRANDMA'S is offered", { done: end.done, next: end.next });
  // #459 item 15: the completion screen is the result-screen shell — NEXT first.
  const shell = await page.evaluate(() => {
    const sheet = document.getElementById('tutorial-complete-sheet');
    const row = sheet && sheet.querySelector('[slot="actions"]');
    const vis = (b) => b.style.display !== 'none' && b.getBoundingClientRect().width > 0;
    return { headline: !!sheet && sheet.hasAttribute('headline'), visible: !!sheet && sheet.getBoundingClientRect().width > 0,
      actions: row ? Array.from(row.querySelectorAll('uf-button')).filter(vis).map((b) => b.id) : [] };
  });
  check(shell.headline && shell.visible && shell.actions[0] === 'btn-tutorial-next', 'SR-01: tutorial complete is a headline sheet with NEXT first in its action row', shell);
  await h.shot(page, 'sr01-tutorial-complete');
  await page.close();
}

// ── SR-21 · goose outfits and colours ──
console.log('SR-21 outfits and colours');
const geese = (page) => page.evaluate(async () => {
  const { colourwayState } = await import('/js/goose-colourways.js');
  const b = window._game.bike, gr = b.goose;
  if (!gr || !gr.riders || !gr.riders.Captain) return { ready: false };
  const root = gr.riders.Captain.root;
  const mats = new Set(); let remapped = 0, total = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || mats.has(m)) continue;
      mats.add(m); total++;
      const st = colourwayState(m);
      if (st && st.u && st.u.cwOn.value === 1) remapped++;
    }
  });
  if (!root.userData.__smokeId) root.userData.__smokeId = Math.random().toString(36).slice(2);
  return {
    ready: true, id: root.userData.__smokeId, captainPath: b._gooseRiderPaths?.Captain || null,
    seated: root.parent?.name === 'Seat_Captain', remapped, total,
    matNames: [...mats].map((m) => m.name).sort().join(','),
  };
});
const openOptions = (page) => page.evaluate(() => window._game._openOptions());
const closeOptions = (page) => page.evaluate(() => window._game._closeOptions());
/** Cyclists captain seated on the bike with its colourway remap live (polled: the swap loads GLBs). */
const cyclistsLive = (page, timeout) => page.waitForFunction(async () => {
  const b = window._game.bike, r = b.goose?.riders?.Captain?.root;
  if (!r || r.parent?.name !== 'Seat_Captain' || !/cyclist/i.test(b._gooseRiderPaths?.Captain || '')) return false;
  const { colourwayState } = await import('/js/goose-colourways.js');
  let n = 0;
  r.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) { const st = m && colourwayState(m); if (st && st.u.cwOn.value === 1) n++; } });
  return n > 0;
}, { timeout }).then(() => true).catch(() => false);
{
  const page = await h.gamePage({ storage: { tandemonium_tutorial_done: 'smoke', tandemonium_goose_outfit: 'victorian' } });
  // The lobby has settled: the bike's geese are loaded before the player opens Options.
  await page.waitForFunction(() => !!window._game.bike?.goose?.riders?.Captain, { timeout: 120000 }).catch(() => {});
  // Chosen in the lobby: Cyclists, then its second colourway.
  await openOptions(page);
  await clickId(page, 'opt-outfit-cyclists');
  await clickId(page, 'opt-colour-1');
  const ui = await page.evaluate(() => ({
    outfit: document.getElementById('opt-outfit-cyclists').classList.contains('active'),
    colour: document.getElementById('opt-colour-1').classList.contains('active'),
    colourShown: document.getElementById('opt-colour-1').style.display !== 'none',
  }));
  check(ui.outfit && ui.colourShown && ui.colour, 'SR-21: Options shows Cyclists and its 2nd colourway as chosen', ui);
  await closeOptions(page);
  await clickId(page, 'btn-solo');
  await sleep(400);
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await cyclistsLive(page, 120000);
  let s = await geese(page);
  check(s.ready && /cyclist/i.test(s.captainPath || '') && s.seated, 'SR-21: the ride starts with the Cyclists captain seated on the bike', s);
  check(s.remapped > 0, 'SR-21: the chosen colourway is live on the captain goose materials', { remapped: s.remapped, of: s.total });
  await h.shot(page, 'sr21-cyclists-colour1');

  // Live in the ride: switch to Georgian; the geese are swapped in place.
  const before = s;
  await openOptions(page);
  await clickId(page, 'opt-outfit-georgian');
  await page.waitForFunction((oldId) => {
    const r = window._game.bike.goose?.riders?.Captain?.root;
    return r && r.parent?.name === 'Seat_Captain' && r.userData.__smokeId !== oldId && /georgian/i.test(window._game.bike._gooseRiderPaths?.Captain || '');
  }, { timeout: 120000 }, before.id).catch(() => {});
  s = await geese(page);
  check(s.ready && s.id !== before.id && /georgian/i.test(s.captainPath || '') && s.seated && s.matNames !== before.matNames,
    'SR-21: switching to Georgian mid-ride swaps a new captain model onto the seat', { path: s.captainPath, newModel: s.id !== before.id, seated: s.seated });
  // Its colourways: the 2nd on, then "own colours" (index 0) off again.
  await clickId(page, 'opt-colour-1');
  const on = await page.waitForFunction(async () => {
    const { colourwayState } = await import('/js/goose-colourways.js');
    let n = 0; window._game.bike.goose.riders.Captain.root.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) { const st = m && colourwayState(m); if (st && st.u.cwOn.value === 1) n++; } });
    return n > 0;
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  check(on, "SR-21: a Georgian colourway applies live (remap on)");
  await clickId(page, 'opt-colour-0');
  s = await geese(page);
  check(s.remapped === 0, "SR-21: \"own colours\" turns the remap off again", { remapped: s.remapped });
  await closeOptions(page);
  check(await page.evaluate(() => localStorage.getItem('tandemonium_goose_outfit')) === 'georgian', 'SR-21: the outfit choice is saved for the next ride');
  await page.close();
}

// Found by this smoke in CI (#472): an outfit chosen while the bike's geese
// were still loading was lost (setGooseRiders returned early with no goose).
// BikeModel now remembers it and seats it when the load ends. Reproduced by
// holding the default captain GLB back for 5 s.
console.log('SR-21 outfit chosen while the geese load');
{
  const page = await h.gamePage({
    storage: { tandemonium_tutorial_done: 'smoke', tandemonium_goose_outfit: 'victorian' },
    before: (p) => p.evaluateOnNewDocument(() => {
      const orig = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (/\/goose_captain\.glb(\?|$)/.test(url)) return new Promise((r) => setTimeout(r, 5000)).then(() => orig(input, init));
        return orig(input, init);
      };
    }),
  });
  const loading = await page.evaluate(() => !window._game.bike?.goose);
  await openOptions(page);
  await clickId(page, 'opt-outfit-cyclists');
  await clickId(page, 'opt-colour-1');
  await closeOptions(page);
  await clickId(page, 'btn-solo');
  await sleep(400);
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  const ok = await cyclistsLive(page, 30000);
  const s = await geese(page);
  if (loading) check(ok, 'SR-21: an outfit picked while the geese are still loading reaches the ride', { captainPath: s.captainPath, remapped: s.remapped });
  else console.log('  (race not reproduced: the geese had loaded before Options opened)');
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
