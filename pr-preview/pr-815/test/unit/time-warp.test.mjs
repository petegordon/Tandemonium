// #611 / #644 · time warp mode: a warped day rides that real day's road, and
// counts as that day for the calendar achievements, the ride counters and the cap.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_WARP_DAYS, shiftDayKey, warpedDayKey, warpDays, playDayKey, warpForward, leaveWarp,
  canWarpForward, warpLine, longDayLabel,
} from '../../js/time-warp.js';
import { dailyKey, dailySeed, deriveSeed, itemSeed, SALT } from '../../js/daily-seed.js';
import {
  resolveDailyLevel, recordRideStart, recordDailyFinish, ridesStarted, dailyStatus, computeStreak, finishedToday,
  buildShareStrip,
} from '../../js/daily-ride.js';
import { emptyStats, applyEvent, getDefinition } from '../../js/achievement-defs.js';
import { dailyRideGate, DEMO_RULES } from '../../js/edition.js';
import { dailyLaunchSeed } from '../../js/slingshot.js';
import { LEVELS } from '../../js/race-config.js';
import { RoadPath } from '../../js/road-path.js';

const DAY = 86400000;
const BASE = LEVELS.find(l => l.isDaily);

function memStore() {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) };
}

// Times around the 09:00 UTC rollover, where a sloppy shift would be off by one.
const NOWS = [
  '2026-11-07T00:30:00Z', '2026-11-07T08:59:59Z', '2026-11-07T09:00:00Z',
  '2026-11-07T15:00:00Z', '2026-11-07T23:59:59Z', '2026-12-29T12:00:00Z',   // across a year end
].map(s => new Date(s));

/** The road's shape at a few distances (what the smoke compares in the game). */
function roadPrint(seed) {
  const path = new RoadPath(deriveSeed(seed, SALT.road));
  return [0, 125, 250, 375, 499].map(d => {
    const p = path.getPointAtDistance(d);
    return [+p.x.toFixed(3), +p.z.toFixed(3)];
  });
}

test('the key for +1..+7 warped today == the key computed on that day with no warp', () => {
  for (const now of NOWS) {
    for (let k = 1; k <= MAX_WARP_DAYS; k++) {
      const onTheDay = new Date(now.getTime() + k * DAY);
      assert.equal(warpedDayKey(k, now), dailyKey(onTheDay), `${now.toISOString()} +${k}`);
    }
  }
});

test('pressing Warp k times gives that day\'s key, seed, road, item seeds and Daily Launch course', () => {
  for (const now of NOWS) {
    leaveWarp();
    for (let k = 1; k <= MAX_WARP_DAYS; k++) {
      assert.equal(warpForward(now), k);
      const onTheDay = new Date(now.getTime() + k * DAY);
      const warped = resolveDailyLevel(BASE, { key: playDayKey(now), warp: warpDays(now) });
      const real = resolveDailyLevel(BASE, { key: dailyKey(onTheDay), seed: dailySeed(onTheDay) });
      assert.equal(warped.key, real.key);
      assert.equal(warped.seed, real.seed, 'seed from the key');
      assert.equal(warped.warp, k);
      assert.equal(real.warp, undefined, 'the real day is not marked');
      for (const salt of [SALT.obstacles, SALT.collectibles, SALT.geese, SALT.tokens]) {
        assert.equal(itemSeed(warped, salt, 0, 1), itemSeed(real, salt, 0, 1));
      }
      assert.equal(dailyLaunchSeed(warped.key), dailyLaunchSeed(real.key));
      if (now === NOWS[0]) assert.deepEqual(roadPrint(warped.seed), roadPrint(real.seed));
    }
  }
  leaveWarp();
});

test('a key handed in without a seed rides that key\'s road (never today\'s)', () => {
  const lvl = resolveDailyLevel(BASE, { key: '2026-11-12' });
  assert.equal(lvl.seed, dailySeed(new Date('2026-11-12T12:00:00Z')));
});

test('one day per press, at most 7, then the button stops; Back to today ends it', () => {
  const now = NOWS[3];
  leaveWarp();
  assert.equal(warpDays(now), 0);
  assert.equal(playDayKey(now), dailyKey(now));
  for (let k = 1; k <= 7; k++) assert.equal(warpForward(now), k);
  assert.equal(canWarpForward(now), false);
  assert.equal(warpForward(now), 7, 'an eighth press does nothing');
  assert.equal(playDayKey(now), '2026-11-14');
  leaveWarp();
  assert.equal(warpDays(now), 0);
  assert.equal(playDayKey(now), '2026-11-07');
});

test('the real date catching up shrinks the warp, then ends it', () => {
  const now = NOWS[3];
  leaveWarp();
  warpForward(now); warpForward(now);                       // on Nov 9
  assert.equal(warpDays(new Date(now.getTime() + DAY)), 1);  // the 09:00 rollover to Nov 8
  assert.equal(playDayKey(new Date(now.getTime() + DAY)), '2026-11-09', 'the target day stays put');
  assert.equal(warpDays(new Date(now.getTime() + 2 * DAY)), 0, 'Nov 9 arrived: back to the real date');
  assert.equal(playDayKey(new Date(now.getTime() + 3 * DAY)), '2026-11-10');
  leaveWarp();
});

test('the card line says which day it is', () => {
  assert.equal(longDayLabel('2026-11-10'), 'Tuesday, November 10');
  assert.equal(warpLine('2026-11-10', 3), '⏳ Tuesday, November 10 · warped +3');
  assert.equal(shiftDayKey('2026-12-30', 3), '2027-01-02');
});

/** One finished Daily Ride (and Daily Launch) on `key`, the way game.js + achievements.js record them. */
function rideDaily(store, L, key) {
  const rideNo = recordRideStart(store, key);
  recordDailyFinish(store, key, { timeMs: 90000, rideNo });
  L = applyEvent(L, 'ride', { mode: 'daily', newRide: true, metres: 500, finished: true }, key);
  L = applyEvent(L, 'finish', { finishedLevel: 'daily' }, key);
  L = applyEvent(L, 'dailyLaunch', { key }, key);
  return L;
}
const earned = (id, L, store, key) => !!getDefinition(id).condition({ dailyStreak: computeStreak(store, key).current }, L);
const CALENDAR = ['days_3', 'days_7', 'daily_streak_3', 'daily_streak_7', 'launch_week'];

test('7 warped days in one sitting earn all five calendar achievements', () => {
  const now = NOWS[3];
  const store = memStore();
  let L = emptyStats();
  leaveWarp();
  for (let k = 1; k <= 7; k++) {
    warpForward(now);
    L = rideDaily(store, L, playDayKey(now));
  }
  const key = playDayKey(now);
  for (const id of CALENDAR) assert.ok(earned(id, L, store, key), id);
  assert.equal(L.days, 7);
  assert.equal(L.dailyDayBest, 7);
  assert.equal(computeStreak(store, key).current, 7);
  leaveWarp();

  // Today plus 6 warped days is a week too (A Week of Roads at +6).
  const s2 = memStore();
  let L2 = rideDaily(s2, emptyStats(), dailyKey(now));
  for (let k = 1; k <= 6; k++) { warpForward(now); L2 = rideDaily(s2, L2, playDayKey(now)); }
  assert.ok(earned('daily_streak_7', L2, s2, playDayKey(now)));
  leaveWarp();
});

test('real days after a warp: nothing counted twice, the real streak unbroken, the run carries on', () => {
  const now = NOWS[3];                    // real Nov 7
  const store = memStore();
  let L = rideDaily(store, emptyStats(), '2026-11-07');
  leaveWarp();
  for (let k = 1; k <= 3; k++) { warpForward(now); L = rideDaily(store, L, playDayKey(now)); }   // Nov 8, 9, 10
  leaveWarp();
  const after = { days: L.days, run: L.dailyDayRun, best: L.dailyDayBest, launches: L.launchDays.length };
  assert.deepEqual(after, { days: 4, run: 4, best: 4, launches: 4 });

  // Back on the real date (still Nov 7): the streak held today is today's, not the future's.
  assert.equal(computeStreak(store, '2026-11-07').current, 1);

  // Real Nov 8 arrives: the warp already rode it. Riding again is the same day.
  assert.ok(finishedToday(store, '2026-11-08'), 'the card already shows it finished (no second daily bonus)');
  L = rideDaily(store, L, '2026-11-08');
  assert.equal(L.days, 4, 'no new day');
  assert.equal(L.launchDays.length, 4, 'no new launch day');
  assert.equal(L.dailyDayRun, 4, 'the run is not reset by a day behind it');
  assert.equal(L.lastDailyDay, '2026-11-10');
  assert.equal(computeStreak(store, '2026-11-08').current, 2, 'real streak: Nov 7 + Nov 8');
  assert.equal(dailyStatus(store, '2026-11-08').finished, 2);

  // Nov 11 (the day after the warp's last day): the run carries on to 5.
  L = rideDaily(store, L, '2026-11-11');
  assert.equal(L.dailyDayRun, 5);
  assert.equal(L.days, 5);
  assert.equal(computeStreak(store, '2026-11-11').current, 5);
});

test('the per-day ride counter and the demo cap key by the warped day', () => {
  const now = NOWS[3];
  const store = memStore();
  leaveWarp();
  const earnedIds = ['tutorial_done', 'home_sweet'];
  for (let i = 0; i < DEMO_RULES.dailyRideCap; i++) recordRideStart(store, dailyKey(now));
  assert.equal(dailyRideGate(DEMO_RULES, ridesStarted(store, playDayKey(now)), earnedIds).ok, false, 'today is used up');
  warpForward(now);
  assert.equal(ridesStarted(store, playDayKey(now)), 0);
  assert.equal(dailyRideGate(DEMO_RULES, ridesStarted(store, playDayKey(now)), earnedIds).ok, true, 'the warped day has its own rides');
  recordRideStart(store, playDayKey(now));
  assert.equal(ridesStarted(store, '2026-11-08'), 1);
  assert.equal(ridesStarted(store, '2026-11-07'), DEMO_RULES.dailyRideCap);
  leaveWarp();
});

test('the share strip marks a warped ride', () => {
  const strip = buildShareStrip({ key: '2026-11-10', mode: 'solo', timeMs: 90000, distance: 500, warp: true });
  assert.match(strip.split('\n')[0], /Nov 10 ⏳$/);
  const plain = buildShareStrip({ key: '2026-11-10', mode: 'solo', timeMs: 90000, distance: 500 });
  assert.doesNotMatch(plain, /⏳/);
});
