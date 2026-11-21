import test from 'node:test';
import assert from 'node:assert/strict';
import { gyroOptionAvailable, steamTypeMayHaveGyro } from '../../js/gyro-tip.js';

test('nothing connected, or an Xbox pad through Steam: no gyro option', () => {
  assert.equal(gyroOptionAvailable({}), false);
  assert.equal(gyroOptionAvailable({ steamTypes: ['3'] }), false);
});

test('a gyro pad, a phone, or live motion each count', () => {
  for (const seen of [{ hidGyro: true }, { padGyro: true }, { phones: 1 }, { active: true }, { steamTypes: ['3', '13'] }]) {
    assert.equal(gyroOptionAvailable(seen), true);
  }
});

test('Steam types: gyro families yes, Xbox no, not-yet-named gets the benefit of the doubt', () => {
  for (const t of ['1', '5', '10', '13', '14', '', '0', null]) assert.equal(steamTypeMayHaveGyro(t), true, String(t));
  for (const t of ['2', '3', '4']) assert.equal(steamTypeMayHaveGyro(t), false, t);
});
