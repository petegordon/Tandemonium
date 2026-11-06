// #535 · Steam's virtual XInput copy of a Steam Controller we already read on
// WebHID is hidden — including one switched on after launch, which Steam
// leaves as type 0 (unknown).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSteamTwinPad, setControllerManager } from '../../js/input-manager.js';

class SteamControllerDriver { static needsSiblingFanout = true; }
class OtherDriver {}

const XI = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
const pad = (index, id = XI) => ({ index, id, axes: [0, 0, 0, 0], buttons: [] });

/** Steam's XInput slots + the Steam Controllers streaming on WebHID. */
function world({ slots, hidBodies = 0, otherHid = 0 }) {
  globalThis.window = { steam: { input: { getXInputMap: () => slots } } };
  const now = performance.now();
  const entry = (Driver) => ({ driver: new Driver(), hidActiveSince: now - 10 });
  const pool = new Map();
  for (let i = 0; i < hidBodies; i++) pool.set('sc' + i, entry(SteamControllerDriver));
  for (let i = 0; i < otherHid; i++) pool.set('o' + i, entry(OtherDriver));
  setControllerManager({ _hidPool: pool, slots: [] });
}
const slot = (index, type) => ({ index, handle: String(1000 + index), type: String(type) });

test('a Steam-named XInput pad is the twin of a WebHID Steam Controller', () => {
  world({ slots: [slot(0, 14)], hidBodies: 1 });
  assert.equal(isSteamTwinPad(pad(0), [pad(0)]), true);
});

test('#535: a second Steam Controller switched on later (type 0) is hidden too', () => {
  // The diag log: XInput slots 0:14 | 1:0, two bodies streaming on the Puck.
  const pads = [pad(0), pad(1)];
  world({ slots: [slot(0, 14), slot(1, 0)], hidBodies: 2 });
  assert.equal(isSteamTwinPad(pads[0], pads), true);
  assert.equal(isSteamTwinPad(pads[1], pads), true);
});

test('an unknown-type pad stays when every WebHID Steam Controller is already accounted for', () => {
  const pads = [pad(0), pad(1)];
  world({ slots: [slot(0, 14), slot(1, 0)], hidBodies: 1 });
  assert.equal(isSteamTwinPad(pads[1], pads), false);
});

test('only as many unknown pads as unnamed Steam Controllers are hidden', () => {
  const pads = [pad(0), pad(1), pad(2)];
  world({ slots: [slot(0, 14), slot(1, 0), slot(2, 0)], hidBodies: 2 });
  assert.equal(isSteamTwinPad(pads[1], pads), true);
  assert.equal(isSteamTwinPad(pads[2], pads), false);
});

test('a pad Steam names as something else (a DualSense, an Xbox pad) is never hidden', () => {
  const pads = [pad(0), pad(1)];
  world({ slots: [slot(0, 14), slot(1, 13)], hidBodies: 2 });
  assert.equal(isSteamTwinPad(pads[1], pads), false);
  world({ slots: [slot(0, 14), slot(1, 3)], hidBodies: 2 });
  assert.equal(isSteamTwinPad(pads[1], pads), false);
});

test('no Steam Controller on WebHID: the XInput pad is that controller and stays', () => {
  world({ slots: [slot(0, 14)], hidBodies: 0, otherHid: 1 });
  assert.equal(isSteamTwinPad(pad(0), [pad(0)]), false);
  world({ slots: [slot(0, 0)], hidBodies: 0 });
  assert.equal(isSteamTwinPad(pad(0), [pad(0)]), false);
});

test('a non-XInput pad, or XInput pads Steam did not emit, are left alone', () => {
  world({ slots: [slot(0, 0)], hidBodies: 1 });
  assert.equal(isSteamTwinPad(pad(0, 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), [pad(0)]), false);
  // Two XInput pads but Steam only emitted one: ranks can't be trusted.
  assert.equal(isSteamTwinPad(pad(1), [pad(0), pad(1)]), false);
});

// #581 · the rank match refuses to guess when Chromium's XInput pad count and
// Steam's slot list differ (Chromium reveals a pad only after its first press),
// and the Steam Controller's twin leaked into the seat screens as an "Xbox"
// pad. A pad whose presses mirror a live WebHID Steam Controller is its twin,
// sticky until that Gamepad index empties or holds another pad.
import { resetSteamTwinMemory } from '../../js/input-manager.js';

/** A manager whose fold-window history says: pad `padBtns`, Steam Controllers `scBtns[k]`. */
function pressWorld({ padBtns = {}, scBtns = [], slots = [] }) {
  globalThis.window = { steam: { input: { getXInputMap: () => slots } } };
  const now = performance.now();
  const recent = (btns) => new Map(btns.map((i) => [i, now]));
  const pool = new Map();
  scBtns.forEach((b, k) => pool.set('sc' + k, { driver: new SteamControllerDriver(), hidActiveSince: now - 10, _recentBtns: recent(b), synthetic: { buttons: [] } }));
  const padMap = new Map(Object.entries(padBtns).map(([i, b]) => [Number(i), recent(b)]));
  setControllerManager({
    _hidPool: pool, slots: [], _frameNow: now, opts: { foldWindowMs: 350 },
    _recentPadBtns: padMap,
    _recentPressed(m) { const s = new Set(); if (!m) return s; for (const [i, ts] of m) if (this._frameNow - ts <= 350) s.add(i); return s; },
  });
}

test('#581: counts disagree (no slot map match), but the pad mirrors a Steam Controller\'s A → twin, and it stays one', () => {
  resetSteamTwinMemory();
  const pads = [pad(0), pad(1)];
  pressWorld({ padBtns: { 1: [0] }, scBtns: [[0]], slots: [slot(0, 14)] });   // 2 XInput pads, 1 Steam slot: rank match refuses
  assert.equal(isSteamTwinPad(pads[1], pads), true);
  pressWorld({ padBtns: {}, scBtns: [[]], slots: [slot(0, 14)] });            // released: nothing to correlate any more
  assert.equal(isSteamTwinPad(pads[1], pads), true, 'sticky');
});

test('#581: a pad pressing what no Steam Controller pressed is not a twin', () => {
  resetSteamTwinMemory();
  const pads = [pad(0), pad(1)];
  pressWorld({ padBtns: { 1: [1] }, scBtns: [[0]] });
  assert.equal(isSteamTwinPad(pads[1], pads), false);
  pressWorld({ padBtns: { 1: [] }, scBtns: [[]] });
  assert.equal(isSteamTwinPad(pads[1], pads), false, 'an idle pad gives no evidence');
});

test('#581: never more press-twins than Steam Controllers; a new pad at a freed index is judged afresh', () => {
  resetSteamTwinMemory();
  const pads = [pad(0), pad(1)];
  pressWorld({ padBtns: { 0: [0], 1: [0] }, scBtns: [[0]] });               // one Steam Controller, two pads pressing A together
  const t0 = isSteamTwinPad(pads[0], pads), t1 = isSteamTwinPad(pads[1], pads);
  assert.equal(Number(t0) + Number(t1), 1, 'one twin for one Steam Controller');
  const realXbox = { index: 0, id: 'Xbox Wireless Controller (XInput STANDARD GAMEPAD)', axes: [0, 0, 0, 0], buttons: [] };
  pressWorld({ padBtns: {}, scBtns: [[]] });
  assert.equal(isSteamTwinPad(realXbox, [realXbox, pads[1]]), false, 'another pad at index 0 is not remembered as the twin');
});

// #581 · quick taps: Steam's virtual press lands after the hardware's, so on a
// quick tap a SEATED Steam Controller's synthetic already reads released when
// the twin reads pressed. A short press history covers seated pads too, and a
// twin claimed before it was recognised is reported for release.
import { noteSteamControllerPresses, claimedSteamTwinSlots } from '../../js/input-manager.js';

function seatedWorld() {
  globalThis.window = { steam: { input: { getXInputMap: () => [] } } };
  const now = performance.now();
  const btns = () => Array.from({ length: 22 }, () => ({ pressed: false }));
  const sc = { driver: new SteamControllerDriver(), hidActiveSince: now - 10, synthetic: { buttons: btns() } };
  const padHist = new Map();
  const mgr = {
    _hidPool: new Map(), _frameNow: now, opts: { foldWindowMs: 350 }, _recentPadBtns: padHist,
    slots: [{ id: 'P1', state: 'claimed', _hidEntry: sc, gamepadIndex: null }, { id: 'P3', state: 'claimed', _hidEntry: null, gamepadIndex: 1 }],
    _recentPressed(m) { const s = new Set(); if (!m) return s; for (const [i, ts] of m) if (this._frameNow - ts <= 350) s.add(i); return s; },
  };
  setControllerManager(mgr);
  return { sc, mgr, padHist, now };
}

test('#581: a quick tap on a seated Steam Controller still identifies its late twin', () => {
  resetSteamTwinMemory();
  const { sc, padHist, now } = seatedWorld();
  const pads = [null, pad(1)];
  sc.synthetic.buttons[0].pressed = true;
  noteSteamControllerPresses(now);            // the hardware's press, one frame
  sc.synthetic.buttons[0].pressed = false;    // released before Steam's twin shows it
  padHist.set(1, new Map([[0, now]]));         // the twin's A, a moment later
  assert.equal(isSteamTwinPad(pads[1], pads), true);
});

test('#581: a slot holding that twin is reported for release; a WebHID slot never is', () => {
  resetSteamTwinMemory();
  const { sc, padHist, now } = seatedWorld();
  const pads = [null, pad(1)];
  sc.synthetic.buttons[0].pressed = true;
  noteSteamControllerPresses(now);
  padHist.set(1, new Map([[0, now]]));
  assert.deepEqual(claimedSteamTwinSlots(pads), ['P3']);
});

test('#581: without a matching hardware press, nothing is released', () => {
  resetSteamTwinMemory();
  const { padHist } = seatedWorld();
  const pads = [null, pad(1)];
  padHist.set(1, new Map([[0, performance.now()]]));
  assert.deepEqual(claimedSteamTwinSlots(pads), []);
});

// #581 · a Steam Controller switched off stays plugged in (the Puck) and only
// stops reporting; and a DualSense behind a frozen Gamepad twin.
import { isSilentSteamControllerSlot, frozenTwinHidEntries, PUCK_SILENT_MS } from '../../js/input-manager.js';

test('#581: a claimed Steam Controller slot is silent after PUCK_SILENT_MS without a report; never an idle sibling or another pad', () => {
  const now = 100000;
  const sc = (since) => ({ state: 'claimed', _hidEntry: { driver: new SteamControllerDriver(), hidActiveSince: since } });
  assert.equal(isSilentSteamControllerSlot(sc(now - PUCK_SILENT_MS - 1), now), true);
  assert.equal(isSilentSteamControllerSlot(sc(now - 100), now), false);
  assert.equal(isSilentSteamControllerSlot(sc(0), now), false, 'an interface that never streamed is not "switched off"');
  assert.equal(isSilentSteamControllerSlot({ state: 'claimed', _hidEntry: { driver: new OtherDriver(), hidActiveSince: 1 } }, now), false);
  assert.equal(isSilentSteamControllerSlot({ state: 'empty', _hidEntry: null }, now), false);
});

test('#581: a pressed WebHID pad behind a frozen same-name Gamepad entry is returned; a live twin or no twin is left to the manager', () => {
  const DS_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
  const entry = (pressed) => ({ device: { productName: 'DualSense Wireless Controller' }, hasFreshButtonPress: () => pressed });
  const world = (entries, padPressed = false) => {
    const now = performance.now();
    setControllerManager({ _hidPool: new Map(entries.map((e, i) => [i, e])), slots: [], _frameNow: now, opts: { foldWindowMs: 350 },
      _recentPadBtns: new Map(padPressed ? [[0, new Map([[0, now]])]] : []),
      _recentPressed(m) { const s = new Set(); if (!m) return s; for (const [i, ts] of m) if (this._frameNow - ts <= 350) s.add(i); return s; } });
  };
  const frozen = [{ index: 0, id: DS_ID, buttons: [{ pressed: false }] }];
  const e = entry(true);
  world([e]);
  assert.deepEqual(frozenTwinHidEntries(frozen), [e]);
  world([e], true);
  assert.deepEqual(frozenTwinHidEntries(frozen), [], 'the twin shows the press: the manager\'s Gamepad claim takes it');
  world([e]);
  assert.deepEqual(frozenTwinHidEntries([]), [], 'no twin: the manager claims it itself');
  world([entry(false)]);
  assert.deepEqual(frozenTwinHidEntries(frozen), [], 'no press, no claim');
});
