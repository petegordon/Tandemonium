// C-2 / #641 · the road everyone rides today: every ride counts, the best stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDailyLevel, formatDayLabel, dailyStatus, prune, dailyDescription,
  recordRideStart, recordDailyFinish, ridesStarted, firstTry, finishedToday,
  KEEP_DAYS, STORAGE_KEY
} from '../../js/daily-ride.js';
import { dailyKey, dailySeed } from '../../js/daily-seed.js';

const base = { id: 'daily', name: 'Daily Ride', distance: 500, checkpointInterval: 125 };
const DAY = '2026-09-08';

function memStore() {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v), _m: m };
}

/** One whole ride: start, then finish (as game.js does). */
function ride(store, key, run = {}) {
  const rideNo = recordRideStart(store, key);
  if (run.dnf) return rideNo;
  recordDailyFinish(store, key, { ...run, rideNo });
  return rideNo;
}

test('resolving attaches the day, the seed and a label without touching LEVELS', () => {
  const level = resolveDailyLevel(base, { key: DAY, seed: 1234 });
  assert.equal(level.key, DAY);
  assert.equal(level.seed, 1234);
  assert.equal(level.dateLabel, 'Tue, Sep 8');
  assert.equal(level.distance, 500);
  assert.equal(base.key, undefined, 'the base level is not mutated');
  assert.equal(base.seed, undefined);
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
  const status = dailyStatus(memStore(), DAY);
  assert.deepEqual(status, { started: 0, finished: 0, best: null, first: null });
  assert.equal(dailyDescription(status, DAY), 'Tue, Sep 8 · not ridden yet');
});

test('#641 every ride counts: starts and finishes accumulate, the best is kept', () => {
  const store = memStore();
  ride(store, DAY, { timeMs: 161000 });
  ride(store, DAY, { timeMs: 154500 });
  ride(store, DAY, { timeMs: 170000 });
  const status = dailyStatus(store, DAY);
  assert.equal(status.started, 3);
  assert.equal(status.finished, 3);
  assert.equal(status.best, 154500, 'the best of the day, not the last');
  assert.equal(dailyDescription(status, DAY), 'Tue, Sep 8 · finished ×3 · best 2:35');
});

test('#641 a ride counts when it starts: a quit ride still uses one', () => {
  const store = memStore();
  ride(store, DAY, { dnf: true });
  assert.equal(ridesStarted(store, DAY), 1);
  assert.equal(finishedToday(store, DAY), false);
  assert.equal(dailyDescription(dailyStatus(store, DAY), DAY), 'Tue, Sep 8 · ridden once');
  ride(store, DAY, { timeMs: 120000 });
  assert.equal(ridesStarted(store, DAY), 2);
  assert.match(dailyDescription(dailyStatus(store, DAY), DAY), /finished once · best 2:00/);
});

test("#666 a demo guest's rides in a full host's room count as rides, not against the cap", () => {
  const store = memStore();
  assert.equal(recordRideStart(store, DAY), 1);
  assert.equal(recordRideStart(store, DAY, { guest: true }), 2, 'still ride 2 of the day (first try, the card)');
  assert.equal(recordRideStart(store, DAY, { guest: true }), 3);
  assert.equal(ridesStarted(store, DAY), 1, 'only the own ride is on the cap');
  assert.equal(dailyStatus(store, DAY).started, 3);
  recordRideStart(store, DAY);
  assert.equal(ridesStarted(store, DAY), 2);
});

test('#641 / #403 a helped finish counts as a finish but is not the best', () => {
  const store = memStore();
  ride(store, DAY, { timeMs: 90000, helped: true });
  assert.equal(finishedToday(store, DAY), true);
  assert.equal(dailyStatus(store, DAY).best, null);
  ride(store, DAY, { timeMs: 110000 });
  assert.equal(dailyStatus(store, DAY).best, 110000, 'a slower unaided finish is the best');
  ride(store, DAY, { skipped: true });
  assert.equal(dailyStatus(store, DAY).best, 110000, 'a shortcut is never a best');
});

test('#641 the first try is ride 1, whatever happens after it', () => {
  const s = memStore();
  assert.equal(firstTry(s, DAY), null);
  ride(s, DAY, { timeMs: 130000 });
  assert.deepEqual(firstTry(s, DAY), { timeMs: 130000, helped: false });
  ride(s, DAY, { timeMs: 100000 });
  assert.deepEqual(firstTry(s, DAY), { timeMs: 130000, helped: false }, 'a faster second ride is not the first try');

  // The first ride quit: still riding it → null; once ride 2 starts it was a DNF.
  const q = memStore();
  recordRideStart(q, DAY);
  assert.equal(firstTry(q, DAY), null);
  ride(q, DAY, { timeMs: 100000 });
  assert.deepEqual(firstTry(q, DAY), { dnf: true });

  // A helped first ride, and a shortcut.
  const h = memStore();
  ride(h, DAY, { timeMs: 140000, helped: true });
  assert.deepEqual(firstTry(h, DAY), { timeMs: 140000, helped: true });
  const k = memStore();
  ride(k, DAY, { skipped: true });
  assert.deepEqual(firstTry(k, DAY), { skipped: true });
});

test('yesterday\'s rides do not count towards today', () => {
  const store = memStore();
  ride(store, '2026-09-07', { timeMs: 100000 });
  assert.equal(dailyStatus(store, DAY).started, 0);
  assert.equal(dailyStatus(store, '2026-09-07').finished, 1);
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
  assert.doesNotThrow(() => ride(angry, DAY, { timeMs: 1000 }));
  assert.deepEqual(dailyStatus(angry, DAY), { started: 0, finished: 0, best: null, first: null });
});

test('the store key is namespaced', () => {
  const store = memStore();
  ride(store, DAY, { timeMs: 1000 });
  assert.ok(store._m.has(STORAGE_KEY));
});

test('a save from before #641 still reads: practice finishes and the ranked best', () => {
  const store = memStore();
  store.set(STORAGE_KEY, JSON.stringify({
    [DAY]: { practice: 2, best: 62000, ranked: { solo: { timeMs: 65400 }, pair: { dnf: true } } }
  }));
  const status = dailyStatus(store, DAY);
  assert.equal(status.finished, 2);
  assert.equal(status.best, 62000);
  assert.equal(status.started, 0);
  assert.equal(finishedToday(store, DAY), true);
});
