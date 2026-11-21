// #646 · steering settings follow the controller: the per-controller store, its migration
// from the old screen-wide settings, and what a seat's InputManager gets from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerSettings, settingsKeyFor, legacyDefaults, nextPrompt, PROMPT_CHOICES } from '../../js/controller-settings.js';
import { feelTuning, applySteeringFeel, TUNE, TUNING_BASE } from '../../js/config.js';
import { applyPadSettings } from '../../js/players-sheet.js';

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('settingsKeyFor: serial names the unit, a browser pad its model (the slot comes off)', () => {
  assert.equal(settingsKeyFor('serial:AB12'), 'serial:AB12');
  assert.equal(settingsKeyFor('pad:054c:0ce6:P2'), 'pad:054c:0ce6');
  assert.equal(settingsKeyFor('pad:054c:0ce6:P4'), 'pad:054c:0ce6');
  assert.equal(settingsKeyFor('pad:054c:0ce6:P?'), 'pad:054c:0ce6');
  assert.equal(settingsKeyFor('pad:name:xbox-360-controller:P3'), 'pad:name:xbox-360-controller');
  assert.equal(settingsKeyFor('steam:P1'), 'steam');
  assert.equal(settingsKeyFor('keyboard'), 'keyboard');
  assert.equal(settingsKeyFor(null), null);
  assert.equal(settingsKeyFor(''), null);
});

test('migration: the old screen-wide settings become every pad\'s starting point', () => {
  const store = memStore({ tandemonium_joystick: 'off', tandemonium_steering_feel: '0.72' });
  const cs = new ControllerSettings({ store, defaultFeel: 0.3 });
  const s = cs.get('pad:054c:0ce6');
  assert.deepEqual(s, { stick: false, gyro: null, feel: 0.72, prompts: 'auto' });
  assert.deepEqual(cs.get('serial:XYZ'), s, 'any existing pad rides as before');
  assert.equal(cs.has('pad:054c:0ce6'), false);
  // The snapshot is frozen: a later change to the old keys does not move the defaults.
  store.setItem('tandemonium_joystick', 'on');
  store.setItem('tandemonium_steering_feel', '0.1');
  const again = new ControllerSettings({ store, defaultFeel: 0.3 });
  assert.equal(again.get('pad:054c:0ce6').stick, false);
  assert.equal(again.get('pad:054c:0ce6').feel, 0.72);
});

test('migration: nothing saved = automatic stick/gyro and the default feel', () => {
  const cs = new ControllerSettings({ store: memStore(), defaultFeel: 0.3 });
  assert.deepEqual(cs.defaults(), { stick: null, gyro: null, feel: 0.3, prompts: 'auto' });
  assert.deepEqual(legacyDefaults(memStore({ tandemonium_joystick: 'on' }), 0.5), { stick: true, gyro: null, feel: 0.5, prompts: 'auto' });
  assert.equal(legacyDefaults(memStore({ tandemonium_steering_feel: 'junk' }), 0.4).feel, 0.4);
  assert.equal(legacyDefaults(memStore({ tandemonium_steering_feel: '7' }), 0.4).feel, 1, 'clamped');
});

test('a change sticks to that controller only, and survives a reload', () => {
  const store = memStore();
  const cs = new ControllerSettings({ store, defaultFeel: 0.3 });
  const seen = [];
  cs.onChange((k) => seen.push(k));
  cs.set('pad:054c:0ce6', { feel: 0.814 });
  cs.set('pad:054c:0ce6', { gyro: false });
  assert.deepEqual(cs.get('pad:054c:0ce6'), { stick: null, gyro: false, feel: 0.81, prompts: 'auto' });
  assert.equal(cs.get('pad:045e:02ea').feel, 0.3, 'another controller keeps its own');
  assert.deepEqual(seen, ['pad:054c:0ce6', 'pad:054c:0ce6']);
  cs.set('pad:054c:0ce6', { gyro: false });
  assert.equal(seen.length, 2, 'no change, no event');
  const reloaded = new ControllerSettings({ store, defaultFeel: 0.3 });
  assert.equal(reloaded.get('pad:054c:0ce6').feel, 0.81);
  assert.equal(reloaded.get('pad:054c:0ce6').gyro, false);
  assert.equal(reloaded.get('pad:045e:02ea').gyro, null);
});

test('bad input is ignored: junk fields, a null key, a broken store', () => {
  const store = memStore({ tandemonium_controller_settings: '{not json' });
  const cs = new ControllerSettings({ store, defaultFeel: 0.3 });
  cs.set('k', { stick: 'yes', feel: 'x', prompts: 'sega', gyro: true });
  assert.deepEqual(cs.get('k'), { stick: null, gyro: true, feel: 0.3, prompts: 'auto' });
  assert.deepEqual(cs.set(null, { feel: 1 }), cs.defaults());
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const cs2 = new ControllerSettings({ store: throwing, defaultFeel: 0.3 });
  assert.equal(cs2.set('k', { feel: 0.9 }).feel, 0.9, 'works for the session without storage');
});

test('button prompts cycle through every choice', () => {
  let v = 'auto';
  const seen = [];
  for (let i = 0; i < PROMPT_CHOICES.length; i++) { v = nextPrompt(v); seen.push(v); }
  assert.deepEqual(seen, ['playstation', 'xbox', 'nintendo', 'steam', 'auto']);
  assert.equal(nextPrompt('junk'), 'auto');
});

test('feelTuning is what applySteeringFeel puts in TUNE (pure, from the base)', () => {
  const before = { ...TUNE };
  try {
    applySteeringFeel(0.8);
    const t = feelTuning(0.8);
    for (const k of Object.keys(t)) assert.equal(TUNE[k], t[k], k);
    assert.equal(t.steeringFeel, 0.8);
    // Stable steers gentler than Responsive: more degrees for a full lean, wider dead zone.
    const stable = feelTuning(0), resp = feelTuning(1);
    assert.ok(stable.gyroSensitivity > resp.gyroSensitivity);
    assert.ok(stable.gyroDeadzone > resp.gyroDeadzone);
    // A custom base (another calibration) scales that base.
    const base = { ...TUNING_BASE, gyroSensitivity: 50 };
    assert.equal(feelTuning(0.5, base).gyroSensitivity, Math.min(60, 50 * (1.15 - 0.15)));
  } finally { Object.assign(TUNE, before); }
});

test('applyPadSettings: a seat\'s controller settings land on its InputManager', () => {
  const calls = [];
  const mk = (o = {}) => ({ motionEnabled: true, motionLean: 0.4, suppressGamepadLean: false, controllerTune: null, startTiltCalibration() { calls.push('cal'); }, ...o });
  const tune = feelTuning(0.9);
  // Automatic: gyro as the join armed it, the stick off while the gyro is live (#576).
  let im = mk();
  applyPadSettings(im, { stick: null, gyro: null }, tune, true);
  assert.equal(im.motionEnabled, true);
  assert.equal(im.suppressGamepadLean, true);
  assert.equal(im.controllerTune, tune);
  // …and on when there is no gyro to steer with.
  im = mk({ motionEnabled: false });
  applyPadSettings(im, { stick: null, gyro: null }, tune, false);
  assert.equal(im.suppressGamepadLean, false);
  // Gyro off: motion stops, lean zeroed; the stick takes over automatically.
  im = mk();
  applyPadSettings(im, { stick: null, gyro: false }, tune, true);
  assert.equal(im.motionEnabled, false);
  assert.equal(im.motionLean, 0);
  assert.equal(im.suppressGamepadLean, false);
  // Explicit stick on alongside gyro; gyro back on recalibrates once.
  im = mk({ motionEnabled: false });
  applyPadSettings(im, { stick: true, gyro: true }, tune, true);
  assert.equal(im.motionEnabled, true);
  assert.equal(im.suppressGamepadLean, false);
  assert.deepEqual(calls, ['cal']);
  // Gyro on cannot arm a pad without motion sensors.
  im = mk({ motionEnabled: false });
  applyPadSettings(im, { stick: false, gyro: true }, null, false);
  assert.equal(im.motionEnabled, false);
  assert.equal(im.suppressGamepadLean, true);
  assert.equal(im.controllerTune, null);
  applyPadSettings(null, { stick: true, gyro: true }, tune, true);   // no seat: no-op
});
