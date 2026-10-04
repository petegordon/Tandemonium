// B-3 · personal bests, splits, medals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  key, getBest, recordRun, trim, splitDelta, formatDelta, formatTime,
  medalFor, nextMedal, MAX_KEYS, capMedal, HELPED_ICON
} from '../../js/records.js';

test('keys separate level, difficulty and mode', () => {
  assert.equal(key('grandma', 'chill', 'solo'), 'grandma|chill|solo');
  assert.notEqual(key('grandma', 'chill', 'solo'), key('grandma', 'chill', 'coop'));
  assert.equal(key('grandma', 'chill'), 'grandma|chill|solo', 'solo is the default');
});

test('the first run is always a best, with no delta to report', () => {
  const store = {};
  const r = recordRun(store, 'k', { timeMs: 161000, splits: [40000, 80000] });
  assert.equal(r.isNewBest, true);
  assert.equal(r.delta, null);
  assert.equal(getBest(store, 'k').timeMs, 161000);
});

test('a slower run does not overwrite the best, and reports how far off', () => {
  const store = {};
  recordRun(store, 'k', { timeMs: 161000, splits: [40000] });
  const r = recordRun(store, 'k', { timeMs: 167000, splits: [42000] });
  assert.equal(r.isNewBest, false);
  assert.equal(r.delta, 6000);
  assert.equal(getBest(store, 'k').timeMs, 161000, 'the best must stand');
  assert.deepEqual(getBest(store, 'k').splits, [40000]);
});

test('a faster run replaces the best and reports the gain', () => {
  const store = {};
  recordRun(store, 'k', { timeMs: 161000 });
  const r = recordRun(store, 'k', { timeMs: 154500 });
  assert.equal(r.isNewBest, true);
  assert.equal(r.delta, -6500);
  assert.equal(getBest(store, 'k').timeMs, 154500);
});

test('a best with no splits adopts splits from a later slower run', () => {
  // Records written before splits existed should not permanently disable the
  // checkpoint deltas.
  const store = { k: { timeMs: 100000, splits: [], collectibles: 0, crashes: 0, date: '2026-01-01' } };
  recordRun(store, 'k', { timeMs: 120000, splits: [30000, 60000] });
  assert.deepEqual(getBest(store, 'k').splits, [30000, 60000]);
  assert.equal(getBest(store, 'k').timeMs, 100000, 'the time itself is untouched');
});

test('nonsense runs are ignored', () => {
  const store = {};
  for (const bad of [null, {}, { timeMs: 0 }, { timeMs: -5 }, { timeMs: NaN }]) {
    assert.equal(recordRun(store, 'k', bad).isNewBest, false);
  }
  assert.equal(getBest(store, 'k'), null);
});

test('the store is trimmed oldest-first', () => {
  const store = {};
  for (let i = 0; i < MAX_KEYS + 10; i++) {
    store['k' + i] = { timeMs: 1000, splits: [], date: new Date(2020, 0, 1 + i).toISOString() };
  }
  trim(store);
  assert.equal(Object.keys(store).length, MAX_KEYS);
  assert.equal(store.k0, undefined, 'the oldest went first');
  assert.ok(store['k' + (MAX_KEYS + 9)], 'the newest stayed');
});

test('split deltas compare against the best at the same checkpoint', () => {
  const best = { timeMs: 100000, splits: [30000, 60000] };
  assert.equal(splitDelta(best, 0, 31300), 1300);
  assert.equal(splitDelta(best, 1, 59200), -800);
  assert.equal(splitDelta(best, 5, 10), null, 'no such checkpoint in the best');
  assert.equal(splitDelta(null, 0, 10), null);
});

test('deltas always carry their sign', () => {
  assert.equal(formatDelta(1300), '+1.3');
  assert.equal(formatDelta(-800), '−0.8');
  assert.equal(formatDelta(0), '−0.0');
  assert.equal(formatDelta(null), '');
});

test('times read as minutes and seconds', () => {
  assert.equal(formatTime(161000), '2:41');
  assert.equal(formatTime(59400), '0:59');
  assert.equal(formatTime(600000), '10:00');
  assert.equal(formatTime(undefined), '—');
});

test('medals are awarded at or under the threshold', () => {
  const t = { gold: 140000, silver: 170000, bronze: 210000 };
  assert.equal(medalFor(139000, t), 'gold');
  assert.equal(medalFor(140000, t), 'gold', 'exactly on the threshold counts');
  assert.equal(medalFor(150000, t), 'silver');
  assert.equal(medalFor(200000, t), 'bronze');
  assert.equal(medalFor(240000, t), null);
  assert.equal(medalFor(100, null), null);
});

test('the next medal up is what the screen should point at', () => {
  assert.equal(nextMedal(null), 'bronze');
  assert.equal(nextMedal('bronze'), 'silver');
  assert.equal(nextMedal('silver'), 'gold');
  assert.equal(nextMedal('gold'), null);
});

// #400 · the D-4 ghost is gone. Stores saved while it existed carry a ride
// track on each best; those are dropped and every time survives.
test('legacy ghost tracks are dropped, records are kept', () => {
  const store = {};
  const track = { hz: 5, count: 2, data: [0, 0, 0, 1, 0, 0] };
  for (let i = 0; i < 12; i++) {
    store['k' + i] = {
      timeMs: 1000, splits: [], collectibles: 0, crashes: 0,
      date: new Date(2026, 0, 1 + i).toISOString(), track
    };
  }
  trim(store);
  assert.equal(Object.values(store).filter(r => 'track' in r).length, 0, 'no tracks kept');
  assert.equal(Object.keys(store).length, 12, 'the RECORDS must all survive');
  assert.equal(store.k0.timeMs, 1000, 'times are still there');
});

// ---- #403 · the helping hand ----------------------------------------------

test('#403 a helped run caps the medal at bronze; a skipped one earns none', () => {
  assert.equal(capMedal('gold', { helped: true }), 'bronze');
  assert.equal(capMedal('silver', { helped: true }), 'bronze');
  assert.equal(capMedal('bronze', { helped: true }), 'bronze');
  assert.equal(capMedal(null, { helped: true }), null, 'too slow for bronze is still no medal');
  assert.equal(capMedal('gold', { skipped: true }), null);
  assert.equal(capMedal('gold', { helped: true, skipped: true }), null);
  assert.equal(capMedal('gold'), 'gold');
  assert.equal(HELPED_ICON, '🛟');
});

test('#403 a helped run is recorded with 🛟 when there is no best yet', () => {
  const store = {};
  const r = recordRun(store, 'k', { timeMs: 200000, helped: true });
  assert.equal(r.isNewBest, true);
  assert.equal(getBest(store, 'k').helped, true);
});

test('#403 a helped run never overwrites an unassisted best, however fast', () => {
  const store = {};
  recordRun(store, 'k', { timeMs: 161000 });
  const r = recordRun(store, 'k', { timeMs: 120000, helped: true });
  assert.equal(r.isNewBest, false);
  assert.equal(getBest(store, 'k').timeMs, 161000);
  assert.equal(getBest(store, 'k').helped, undefined);
});

test('#403 a faster helped run replaces a helped best; an unassisted finish always replaces it', () => {
  const store = {};
  recordRun(store, 'k', { timeMs: 200000, helped: true });
  const faster = recordRun(store, 'k', { timeMs: 190000, helped: true });
  assert.equal(faster.isNewBest, true);
  assert.equal(getBest(store, 'k').timeMs, 190000);
  assert.equal(getBest(store, 'k').helped, true);
  const real = recordRun(store, 'k', { timeMs: 210000 });
  assert.equal(real.isNewBest, true, 'the first unassisted finish outranks any 🛟 best');
  assert.equal(real.replacedHelped, true);
  assert.equal(getBest(store, 'k').timeMs, 210000);
  assert.equal(getBest(store, 'k').helped, undefined);
});

test('#403 a run with a skipped checkpoint is never a best', () => {
  const store = {};
  const first = recordRun(store, 'k', { timeMs: 100000, skipped: true });
  assert.equal(first.isNewBest, false);
  assert.equal(getBest(store, 'k'), null);
  recordRun(store, 'k', { timeMs: 161000 });
  const r = recordRun(store, 'k', { timeMs: 90000, skipped: true });
  assert.equal(r.isNewBest, false);
  assert.equal(getBest(store, 'k').timeMs, 161000);
});
