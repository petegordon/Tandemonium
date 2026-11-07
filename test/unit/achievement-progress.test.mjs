// Pete, Steam playtest 2026-11-07: "a lot of the achievements don't give you progress" — best-so-far progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, emptyStats, migrateStats, foldBests, bestProgress, upgradeProgressAny, upgradeProgressAll } from '../../js/achievement-defs.js';
import { UPGRADES } from '../../js/slingshot.js';

const byId = id => ACHIEVEMENTS.find(a => a.id === id);

test('the measurable achievements now carry progress (a counter or a best-so-far)', () => {
  for (const id of ['steady_hands', 'centerline', 'speed_demon', 'terminal_goose', 'afterburner', 'collector', 'hoarder',
    'daily_haul', 'perfect_sync', 'team_player', 'pair_10_rides', 'pair_100km', 'max_upgrade', 'garage_royalty']) {
    const a = byId(id);
    assert.ok(a.progress || a.best, id);
  }
  assert.ok(ACHIEVEMENTS.filter(a => a.progress || a.best).length >= 71);
});

test('foldBests keeps the highest value ever seen, and only for unearned ones', () => {
  let L = emptyStats();
  L = foldBests(L, { speed: 30 / 3.6, collectibles: 4, totalCollectibles: 8, steadyBest: 12.34 });
  assert.equal(L.bests.speed_demon, 30);
  assert.equal(L.bests.terminal_goose, 30);
  assert.equal(L.bests.collector, 4);
  assert.equal(L.bests.hoarder, 50);
  assert.equal(L.bests.steady_hands, 12.3);
  const same = foldBests(L, { speed: 20 / 3.6 });
  assert.equal(same, L, 'nothing improved: the same object (no save)');
  L = foldBests(L, { speed: 42 / 3.6 }, new Set(['speed_demon']));
  assert.equal(L.bests.speed_demon, 30, 'earned: left alone');
  assert.equal(L.bests.terminal_goose, 42);
  assert.deepEqual(bestProgress(byId('terminal_goose'), L), [42, 65]);
  assert.deepEqual(bestProgress(byId('collector'), L), [4, 10]);
  assert.deepEqual(bestProgress(byId('afterburner'), L), [0, 10]);
});

test('team play and the Daily Haul only count in their own rides', () => {
  let L = foldBests(emptyStats(), { safePct: 90, isMultiplayer: false, collectibles: 5, totalCollectibles: 5 });
  assert.equal(L.bests.team_player, undefined, 'solo safe-riding is not co-op');
  assert.equal(L.bests.daily_haul, undefined, 'not the Daily Ride');
  L = foldBests(L, { safePct: 64, isMultiplayer: true, finishedLevel: 'daily', collectibles: 15, totalCollectibles: 20 });
  assert.equal(L.bests.team_player, 64);
  assert.equal(L.bests.daily_haul, 75);
});

test('bests survive a save and load; junk is dropped', () => {
  const L = foldBests(emptyStats(), { speed: 10 });
  const back = migrateStats(JSON.parse(JSON.stringify({ ...L, bests: { ...L.bests, nope: -1, bad: 'x' } })));
  assert.equal(back.bests.speed_demon, L.bests.speed_demon);
  assert.ok(!('nope' in back.bests) && !('bad' in back.bests));
  assert.deepEqual(migrateStats(null).bests, {});
});

test('the garage ones read the wallet: closest upgrade to max, and how many are maxed', () => {
  assert.deepEqual(upgradeProgressAll({}), [0, UPGRADES.length]);
  const u0 = UPGRADES[0], u1 = UPGRADES[1];
  const live = { wallet: { lv: { [u0.id]: u0.max, [u1.id]: 1 } } };
  assert.deepEqual(upgradeProgressAny(live), [u0.max, u0.max]);
  assert.deepEqual(upgradeProgressAll(live), [1, UPGRADES.length]);
});
