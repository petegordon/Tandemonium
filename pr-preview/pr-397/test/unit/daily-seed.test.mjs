// B-4 / D-0 · one integer describes a whole world, and the day it belongs to.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailyKey, seedFromKey, dailySeed, deriveSeed, makePlacementSalt, SALT, ROLLOVER_HOUR_UTC
} from '../../js/daily-seed.js';

test('the road rolls over at 09:00 UTC, not at midnight', () => {
  assert.equal(dailyKey(new Date('2026-09-08T08:59:59Z')), '2026-09-07');
  assert.equal(dailyKey(new Date('2026-09-08T09:00:00Z')), '2026-09-08');
  assert.equal(dailyKey(new Date('2026-09-08T23:59:59Z')), '2026-09-08');
  assert.equal(dailyKey(new Date('2026-09-09T08:00:00Z')), '2026-09-08');
  assert.equal(ROLLOVER_HOUR_UTC, 9);
});

test('midnight in the local timezone does not change the key', () => {
  // 2026-09-08 00:00 in New York is 04:00 UTC — still the 7th's road.
  assert.equal(dailyKey(new Date('2026-09-08T04:00:00Z')), '2026-09-07');
  // …and 20:00 in New York (00:00 UTC next day) is still the 8th's road.
  assert.equal(dailyKey(new Date('2026-09-09T00:00:00Z')), '2026-09-08');
});

test('a key always produces the same non-zero seed', () => {
  const a = seedFromKey('2026-09-08');
  assert.equal(a, seedFromKey('2026-09-08'));
  assert.ok(a > 0 && Number.isInteger(a));
  assert.notEqual(a, seedFromKey('2026-09-09'));
});

test('no key hashes to zero', () => {
  for (let d = 1; d <= 28; d++) {
    const k = `2026-02-${String(d).padStart(2, '0')}`;
    assert.notEqual(seedFromKey(k), 0, k);
  }
  assert.notEqual(seedFromKey(''), 0);
});

test('consecutive days give unrelated roads', () => {
  const seeds = new Set();
  for (let d = 1; d <= 31; d++) seeds.add(seedFromKey(`2026-03-${String(d).padStart(2, '0')}`));
  assert.equal(seeds.size, 31, 'a month of days must not collide');
});

test('derived seeds are distinct per salt and stable', () => {
  const base = dailySeed(new Date('2026-09-08T12:00:00Z'));
  const derived = Object.values(SALT).map(s => deriveSeed(base, s));
  assert.equal(new Set(derived).size, derived.length, 'salts must not collide');
  assert.equal(deriveSeed(base, SALT.trees), deriveSeed(base, SALT.trees));
  for (const d of derived) assert.ok(d > 0 && Number.isInteger(d));
});

test('deriveSeed never returns zero, even from a zero base', () => {
  assert.notEqual(deriveSeed(0, 0), 0);
  assert.notEqual(deriveSeed(0, SALT.road), 0);
});

test('the placement salt varies run to run but stays small', () => {
  const a = makePlacementSalt(1757300000000);
  const b = makePlacementSalt(1757300000001);
  assert.notEqual(a, b);
  assert.ok(a >= 0 && a < 1000000);
});
