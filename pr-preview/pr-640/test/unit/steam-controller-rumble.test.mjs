// #617 · Steam Controller haptics + light. Its WebHID driver has no rumble command
// and its Steam XInput twin is hidden from the seats, so rumble used to go nowhere.
// Now it goes to the twin pad and to Steam Input by the twin's handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { steamTargetForEntry, setControllerManager, resetSteamTwinMemory } from '../../js/input-manager.js';
import { hapticCrash, hapticHooks } from '../../js/haptics.js';
import { colourwaysFor, colourwayName } from '../../js/goose-colourways.js';
import DATA from '../../js/goose-colourways-data.js';

class SteamControllerDriver { static needsSiblingFanout = true; }
class DualSenseDriver {}

const XI = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';

function world({ slots, bodies = 1, pads }) {
  resetSteamTwinMemory();
  globalThis.window = { steam: { input: { getXInputMap: () => slots } } };
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true, writable: true });
  const now = performance.now();
  const entries = [];
  const pool = new Map();
  for (let i = 0; i < bodies; i++) { const e = { driver: new SteamControllerDriver(), hidActiveSince: now - 10 }; entries.push(e); pool.set('sc' + i, e); }
  setControllerManager({ _hidPool: pool, slots: [] });
  return entries;
}
const xpad = (index, played = []) => ({
  index, id: XI, axes: [0, 0, 0, 0], buttons: [],
  vibrationActuator: { playEffect: (type, o) => { played.push({ index, type, ...o }); return Promise.resolve('complete'); } },
});

test('one Steam Controller: rumble targets its twin pad and its Steam handle', () => {
  const pads = [xpad(0)];
  const [sc] = world({ slots: [{ index: 0, handle: '777', type: '14' }], pads });
  assert.deepEqual(steamTargetForEntry(sc, pads), { padIndex: 0, handle: '777' });
});

test('two Steam Controllers not yet linked by a press: no guess', () => {
  const pads = [xpad(0), xpad(1)];
  const [a] = world({ slots: [{ index: 0, handle: '1', type: '14' }, { index: 1, handle: '2', type: '14' }], bodies: 2, pads });
  assert.equal(steamTargetForEntry(a, pads), null);
});

test('a pad that is not a Steam Controller has no Steam target', () => {
  const pads = [xpad(0)];
  world({ slots: [{ index: 0, handle: '9', type: '14' }], pads });
  assert.equal(steamTargetForEntry({ driver: new DualSenseDriver(), hidActiveSince: 1 }, pads), null);
  assert.equal(steamTargetForEntry(null, pads), null);
});

test('a crash rumbles a seated Steam Controller through its twin and Steam Input', () => {
  const played = [];
  const pads = [xpad(0, played)];
  world({ slots: [{ index: 0, handle: '777', type: '14' }], pads });
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
