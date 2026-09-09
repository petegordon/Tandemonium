// D-2 / D-3 / D-5 · ranked runs, the share strip, and streaks that forgive.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankedDone, rankedResult, recordRanked, recordPractice,
  computeStreak, computePairStreak, recordPartner, spendFreeze,
  buildShareStrip, isoWeek, daysBetween, FREEZES_PER_MONTH
} from '../../js/daily-ride.js';

function memStore() {
  const m = new Map();
  return { get: k => m.get(k) ?? null, set: (k, v) => m.set(k, v) };
}

// ── D-2 · ranked runs ─────────────────────────────────────────────────────

test('one ranked run per day per mode', () => {
  const s = memStore();
  assert.equal(rankedDone(s, '2026-09-08', 'solo'), false);

  const first = recordRanked(s, '2026-09-08', 'solo', { timeMs: 161000, distance: 500 });
  assert.equal(first.recorded, true);
  assert.equal(rankedDone(s, '2026-09-08', 'solo'), true);

  const second = recordRanked(s, '2026-09-08', 'solo', { timeMs: 120000, distance: 500 });
  assert.equal(second.recorded, false, 'a faster second attempt must not overwrite it');
  assert.equal(rankedResult(s, '2026-09-08', 'solo').timeMs, 161000);
});

test('solo and pair runs are independent', () => {
  const s = memStore();
  recordRanked(s, '2026-09-08', 'solo', { timeMs: 161000, distance: 500 });
  assert.equal(rankedDone(s, '2026-09-08', 'pair'), false,
    'riding alone at lunch must not use up the evening ride with a partner');
  assert.equal(recordRanked(s, '2026-09-08', 'pair', { timeMs: 150000 }).recorded, true);
});

test('a new day gives the run back', () => {
  const s = memStore();
  recordRanked(s, '2026-09-08', 'solo', { timeMs: 161000 });
  assert.equal(rankedDone(s, '2026-09-09', 'solo'), false);
});

test('END RIDE consumes the run as a DNF', () => {
  const s = memStore();
  const r = recordRanked(s, '2026-09-08', 'solo', { dnf: true, distance: 320 });
  assert.equal(r.recorded, true);
  assert.equal(r.result.dnf, true);
  assert.equal(r.result.timeMs, null);
  assert.equal(rankedDone(s, '2026-09-08', 'solo'), true,
    'a bad start must not be abandonable for a re-roll');
});

test('safety and sync are recorded, not forbidden', () => {
  const s = memStore();
  const r = recordRanked(s, '2026-09-08', 'pair',
    { timeMs: 150000, safety: true, sync: 0.82, partner: 'sam' });
  assert.equal(r.result.safety, true);
  assert.equal(r.result.sync, 82);
  assert.equal(r.result.partner, 'sam');
});

test('an unknown mode is refused', () => {
  const s = memStore();
  assert.equal(recordRanked(s, '2026-09-08', 'versus', { timeMs: 1 }).recorded, false);
});

// ── D-5 · streaks ─────────────────────────────────────────────────────────

test('consecutive days build a streak', () => {
  const s = memStore();
  for (const d of ['2026-09-06', '2026-09-07', '2026-09-08']) recordPractice(s, d, 100000);
  const st = computeStreak(s, '2026-09-08');
  assert.equal(st.current, 3);
  assert.equal(st.usedFreeze, false);
});

test('the streak survives until the end of the following day', () => {
  const s = memStore();
  recordPractice(s, '2026-09-07', 100000);
  const st = computeStreak(s, '2026-09-08');
  assert.equal(st.current, 1, 'yesterday still counts today');
});

test('a missed day spends a freeze instead of breaking the streak', () => {
  const s = memStore();
  for (const d of ['2026-09-05', '2026-09-06', '2026-09-08']) recordPractice(s, d, 100000);
  const st = computeStreak(s, '2026-09-08');
  assert.equal(st.current, 3, 'the 7th was missed and frozen over');
  assert.equal(st.usedFreeze, true);
  assert.equal(st.freezesLeft, FREEZES_PER_MONTH - 1);
});

test('two missed days in a row break it, and the best is kept', () => {
  const s = memStore();
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03']) recordPractice(s, d, 100000);
  const st = computeStreak(s, '2026-09-08');
  assert.equal(st.current, 0);
  assert.equal(st.best, 3, 'the best streak is remembered even after a break');
});

test('freezes run out', () => {
  const s = memStore();
  for (const d of ['2026-09-02', '2026-09-04', '2026-09-06', '2026-09-08']) recordPractice(s, d, 100000);
  const st = computeStreak(s, '2026-09-08');
  // Three one-day gaps, two freezes: the streak covers the first two gaps.
  assert.equal(st.freezesLeft, 0);
  assert.equal(st.current, 3);
});

test('a spent freeze is remembered across sessions', () => {
  const s = memStore();
  recordPractice(s, '2026-09-08', 100000);
  spendFreeze(s, '2026-09-08');
  spendFreeze(s, '2026-09-08');
  assert.equal(computeStreak(s, '2026-09-08').freezesLeft, 0);
  // A new month gets its own allowance.
  recordPractice(s, '2026-10-01', 100000);
  assert.equal(computeStreak(s, '2026-10-01').freezesLeft, FREEZES_PER_MONTH);
});

test('a player with no rides has no streak and full freezes', () => {
  const st = computeStreak(memStore(), '2026-09-08');
  assert.deepEqual(st, { current: 0, best: 0, freezesLeft: FREEZES_PER_MONTH, usedFreeze: false });
});

test('the pair streak counts weeks, not days', () => {
  const s = memStore();
  // A Tuesday one week, a Saturday the next: two weeks, one streak.
  recordPractice(s, '2026-09-01', 100000); recordPartner(s, '2026-09-01', 'sam');
  recordPractice(s, '2026-09-12', 100000); recordPartner(s, '2026-09-12', 'sam');
  const st = computePairStreak(s, 'sam', '2026-09-12');
  assert.equal(st.current, 2);
});

test('the pair streak ignores rides with someone else', () => {
  const s = memStore();
  recordPractice(s, '2026-09-08', 100000); recordPartner(s, '2026-09-08', 'jo');
  assert.equal(computePairStreak(s, 'sam', '2026-09-08').current, 0);
  assert.equal(computePairStreak(s, 'jo', '2026-09-08').current, 1);
});

test('the pair streak stays alive through the following week', () => {
  const s = memStore();
  recordPractice(s, '2026-09-01', 100000); recordPartner(s, '2026-09-01', 'sam');
  assert.equal(computePairStreak(s, 'sam', '2026-09-08').current, 1, 'last week still counts');
  assert.equal(computePairStreak(s, 'sam', '2026-09-20').current, 0, 'three weeks later it is gone');
});

test('ISO weeks and day gaps behave', () => {
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2026-09-08'), isoWeek('2026-09-13'), 'Tue and Sun of one week');
  assert.notEqual(isoWeek('2026-09-13'), isoWeek('2026-09-14'), 'Monday starts a new week');
  assert.equal(daysBetween('2026-09-01', '2026-09-08'), 7);
});

// ── D-3 · the share strip ─────────────────────────────────────────────────

const RUN = {
  key: '2026-09-08', mode: 'solo', timeMs: 161000, distance: 500, raceDistance: 500,
  medal: 'silver', collectibles: 9, collectiblesTotal: 12, crashes: 1
};

test('a ranked solo finish reads exactly as specified', () => {
  assert.equal(buildShareStrip(RUN), [
    "Tandemonium · Today's Road · Sep 8",
    '2:41 · 🥈 · 🎁 9/12 · 💥 1',
    '▰▰▰▰▰▰▰▰▰▰▰▰ 500m',
    'https://tandemonium.jimandi.love/?daily=2026-09-08'
  ].join('\n'));
});

test('a pair finish names the partner and the sync', () => {
  const strip = buildShareStrip({ ...RUN, mode: 'pair', sync: 0.82 * 100, partnerName: 'Sam' });
  assert.match(strip, /Today's Road · Sep 8 with Sam/);
  assert.match(strip, /^👥 2:41/m);
  assert.match(strip, /🔗 82%/);
});

test('a DNF says how far, not how long', () => {
  const strip = buildShareStrip({ ...RUN, dnf: true, distance: 320, medal: null });
  assert.match(strip, /DNF @ 320m/);
  assert.doesNotMatch(strip, /2:41/);
  assert.match(strip, /▰▰▰▰▰▰▰▰▱▱▱▱ 500m/, 'the bar shows how far they got: 320/500 -> 8 of 12');
});

test('practice and safety are flagged honestly', () => {
  const strip = buildShareStrip({ ...RUN, safety: true, practice: true });
  assert.match(strip, /🛡️/);
  assert.match(strip, /🏋️/);
});

test('a streak of two or more is worth showing; one is not', () => {
  assert.match(buildShareStrip({ ...RUN, streak: 4 }), /🔥 4/);
  assert.doesNotMatch(buildShareStrip({ ...RUN, streak: 1 }), /🔥/);
});

test('the strip never leaks the road', () => {
  const strip = buildShareStrip({ ...RUN, obstacleAt: 88, seed: 12345 });
  assert.doesNotMatch(strip, /88/, 'no obstacle positions');
  assert.doesNotMatch(strip, /12345/, 'no seed');
  // Only the four intended lines.
  assert.equal(strip.split('\n').length, 4);
});

test('the deep link points at the day that was ridden', () => {
  assert.match(buildShareStrip({ ...RUN, key: '2026-12-25' }), /\?daily=2026-12-25$/);
  assert.match(buildShareStrip(RUN, { origin: 'https://example.test' }), /example\.test\/\?daily=/);
});
