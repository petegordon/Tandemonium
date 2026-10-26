#!/usr/bin/env node
// smoke:webhid · WebHID controllers at the parsing and seat level (test script
// IN-06, IN-08, IN-10, IN-11, MC-11, MC-12). Gyro FEEL stays manual.
//
// A fake navigator.hid (scripts/lib/fake-webhid.mjs) replays recorded reports
// (scripts/fixtures/hid/, copied from the controller lab) through the real
// drivers and ControllerManager; the Gamepad API side is fake-gamepads.mjs.
//
//   IN-06  DualSense USB: pooled, bound to the P1 pad's seat, DS5 IMU layout,
//          accel ≈ 1 g, gyro live, PlayStation prompts, HID buttons parse
//   IN-08  DualShock 4 v1 over Bluetooth: BT detected, feature 0x02 read flips
//          it to full reports (0x11), gyro live on P1
//   IN-11  GameSir Super Nova (DS4 mode): GameSir IMU family at byte 12, gyro live
//   IN-10  Steam Controller via Puck: HID-only seat by pressing A, lizard-mode
//          handshake sent, "Steam Controller 2026 (via Puck)", Steam prompts
//   MC-11  two identical DualSense: each seat keeps its own unit across one
//          disconnect + reconnect (a NEW HIDDevice object, as Chrome hands out)
//   MC-12  two Steam Controller bodies on one Puck (+ an idle receiver
//          interface): two seats, each its own body, idle interface unseated
//
//   boot   a pad + already-granted HID device present at boot: the controller
//          is held once and seats once (the core poolDevice race, fixed in
//          controller-core 0.6.1)
import { startHarness, sleep } from './lib/smoke-harness.mjs';
import { installFakeGamepads, fakePads } from './lib/fake-gamepads.mjs';
import { installFakeWebHid, fakeHid, hidDevice, FACE_A } from './lib/fake-webhid.mjs';

const h = await startHarness({ port: 8964 });
const { check } = h;
const STORAGE = { tandemonium_tutorial_done: 'smoke' };
const known = [];

/** Seat + pool snapshot. HID devices are named by their fake key. */
const snap = (page) => page.evaluate(() => {
  const m = window.__controllerManager;
  const g = window._game;
  const key = (d) => (d ? d.__fakeKey : null);
  const slots = m.slots.map((s) => ({
    id: s.id, state: s.state, pad: s.gamepadIndex, hid: key(s.hidDevice),
    driver: s.driver?.entry?.name || null, conn: s.driver?.connectionType || null,
    family: s.driver?._detectedImuFamily || null, gyroOffset: s.driver?._detectedImuOffset?.gyroOffset ?? null,
    streaming: !!(s._hidEntry && s._hidEntry.hidActiveSince > 0), accelOk: !!s._hidEntry?._accelVerified,
    btnA: !!(s._hidEntry?.synthetic?.buttons?.[0]?.pressed),
  }));
  const pool = [...m._hidPool.values()].map((e) => ({ hid: key(e.device), driver: e.driver?.entry?.name || null, streaming: e.hidActiveSince > 0 }));
  const id = g.lobby._p1Identity();
  return { slots, pool, p1: id ? { name: id.name, glyph: id.glyphFamily } : null, gyroP1: g.input.gyroConnected };
});
const slot = (s, id) => s.slots.find((x) => x.id === id);

// Everything waits on state, never on a fixed delay: a CI runner draws 1–3 fps
// under software WebGL, so one game frame can take most of a second.
const WAIT_MS = 45000;

// A throttled or CI page can take longer than puppeteer's 30 s default just to load.
const slowLoad = (p) => { p.setDefaultNavigationTimeout(180000); p.setDefaultTimeout(180000); };

/** Poll the snapshot until `pred(snap)` holds (or time runs out); returns the last snapshot. */
async function waitFor(page, pred, timeout = WAIT_MS) {
  let s;
  for (const t0 = Date.now(); ;) {
    s = await snap(page);
    if (pred(s) || Date.now() - t0 > timeout) return s;
    await sleep(200);
  }
}

/** True once each named device is streaming, pooled or seated. */
const streamingAll = (keys) => (s) => keys.every((k) => s.pool.some((e) => e.hid === k && e.streaming) || s.slots.some((x) => x.hid === k && x.streaming));

/** Set A on a pad and its HID twin in ONE page task, so no game frame sees one without the other. */
const setBoth = (ctx, padIndex, hidKey, bit, on) => ctx.page.evaluate((k, o, m, pi, down) => {
  window.__fakeHid.hold(k, o, m, down);
  if (pi != null) window.__fakePads.hold(pi, 'A', down);
}, hidKey, bit.offset, bit.mask, padIndex, on);

/**
 * Hold A on a pad and on its HID twin together (one physical press reads on
 * both at once) until `pred(snap)` holds, then release and wait for it to land.
 * Both are set in the same page task: two separate calls let a slow page draw a
 * frame between them, and then core's ambiguous-unit binding guesses (see the
 * MC-11 note below).
 */
async function holdUntil(ctx, padIndex, hidKey, bit, pred, timeout = WAIT_MS) {
  await setBoth(ctx, padIndex, hidKey, bit, true);
  const s = await waitFor(ctx.page, pred, timeout);
  await setBoth(ctx, padIndex, hidKey, bit, false);
  await waitFor(ctx.page, (x) => !x.slots.some((y) => y.btnA), 5000);
  return s;
}

/**
 * Open the game with these HID devices granted, wait for them to stream, then
 * plug `pads` (a pad plugged after launch, as most are). `join` seats P1 the
 * way a player does: if the lobby's boot auto-claim didn't take the pad (its
 * 2 s window can pass before the pad shows on a slow machine), press A on it
 * (pad + its HID twin together) until the seat is claimed and bound.
 */
async function open(devices, { pads = [], join = null } = {}) {
  const page = await h.gamePage({ storage: STORAGE, before: async (p) => { slowLoad(p); await installFakeWebHid(p, devices); await installFakeGamepads(p); } });
  const ctx = { page, pads: fakePads(page), hid: fakeHid(page), idx: [] };
  await waitFor(page, streamingAll(devices.filter((d) => d.reports.length).map((d) => d.key)));
  for (const m of pads) ctx.idx.push(await ctx.pads.plug(m));
  if (join) {
    const seated = (s) => slot(s, 'P1').state === 'claimed' && slot(s, 'P1').hid === join.hid && slot(s, 'P1').streaming;
    if (!seated(await waitFor(page, seated, 3000))) { console.log('  (pad not auto-claimed; joining by pressing A)'); await holdUntil(ctx, join.pad, join.hid, join.bit, seated); }
    await waitFor(page, (s) => seated(s) && slot(s, 'P1').accelOk && s.gyroP1 && !!s.p1);
  }
  return ctx;
}

// ── IN-06 DualSense USB ──
console.log('IN-06 DualSense USB');
{
  const ctx = await open([hidDevice.dualsenseUsb('ds')], { pads: ['dualsense'], join: { pad: 0, hid: 'ds', bit: FACE_A.ds5Usb } });
  let s = await snap(ctx.page);
  const p1 = slot(s, 'P1');
  check(p1.state === 'claimed' && p1.pad === 0 && p1.hid === 'ds', 'IN-06: the DualSense pad claims P1 and its HID device binds to that seat', p1);
  check(p1.driver === 'Sony DualSense' && p1.conn === 'usb' && p1.family === 'sony-ds5' && p1.gyroOffset === 15, 'IN-06: DualSense driver, USB, DS5 IMU layout (gyro at byte 15)', p1);
  check(p1.streaming && p1.accelOk && s.gyroP1, 'IN-06: reports streaming, accel ≈ 1 g, P1 gyro live', { streaming: p1.streaming, accelOk: p1.accelOk, gyro: s.gyroP1 });
  check(s.p1 && s.p1.name === 'Sony DualSense' && s.p1.glyph === 'playstation', 'IN-06: lobby names it "Sony DualSense" with PlayStation prompts', s.p1);
  await ctx.hid.hold('ds', FACE_A.ds5Usb, true);
  s = await waitFor(ctx.page, (x) => slot(x, 'P1').btnA, 15000);
  check(slot(s, 'P1').btnA, 'IN-06: cross in the HID report reads as button 0 on the seat');
  await ctx.hid.hold('ds', FACE_A.ds5Usb, false);
  check(!s.pool.some((e) => e.hid === 'ds'), 'IN-06: one entry for the device (none left in the pool)', s.pool);
  await ctx.page.close();
}

// ── IN-08 DualShock 4 v1 over Bluetooth ──
console.log('IN-08 DualShock 4 BT');
{
  const ctx = await open([hidDevice.ds4Bt('ds4')], { pads: ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)'], join: { pad: 0, hid: 'ds4', bit: FACE_A.ds4Bt } });
  const s = await snap(ctx.page);
  const p1 = slot(s, 'P1');
  const st = await ctx.hid.stats('ds4');
  check(p1.hid === 'ds4' && p1.driver === 'Sony DualShock 4 v1' && p1.conn === 'bluetooth', 'IN-08: DS4 v1 bound to P1, Bluetooth detected', p1);
  check(st.featureReads >= 1, 'IN-08: feature report read to leave compatibility mode', st.featureReads);
  check(p1.streaming && p1.accelOk && p1.gyroOffset === 14 && s.gyroP1, 'IN-08: full 0x11 reports parse at the BT offset (14), accel ≈ 1 g, gyro live', p1);
  check(s.p1 && s.p1.glyph === 'playstation', 'IN-08: PlayStation prompts', s.p1);
  await ctx.page.close();
}

// ── IN-11 GameSir Super Nova (DS4 mode) ──
console.log('IN-11 Super Nova');
{
  const ctx = await open([hidDevice.superNova('nova')], { pads: ['ds4'], join: { pad: 0, hid: 'nova', bit: FACE_A.ds4Usb } });
  const s = await snap(ctx.page);
  const p1 = slot(s, 'P1');
  check(p1.hid === 'nova' && p1.conn === 'usb' && p1.family === 'gamesir-ds4' && p1.gyroOffset === 12, 'IN-11: Super Nova bound to P1, GameSir IMU family (byte 12), USB', p1);
  check(p1.streaming && p1.accelOk && s.gyroP1, 'IN-11: recorded reports parse, accel ≈ 1 g, gyro live', p1);
  // The IMU layout can't tell a Super Nova from a real DS4 v2 (same vid:pid,
  // same bytes), so the seat shows the DS4 v2 name. Recorded, not asserted.
  console.log(`  note IN-11: named "${s.p1 && s.p1.name}" (a Super Nova can't be told from a DS4 v2 by WebHID alone)`);
  await ctx.page.close();
}

// ── IN-10 Steam Controller via Puck ──
console.log('IN-10 Steam Controller via Puck');
{
  const ctx = await open([hidDevice.steamPuck('puck')]);
  let s = await snap(ctx.page);
  const st = await ctx.hid.stats('puck');
  const pooled = s.pool.find((e) => e.hid === 'puck');
  check(pooled && pooled.driver === 'Steam Controller 2026 (via Puck)' && pooled.streaming, 'IN-10: Puck pooled with the via-Puck driver, streaming', pooled);
  check(st.featureSends >= 2, 'IN-10: lizard-mode handshake sent (CLEAR + SET_SETTINGS)', st.featureSends);
  check(slot(s, 'P1').state === 'empty', 'IN-10: no seat until a button is pressed (HID-only, no Gamepad pad)', slot(s, 'P1').state);
  await holdUntil(ctx, null, 'puck', FACE_A.steam, (x) => slot(x, 'P1').state === 'claimed');
  s = await waitFor(ctx.page, (x) => x.gyroP1 && !!x.p1);
  const p1 = slot(s, 'P1');
  check(p1.state === 'claimed' && p1.hid === 'puck' && p1.pad === null, 'IN-10: pressing A seats P1 on the Puck over WebHID', p1);
  check(s.p1 && s.p1.name === 'Steam Controller 2026 (via Puck)' && s.p1.glyph === 'steam', 'IN-10: named "Steam Controller 2026 (via Puck)" with Steam prompts', s.p1);
  check(s.gyroP1, 'IN-10: P1 gyro live from the Puck stream');
  await ctx.page.close();
}

// ── MC-11 two identical DualSense keep their own seats across a reconnect ──
console.log('MC-11 two identical DualSense');
{
  const ctx = await open([hidDevice.dualsenseUsb('ds-a'), hidDevice.dualsenseUsb('ds-b')], { pads: ['dualsense', 'dualsense'] });
  const [a, b] = ctx.idx;
  // P1 may already hold pad A if the boot auto-claim caught it; either way A's press seats it.
  await holdUntil(ctx, a, 'ds-a', FACE_A.ds5Usb, (x) => slot(x, 'P1').state === 'claimed' && !!slot(x, 'P1').hid);
  await holdUntil(ctx, b, 'ds-b', FACE_A.ds5Usb, (x) => slot(x, 'P2').state === 'claimed' && !!slot(x, 'P2').hid);
  let s = await waitFor(ctx.page, (x) => slot(x, 'P1').streaming && slot(x, 'P2').streaming);
  check(slot(s, 'P1').pad === a && slot(s, 'P1').hid === 'ds-a' && slot(s, 'P2').pad === b && slot(s, 'P2').hid === 'ds-b',
    'MC-11: each pad seats with its own unit (P1 = A, P2 = B)', { P1: slot(s, 'P1'), P2: slot(s, 'P2') });
  // B drops (pad + HID both go away, as an unplug does) …
  await ctx.pads.unplug(b);
  await ctx.hid.disconnect('ds-b');
  s = await waitFor(ctx.page, (x) => slot(x, 'P2').state === 'orphan');
  check(slot(s, 'P2').state === 'orphan' && slot(s, 'P1').hid === 'ds-a' && slot(s, 'P1').state === 'claimed', 'MC-11: B unplugged → P2 orphaned, P1 keeps unit A', { P1: slot(s, 'P1'), P2: slot(s, 'P2') });
  // … and comes back: a new HIDDevice object for the same unit.
  await ctx.hid.connect('ds-b');
  await ctx.pads.replug(b);
  await waitFor(ctx.page, streamingAll(['ds-b']));
  const back = (x) => slot(x, 'P2').state === 'claimed' && slot(x, 'P2').hid === 'ds-b' && slot(x, 'P2').streaming;
  if (!back(await waitFor(ctx.page, back, 3000))) await holdUntil(ctx, b, 'ds-b', FACE_A.ds5Usb, back);
  s = await snap(ctx.page);
  const st = await ctx.hid.stats('ds-b');
  check(st.objects === 2, 'MC-11: the reconnect handed out a new HIDDevice object', st.objects);
  check(slot(s, 'P2').state === 'claimed' && slot(s, 'P2').pad === b && slot(s, 'P2').hid === 'ds-b' && slot(s, 'P2').streaming,
    'MC-11: B back → P2 reclaimed with unit B, streaming', slot(s, 'P2'));
  check(slot(s, 'P1').hid === 'ds-a' && slot(s, 'P1').pad === a, 'MC-11: P1 still on unit A', slot(s, 'P1'));
  const seated = s.slots.filter((x) => x.hid).map((x) => x.hid);
  check(new Set(seated).size === seated.length, 'MC-11: no unit holds two seats', seated);
  await ctx.page.close();
}

// ── MC-11b the press reaches the HID stream a frame before the pad sample ──
// Real pads do this: one press lands in the unit's own HID report a frame or
// two before Chrome's Gamepad sample shows it. With P1 seated by its pad and
// no unit bound yet, core 0.6.1 bound the OTHER (never-pressed) identical unit
// on that frame (Tier 2). Core 0.6.2 waits for the pad to catch up.
console.log('MC-11b press lands on HID a frame early');
{
  const ctx = await open([hidDevice.dualsenseUsb('ds-a'), hidDevice.dualsenseUsb('ds-b')], { pads: ['dualsense'] });
  const a = ctx.idx[0];
  // P1 seated by pad A alone (boot auto-claim, or a pad-only press): two identical
  // candidate units and no HID press, so core binds neither yet.
  const p1Claimed = (x) => slot(x, 'P1').state === 'claimed' && slot(x, 'P1').pad === a;
  if (!p1Claimed(await waitFor(ctx.page, p1Claimed, 3000))) {
    await ctx.pads.hold(a, 'A', true);
    await waitFor(ctx.page, p1Claimed);
    await ctx.pads.hold(a, 'A', false);
  }
  let s = await waitFor(ctx.page, (x) => !x.slots.some((y) => y.btnA));
  check(p1Claimed(s) && !slot(s, 'P1').hid, 'MC-11b: P1 seated by its pad, no unit bound yet (two identical candidates)', slot(s, 'P1'));
  const b = await ctx.pads.plug('dualsense');
  // Unit A's HID report shows cross; hold it for two game frames before pad A's sample does.
  await ctx.hid.hold('ds-a', FACE_A.ds5Usb, true);
  await ctx.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  s = await snap(ctx.page);
  check(slot(s, 'P1').hid !== 'ds-b', "MC-11b: the HID press alone doesn't bind P1 to the other player's unit", slot(s, 'P1'));
  await ctx.pads.hold(a, 'A', true);
  s = await waitFor(ctx.page, (x) => !!slot(x, 'P1').hid);
  await ctx.pads.hold(a, 'A', false);
  await ctx.hid.hold('ds-a', FACE_A.ds5Usb, false);
  check(slot(s, 'P1').hid === 'ds-a', 'MC-11b: once the pad shows the press, P1 binds its own unit A', slot(s, 'P1'));
  await waitFor(ctx.page, (x) => !x.slots.some((y) => y.btnA), 5000);
  await holdUntil(ctx, b, 'ds-b', FACE_A.ds5Usb, (x) => slot(x, 'P2').state === 'claimed' && !!slot(x, 'P2').hid);
  s = await snap(ctx.page);
  check(slot(s, 'P2').pad === b && slot(s, 'P2').hid === 'ds-b', 'MC-11b: P2 joins on pad B with unit B', slot(s, 'P2'));
  await ctx.page.close();
}

// ── MC-12 two Steam Controller bodies on one Puck ──
console.log('MC-12 two Steam Controllers on one Puck');
{
  const ctx = await open([hidDevice.steamPuck('body-1'), hidDevice.steamPuck('body-2'), hidDevice.puckIdleSibling('puck-idle')]);
  await holdUntil(ctx, null, 'body-1', FACE_A.steam, (x) => slot(x, 'P1').state === 'claimed');
  await holdUntil(ctx, null, 'body-2', FACE_A.steam, (x) => slot(x, 'P2').state === 'claimed');
  const s = await waitFor(ctx.page, (x) => slot(x, 'P1').streaming && slot(x, 'P2').streaming);
  check(slot(s, 'P1').hid === 'body-1' && slot(s, 'P2').hid === 'body-2', 'MC-12: P1 = body 1, P2 = body 2 (no cross-wiring)', { P1: slot(s, 'P1').hid, P2: slot(s, 'P2').hid });
  check(slot(s, 'P1').streaming && slot(s, 'P2').streaming, 'MC-12: both seats streaming their own body');
  check(!s.slots.some((x) => x.hid === 'puck-idle'), 'MC-12: the idle receiver interface takes no seat', s.slots.map((x) => x.hid));
  const ids = await ctx.page.evaluate(() => {
    const m = window.__controllerManager;
    return m.controllerRoster(navigator.getGamepads()).filter((r) => r.kind === 'slot').map((r) => r.name);
  });
  check(ids.length === 2, 'MC-12: the roster lists two seated controllers', ids);
  await ctx.page.close();
}

// ── Pad + granted HID both present at boot: the controller is held once ──
// (Was a KNOWN bug: autoPoolApprovedHid and the lobby's connectHidForSlot raced
// in core poolDevice and pooled it twice. Fixed in controller-core 0.6.1.)
console.log('pad + granted HID at boot');
{
  const runs = 3;
  let dup = 0, doubleSeat = 0;
  for (let r = 0; r < runs; r++) {
    const page = await h.gamePage({ storage: STORAGE, before: async (p) => { slowLoad(p); await installFakeWebHid(p, [hidDevice.dualsenseUsb('ds')]); await installFakeGamepads(p, { atBoot: ['dualsense'] }); } });
    const ctx = { page, pads: fakePads(page), hid: fakeHid(page) };
    // Settle: P1 seated + bound (boot auto-claim, or a press if a slow machine
    // missed its window), then a beat for any racing second pool to land.
    const seated = (s) => slot(s, 'P1').state === 'claimed' && slot(s, 'P1').hid === 'ds' && slot(s, 'P1').streaming;
    if (!seated(await waitFor(page, seated, 8000))) { console.log('  (boot auto-claim missed; joining by pressing A)'); await holdUntil(ctx, 0, 'ds', FACE_A.ds5Usb, seated); }
    await sleep(1500);
    // Held = pool entries + seats for this one unit. One controller, one holder.
    const held = await page.evaluate(() => {
      const m = window.__controllerManager;
      return [...m._hidPool.values()].filter((e) => e.device.__fakeKey === 'ds').length
        + m.slots.filter((s) => s.hidDevice && s.hidDevice.__fakeKey === 'ds').length;
    });
    if (held > 1) dup++;
    // A press must not seat it a second time.
    await holdUntil(ctx, 0, 'ds', FACE_A.ds5Usb, (x) => slot(x, 'P1').btnA, 15000);
    await sleep(800);
    const s = await snap(page);
    if (s.slots.filter((x) => x.hid === 'ds').length > 1) doubleSeat++;
    await page.close();
  }
  check(dup === 0, `boot: the DualSense is held once (pool or seat), never twice (${runs} boots)`, { dup });
  check(doubleSeat === 0, `boot: pressing A seats it once, never as P1 and P2 (${runs} boots)`, { doubleSeat });
}

check(h.errors.length === 0, 'no page errors', h.errors);
if (known.length) console.log(`\nknown bugs (not failing the run): ${known.join('; ')}`);
await h.finish();
