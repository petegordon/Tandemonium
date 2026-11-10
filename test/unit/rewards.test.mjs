// #611 · rewards: the player-bots unlock (all solo achievements but one) and the robot outfit lock (the Solo Flight's, #736).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS } from '../../js/achievement-defs.js';
import { GOOSE_OUTFITS } from '../../js/goose-outfits.js';
import {
  isCalendarAchievement, isMultiplayerAchievement, isSoloAchievement, soloAchievementIds,
  playerBotsProgress, lockedOutfits, outfitLockHint, timeWarpProgress, rewardProgress,
} from '../../js/rewards.js';

const byId = (id) => ACHIEVEMENTS.find(a => a.id === id);

test('calendar = day counters and day streaks; multiplayer = together + versus + Full House', () => {
  for (const id of ['days_3', 'days_7', 'daily_streak_3', 'daily_streak_7', 'launch_week']) assert.ok(isCalendarAchievement(byId(id)), id);
  for (const id of ['coop_first', 'social_goose', 'versus_first', 'versus_win']) assert.ok(isMultiplayerAchievement(byId(id)), id);
  for (const id of ['first_pedal', 'marathon', 'grandma_gold', 'sling_40', 'daily_launch']) assert.ok(isSoloAchievement(byId(id)), id);
  assert.ok(isMultiplayerAchievement({ id: 'full_house', section: 'explore' }), 'Full House (#608) needs co-op and versus');
});

test('every achievement is in exactly one group', () => {
  for (const a of ACHIEVEMENTS) {
    const cal = isCalendarAchievement(a);
    const n = [cal, isMultiplayerAchievement(a) && !cal, isSoloAchievement(a)].filter(Boolean).length;
    assert.equal(n, 1, a.id);
  }
});

test('player bots: all solo but one', () => {
  const solo = soloAchievementIds();
  assert.ok(solo.length > 60, 'most of the 100 are solo');
  assert.deepEqual(playerBotsProgress([]), { have: 0, need: solo.length - 1, total: solo.length, unlocked: false });
  const allButTwo = solo.slice(2);
  assert.equal(playerBotsProgress(allButTwo).unlocked, false);
  const allButOne = solo.slice(1);
  assert.equal(playerBotsProgress(allButOne).unlocked, true, 'any one solo achievement can be skipped');
  assert.equal(playerBotsProgress([...allButTwo, 'versus_win', 'days_7', 'coop_first']).unlocked, false, 'multiplayer / calendar ones do not count');
  assert.equal(playerBotsProgress([...allButOne, ...allButOne]).have, solo.length - 1, 'duplicates count once');
});

test('the robot outfit is locked until the Solo Flight reward (all solo achievements but one), with a progress hint', () => {
  const solo = soloAchievementIds();
  const need = playerBotsProgress([]).need;
  const robotOnly = { robot: GOOSE_OUTFITS.robot };
  assert.deepEqual([...lockedOutfits(robotOnly, [])], ['robot']);
  assert.deepEqual([...lockedOutfits(robotOnly, solo.slice(2))], ['robot']);
  assert.deepEqual([...lockedOutfits(robotOnly, solo.slice(1))], [], 'the Solo Flight brings it');
  assert.equal(outfitLockHint(GOOSE_OUTFITS.robot, solo.slice(0, 5)), `Solo Flight reward: 5 of ${need} solo achievements`);
  assert.equal(outfitLockHint(GOOSE_OUTFITS.victorian, []), 'Coming to the store');
  assert.equal(rewardProgress('nope', []), null);
});

test('a Time Warp reward outfit (none today, #736) still reads its own progress', () => {
  const nonCal = ACHIEVEMENTS.filter(a => !isCalendarAchievement(a)).map(a => a.id);
  const tw = { suit: { reward: 'timeWarp' } };
  assert.deepEqual([...lockedOutfits(tw, nonCal.slice(6))], ['suit']);
  assert.deepEqual([...lockedOutfits(tw, nonCal.slice(5))], []);
  assert.equal(outfitLockHint(tw.suit, nonCal.slice(0, 5)), `Time Warp reward: 5 of ${timeWarpProgress([]).need} achievements`);
});

// #736 · Victorian is free; Cyclists, Fancy and Georgian come with the holiday bikes; worn ones are kept.
test('the holiday outfits: Christmas → Cyclists, New Year → Fancy, Birthday → Georgian', async () => {
  const { outfitForBike } = await import('../../js/goose-outfits.js');
  assert.equal(outfitForBike('bike_christmas'), 'cyclists');
  assert.equal(outfitForBike('bike_newyears'), 'fancy');
  assert.equal(outfitForBike('bike_birthday'), 'georgian');
  assert.equal(outfitForBike('bike_green'), null);
  const none = new Set();
  assert.deepEqual([...lockedOutfits(GOOSE_OUTFITS, [], ACHIEVEMENTS, none)].sort(), ['cyclists', 'fancy', 'georgian', 'robot']);
  const christmas = ['grandma_green', 'grandma_red'];
  assert.ok(!lockedOutfits(GOOSE_OUTFITS, christmas, ACHIEVEMENTS, none).has('cyclists'));
  const newYear = ['grandma_yellow', 'grandma_default'];
  assert.ok(!lockedOutfits(GOOSE_OUTFITS, newYear, ACHIEVEMENTS, none).has('fancy'));
  const all5 = ['grandma_red', 'grandma_blue', 'grandma_yellow', 'grandma_green', 'grandma_default'];
  const l = lockedOutfits(GOOSE_OUTFITS, all5, ACHIEVEMENTS, none);
  assert.ok(!l.has('georgian') && !l.has('cyclists') && !l.has('fancy'));
  assert.ok(!lockedOutfits(GOOSE_OUTFITS, [], ACHIEVEMENTS, none).has('victorian'), 'Victorian is free');
  assert.equal(outfitLockHint(GOOSE_OUTFITS.cyclists, []), "Christmas Cruiser reward: finish Grandma's on Jungle Cruiser and Cherry Bomb");
});

test('outfits already worn before #736 are kept (recorded once)', async () => {
  const { seedKeptOutfits, keptOutfits, OUTFITS_KEPT_KEY } = await import('../../js/rewards.js');
  const mem = new Map();
  const storage = { getItem: (k) => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, v) };
  seedKeptOutfits(GOOSE_OUTFITS, ['fancy', 'victorian', 'robot', 'fancy'], storage);
  assert.deepEqual([...keptOutfits(storage)], ['fancy'], 'only holiday outfits; Robot still needs the Solo Flight');
  seedKeptOutfits(GOOSE_OUTFITS, ['georgian'], storage);
  assert.deepEqual(JSON.parse(mem.get(OUTFITS_KEPT_KEY)), ['fancy'], 'once only');
  assert.ok(!lockedOutfits(GOOSE_OUTFITS, [], ACHIEVEMENTS, keptOutfits(storage)).has('fancy'));
});
