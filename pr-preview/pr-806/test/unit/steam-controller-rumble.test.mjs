// #617 · Steam Controller haptics + light. Its WebHID driver has no rumble command
// and its Steam XInput twin is hidden from the seats, so rumble used to go nowhere.
// Now it goes to the twin pad and to Steam Input by the twin's handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { steamTargetForEntry, setControllerManager } from '../../js/input-manager.js';
import { hapticCrash, hapticHooks } from '../../js/haptics.js';
import { colourwaysFor, colourwayName } from '../../js/goose-colourways.js';
import DATA from '../../js/goose-colourways-data.js';

class SteamControllerDriver { static needsSiblingFanout = true; }
class DualSenseDriver {}

const XI = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';

/**
 * Steam's slot map + the manager's units (controller-core 0.7 links each Steam
 * Controller to its XInput twin and Steam slot; the lab tests cover how).
 * @param {{ slots: any[], units: Array<{ twinPadIndex?: number|null, steamSlot?: any }> }} w
 */
function world({ slots, units }) {
  globalThis.window = { steam: { input: { getXInputMap: () => slots } } };
  const built = units.map((u, i) => ({
    entry: { driver: new SteamControllerDriver(), device: { key: 'sc' + i } },
    presence: 'present', twinPadIndex: u.twinPadIndex ?? null, steamSlot: u.steamSlot ?? null,
  }));
  setControllerManager({ unitForDevice: (d) => built.find((u) => u.entry.device === d) || null, allUnits: () => built });
  return built.map((u) => u.entry);
}
const xpad = (index, played = []) => ({
  index, id: XI, axes: [0, 0, 0, 0], buttons: [],
  vibrationActuator: { playEffect: (type, o) => { played.push({ index, type, ...o }); return Promise.resolve('complete'); } },
});

test('a Steam Controller linked to its twin: rumble targets the twin pad and its Steam handle', () => {
  const slot = { index: 0, handle: '777', type: '14' };
  const [sc] = world({ slots: [slot], units: [{ twinPadIndex: 0, steamSlot: slot }] });
  assert.deepEqual(steamTargetForEntry(sc), { padIndex: 0, handle: '777' });
});

test('one Steam Controller, twin not linked yet: the one Steam-family handle', () => {
  const [sc] = world({ slots: [{ index: 0, handle: '777', type: '14' }], units: [{}] });
  assert.deepEqual(steamTargetForEntry(sc), { padIndex: null, handle: '777' });
});

test('two Steam Controllers not yet linked: no guess', () => {
  const [a] = world({ slots: [{ index: 0, handle: '1', type: '14' }, { index: 1, handle: '2', type: '14' }], units: [{}, {}] });
  assert.equal(steamTargetForEntry(a), null);
});

test('a pad that is not a Steam Controller has no Steam target', () => {
  world({ slots: [{ index: 0, handle: '9', type: '14' }], units: [{}] });
  assert.equal(steamTargetForEntry({ driver: new DualSenseDriver(), device: {} }), null);
  assert.equal(steamTargetForEntry(null), null);
});

test('a crash rumbles a seated Steam Controller through its twin and Steam Input', () => {
  const played = [];
  const pads = [xpad(0, played)];
  world({ slots: [{ index: 0, handle: '777', type: '14' }], units: [{ twinPadIndex: 0 }] });
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true, writable: true });
  const sent = [];
  const prev = hapticHooks.steamInput;
  hapticHooks.steamInput = () => ({ vibrate: (...a) => sent.push(a) });
  try {
    // A Steam Controller seat: its driver has no setRumble and no Gamepad index.
    const src = { gamepadIndex: null, _controllerDriver: {}, steamRumbleTarget: () => ({ padIndex: 0, handle: '777' }) };
    hapticCrash([src]);
  } finally { hapticHooks.steamInput = prev; }
  assert.equal(played.length, 1);
  assert.equal(played[0].type, 'dual-rumble');
  assert.deepEqual(sent, [['777', 0.8, 0.4, 300]]);
});

test('a driver with its own rumble (DualSense) still uses it, not Steam', () => {
  const sent = [];
  let driverRumbles = 0;
  const prev = hapticHooks.steamInput;
  hapticHooks.steamInput = () => ({ vibrate: (...a) => sent.push(a) });
  try {
    hapticCrash([{ gamepadIndex: null, _controllerDriver: { setRumble: () => { driverRumbles++; return Promise.resolve(); } }, steamRumbleTarget: () => ({ padIndex: null, handle: '1' }) }]);
  } finally { hapticHooks.steamInput = prev; }
  assert.equal(driverRumbles, 1);
  assert.equal(sent.length, 0);
});

test('#617: every colourway button is one word', () => {
  for (const outfit of Object.keys(DATA)) {
    for (const w of colourwaysFor(outfit)) assert.match(w.label, /^[A-Z][a-z]+$/, `${outfit}/${w.key}: "${w.label}"`);
  }
  assert.equal(colourwayName('v_navy', 'Navy + mustard'), 'Navy');
  assert.equal(colourwayName('x_new', 'Rust + cream'), 'Rust');
});
