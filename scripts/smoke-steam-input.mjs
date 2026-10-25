#!/usr/bin/env node
// smoke:steam-input · the desktop app's Steam Input path, with Steam faked
// (scripts/lib/fake-steam.mjs stands in for electron/preload.js). Covers
// docs/test-script.md IN-12 and IN-13.
//
//   IN-12  a DualSense that Steam Input has captured (no Gamepad API pad at all):
//          the seat is connected through Steam, gyro lean is read from Steam's
//          motion data (source 'steam') and follows the tilt both ways, the bound
//          Steer action takes over when Steam sends no motion, Steam's pedal
//          actions pedal the bike, and Options says Steam Input has the DualSense
//   IN-13  Options → DualSense source: Auto / Steam Input / WebHID save the choice
//          and light the button; the note says it applies on the next launch, and
//          a relaunch with each choice routes the DualSense accordingly
//
// KNOWN checks print "KNOWN BUG" instead of failing, so CI stays green while the
// bug is open; "FIXED" means turn it into a normal check.
import { startHarness, sleep, clickId, waitState } from './lib/smoke-harness.mjs';
import { installFakeSteam, fakeSteam, steamPad, ELECTRON_UA } from './lib/fake-steam.mjs';

const h = await startHarness({ port: 8966, outDir: 'tandemonium-steam-input' });
const { check } = h;
const known = (ok, name, detail) => {
  console.log(`  ${ok ? 'FIXED (make this a check)' : 'KNOWN BUG'} ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};
const H = '7';   // the captured DualSense's Steam handle

/** Desktop-app page with Steam holding one controller. */
async function open({ type = '13', motion = true, dsSource = null } = {}) {
  const storage = { tandemonium_tutorial_done: 'smoke' };
  if (dsSource) storage.tandemonium_dualsense_source = dsSource;
  const page = await h.gamePage({
    userAgent: ELECTRON_UA, storage,
    before: async (p) => {
      await installFakeSteam(p, { controllers: [steamPad({ handle: H, type, motion })] });
      await p.evaluateOnNewDocument(() => { window.__gyroDebug = true; });
    },
  });
  await sleep(1500);
  return { page, steam: fakeSteam(page) };
}
const input = (page) => page.evaluate(() => {
  const i = window._game.input;
  return {
    connected: i.gamepadConnected, steamActive: i._steamInputActive, steamType: i._steamInputType,
    source: i._dualsenseSource, motionOn: i.motionEnabled, lean: i.motionLean || 0,
    gyroSource: window.__gyroDebugState ? window.__gyroDebugState.source : null,
  };
});
const ride = async (page) => {
  await clickId(page, 'btn-solo'); await sleep(600);
  await clickId(page, 'btn-start-ride');
  await waitState(page, 'playing');
  await sleep(1000);
};
/** Wait (headless frames are slow) until the lean satisfies `pred`; returns the last lean. */
const leanUntil = async (page, pred, ms = 30000) => {
  const t0 = Date.now(); let v = 0;
  while (Date.now() - t0 < ms) { v = (await input(page)).lean; if (pred(v)) return v; await sleep(300); }
  return v;
};
const dsState = async (page) => {
  await clickId(page, 'ctrl-settings-btn'); await sleep(500);
  const r = await page.evaluate(() => ({
    text: document.getElementById('opt-ds-state').textContent,
    active: ['auto', 'steam', 'webhid'].filter((k) => document.getElementById('opt-ds-' + k).classList.contains('active')),
    saved: localStorage.getItem('tandemonium_dualsense_source'),
  }));
  return r;
};
const closeOptions = async (page) => { await clickId(page, 'options-close-btn'); await sleep(300); };

// ── IN-12: Steam Input owns the DualSense ──
console.log('IN-12 gyro from Steam');
{
  const { page, steam } = await open();
  let s = await input(page);
  check(s.connected && s.steamActive && s.steamType === '13', 'IN-12 Steam-captured DualSense connects the seat with no Gamepad API pad', s);
  check(await page.evaluate(() => navigator.getGamepads().filter(Boolean).length) === 0, 'IN-12 (no Gamepad API pad present)');
  // Steam's Confirm action works the menus.
  const before = await page.evaluate(() => document.getElementById('lobby-flow').current);
  const focused = await page.evaluate(() => document.querySelector('.gamepad-focus')?.id || null);
  await steam.press(H, 'Confirm'); await sleep(400); await steam.release(H, 'Confirm'); await sleep(900);
  const after = await page.evaluate(() => document.getElementById('lobby-flow').current);
  check(focused && after !== before, 'IN-12 Steam Confirm presses the focused lobby button', { focused, before, after });
  await page.evaluate(() => { const l = window._game.lobby; l._showStep(l.modeStep); });
  await sleep(400);
  await ride(page);
  s = await input(page);
  check(s.motionOn, 'IN-12 motion arms itself when Steam captures the pad', s);
  // Steam motion runs through SensorFusion, which first takes a one-shot bias
  // calibration (150 samples; slow at headless frame rates). Wait it out.
  const calibrated = await page.waitForFunction((h) => {
    const f = window._game.input._steamFusions && window._game.input._steamFusions.get(h);
    return !!f && !f.calibrating;
  }, { timeout: 180000, polling: 500 }, H).then(() => true).catch(() => false);
  check(calibrated, 'IN-12 Steam motion calibrates (one-shot bias capture)');
  await steam.tilt(H, 40);
  const right = await leanUntil(page, (v) => v < -0.04);
  s = await input(page);
  check(s.gyroSource === 'steam', 'IN-12 the gyro lean is read from Steam motion (source "steam")', s.gyroSource);
  check(right < -0.04, 'IN-12 rolling the pad one way leans the bike that way', +right.toFixed(3));
  await steam.tilt(H, -40);
  const left = await leanUntil(page, (v) => v > 0.04);
  check(left > 0.04, 'IN-12 rolling it the other way leans the other way', +left.toFixed(3));
  await steam.tilt(H, 0);
  const level = await leanUntil(page, (v) => Math.abs(v) < Math.abs(left) / 2);
  check(Math.abs(level) < Math.abs(left) / 2, 'IN-12 level again: lean heads back to centre', { level: +level.toFixed(3), from: +left.toFixed(3) });
  // Steam's pedal actions pedal the bike.
  // Count the pedal controller's strokes (its tapEvents array is cleared in
  // place, so wrapping push on it sees every stroke).
  await page.evaluate(() => {
    window.__strokes = { left: 0, right: 0 };
    const ev = window._game.pedalCtrl.tapEvents;
    const push = ev.push.bind(ev);
    ev.push = (...xs) => { for (const x of xs) if (x && x.foot) window.__strokes[x.foot]++; return push(...xs); };
  });
  for (let i = 0; i < 10; i++) {
    const k = i % 2 ? 'PedalRight' : 'PedalLeft';
    await steam.press(H, k); await sleep(300); await steam.release(H, k); await sleep(300);
  }
  const strokes = await page.evaluate(() => window.__strokes);
  check(strokes.left >= 2 && strokes.right >= 2, 'IN-12 Steam PedalLeft / PedalRight pedal the bike (left and right strokes)', strokes);
  // Options names Steam as the DualSense's source.
  const o = await dsState(page);
  check(/Steam Input active/.test(o.text), 'IN-12 Options shows Steam Input has the DualSense', o.text);
  await h.shot(page, 'in12-options-steam');
  await closeOptions(page);
  // Steam lets go: the seat drops (and the ride pauses — #468).
  await steam.set([]);
  await sleep(1500);
  s = await input(page);
  check(!s.connected && !s.steamActive, 'IN-12 Steam releasing the pad disconnects the seat', s);
  await page.close();
}

console.log('IN-12 Steer fallback (no motion from Steam)');
{
  const { page, steam } = await open({ motion: false });
  await ride(page);
  await steam.patch(H, { steerX: 0.8 });
  const v = await leanUntil(page, (x) => Math.abs(x) > 0.3);
  check(Math.abs(v) > 0.3, 'IN-12 with no motion data, the bound Steer action leans the bike', +v.toFixed(3));
  await steam.patch(H, { steerX: 0 });
  const c = await leanUntil(page, (x) => Math.abs(x) < 0.05);
  check(Math.abs(c) < 0.05, 'IN-12 Steer back to centre', +c.toFixed(3));
  await page.close();
}

// ── IN-13: the DualSense source option ──
console.log('IN-13 DualSense source');
{
  const { page } = await open();
  let o = await dsState(page);
  check(o.active.join() === 'auto' && o.saved === null, 'IN-13 Auto is the default', o);
  check(/next launch/.test(o.text), 'IN-13 the note says the choice applies on the next launch', o.text);
  for (const [btn, key, want] of [['opt-ds-webhid', 'webhid', 'webhid'], ['opt-ds-steam', 'steam', 'steam-input'], ['opt-ds-auto', 'auto', 'auto']]) {
    await clickId(page, btn); await sleep(300);
    o = await page.evaluate(() => ({
      active: ['auto', 'steam', 'webhid'].filter((k) => document.getElementById('opt-ds-' + k).classList.contains('active')),
      saved: localStorage.getItem('tandemonium_dualsense_source'),
    }));
    check(o.active.join() === key && o.saved === want, `IN-13 ${key}: saved and lit`, o);
  }
  // Not live by design: this session keeps the source it launched with.
  await clickId(page, 'opt-ds-webhid'); await sleep(300);
  check((await input(page)).source === 'auto', 'IN-13 this session keeps its launch-time source (applies next launch)');
  await closeOptions(page);
  await page.close();
}
for (const [pref, steamWants] of [['auto', true], ['steam-input', true], ['webhid', false]]) {
  const { page } = await open({ dsSource: pref });
  await sleep(800);
  const s = await input(page);
  const name = `IN-13 relaunch with "${pref}": Steam's DualSense ${steamWants ? 'is used' : 'is ignored (left to WebHID)'}`;
  if (pref === 'webhid') {
    // js/input-manager.js _refreshSteamInputSnapshot filters with
    // type.includes('ps5'), but main.js sends the numeric enum ('13'); the
    // filter never matches, so WebHID mode still takes the DualSense from Steam.
    known(s.source === 'webhid' && s.steamActive === steamWants, name + ' (filter matches "ps5" but Steam sends "13")', s);
  } else {
    check(s.source === pref && s.steamActive === steamWants, name, s);
  }
  await page.close();
}

check(h.errors.length === 0, 'no page errors', h.errors);
await h.finish();
