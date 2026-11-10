// #736 · the bike ladder: colour bikes at 35 / 50 / 65 achievements, each leading to a holiday bike,
// and what the "New bike!" screen celebrates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS } from '../../js/achievement-defs.js';
import { FULL_RULES, DEMO_RULES } from '../../js/edition.js';
import {
  BIKE_ORDER, COUNT_BIKES, unlockedBikes, bikeUnlocked, countBikeProgress, holidayUnlocked,
  nextBikeGoal, nextBikeGoalText, pendingBikeCelebration, welcomeText, achievementCount, earnedLine,
} from '../../js/bike-unlocks.js';

const COLOURS = ['grandma_default', 'grandma_orange', 'grandma_magenta', 'grandma_red', 'grandma_blue', 'grandma_green', 'grandma_yellow'];
const FILLER = ACHIEVEMENTS.map(a => a.id).filter(id => !COLOURS.includes(id));
/** n achievements, none of them the colour ones, plus `extra`. */
const ids = (n, extra = []) => [...FILLER.slice(0, n - extra.length), ...extra];

test('the order (Christmas before New Year), the counts', () => {
  assert.deepEqual(COUNT_BIKES, { bike_green: 35, bike_yellow: 50, bike_blue: 65 });
  assert.equal(BIKE_ORDER.length, 13);
  assert.equal(new Set(BIKE_ORDER).size, 13);
});

test('demo: Grandma\'s Classic and Marmalade only', () => {
  assert.deepEqual(unlockedBikes(ids(20), DEMO_RULES), ['default', 'bike_orange']);
  assert.deepEqual(unlockedBikes(ids(70), DEMO_RULES), ['default', 'bike_orange']);
});

test('full game start: four bikes', () => {
  assert.deepEqual(unlockedBikes([], FULL_RULES), ['default', 'bike_orange', 'bike_magenta', 'bike_red']);
});

test('Jungle at 35, Banana at 50, Ocean at 65', () => {
  assert.equal(bikeUnlocked('bike_green', ids(34), FULL_RULES), false);
  assert.equal(bikeUnlocked('bike_green', ids(35), FULL_RULES), true);
  assert.equal(bikeUnlocked('bike_yellow', ids(49), FULL_RULES), false);
  assert.equal(bikeUnlocked('bike_yellow', ids(50), FULL_RULES), true);
  assert.equal(bikeUnlocked('bike_blue', ids(64), FULL_RULES), false);
  assert.equal(bikeUnlocked('bike_blue', ids(65), FULL_RULES), true);
});

test('a colour already finished at Grandma\'s stays the player\'s', () => {
  const p = countBikeProgress('bike_blue', ['grandma_blue'], ACHIEVEMENTS);
  assert.deepEqual(p, { have: 1, need: 65, kept: true, unlocked: true });
  assert.ok(unlockedBikes(['grandma_blue', 'grandma_green', 'grandma_yellow'], FULL_RULES).includes('bike_blue'));
});

test('holiday bikes: Jungle + Cherry = Christmas; Banana + Grandma\'s = New Year; all five = Birthday', () => {
  assert.ok(holidayUnlocked('bike_christmas', ['grandma_green', 'grandma_red']));
  assert.ok(!holidayUnlocked('bike_christmas', ['grandma_green']));
  assert.ok(holidayUnlocked('bike_newyears', ['grandma_yellow', 'grandma_default']));
  assert.ok(!holidayUnlocked('bike_birthday', ['grandma_red', 'grandma_yellow', 'grandma_green', 'grandma_default']));
  assert.ok(holidayUnlocked('bike_birthday', ['grandma_red', 'grandma_blue', 'grandma_yellow', 'grandma_green', 'grandma_default']));
});

test('the next goal: the nearest count bike, then the special bikes', () => {
  assert.deepEqual(nextBikeGoal(ids(23), FULL_RULES), { key: 'bike_green', name: 'Jungle Cruiser', left: 12, unit: 'achievements' });
  assert.equal(nextBikeGoal(ids(36), FULL_RULES).key, 'bike_yellow');
  assert.equal(nextBikeGoal(ids(66), FULL_RULES).key !== 'bike_blue', true);
  assert.equal(nextBikeGoal(ids(23), DEMO_RULES), null);
  assert.equal(nextBikeGoal(ACHIEVEMENTS.map(a => a.id), FULL_RULES), null);
  assert.equal(nextBikeGoalText({ name: 'Jungle Cruiser', left: 12, unit: 'achievements' }), '12 more achievements to Jungle Cruiser');
  assert.equal(nextBikeGoalText({ name: 'Jungle Cruiser', left: 1, unit: 'achievements' }), '1 more achievement to Jungle Cruiser');
});

test('first time: what the player has is taken as seen (no celebration)', () => {
  const r = pendingBikeCelebration(null, ids(40), FULL_RULES);
  assert.deepEqual(r.bikes, []);
  assert.equal(r.welcome, null);
  assert.ok(r.next.bikes.includes('bike_green'));
  assert.equal(r.next.edition, 'full');
  assert.equal(r.next.count, 40);
});

test('a ride that crosses 35: Jungle is new', () => {
  const state = pendingBikeCelebration(null, ids(34), FULL_RULES).next;
  const r = pendingBikeCelebration(state, ids(35), FULL_RULES);
  assert.deepEqual(r.bikes, ['bike_green']);
  assert.equal(r.welcome, null);
  assert.deepEqual(pendingBikeCelebration(r.next, ids(35), FULL_RULES).bikes, [], 'celebrated once');
});

test('the Jungle ride to Grandma\'s: Christmas is new (and Banana too when it is the 50th)', () => {
  const before = ids(49, ['grandma_red']);
  const state = pendingBikeCelebration(null, before, FULL_RULES).next;
  const r = pendingBikeCelebration(state, [...before, 'grandma_green'], FULL_RULES);
  assert.deepEqual(r.bikes, ['bike_yellow', 'bike_christmas'], 'two bikes, one screen');
});

test('demo → full game: a welcome with the jump and every new bike', () => {
  const demo = pendingBikeCelebration(null, ids(20), DEMO_RULES).next;
  assert.equal(demo.edition, 'demo');
  const r = pendingBikeCelebration(demo, ids(52), FULL_RULES);
  assert.deepEqual(r.welcome, { kind: 'demo', achievements: 32 });
  assert.deepEqual(r.bikes, ['bike_magenta', 'bike_red', 'bike_green', 'bike_yellow']);
  assert.equal(welcomeText(r.welcome, r.bikes.length), 'Your demo riding earned you 32 achievements and 4 new bikes.');
});

test('sign-in that brings in progress: a welcome; a single new achievement is not one', () => {
  const state = pendingBikeCelebration(null, ids(10), FULL_RULES).next;
  const r = pendingBikeCelebration(state, ids(40), FULL_RULES, { signIn: true });
  assert.deepEqual(r.welcome, { kind: 'signin', achievements: 30 });
  assert.deepEqual(r.bikes, ['bike_green']);
  assert.equal(pendingBikeCelebration(state, ids(11), FULL_RULES, { signIn: true }).welcome, null);
  assert.equal(pendingBikeCelebration(state, ids(40), FULL_RULES).welcome, null, 'not on a ride');
});

test('holiday bikes never stack from a jump (they need rides)', () => {
  const demo = pendingBikeCelebration(null, ids(20), DEMO_RULES).next;
  const r = pendingBikeCelebration(demo, ids(70), FULL_RULES);
  assert.ok(!r.bikes.some(k => ['bike_christmas', 'bike_newyears', 'bike_birthday'].includes(k)));
});

test('every bike has a line saying how it was earned (but the two the game starts with)', () => {
  for (const k of BIKE_ORDER) if (!['default', 'bike_orange'].includes(k)) assert.ok(earnedLine(k), k);
  assert.equal(achievementCount(['first_pedal', 'first_pedal', 'not_an_achievement']), 1);
});

test('a colour bike ridden before #736 stays the player\'s (the saved pick, recorded once)', async () => {
  const { seedKeptBikes, keptBikes, BIKES_KEPT_KEY } = await import('../../js/bike-unlocks.js');
  const mem = new Map();
  const storage = { getItem: (k) => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, v) };
  seedKeptBikes('bike_blue', storage);
  assert.deepEqual([...keptBikes(storage)], ['bike_blue']);
  seedKeptBikes('bike_green', storage);
  assert.deepEqual(JSON.parse(mem.get(BIKES_KEPT_KEY)), ['bike_blue'], 'once only');
  const mem2 = new Map();
  const s2 = { getItem: (k) => mem2.has(k) ? mem2.get(k) : null, setItem: (k, v) => mem2.set(k, v) };
  seedKeptBikes('bike_red', s2);
  assert.deepEqual(JSON.parse(mem2.get(BIKES_KEPT_KEY)), [], 'Cherry needs no keeping');
});
