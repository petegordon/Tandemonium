// A gyro player's saved calibration loads back into the GYRO base (it is saved
// under the phone-named keys), and a phone save is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.navigator ??= { userAgent: 'node' };
globalThis.window ??= {};
const { tuningBaseFromSave } = await import('../../js/config.js');

test('a gyro save maps its phone-named keys onto the gyro base', () => {
  const data = { inputType: 'gyro', sensitivity: 58, deadzone: 4, responseCurve: 2 };
  const out = tuningBaseFromSave(data, { sensitivity: 58, deadzone: 4, responseCurve: 2 });
  assert.deepEqual(out, { gyroSensitivity: 58, gyroDeadzone: 4, gyroResponseCurve: 2 });
  assert.equal(out.sensitivity, undefined, 'the phone base is left alone');
});

test('a phone save is passed through unchanged', () => {
  const values = { sensitivity: 23, deadzone: 4, responseCurve: 2 };
  assert.equal(tuningBaseFromSave({ inputType: 'phone' }, values), values);
});

test('keys that are already gyro-named stay gyro-named', () => {
  assert.deepEqual(tuningBaseFromSave({ inputType: 'gyro' }, { gyroSensitivity: 50 }), { gyroSensitivity: 50 });
});
