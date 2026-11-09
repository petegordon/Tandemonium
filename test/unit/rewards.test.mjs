// #611 · rewards: the player-bots unlock (all solo achievements but one) and the robot outfit lock (Time Warp, #644).
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

test('the robot outfit is locked until the Time Warp reward (any non-calendar achievements but 5), with a progress hint', () => {
  const nonCal = ACHIEVEMENTS.filter(a => !isCalendarAchievement(a)).map(a => a.id);
  const need = timeWarpProgress([]).need;
  assert.deepEqual([...lockedOutfits(GOOSE_OUTFITS, [])], ['robot']);
  assert.deepEqual([...lockedOutfits(GOOSE_OUTFITS, soloAchievementIds().slice(1))], ['robot'], 'player bots alone no longer unlocks it');
  assert.deepEqual([...lockedOutfits(GOOSE_OUTFITS, nonCal.slice(6))], ['robot']);
  assert.deepEqual([...lockedOutfits(GOOSE_OUTFITS, nonCal.slice(5))], []);
  assert.equal(outfitLockHint(GOOSE_OUTFITS.robot, nonCal.slice(0, 5)), `Time Warp reward: 5 of ${need} achievements`);
  assert.equal(outfitLockHint(GOOSE_OUTFITS.victorian, []), 'Coming to the store');
  assert.equal(rewardProgress('nope', []), null);
});

test('a player-bots reward outfit (none today) still reads its own progress', () => {
  const solo = soloAchievementIds();
  const bots = { bot: { reward: 'playerBots' } };
  assert.deepEqual([...lockedOutfits(bots, [])], ['bot']);
  assert.deepEqual([...lockedOutfits(bots, solo.slice(1))], []);
  assert.equal(outfitLockHint(bots.bot, solo.slice(0, 5)), 'Player Bots reward: 5 of ' + (solo.length - 1) + ' solo achievements');
});
