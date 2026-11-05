// Versus join cards under Steam Input: a pad we already read on WebHID is
// joined through WebHID, and its Steam snapshot twin is not offered again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withoutWebHidTwins, hidFamily, steamFamily } from '../../js/lobby/join-candidates.js';

const DUALSENSE = { vendorId: 0x054c, productId: 0x0ce6, productName: 'DualSense Wireless Controller' };
const DS4 = { vendorId: 0x054c, productId: 0x09cc, productName: 'Wireless Controller' };
const PUCK = { vendorId: 0x28de, productId: 0x1304, productName: 'Steam Controller' };
const SWITCH_PRO = { vendorId: 0x057e, productId: 0x2009, productName: 'Pro Controller' };
const MYSTERY = { vendorId: 0x1234, productId: 0x5678, productName: 'Thing' };

const steam = (handle, type) => ({ handle, type: String(type) });

test('families: registry vid:pid for WebHID, Steam type enum for the snapshot', () => {
  assert.equal(hidFamily(DUALSENSE), 'playstation');
  assert.equal(hidFamily(PUCK), 'steam');
  assert.equal(hidFamily(SWITCH_PRO), 'nintendo');
  assert.equal(hidFamily(MYSTERY), null);
  assert.equal(steamFamily('13'), 'playstation');
  assert.equal(steamFamily('k_ESteamInputType_PS5Controller'), 'playstation');
  assert.equal(steamFamily('14'), 'steam');
  assert.equal(steamFamily('3'), 'xbox');
  assert.equal(steamFamily('0'), 'steam');
});

test('a Bluetooth DualSense on WebHID hides its Steam Input twin (the reported bug)', () => {
  // Two Steam Controllers seated over the Puck, DualSense streaming on WebHID,
  // Steam's snapshot (Steam-family entries already filtered) holds the DualSense.
  const kept = withoutWebHidTwins([steam('900', 13)], [PUCK, PUCK, DUALSENSE]);
  assert.deepEqual(kept, []);
});

test('a Steam-captured pad WebHID does not hold stays joinable', () => {
  const kept = withoutWebHidTwins([steam('900', 13), steam('901', 3)], [DUALSENSE]);
  assert.deepEqual(kept.map((e) => e.handle), ['901']);
});

test('one Steam entry per WebHID device of the family', () => {
  const two = [steam('1', 13), steam('2', 13), steam('3', 5)];
  assert.deepEqual(withoutWebHidTwins(two, [DUALSENSE]).map((e) => e.handle), ['2', '3']);
  assert.deepEqual(withoutWebHidTwins(two, [DUALSENSE, DS4]).map((e) => e.handle), ['3']);
  assert.deepEqual(withoutWebHidTwins(two, [DUALSENSE, DS4, DUALSENSE]), []);
});

test('an unnamed (type 0) Steam entry is the twin of a WebHID Steam Controller', () => {
  assert.deepEqual(withoutWebHidTwins([steam('7', 0)], [PUCK]), []);
  assert.deepEqual(withoutWebHidTwins([steam('7', 0)], [DUALSENSE]).map((e) => e.handle), ['7']);
});

test('nothing on WebHID, or an unknown WebHID device: every Steam entry stays', () => {
  const all = [steam('1', 13), steam('2', 14)];
  assert.deepEqual(withoutWebHidTwins(all, []), all);
  assert.deepEqual(withoutWebHidTwins(all, [MYSTERY]), all);
  assert.deepEqual(withoutWebHidTwins(all, null), all);
});
