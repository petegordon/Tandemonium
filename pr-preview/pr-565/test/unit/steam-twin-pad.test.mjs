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
