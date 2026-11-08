// #458 · items 2, 13, 14: versus seat order, controller glyph families, and
// the names the lobby shows for a controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hidDeviceIdentity, slotIdentityHidFirst, steamTypeGlyphIdentity, fixRosterRow,
  prettyGamepadName, prettyHidName, lowestFreePlayerNumber, versusJoinSeat,
} from '../../js/lobby/controller-labels.js';
import { identifyGamepadId } from '../../shared/device-identity.js';
import { resolveGlyph } from '../../shared/ui/elements/uf-controller-glyph.js';

const PUCK = { vendorId: 0x28de, productId: 0x1304, productName: 'Steam Controller' };
const SC_USB = { vendorId: 0x28de, productId: 0x1302, productName: 'Steam Controller' };
const SWITCH_PRO = { vendorId: 0x057e, productId: 0x2009, productName: 'Pro Controller' };

test('item 14: a Steam Controller on the Puck is named by its vid:pid, not "direct USB-C"', () => {
  assert.equal(prettyHidName(PUCK), 'STEAM CONTROLLER 2026 (VIA PUCK)');
  assert.equal(prettyHidName(SC_USB), 'STEAM CONTROLLER 2026 (DIRECT USB-C)');
  // The HID synthetic's label carries no vid:pid; it used to resolve to the first Steam entry.
  assert.equal(prettyGamepadName('HID::Steam Controller'), 'STEAM CONTROLLER');
  assert.doesNotMatch(prettyGamepadName('Steam Controller'), /USB-C/);
});

test('item 14: core\'s label-first slot identity is corrected by the HID binding', () => {
  const slot = { controllerLabel: 'HID::Steam Controller', hidDevice: PUCK, driver: null };
  const core = () => identifyGamepadId(slot.controllerLabel);
  assert.match(core().name, /direct USB-C/, 'precondition: core mislabels the Puck');
  const id = slotIdentityHidFirst(slot, core);
  assert.equal(id.name, 'Steam Controller 2026 (via Puck)');
  assert.equal(id.glyphFamily, 'steam');
  const row = fixRosterRow({ key: 's:P1', name: core().name, shortName: 'Steam Controller', glyphFamily: 'steam', device: PUCK });
  assert.equal(row.name, 'Steam Controller 2026 (via Puck)');
  // No device: untouched.
  const plain = { key: 'g:0', name: 'Xbox 360' };
  assert.equal(fixRosterRow(plain), plain);
});

test('exact vid:pid keeps the full entry name; pattern-only falls back to the short name', () => {
  assert.equal(prettyGamepadName('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'NINTENDO SWITCH PRO');
  assert.equal(prettyGamepadName('Steam Controller (Vendor: 28de Product: 1304)'), 'STEAM CONTROLLER 2026 (VIA PUCK)');
  assert.equal(prettyGamepadName('Some Pad (Vendor: 1234 Product: 5678)'), 'SOME PAD');
  assert.equal(prettyGamepadName(''), 'CONTROLLER');
});

test('item 13: Switch Pro and Steam Controller get their own glyph families', () => {
  assert.equal(hidDeviceIdentity(SWITCH_PRO).glyphFamily, 'nintendo');
  assert.equal(hidDeviceIdentity(PUCK).glyphFamily, 'steam');
  // The 2015 Steam Controller isn't in the registry but is still Valve's pad.
  assert.equal(hidDeviceIdentity({ vendorId: 0x28de, productId: 0x1142 }).glyphFamily, 'steam');
  assert.equal(hidDeviceIdentity({ vendorId: 0x1234, productId: 0x5678 }), null);
  // Steam Input types (main.js sends the enum number as a string).
  assert.equal(steamTypeGlyphIdentity('10').glyphFamily, 'nintendo');
  assert.equal(steamTypeGlyphIdentity('k_ESteamInputType_SwitchProController').glyphFamily, 'nintendo');
  assert.equal(steamTypeGlyphIdentity('13').glyphFamily, 'playstation');
  assert.equal(steamTypeGlyphIdentity('14').glyphFamily, 'steam');
  assert.equal(steamTypeGlyphIdentity('3').glyphFamily, 'xbox');
  assert.equal(steamTypeGlyphIdentity('99').glyphFamily, 'steam');
  // And those families draw letters, not the generic diamond.
  assert.deepEqual([resolveGlyph('confirm', 'nintendo').text, resolveGlyph('back', 'nintendo').text], ['B', 'A']);
  assert.equal(resolveGlyph('confirm', 'nintendo').shape, 'round');
  assert.deepEqual([resolveGlyph('confirm', 'steam').text, resolveGlyph('back', 'steam').text], ['A', 'B']);
  assert.equal(resolveGlyph('confirm', 'steam').shape, 'round');
});

test('item 2: player numbers fill the lowest free seat', () => {
  assert.equal(lowestFreePlayerNumber([]), 1);
  assert.equal(lowestFreePlayerNumber([{ n: 1 }, { n: 3 }]), 2);
  assert.equal(lowestFreePlayerNumber([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]), null);
});

test('item 2: the first pad to join takes an empty (keyboard placeholder) P1 seat', () => {
  const kbP1 = [{ n: 1, type: 'keyboard', slotId: 'P1' }];
  assert.deepEqual(versusJoinSeat(kbP1, { p1SlotEmpty: true, kind: 'gamepad' }), { takeP1: true, n: 1 });
  assert.deepEqual(versusJoinSeat(kbP1, { p1SlotEmpty: true, kind: 'hid' }), { takeP1: true, n: 1 });
  // #562: phones bring their own input and never take Player 1's slot.
  assert.deepEqual(versusJoinSeat(kbP1, { p1SlotEmpty: true, kind: 'phone' }), { takeP1: false, n: lowestFreePlayerNumber(kbP1) });
  // Steam Input pads bind by handle, not slot: they join as the next player.
  assert.deepEqual(versusJoinSeat(kbP1, { p1SlotEmpty: true, kind: 'steam' }), { takeP1: false, n: 2 });
  // A pad already holds P1: the joiner is the next free number.
  const padP1 = [{ n: 1, type: 'gamepad', slotId: 'P1' }, { n: 3, type: 'gamepad', slotId: 'P3' }];
  assert.deepEqual(versusJoinSeat(padP1, { p1SlotEmpty: false, kind: 'gamepad' }), { takeP1: false, n: 2 });
});
