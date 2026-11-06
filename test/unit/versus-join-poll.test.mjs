// #581 · a pad the game sees twice (Gamepad API + WebHID) is one join card,
// and a press on either source joins it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergedPollGp } from '../../js/lobby/join-poll.js';

const btns = (n, pressed = []) => Array.from({ length: n }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 }));

test('a frozen Gamepad entry plus a live WebHID synthetic: ✕ on the synthetic counts', () => {
  const frozen = { buttons: btns(17), axes: [0, 0, 0, 0] };            // Chromium's entry, stuck since 0x31 mode
  const synthetic = { buttons: btns(22, [0]), axes: [0.4, 0, 0, 0] };   // the driver's parse of the real report
  const m = mergedPollGp(frozen, synthetic);
  assert.equal(m.buttons[0].pressed, true);
  assert.equal(m.buttons[1].pressed, false);
  assert.equal(m.buttons.length, 22);
  assert.equal(m.axes[0], 0.4);
});

test('a press on the Gamepad entry still counts (a pad whose buttons live only there)', () => {
  const gp = { buttons: btns(17, [0, 15]), axes: [-0.8, 0, 0, 0] };
  const synthetic = { buttons: btns(22), axes: [0, 0, 0, 0] };
  const m = mergedPollGp(gp, synthetic);
  assert.equal(m.buttons[0].pressed, true);
  assert.equal(m.buttons[15].pressed, true);
  assert.equal(m.axes[0], -0.8);
});

test('missing or partial sources are tolerated', () => {
  assert.equal(mergedPollGp(null, null).axes.length, 4);
  assert.equal(mergedPollGp({ buttons: btns(2, [1]) }, undefined).buttons[1].pressed, true);
  assert.equal(mergedPollGp(undefined, { axes: [0, 0.2] }).axes[1], 0.2);
});

// #581 · a seated pad showed twice in the co-op roster: once through its slot,
// once as its own (frozen) Gamepad entry, "DualSense · seats full".
import { withoutHeldTwins } from '../../js/lobby/join-poll.js';
const DS = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const gpc = (gpIndex, id = DS) => ({ gpIndex, gp: { id } });
const dsDevice = { productName: 'DualSense Wireless Controller' };

test('a slot that adopted its pad\'s Gamepad entry drops that index', () => {
  const kept = withoutHeldTwins([gpc(0), gpc(1, 'Xbox Wireless Controller')], [{ state: 'claimed', hidDevice: dsDevice, gamepadIndex: 0 }]);
  assert.deepEqual(kept.map((c) => c.gpIndex), [1]);
});

test('a WebHID-only slot drops the one Gamepad candidate named like its device (the reported bug)', () => {
  const kept = withoutHeldTwins([gpc(2), gpc(3, 'Xbox Wireless Controller')], [{ state: 'claimed', hidDevice: dsDevice, gamepadIndex: null }]);
  assert.deepEqual(kept.map((c) => c.gpIndex), [3]);
});

test('two identical pads and one WebHID-only slot: nothing dropped (never hide a real controller)', () => {
  const kept = withoutHeldTwins([gpc(0), gpc(1)], [{ state: 'claimed', hidDevice: dsDevice, gamepadIndex: null }]);
  assert.deepEqual(kept.map((c) => c.gpIndex), [0, 1]);
});

test('empty slots and Gamepad-only claims hide nothing', () => {
  const kept = withoutHeldTwins([gpc(0), gpc(1)], [
    { state: 'empty', hidDevice: dsDevice, gamepadIndex: 0 },
    { state: 'claimed', hidDevice: null, gamepadIndex: 1 },
  ]);
  assert.deepEqual(kept.map((c) => c.gpIndex), [0, 1]);
});
