// #819 · Pete's first-ride pacing: a clean first Grandma's ride awards 5, and the rest arrive over later rides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACHIEVEMENTS, applyEvent, emptyStats, grandmaMedalGrant, seedStats, withGrandmaFinished } from '../../js/achievement-defs.js';

const storage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const ach = (id) => ACHIEVEMENTS.find((a) => a.id === id);

async function manager({ demo = false } = {}) {
  globalThis.localStorage = storage();
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = demo;
  return m;
}

/** One clean 40 s Grandma's ride with a run of presents and 120 Tandem Tokens. → what it awarded */
function ride(m, { medal = 'gold', streak = 2, difficulty = 'adventurous', bikeKey = 'default', newBest = false, crashes = 0 } = {}) {
  const got = [];
  const add = (list) => got.push(...(list || []).map((a) => a.id));
  add(m.record('pedal', {}));
  for (let i = 1; i <= streak; i++) add(m.record('boost', { count: 1, streak: i }));
  add(m.record('coins', { amount: 120 }));
  add(m.record('ride', { newRide: true, mode: 'grandma', metres: 250, finished: true, earned: 120 }));
  add(m.finish({ ref: {}, finishedLevel: 'grandma', medal, newBest, difficulty, bikeKey, offroadT: 0, treeHits: 0,
    crashes, restarts: 0, distance: 250, raceDistance: 250, collectibles: streak, totalCollectibles: 9, isCoop: false }));
  return got;
}

test('a clean first gold ride awards exactly the agreed 5', async () => {
  const m = await manager();
  assert.deepEqual(ride(m).sort(), ['coin_first', 'first_pedal', 'grandma_gold', 'medal_key', 'perfect_1k'].sort());
});

test('the next rides bring Made It, the next medals and Home Sweet Home', async () => {
  const m = await manager();
  ride(m);
  const second = ride(m, { newBest: true });
  for (const id of ['first_finish', 'grandma_silver', 'new_best']) assert.ok(second.includes(id), `${id}: ${second}`);
  const third = ride(m);
  for (const id of ['home_sweet', 'grandma_bronze', 'no_offroad', 'adventurer']) assert.ok(third.includes(id), `${id}: ${third}`);
  assert.ok(!m.getEarnedIds().includes('grandma_default'));
  ride(m);
  assert.ok(ride(m).includes('grandma_default'), "Grandma's Classic on the 5th default-bike finish");
});

test('one medal per run: the best not yet earned, at or below this run', () => {
  assert.equal(grandmaMedalGrant('gold', []), 'grandma_gold');
  assert.equal(grandmaMedalGrant('gold', ['grandma_gold']), 'grandma_silver');
  assert.equal(grandmaMedalGrant('silver', ['grandma_gold', 'grandma_silver']), 'grandma_bronze');
  assert.equal(grandmaMedalGrant('bronze', []), 'grandma_bronze');
  assert.equal(grandmaMedalGrant('gold', ['grandma_bronze']), 'grandma_gold');
  assert.equal(grandmaMedalGrant('bronze', ['grandma_bronze']), null);
  assert.equal(grandmaMedalGrant(null, []), null);
});

test('Turbo Goose takes 3 presents in a row; a missed one breaks the run', async () => {
  const m = await manager();
  assert.ok(!ride(m, { streak: 2 }).includes('first_boost'));
  assert.ok(ride(m, { streak: 3 }).includes('first_boost'));
  const { CollectibleManager } = await import('../../js/collectibles.js');
  const run = (row) => CollectibleManager.prototype.collectedRun.call({ _items: row.map((c) => ({ collected: !!c })) });
  assert.equal(run([1, 1, 0, 1, 1]), 2);
  assert.equal(run([1, 1, 1, 0, 1]), 3);
  assert.equal(run([0, 0]), 0);
});

test("the Tutorial is not a finish or a ride, and Learner's Permit still comes from it", () => {
  let L = applyEvent(emptyStats(), 'tutorial', { clean: true }, '2026-11-21');
  L = applyEvent(L, 'ride', { newRide: true, mode: 'tutorial', metres: 100, finished: true }, '2026-11-21');
  assert.deepEqual([L.finishes, L.rides, L.tutorialDone], [0, 0, 1]);
  assert.ok(ach('tutorial_done').condition({}, L));
  const seeded = seedStats(emptyStats(), { records: { 'tutorial|chill|solo': { timeMs: 1000 } } });
  assert.equal(seeded.finishes, 0);
});

test('Payday takes 300 Tandem Tokens', () => {
  assert.equal(ach('payday').condition({}, { bestRideCoins: 299 }), false);
  assert.equal(ach('payday').condition({}, { bestRideCoins: 300 }), true);
});

test("one Grandma's finish still opens the demo's Daily Ride", () => {
  assert.deepEqual(withGrandmaFinished(['tutorial_done'], { grandmaFinishes: 1 }), ['tutorial_done', 'home_sweet']);
  assert.deepEqual(withGrandmaFinished(['tutorial_done'], { grandmaFinishes: 0 }), ['tutorial_done']);
});

test("the demo's first ride stays paced", async () => {
  const m = await manager({ demo: true });
  assert.deepEqual(ride(m).sort(), ['first_pedal', 'grandma_gold'].sort());
});
