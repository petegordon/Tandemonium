// C-2 · the road everyone rides today.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDailyLevel, formatDayLabel, dailyStatus, recordPractice, prune,
  dailyDescription, recordRanked, KEEP_DAYS, STORAGE_KEY
} from '../../js/daily-ride.js';
import { dailyKey, dailySeed } from '../../js/daily-seed.js';

const base = { id: 'daily', name: "Today's Road", distance: 500, checkpointInterval: 125 };

function memStore() {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v), _m: m };
}

test('resolving attaches the day, the seed and a label without touching LEVELS', () => {
  const frozen = { ...base };
  const level = resolveDailyLevel(base, { key: '2026-09-08', seed: 12345 });
  assert.equal(level.key, '2026-09-08');
  assert.equal(level.seed, 12345);
  assert.equal(level.dateLabel, 'Tue, Sep 8');
  assert.equal(level.distance, 500);
  assert.deepEqual(base, frozen, 'the static level must not be mutated');
});

test('resolving with no arguments uses today', () => {
  const level = resolveDailyLevel(base);
  assert.equal(level.key, dailyKey());
  assert.equal(level.seed, dailySeed());
});

test('the day label is locale-independent', () => {
  assert.equal(formatDayLabel('2026-01-01'), 'Thu, Jan 1');
  assert.equal(formatDayLabel('2026-12-25'), 'Fri, Dec 25');
  assert.equal(formatDayLabel('nonsense'), '');
});

test('an untouched day reads as not ridden', () => {
  const store = memStore();
  const status = dailyStatus(store, '2026-09-08');
  assert.deepEqual(status, { practiced: 0, best: null, ranked: { solo: null, pair: null } });
  assert.equal(dailyDescription(status, '2026-09-08'), 'Tue, Sep 8 · not ridden yet');
});

test('practice runs accumulate and keep the day\'s best', () => {
  const store = memStore();
  recordPractice(store, '2026-09-08', 161000);
  recordPractice(store, '2026-09-08', 154500);
  recordPractice(store, '2026-09-08', 170000);
  const status = dailyStatus(store, '2026-09-08');
  assert.equal(status.practiced, 3);
  assert.equal(status.best, 154500, 'the best of the day, not the last');
  assert.equal(dailyDescription(status, '2026-09-08'), 'Tue, Sep 8 · ridden ×3 · best 2:35');
});

test('one ride reads as "ridden once"', () => {
  const store = memStore();
  recordPractice(store, '2026-09-08', 120000);
  assert.match(dailyDescription(dailyStatus(store, '2026-09-08'), '2026-09-08'), /ridden once/);
});

test('yesterday\'s rides do not count towards today', () => {
  const store = memStore();
  recordPractice(store, '2026-09-07', 100000);
  assert.equal(dailyStatus(store, '2026-09-08').practiced, 0);
  assert.equal(dailyStatus(store, '2026-09-07').practiced, 1);
});

test('old days are pruned, recent ones are kept', () => {
  const all = {
    '2026-01-01': { practice: 1 },
    '2026-08-20': { practice: 1 },
    '2026-09-08': { practice: 1 }
  };
  const kept = prune(all, '2026-09-08');
  assert.equal(kept['2026-01-01'], undefined, 'far past dropped');
  assert.ok(kept['2026-08-20'], `within ${KEEP_DAYS} days kept`);
  assert.ok(kept['2026-09-08']);
});

test('a store that throws does not take the ride down', () => {
  const angry = { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); } };
  assert.doesNotThrow(() => recordPractice(angry, '2026-09-08', 1000));
  assert.deepEqual(dailyStatus(angry, '2026-09-08'), { practiced: 0, best: null, ranked: { solo: null, pair: null } });
});

test('the store key is namespaced', () => {
  const store = memStore();
  recordPractice(store, '2026-09-08', 1000);
  assert.ok(store._m.has(STORAGE_KEY));
});

// #398 · a ranked run used the day's one attempt; the card has to say so.
test('a ranked finish counts as ridden and shows its time', () => {
  const store = memStore();
  recordRanked(store, '2026-09-08', 'solo', { timeMs: 65400, distance: 500 });
  const status = dailyStatus(store, '2026-09-08');
  assert.equal(status.ranked.solo.timeMs, 65400);
  assert.equal(dailyDescription(status, '2026-09-08'), 'Tue, Sep 8 · Ranked ✓ 1:05');
});

test('a ranked DNF (END RIDE) still reads as the run being used', () => {
  const store = memStore();
  recordRanked(store, '2026-09-08', 'solo', { dnf: true, distance: 120 });
  assert.equal(dailyDescription(dailyStatus(store, '2026-09-08'), '2026-09-08'), 'Tue, Sep 8 · Ranked · DNF');
});

test('solo and pair ranked runs and practice all show', () => {
  const store = memStore();
  recordRanked(store, '2026-09-08', 'pair', { timeMs: 70000 });
  recordRanked(store, '2026-09-08', 'solo', { dnf: true });
  recordPractice(store, '2026-09-08', 62000);
  assert.equal(dailyDescription(dailyStatus(store, '2026-09-08'), '2026-09-08'),
    'Tue, Sep 8 · Ranked · DNF · Pair ranked ✓ 1:10 · ridden once · best 1:02');
});
