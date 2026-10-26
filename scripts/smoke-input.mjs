#!/usr/bin/env node
// smoke:input · one player, one device (docs/test-script.md §4).
//
//   IN-01  keyboard: arrow keys pedal, A/D lean, keys move through and pick in
//          the lobby, Esc backs out
//   IN-02  touch (phone): the on-screen pedal bar pedals the bike
//   IN-05  Xbox pad (fake Gamepad API): triggers and bumpers pedal, the left
//          stick leans, A picks and B backs in menus
//   IN-15  Recenter from the quick menu mid-ride: tilt calibration runs again
//          and the ride carries on
//   IN-16  button prompts match P1's pad: lobby glyphs and the in-ride pedal hint
//
// Real input events throughout (page.keyboard, CDP touch, fake pads through
// the real ControllerManager). Every outcome is polled: CI runs at 1-3 fps.
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';

const h = await startHarness({ port: 8981, outDir: 'tandemonium-input' });
const { check } = h;
const STORAGE = { tandemonium_tutorial_done: 'smoke' };
const until = async (page, fn, arg, timeout = 15000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }, arg).then(() => true).catch(() => false);
const step = (page) => page.evaluate(() => document.getElementById('lobby-flow').current);

/** Record every balance update's lean input (the steering the bike is given). */
const recordLean = (page) => page.evaluate(() => {
  const g = window._game, bc = g.balanceCtrl;
  if (bc.__rec) return;
  const up = bc.update.bind(bc);
  window.__lean = { min: 0, max: 0, last: 0 };
  bc.update = (...a) => { const r = up(...a); const l = r && r.leanInput || 0; const s = window.__lean; s.last = l; s.min = Math.min(s.min, l); s.max = Math.max(s.max, l); return r; };
  bc.__rec = true;
});
const resetLean = (page) => page.evaluate(() => { window.__lean = { min: 0, max: 0, last: 0 }; });
const lean = (page) => page.evaluate(() => window.__lean);
const dist = (page) => page.evaluate(() => window._game.bike.distanceTraveled);

/** Start a Grandma's ride from the lobby with the buttons (the input under test drives it after). */
async function startRide(page) {
  if (await step(page) === 'lobby-mode') { await clickId(page, 'btn-solo'); await until(page, () => document.getElementById('lobby-flow').current === 'lobby-level'); }
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await recordLean(page);
}

/** Alternate two pedal actions `n` times, each held long enough for a few slow frames. */
async function pedal(page, down, up, n = 8, holdMs = 250) {
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 'R' : 'L';
    await down(side); await sleep(holdMs); await up(side); await sleep(80);
  }
}

// ── IN-01 · keyboard ──
console.log('IN-01 keyboard');
{
  const page = await h.gamePage({ storage: STORAGE });
  await until(page, () => !!document.getElementById('btn-solo'));
  // Lobby with keys only: Tab to SOLO, Enter picks it, Esc comes back.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => { const a = document.activeElement; return !!a && (a.id === 'btn-solo' || !!a.closest?.('#btn-solo')); });
  }
  check(reached, 'IN-01 Tab reaches SOLO in the lobby');
  await page.keyboard.press('Enter');
  check(await until(page, () => document.getElementById('lobby-flow').current === 'lobby-level'), 'IN-01 Enter on SOLO opens the level list', await step(page));
  await page.keyboard.press('Escape');
  check(await until(page, () => document.getElementById('lobby-flow').current === 'lobby-mode'), 'IN-01 Esc backs out to mode select', await step(page));
  // Arrow keys in the lobby: whatever they do, they must not leave the lobby or throw.
  const before = await step(page);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp');
  check(await step(page) === before, 'IN-01 arrow keys in the lobby leave the step alone (they pedal in a ride)', before);

  await startRide(page);
  const d0 = await dist(page);
  await pedal(page, (s) => page.keyboard.down(s === 'L' ? 'ArrowLeft' : 'ArrowRight'), (s) => page.keyboard.up(s === 'L' ? 'ArrowLeft' : 'ArrowRight'));
  check(await until(page, (d) => window._game.bike.distanceTraveled > d + 0.3, d0), 'IN-01 alternating ← → pedals the bike forward', { from: d0, to: await dist(page) });
  await resetLean(page);
  await page.keyboard.down('KeyA');
  const leftOk = await until(page, () => window.__lean.min <= -0.5);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('KeyD');
  const rightOk = await until(page, () => window.__lean.max >= 0.5);
  await page.keyboard.up('KeyD');
  const l = await lean(page);
  check(leftOk && rightOk, 'IN-01 A leans left, D leans right', l);
  check(await page.evaluate(() => window._game.balanceCtrl.steerFrames.keyboard > 0), 'IN-01 the steering counts as keyboard');
  await page.close();
}

// ── IN-02 · touch ──
console.log('IN-02 touch');
{
  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  // A phone starts a ride only once its motion sensors report: stand in a
  // level deviceorientation stream from page load, as a real phone sends.
  const sensors = (p) => p.evaluateOnNewDocument(() => {
    setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: 5, gamma: 0 }); window.dispatchEvent(e); }, 16);
  });
  const page = await h.gamePage({ storage: STORAGE, viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, userAgent: UA, before: sensors });
  await until(page, () => !!document.getElementById('btn-solo'));
  await startRide(page);
  const bar = await page.evaluate(() => { const r = document.getElementById('pedal-bar').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, shown: r.width > 0 && r.height > 0 }; });
  check(bar.shown, 'IN-02 the on-screen pedal bar is shown on a phone', bar);
  const cdp = await page.createCDPSession();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const at = (s) => ({ x: bar.x + bar.w * (s === 'L' ? 0.25 : 0.75), y: bar.y + bar.h / 2 });
  // Holding the left half holds the left pedal (and only it).
  await touch('touchStart', at('L').x, at('L').y);
  const heldL = await until(page, () => window._game.input.touchLeft && !window._game.input.touchRight, null, 5000);
  await touch('touchEnd');
  check(heldL, 'IN-02 a finger on the left half holds the left pedal only');
  const d0 = await dist(page);
  await pedal(page, (s) => touch('touchStart', at(s).x, at(s).y), () => touch('touchEnd'));
  check(await until(page, (d) => window._game.bike.distanceTraveled > d + 0.3, d0), 'IN-02 alternating taps on the pedal bar ride the bike', { from: d0, to: await dist(page) });
  check(await page.evaluate(() => !window._game.input.touchLeft && !window._game.input.touchRight), 'IN-02 lifting the finger lets go of both pedals');
  await page.close();
}

// ── IN-05 · Xbox pad ──
console.log('IN-05 Xbox pad');
{
  const page = await h.gamePage({ storage: STORAGE, before: (p) => installFakeGamepads(p, { atBoot: ['xbox'] }) });
  const pads = fakePads(page);
  check(await until(page, () => window.__controllerManager?.getSlot('P1').state === 'claimed'), 'IN-05 the Xbox pad is P1');
  // Menus: D-pad moves the focus, A picks, B backs.
  await until(page, () => !!document.querySelector('.gamepad-focus'));
  const f0 = await page.evaluate(() => document.querySelector('.gamepad-focus')?.id || '');
  await pads.tap(0, 'DOWN');
  const moved = await until(page, (f) => (document.querySelector('.gamepad-focus')?.id || '') !== f, f0, 5000);
  check(moved, 'IN-05 D-pad down moves the menu focus', { from: f0, to: await page.evaluate(() => document.querySelector('.gamepad-focus')?.id || '') });
  // Back to SOLO and pick it with A.
  for (let i = 0; i < 8 && (await page.evaluate(() => document.querySelector('.gamepad-focus')?.id)) !== 'btn-solo'; i++) await pads.tap(0, 'UP');
  check(await page.evaluate(() => document.querySelector('.gamepad-focus')?.id) === 'btn-solo', 'IN-05 D-pad up returns to SOLO');
  await pads.tap(0, 'A');
  check(await until(page, () => document.getElementById('lobby-flow').current === 'lobby-level'), 'IN-05 A picks SOLO', await step(page));
  await pads.tap(0, 'B');
  check(await until(page, () => document.getElementById('lobby-flow').current === 'lobby-mode'), 'IN-05 B backs to mode select', await step(page));

  await startRide(page);
  // Triggers: LT is the left pedal, RT the right.
  await pads.hold(0, 'LT', true);
  const lt = await until(page, () => window._game.input.isPressed('ArrowLeft') && !window._game.input.isPressed('ArrowRight'), null, 5000);
  await pads.hold(0, 'LT', false);
  await pads.hold(0, 'RB', true);
  const rb = await until(page, () => window._game.input.isPressed('ArrowRight') && !window._game.input.isPressed('ArrowLeft'), null, 5000);
  await pads.hold(0, 'RB', false);
  check(lt && rb, 'IN-05 LT holds the left pedal, RB the right (triggers and bumpers both pedal)', { lt, rb });
  const d0 = await dist(page);
  await pedal(page, (s) => pads.hold(0, s === 'L' ? 'LT' : 'RT', true), (s) => pads.hold(0, s === 'L' ? 'LT' : 'RT', false));
  check(await until(page, (d) => window._game.bike.distanceTraveled > d + 0.3, d0), 'IN-05 alternating triggers pedal the bike forward', { from: d0, to: await dist(page) });
  await resetLean(page);
  await pads.stick(0, 'LX', -0.9);
  const sl = await until(page, () => window.__lean.min <= -0.4);
  await pads.stick(0, 'LX', 0.9);
  const sr = await until(page, () => window.__lean.max >= 0.4);
  await pads.stick(0, 'LX', 0);
  check(sl && sr, 'IN-05 the left stick leans the bike both ways', await lean(page));
  check(await page.evaluate(() => window._game.balanceCtrl.steerFrames.gamepad > 0), 'IN-05 the steering counts as gamepad');
  await page.close();
}

// ── IN-15 · Recenter from the quick menu mid-ride (a phone: tilt steering) ──
console.log('IN-15 recenter');
{
  const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  // A steady tilt stream the test can lean: window.__tilt is the phone's gamma.
  const sensors = (p) => p.evaluateOnNewDocument(() => {
    window.__tilt = 0;
    setInterval(() => { const e = new Event('deviceorientation'); Object.assign(e, { alpha: 0, beta: 5, gamma: window.__tilt }); window.dispatchEvent(e); }, 16);
  });
  const page = await h.gamePage({ storage: STORAGE, viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, userAgent: UA, before: sensors });
  await until(page, () => !!document.getElementById('btn-solo'));
  await startRide(page);
  const ready = await until(page, () => window._game.input.motionEnabled && window._game.input.motionOffset != null && !window._game.input._calibrating, null, 20000);
  check(ready, 'IN-15 tilt steering is on and calibrated');
  // Hold the device tilted: the bike is told to lean.
  await page.evaluate(() => { window.__tilt = 35; });
  const leaning = await until(page, () => Math.abs(window._game.input.getMotionLean()) > 0.15, null, 15000);
  const off0 = await page.evaluate(() => window._game.input.motionOffset);
  check(leaning, 'IN-15 holding a tilt leans the bike', await page.evaluate(() => window._game.input.getMotionLean()));
  // Quick menu → Recenter.
  await clickId(page, 'quick-menu-btn');
  const shown = await until(page, () => { const b = document.getElementById('qm-recenter'); return !!b && b.offsetParent !== null; }, null, 5000);
  check(shown, 'IN-15 the quick menu offers Recenter while tilt steering is on');
  // Watch the calibration from inside the page: on a slow runner it can start
  // and finish between two polls.
  await page.evaluate(() => {
    const im = window._game.input; window.__calStarted = false;
    const orig = im.startTiltCalibration.bind(im);
    im.startTiltCalibration = (...a) => { window.__calStarted = true; return orig(...a); };
  });
  await clickId(page, 'qm-recenter');
  const started = await until(page, () => window.__calStarted === true, null, 3000);
  const done = await until(page, () => window.__calStarted && window._game.input._calibrating === false, null, 20000);
  const off1 = await page.evaluate(() => window._game.input.motionOffset);
  check(started && done, 'IN-15 Recenter runs a fresh tilt calibration', { started, done });
  check(off0 != null && off1 != null && Math.abs(off1 - off0) > 5, 'IN-15 the held tilt becomes the new centre', { before: off0, after: off1 });
  const centred = await until(page, () => Math.abs(window._game.input.getMotionLean()) < 0.1, null, 10000);
  check(centred, 'IN-15 after recentring, the same hold leans no more', await page.evaluate(() => window._game.input.getMotionLean()));
  check(await until(page, () => !document.getElementById('quick-menu-overlay')?.classList.contains('open'), null, 5000), 'IN-15 Recenter closes the quick menu');
  // Keep holding that tilt (it is the centre now) and ride on the pedal bar.
  const bar = await page.evaluate(() => { const r = document.getElementById('pedal-bar').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const cdp = await page.createCDPSession();
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const d0 = await dist(page);
  await pedal(page, (s) => touch('touchStart', bar.x + bar.w * (s === 'L' ? 0.25 : 0.75), bar.y + bar.h / 2), () => touch('touchEnd'));
  check(await until(page, (d) => window._game.state === 'playing' && window._game.bike.distanceTraveled > d + 0.3, d0), 'IN-15 the ride carries on after recentring', { state: await page.evaluate(() => window._game.state) });
  await page.close();
}

// ── IN-16 · button prompts follow P1's pad ──
console.log('IN-16 prompts');
const FAMILY = {
  xbox: { family: 'xbox', back: 'B button', lb: 'LB', rb: 'RB' },
  dualsense: { family: 'playstation', back: '◯ button', lb: 'L1', rb: 'R1' },
  switchpro: { family: 'nintendo', back: 'A button', lb: 'L', rb: 'R' },
  steam: { family: 'steam', back: 'B button', lb: 'LB', rb: 'RB' },
};
/** A bug this smoke found: printed, not failed, until fixed (then make it a check). */
const known = (ok, name, detail) => console.log(`  ${ok ? 'FIXED (make this a check)' : 'KNOWN BUG'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
for (const [model, want] of Object.entries(FAMILY)) {
  // The coach card shows once per input method (a localStorage flag every page
  // here shares): clear it so each pad's first ride gets the card.
  const fresh = (p) => p.evaluateOnNewDocument(() => { try { for (const k of Object.keys(localStorage)) if (k.startsWith('tandemonium_coach_seen_')) localStorage.removeItem(k); } catch {} });
  const page = await h.gamePage({ storage: STORAGE, before: async (p) => { await fresh(p); await installFakeGamepads(p, { atBoot: [model] }); } });
  await until(page, () => window.__controllerManager?.getSlot('P1').state === 'claimed');
  // The level list's prompts (the system bar's Back glyph) draw P1's family;
  // mode select itself shows no glyph.
  await clickId(page, 'btn-solo');
  await until(page, () => document.getElementById('lobby-flow').current === 'lobby-level');
  const ok = await until(page, (f) => {
    const gs = [...document.querySelectorAll('uf-controller-glyph')].filter((g) => g.offsetParent !== null && (g.getAttribute('family') || 'auto') === 'auto');
    return gs.length > 0 && gs.every((g) => g.resolvedFamily === f);
  }, want.family, 10000);
  const seen = await page.evaluate(() => [...document.querySelectorAll('uf-controller-glyph')].filter((g) => g.offsetParent !== null && (g.getAttribute('family') || 'auto') === 'auto')
    .map((g) => ({ fam: g.resolvedFamily, button: g.getAttribute('button'), label: g.getAttribute('aria-label') })));
  check(ok, `IN-16 ${model}: lobby prompts draw ${want.family} glyphs`, seen);
  const back = seen.find((s) => s.button === 'back');
  check(!!back && back.label === want.back, `IN-16 ${model}: the Back prompt reads "${want.back}"`, back);
  if (model !== 'steam') {
    await clickId(page, 'btn-start-ride');
    await waitState(page, 'playing');
    // The first-ride coach card names the pedal buttons.
    const shown = await until(page, () => document.getElementById('coach-card')?.classList.contains('show'), null, 15000);
    check(shown, `IN-16 ${model}: the first-ride coach card shows`);
    const coach = await page.evaluate(() => document.getElementById('coach-pedal-line')?.textContent || '');
    const coachOk = coach.includes(`${want.lb} and ${want.rb}`);
    check(coachOk, `IN-16 ${model}: the coach card names ${want.lb}/${want.rb}`, coach);
    // Stopped after moving off: the HUD's pedal hint names this pad's shoulder
    // buttons. Hold the bike still (it creeps at ~0.5 otherwise).
    await page.evaluate(() => {
      const b = window._game.bike, up = b.update.bind(b);
      b.distanceTraveled = Math.max(1, b.distanceTraveled);
      b.update = (...a) => { const r = up(...a); b.speed = 0; return r; };
    });
    const hint = await until(page, (lb) => new RegExp(`Alternate ${lb}/`).test(document.getElementById('status').textContent), want.lb, 10000);
    check(hint, `IN-16 ${model}: the stopped-bike hint names ${want.lb}/${want.rb}`, await page.evaluate(() => document.getElementById('status').textContent));
  }
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
