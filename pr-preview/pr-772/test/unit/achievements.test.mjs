// #401 · the 100 achievements: the list, the stats, the rules, the demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ACHIEVEMENTS, SECTIONS, DEMO_UNEARNABLE, MEDAL_LEVELS,
  emptyStats, migrateStats, applyEvent, RideTracker, lastCheckpointM, versusResult, opensMedalGate,
  STATS_VERSION, stageForDistance, RENAMED_IDS, migrateEarned, getDefinition,
  COLOUR_BIKES, FULL_HOUSE_MODES, finishModes, seedStats,
} from '../../js/achievement-defs.js';
import { DEMO_RULES, FULL_RULES } from '../../js/edition.js';
import { completedTrails, isStraightShot, COINS_PER_TRAIL, planCourse } from '../../js/slingshot.js';

// The 23 achievements on main before #401 — their ids (Steam API names) must not change
// (daily_streak_30 left with the #608 swap; days_30 and pair_100km kept their ids with new goals).
const EXISTING = [
  'first_500m', 'first_km', 'five_k', 'speed_demon', 'perfect_sync', 'collector', 'hoarder',
  'home_sweet', 'grandma_default', 'grandma_orange', 'grandma_magenta', 'grandma_red',
  'grandma_blue', 'grandma_green', 'grandma_yellow', 'perfect_1k', 'team_player',
  'daily_first', 'daily_streak_7', 'pair_10_rides', 'pair_100km',
  'distance_between_us',
];

// The spec's Demo column "—" (issue #401), plus sling_stage5: the spec marks it
// ✓, but the demo's Slingshot stops at stage 3 (DEMO_RULES.slingshot.maxStage),
// so the edition rules win. (double_down left this list with #546: the pot of
// gold no longer ends the run, so a demo stage 2-3 run can pair it with a best.)
// daily_streak_3/7 (m5): the demo rides the weekly road, which feeds no day streak.
// #641 · the 20 the demo awards (Pete, 2026-11-07).
const DEMO_20 = [
  'first_pedal', 'tutorial_done', 'first_crash', 'first_remount', 'first_boost',
  'home_sweet', 'grandma_bronze', 'grandma_silver', 'grandma_gold', 'first_km',
  'new_best', 'daily_first', 'daily_gold', 'sling_first', 'sling_stage3',
  'jackpot', 'first_upgrade', 'coop_first', 'grandma_orange', 'days_3',
];

// Rows per section, in the spec's order.
// #608: distance -1 (Century), daily -1 (A Month of Roads), together -1 (Standing Date),
// versus -1 +2 (Neck and Beak out; Underdog, Clean Sweep in), explore +1 (Full House), colours +1 (Rainbow Gold).
const SPEC_SECTIONS = { first: 7, distance: 6, back: 4, medals: 9, clean: 7, speed: 4, collect: 4, sling: 15,
  coins: 10, daily: 5, together: 6, versus: 7, chaos: 5, explore: 3, colours: 8 };

test('exactly 100 achievements, unique ids, 7 bike colours', () => {
  assert.equal(ACHIEVEMENTS.length, 100);
  assert.equal(new Set(ACHIEVEMENTS.map(a => a.id)).size, 100);
  const colours = ACHIEVEMENTS.filter(a => a.section === 'colours' && a.id !== 'rainbow_gold');
  assert.equal(colours.length, 7);
  for (const a of colours) assert.match(a.id, /^grandma_/);
  assert.equal(COLOUR_BIKES.length, 7);
});

test('the 23 existing ids are kept unchanged (77 new)', () => {
  const ids = new Set(ACHIEVEMENTS.map(a => a.id));
  for (const id of EXISTING) assert.ok(ids.has(id), `${id} is missing`);
  assert.equal(ACHIEVEMENTS.filter(a => !EXISTING.includes(a.id)).length, 78);
  // #608 swapped these out.
  for (const gone of ['century', 'daily_streak_30', 'standing_date', 'versus_close']) assert.ok(!ids.has(gone), `${gone} was removed (#608)`);
  // Castle and ghost achievements are gone (#400 D2/D3).
  for (const gone of ['royal', 'perfect_5k', 'beat_ghost']) assert.ok(!ids.has(gone), `${gone} was removed`);
});

test('the sections match the spec, in order', () => {
  assert.deepEqual(SECTIONS.map(s => s.id), Object.keys(SPEC_SECTIONS));
  for (const [sec, count] of Object.entries(SPEC_SECTIONS)) {
    assert.equal(ACHIEVEMENTS.filter(a => a.section === sec).length, count, `section ${sec}`);
  }
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.icon && a.desc, `${a.id} needs a name, icon and description`);
    assert.equal(typeof a.condition, 'function', `${a.id} needs a condition`);
  }
  // Section 13 is the hidden one; nothing else is hidden.
  assert.deepEqual(ACHIEVEMENTS.filter(a => a.hidden).map(a => a.id),
    ACHIEVEMENTS.filter(a => a.section === 'chaos').map(a => a.id));
});

// ── every condition is satisfiable ───────────────────────────────

function maxedLifetime() {
  const L = emptyStats();
  for (const [k, v] of Object.entries(L)) {
    if (typeof v === 'number' && k !== 'v') L[k] = 1e6;
    if (typeof v === 'boolean') L[k] = true;
  }
  L.golds = [...MEDAL_LEVELS];
  L.launchDays = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  L.partners = ['a', 'b', 'c'];
  L.dayList = ['2026-10-01'];
  L.grandmaGoldBikes = [...COLOUR_BIKES];
  L.modesFinished = [...FULL_HOUSE_MODES];
  return L;
}

const finishBase = { collectibles: 12, totalCollectibles: 12, crashes: 1, restarts: 0, medal: 'gold',
  newBest: true, difficulty: 'adventurous', offroadT: 0, treeHits: 0, didItMyself: true,
  dailyRanked: true, dailyStreak: 30, pairRides: 10, pairDistanceKm: 100, pairWeekStreak: 4,
  touristFinished: true, isMultiplayer: true, safePct: 90 };
const CANDIDATES = [
  {},                                                        // an event: lifetime stats only
  { speed: 19, offsetScore: 0.95, syncDuration: 12, steadyBest: 61, stripBest: 31, boostBest: 11,
    collectibles: 12, totalCollectibles: 12, isMultiplayer: true, safePct: 85 },   // a ride frame
  { ...finishBase, finishedLevel: 'daily' },
  { ...finishBase, finishedLevel: 'grandma', crashes: 0, bikeKey: 'default' },
  { ...finishBase, finishedLevel: 'grandma', difficulty: 'daredevil' },
  { ...finishBase, finishedLevel: 'grandma', gyroOnly: true },   // #500 Look, No Thumbs
  ...['orange', 'magenta', 'red', 'blue', 'green', 'yellow'].map(c => ({ ...finishBase, finishedLevel: 'grandma', bikeKey: 'bike_' + c })),
];

test('every condition is satisfiable by a synthetic stats object', () => {
  const L = maxedLifetime();
  for (const a of ACHIEVEMENTS) {
    assert.ok(CANDIDATES.some(s => a.condition({ ...s }, L)), `${a.id} can never be earned`);
  }
});

test('nothing is earned from a fresh start', () => {
  const L = emptyStats();
  for (const a of ACHIEVEMENTS) {
    assert.equal(!!a.condition({}, L), false, `${a.id} is earned by doing nothing`);
  }
});

// ── the demo ─────────────────────────────────────────────────────

test('#641: the demo awards exactly the agreed 20, and the full game all 100', () => {
  const demo = ACHIEVEMENTS.filter(a => a.demo).map(a => a.id);
  assert.deepEqual([...demo].sort(), [...DEMO_20].sort());
  assert.deepEqual([...DEMO_RULES.achievements].sort(), [...DEMO_20].sort());
  assert.equal(DEMO_UNEARNABLE.length, 80);
  assert.equal(FULL_RULES.achievements, null);
});

test('#641: every demo achievement can be earned inside the demo', () => {
  for (const a of ACHIEVEMENTS.filter(x => x.demo)) {
    assert.notEqual(a.section, 'versus', `${a.id}: Versus is full-game only`);
    assert.notEqual(a.section, 'explore', `${a.id}: Tourist is full-game only`);
    if (a.section === 'colours') {
      const bike = a.id === 'grandma_default' ? 'default' : 'bike_' + a.id.slice('grandma_'.length);
      assert.ok(DEMO_RULES.bikes.includes(bike), `${a.id}: ${bike} is not a demo bike`);
    }
  }
  // …and every Slingshot row the demo can earn fits inside the demo's stages.
  for (const a of ACHIEVEMENTS.filter(x => x.demo && x.stage)) {
    assert.ok(a.stage <= DEMO_RULES.slingshot.maxStage, `${a.id} needs stage ${a.stage}`);
  }
  // The demo's levels still include everything the demo medal rows need.
  for (const id of ['grandma', 'daily', 'tutorial']) assert.ok(DEMO_RULES.levels.includes(id));
  assert.equal(stageForDistance(500), 3);
  assert.equal(stageForDistance(1000), 7);
});

// ── lifetime stats ───────────────────────────────────────────────

test('stats: a v1 save keeps its distance; junk never throws', () => {
  const L = migrateStats({ cumulativeDistance: 4321 });
  assert.equal(L.v, STATS_VERSION);
  assert.equal(L.cumulativeDistance, 4321);
  assert.equal(L.rides, 0);
  assert.deepEqual(L.dayList, []);
  for (const junk of [null, undefined, 7, 'x', [], { rides: -3, golds: 'no', pedalled: 'yes' }]) {
    const j = migrateStats(junk);
    assert.equal(j.rides, 0);
    assert.deepEqual(j.golds, []);
    assert.equal(j.pedalled, false);
  }
  const round = migrateStats(JSON.parse(JSON.stringify(applyEvent(L, 'ride', { newRide: true, metres: 10 }, '2026-10-04'))));
  assert.equal(round.rides, 1);
  assert.equal(round.days, 1);
  assert.equal(round.cumulativeDistance, 4331);
});

test('stats: rides, distinct days, distance, Tourist, Payday', () => {
  let L = emptyStats();
  L = applyEvent(L, 'ride', { mode: 'solo', newRide: true, metres: 140, earned: 30 }, '2026-10-01');
  L = applyEvent(L, 'ride', { mode: 'solo', newRide: false, metres: 110, earned: 180, finished: true }, '2026-10-01');
  assert.equal(L.rides, 1);
  assert.equal(L.cumulativeDistance, 250);
  assert.equal(L.bestRideCoins, 210);   // one ride, two payouts
  L = applyEvent(L, 'ride', { mode: 'tourist', newRide: true, metres: 900 }, '2026-10-01');
  L = applyEvent(L, 'ride', { mode: 'daily', newRide: true, metres: 500, finished: true }, '2026-10-02');
  L = applyEvent(L, 'slingRun', { distance: 520 }, '2026-10-03');
  assert.equal(L.rides, 4);
  assert.equal(L.days, 3);
  assert.equal(L.touristDistance, 900);
  assert.equal(L.dailyPractice, 1);
  assert.equal(L.slingBest, 520);
  assert.equal(L.cumulativeDistance, 1650);   // the launch is not riding
});

test("stats: Daily Ride day streak and medal keys", () => {
  let L = emptyStats();
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-02', '2026-10-03']) {
    L = applyEvent(L, 'finish', { finishedLevel: 'daily' }, day);
  }
  assert.equal(L.dailyDayRun, 3);
  assert.equal(L.dailyDayBest, 3);
  L = applyEvent(L, 'finish', { finishedLevel: 'daily' }, '2026-10-06');
  assert.equal(L.dailyDayRun, 1);
  assert.equal(L.dailyDayBest, 3);
  assert.equal(opensMedalGate('grandma', 'bronze'), true);
  assert.equal(opensMedalGate('grandma', null), false);
  L = applyEvent(L, 'finish', { finishedLevel: 'grandma', medal: 'gold', isCoop: true, partnerKey: 'p1' }, '2026-10-06');
  assert.equal(L.medalKeys, 1);
  assert.deepEqual(L.golds, ['grandma']);
  assert.equal(L.coopFinishes, 1);
  assert.deepEqual(L.partners, ['p1']);
});

test('stats: the economy events', () => {
  let L = emptyStats();
  L = applyEvent(L, 'coins', { amount: 120 });
  L = applyEvent(L, 'upgrade', { id: 'magnet', level: 8, price: 900 });
  L = applyEvent(L, 'upgrade', { id: 'sling', level: 1, price: 40, allMaxed: true });
  L = applyEvent(L, 'rebuild', { rebuilds: 2 });
  L = applyEvent(L, 'dailyLaunch', { key: '2026-10-04' });
  L = applyEvent(L, 'dailyLaunch', { key: '2026-10-04' });
  L = applyEvent(L, 'stageCleared', { stage: 3 });
  L = applyEvent(L, 'slingRun', { distance: 130, pot: true, record: true, fullTrails: 2, straight: false });
  assert.equal(L.coinsEarned, 120);
  assert.equal(L.coinsSpent, 940);
  assert.equal(L.upgrades, 2);
  assert.equal(L.maxedAny, true);
  assert.equal(L.maxedAll, true);
  assert.equal(L.rebuilds, 2);
  assert.deepEqual(L.launchDays, ['2026-10-04']);
  assert.equal(L.slingStage, 3);
  assert.equal(L.doubleDowns, 1);
  assert.equal(applyEvent(emptyStats(), 'pot', { stage: 2 }).jackpots, 1, 'a pot of gold counts toward Pot of Gold (#546)');
  assert.equal(L.fullTrails, 2);
  assert.equal(L.straightShots, 0);
});

// ── the ride tracker ─────────────────────────────────────────────

const frame = (over = {}) => ({ ref: 'r1', playing: true, fallen: false, speed: 6, lateralOffset: 0,
  onCenterStrip: false, boosting: false, shaking: false, helped: false, ...over });

test('ride tracker: False Start and So Close', () => {
  const t = new RideTracker();
  t.go();
  t.frame(1, frame());
  assert.deepEqual(t.crash({ ref: 'r1', distance: 20, raceDistance: 250 }), { falseStart: true, soClose: false });
  // Only the first crash after a GO.
  assert.equal(t.crash({ ref: 'r1', distance: 21, raceDistance: 250 }).falseStart, false);
  t.go();
  t.frame(4, frame());
  const late = t.crash({ ref: 'r1', distance: 245, raceDistance: 250 });
  assert.deepEqual(late, { falseStart: false, soClose: true });
  assert.equal(t.snapshot().rideCrashes, 3);
});

test('So Close: anywhere past the last checkpoint', () => {
  const t = new RideTracker();
  const at = (distance, lastCheckpoint) => t.crash({ ref: 'r1', distance, raceDistance: 250, lastCheckpoint }).soClose;
  assert.equal(at(199, 200), false);    // still before the last checkpoint
  assert.equal(at(200, 200), true);     // right on it
  assert.equal(at(205, 200), true);     // early in the final stretch: used to need the last 10 m
  assert.equal(at(249, 200), true);
  // No checkpoints on the road: the last 10 m, as before.
  assert.equal(at(235, 0), false);
  assert.equal(at(241, 0), true);
});

test('lastCheckpointM matches RaceManager', () => {
  assert.equal(lastCheckpointM(250, 50), 200);
  assert.equal(lastCheckpointM(260, 50), 250);
  assert.equal(lastCheckpointM(250, 250), 0);   // Tourist: one "checkpoint" at the end = none
  assert.equal(lastCheckpointM(250, 0), 0);
});

test('ride tracker: False Start only within 3 s of GO, versus included (m1)', () => {
  // Versus ticks frame() with ref null each playing frame (game.js · _updateVersus).
  const vs = new RideTracker();
  vs.go();
  for (let i = 0; i < 40; i++) vs.frame(0.1, { ref: null, playing: true });   // 4 s after GO
  assert.equal(vs.crash({ ref: null, distance: 30, raceDistance: 500 }).falseStart, false);
  vs.go();
  for (let i = 0; i < 20; i++) vs.frame(0.1, { ref: null, playing: true });   // 2 s after GO
  assert.equal(vs.crash({ ref: null, distance: 8, raceDistance: 500 }).falseStart, true);
  // A versus GO right after a solo ride (a different ref) still counts from GO.
  const t = new RideTracker();
  t.frame(1, frame({ ref: 'solo' }));
  t.go();
  t.frame(0.5, { ref: null, playing: true });
  assert.equal(t.crash({ ref: null }).falseStart, true);
  // A GO is fresh only until the first frame or crash: a later ride's crash
  // with no GO of its own is not a False Start.
  const u = new RideTracker();
  u.go();
  assert.equal(u.crash({ ref: 'a' }).falseStart, true);
  assert.equal(u.crash({ ref: 'b' }).falseStart, false);
});

test('ride tracker: off-road, centre strip, boost chain, steady hands, did it myself', () => {
  const t = new RideTracker();
  for (let i = 0; i < 31; i++) t.frame(1, frame({ onCenterStrip: true, boosting: i < 11 }));
  t.frame(1, frame({ shaking: true }));
  for (let i = 0; i < 5; i++) t.frame(1, frame({ lateralOffset: 3 }));
  const s = t.snapshot();
  assert.equal(s.stripBest, 31);
  assert.equal(s.boostBest, 11);
  assert.equal(s.steadyBest, 31);
  assert.equal(s.offroadT, 5);
  // #716 Did It Myself: stuck at a checkpoint (a Game Over), then no helping hand or shortcut.
  assert.equal(t.snapshot().didItMyself, false, 'never stuck');
  t.stuck = true;
  assert.equal(t.snapshot().didItMyself, true);
  t.frame(1, frame({ helped: true }));
  assert.equal(t.snapshot().didItMyself, false, 'the helping hand or the Royal Shortcut came in');
  // A new ride starts clean.
  t.frame(1, frame({ ref: 'r2' }));
  assert.equal(t.snapshot().offroadT, 0);
});

test('manager: a gust ridden out earns Weathered (the tracker sees the gust start)', async () => {
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.ride.sync('r1');
  m.gust(true);
  assert.equal(m.ride.gustActive, true);
  const earned = m.gust(false);
  assert.ok(earned.some(e => e.id === 'weathered'), 'Weathered is awarded when the gust ends without a crash');
});

test('ride tracker: a gust ridden out, and one that was not', () => {
  const t = new RideTracker();
  t.gust(true);
  assert.equal(t.gust(false), true);
  t.gust(true);
  t.crash({ ref: undefined });
  assert.equal(t.gust(false), false);
});

test('versus: human win, 2v2, close, comeback', () => {
  const human = [{ type: 'keyboard' }, { type: 'gamepad' }];
  const r = versusResult({
    winner: { id: 'A', members: human }, loser: { id: 'B', members: human, distance: 497, speed: 6 },
    raceDistance: 500, halfLeader: 'B',
  });
  assert.deepEqual([r.win, r.twoVtwo, r.close, r.comeback], [true, true, true, true]);
  const bot = versusResult({
    winner: { id: 'B', members: [{ type: 'bot' }] }, loser: { id: 'A', members: [{ type: 'keyboard' }], distance: 300, speed: 5 },
    raceDistance: 500, halfLeader: 'B',
  });
  assert.deepEqual([bot.win, bot.twoVtwo, bot.close, bot.comeback], [false, false, false, false]);
});

test('#608 versus: Underdog (1v2 as the lone rider) and Clean Sweep (no crash)', () => {
  const one = [{ type: 'keyboard' }], two = [{ type: 'keyboard' }, { type: 'gamepad' }];
  const lone = versusResult({ winner: { id: 'A', members: one, crashes: 0 }, loser: { id: 'B', members: two, distance: 300, speed: 5 }, raceDistance: 500 });
  assert.deepEqual([lone.oneVtwo, lone.clean], [true, true]);
  const tandem = versusResult({ winner: { id: 'B', members: two, crashes: 2 }, loser: { id: 'A', members: one, distance: 300, speed: 5 }, raceDistance: 500 });
  assert.deepEqual([tandem.oneVtwo, tandem.clean], [false, false]);
  let L = applyEvent(emptyStats(), 'versus', { ...lone, win: true });
  L = applyEvent(L, 'versus', { win: false, oneVtwo: true, clean: true });   // a loss counts for neither
  assert.equal(L.versus1v2Wins, 1);
  assert.equal(L.versusClean, 1);
  assert.ok(getDefinition('versus_underdog').condition({}, L));
  assert.ok(getDefinition('versus_clean').condition({}, L));
});

test("#608 Rainbow Gold: gold on Grandma's on each of the 7 colours, any difficulty", () => {
  let L = emptyStats();
  const def = getDefinition('rainbow_gold');
  for (const [i, bikeKey] of COLOUR_BIKES.entries()) {
    assert.equal(def.condition({}, L), false);
    L = applyEvent(L, 'finish', { finishedLevel: 'grandma', medal: 'gold', bikeKey, difficulty: i % 2 ? 'daredevil' : 'chill' });
  }
  L = applyEvent(L, 'finish', { finishedLevel: 'daily', medal: 'gold', bikeKey: 'bike_red' });
  assert.deepEqual([...L.grandmaGoldBikes].sort(), [...COLOUR_BIKES].sort());
  assert.ok(def.condition({}, L));
  assert.deepEqual(def.progress(L), [7, 7]);
  // A special bike or a silver doesn't count.
  let L2 = applyEvent(emptyStats(), 'finish', { finishedLevel: 'grandma', medal: 'gold', bikeKey: 'time_warp' });
  L2 = applyEvent(L2, 'finish', { finishedLevel: 'grandma', medal: 'silver', bikeKey: 'bike_red' });
  assert.deepEqual(L2.grandmaGoldBikes, []);
});

test('#608 Full House: a finish in every mode', () => {
  const def = getDefinition('full_house');
  let L = emptyStats();
  L = applyEvent(L, 'finish', { finishedLevel: 'grandma' });
  L = applyEvent(L, 'finish', { finishedLevel: 'daily', isCoop: true, partnerKey: 'p' });
  L = applyEvent(L, 'slingRun', { distance: 300 });
  L = applyEvent(L, 'versus', { win: false });
  assert.equal(def.condition({}, L), false);
  assert.deepEqual(def.progress(L), [5, 6]);
  L = applyEvent(L, 'finish', { finishedLevel: 'grandma', touristFinished: true });
  assert.ok(def.condition({}, L));
  assert.deepEqual(finishModes({ finishedLevel: 'tutorial' }), []);
  // Saves from before the stat existed fill it in.
  const seeded = seedStats(emptyStats(), { records: { 'grandma|chill|solo': { timeMs: 9000 }, 'daily:2026-11-01|chill|coop': { timeMs: 9000 } }, sling: { runs: 2 } });
  assert.deepEqual([...seeded.modesFinished].sort(), ['coop', 'daily', 'grandma', 'slingshot']);
});

test('#608: Lifer is 100 rides, 5K Together is 5 km, Ship of Theseus is 3 rebuilds', () => {
  assert.equal(getDefinition('days_30').condition({}, { ...emptyStats(), rides: 99 }), false);
  assert.ok(getDefinition('days_30').condition({}, { ...emptyStats(), rides: 100 }));
  assert.equal(getDefinition('days_30').unit, undefined, 'Lifer no longer waits for days');
  assert.ok(getDefinition('pair_100km').condition({ pairDistanceKm: 5 }, emptyStats()));
  assert.equal(getDefinition('pair_100km').condition({ pairDistanceKm: 4.9 }, emptyStats()), false);
  assert.ok(getDefinition('ship_of_theseus').condition({}, { ...emptyStats(), rebuilds: 3 }));
});

// ── Slingshot helpers ────────────────────────────────────────────

test('Slingshot: whole trails and the straight shot', () => {
  const course = planCourse(3, 545);
  const items = course.coins.map(c => ({ absoluteD: c.d, lateralOffset: c.offset, collected: false }));
  assert.equal(completedTrails(items), 0);
  for (let i = 0; i < COINS_PER_TRAIL; i++) items[i].collected = true;   // gate 1's fan
  assert.equal(completedTrails(items), 1);
  items[1].collected = false;
  assert.equal(completedTrails(items), 0);
  assert.equal(isStraightShot(320, null), true);
  assert.equal(isStraightShot(320, 310), true);
  assert.equal(isStraightShot(320, 120), false);
  assert.equal(isStraightShot(250, null), false);
});

// ── the manager (fake localStorage) ──────────────────────────────

function fakeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

test('manager: an old save keeps everything earned; v1 stats migrate', async () => {
  globalThis.localStorage = fakeStorage({
    tandemonium_achievements: JSON.stringify([{ id: 'home_sweet', earnedAt: 1 }, { id: 'grandma_red', earnedAt: 2 }]),
    tandemonium_achievement_stats: JSON.stringify({ cumulativeDistance: 600 }),
  });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  // m21: the migration grants what the old distance already deserved.
  assert.deepEqual(m.getEarnedIds().sort(), ['first_500m', 'grandma_red', 'home_sweet']);
  assert.equal(m.getCumulativeDistance(), 600);
  assert.equal(JSON.parse(localStorage.getItem('tandemonium_achievement_stats')).v, STATS_VERSION);
  const got = m.record('coins', { amount: 5 }).map(a => a.id);
  assert.ok(got.includes('coin_first'), got.join(','));
  assert.ok(m.getEarnedIds().includes('grandma_red'));
});

test("#666 manager: a demo guest earns full-game achievements only on a guest pass, held off the demo's Steam", async () => {
  globalThis.localStorage = fakeStorage({});
  const pushed = [];
  globalThis.window = { steam: { activateAchievement: (id) => { pushed.push(id); return Promise.resolve(true); }, storeStats: () => Promise.resolve(true) } };
  try {
    const { AchievementManager } = await import('../../js/achievements.js');
    const m = new AchievementManager();
    m.demo = true;
    const full = ACHIEVEMENTS.find(a => !a.demo);
    const demoOne = ACHIEVEMENTS.find(a => a.demo);
    const orig = [full.condition, demoOne.condition];
    full.condition = () => true; demoOne.condition = () => true;
    try {
      // Solo demo (no guest pass): the full-game one stays shut.
      let got = m.check({}).map(a => a.id);
      assert.ok(got.includes(demoOne.id) && !got.includes(full.id), got.join(','));
      // In a full host's room: earned, and held.
      m.guestPass = true;
      got = m.check({}).map(a => a.id);
      assert.ok(got.includes(full.id), got.join(','));
    } finally { [full.condition, demoOne.condition] = orig; }
    assert.ok(m.getHeldIds().includes(full.id));
    assert.ok(m.getHeldIds().every(id => m.isHeld(id)));
    assert.equal(m.isHeld(demoOne.id), false);
    assert.ok(pushed.includes(demoOne.id.toUpperCase()), 'a demo achievement still goes to Steam');
    assert.ok(!pushed.includes(full.id.toUpperCase()), 'a held one never goes to the demo app');
    pushed.length = 0;
    await m.syncToSteam();
    assert.ok(pushed.includes(demoOne.id.toUpperCase()) && !pushed.includes(full.id.toUpperCase()), pushed.join(','));
    assert.equal(m.getAllDefinitions().find(d => d.id === full.id).held, true);
    // It is kept (saved, and sent to the account by syncToServer, which sends every earned id).
    assert.ok(JSON.parse(localStorage.getItem('tandemonium_achievements')).some(a => a.id === full.id));
    assert.ok(m.getEarnedIds().includes(full.id));
    // The full game, after buying: nothing held, everything goes to Steam.
    const f = new AchievementManager();
    f.demo = false;
    assert.deepEqual(f.getHeldIds(), []);
    pushed.length = 0;
    await f.syncToSteam();
    assert.ok(pushed.includes(full.id.toUpperCase()) && pushed.includes(demoOne.id.toUpperCase()));
  } finally { delete globalThis.window; }
});

test('manager: badge screen — 100 rows, hidden as ???, colours show, progress', async () => {
  globalThis.localStorage = fakeStorage({ tandemonium_achievements: JSON.stringify([{ id: 'grandma_blue', earnedAt: 1 }]) });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  m.record('ride', { mode: 'solo', newRide: true, metres: 50 });
  const defs = m.getAllDefinitions();
  assert.equal(defs.length, 100);
  assert.equal(defs.find(d => d.id === 'grandma_blue').earned, true, 'an earned bike colour shows lit');
  const fs10 = defs.find(d => d.id === 'false_start');
  assert.equal(fs10.name, '???');
  assert.equal(fs10.secret, true);
  assert.deepEqual(defs.find(d => d.id === 'days_7').progress, [1, 7]);
  assert.equal(m.getSections().length, 15);
  m.record('crash', { falseStart: true });
  assert.equal(m.getAllDefinitions().find(d => d.id === 'false_start').name, 'False Start');
});

test('manager: streak badges show the streak held today, not a stale run (m6)', async () => {
  const { dailyKey } = await import('../../js/daily-seed.js');
  const day = (off) => new Date(Date.parse(dailyKey() + 'T00:00:00Z') + off * 86400000).toISOString().slice(0, 10);
  const fin = { practice: 1 };
  // A 2-day run a month ago: the lifetime counter still says 2.
  globalThis.localStorage = fakeStorage({
    tandemonium_achievement_stats: JSON.stringify({ v: STATS_VERSION, dailyDayRun: 2, dailyDayBest: 2, lastDailyDay: day(-30) }),
    tandemonium_daily: JSON.stringify({ [day(-31)]: fin, [day(-30)]: fin }),
  });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  assert.deepEqual(m.getAllDefinitions().find(d => d.id === 'daily_streak_3').progress, [0, 3]);
  // Ridden yesterday and today: 2 days live.
  localStorage.setItem('tandemonium_daily', JSON.stringify({ [day(-1)]: fin, [day(0)]: fin }));
  assert.deepEqual(m.getAllDefinitions().find(d => d.id === 'daily_streak_7').progress, [2, 7]);
});

test('manager: the stoker (and local co-op) ride tracker earns ride-scoped achievements (m7)', async () => {
  globalThis.localStorage = fakeStorage();
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  // The stoker's bike: remote state only (no physics), on the centre strip.
  const rm = { raceDistance: 500 };
  const game = { state: 'playing', raceManager: rm,
    bike: { lean: 0, fallen: false, speed: 8, _lateralOffset: 0.2, onCenterStrip: true, boostTimer: 0 } };
  m.ride.go();
  const ids = [];
  for (let i = 0; i < 62; i++) ids.push(...m.check({ dt: 1, speed: 8, ...m.rideFrame(1, game) }).map(a => a.id));
  assert.ok(ids.includes('steady_hands') && ids.includes('centerline'), ids.join(','));
  // A clean finish: Stayed on the Road and No Trees.
  const clean = m.finish({ ref: rm, finishedLevel: 'daily', crashes: 0, restarts: 0 }).map(a => a.id);
  assert.ok(clean.includes('no_offroad') && clean.includes('no_trees_daily'), clean.join(','));
  // A stoker crash has no cause: it counts as a crash and against No Trees.
  const m2 = new AchievementManager();
  m2.demo = false;
  const rm2 = { raceDistance: 500 };
  m2.rideFrame(1, { ...game, raceManager: rm2 });
  m2.crash('unknown', { ref: rm2, distance: 100, raceDistance: 500 });
  assert.equal(m2.ride.snapshot().treeHits, 1);
  assert.ok(!m2.finish({ ref: rm2, finishedLevel: 'daily', crashes: 1, restarts: 0 }).some(a => a.id === 'no_trees_daily'));
});

// ── m21 · retroactive credit from existing saves ──────────────────

async function synthSaves() {
  const { getMedals } = await import('../../js/race-config.js');
  const gold = getMedals('grandma', 'chill').gold;
  const fin = { practice: 2, partners: ['pal'] };
  return {
    tandemonium_records: JSON.stringify({
      'grandma|chill|solo': { timeMs: gold - 1000, splits: [], date: '2026-09-01' },
      'grandma|chill|coop': { timeMs: gold + 60000, splits: [], date: '2026-09-02' },
      'daily:2026-09-10|chill|solo': { timeMs: 9000000, splits: [], date: '2026-09-10' },
      'junk|x|solo': { nope: 1 },
    }),
    tandemonium_slingshot: JSON.stringify({ v: 3, best: 540, runs: 12, stage: 4, daily: { key: '2026-09-11', best: 300, runs: 2 } }),
    tandemonium_daily: JSON.stringify({ '2026-09-10': fin, '2026-09-11': fin, '2026-09-12': { practice: 1 }, '2026-09-20': { practice: 0 } }),
    tandemonium_wallet: JSON.stringify({ v: 1, coins: 50, earned: 1500, lv: { sling: 10, wheels: 2 }, rebuilds: 0 }),
  };
}

test('stats: seeding from saves raises counters, never lowers them (m21)', async () => {
  const { seedStats } = await import('../../js/achievement-defs.js');
  const saves = Object.fromEntries(Object.entries(await synthSaves()).map(([k, v]) => [k, JSON.parse(v)]));
  const L = seedStats(migrateStats({ cumulativeDistance: 800 }), {
    records: saves.tandemonium_records, sling: saves.tandemonium_slingshot,
    daily: saves.tandemonium_daily, wallet: saves.tandemonium_wallet,
  });
  assert.equal(L.cumulativeDistance, 800);
  assert.equal(L.finishes, 3);
  assert.equal(L.personalBests, 3);
  assert.equal(L.coopFinishes, 1);
  assert.deepEqual(L.golds, ['grandma']);
  assert.equal(L.medalKeys, 1);
  assert.equal(L.slingBest, 540);
  assert.equal(L.slingStage, 3);
  assert.equal(L.slingLaunches, 12);
  assert.deepEqual(L.launchDays, ['2026-09-11']);
  assert.equal(L.rides, 15);
  assert.equal(L.days, 3);                       // 09-20 has no finish
  assert.equal(L.dailyPractice, 5);
  assert.equal(L.dailyDayBest, 3);
  assert.deepEqual(L.partners, ['pal']);
  assert.equal(L.coinsEarned, 1500);
  assert.equal(L.upgrades, 12);
  assert.equal(L.maxedAny, true);
  assert.equal(L.maxedAll, false);
  assert.ok(L.coinsSpent > 1000);
  // Loses nothing: bigger counters and existing lists survive.
  const big = { ...emptyStats(), finishes: 99, slingBest: 2000, coinsEarned: 1e5, days: 40, dayList: ['2026-09-10', '2026-08-01'], golds: ['daily'] };
  const K = seedStats(big, { records: saves.tandemonium_records, sling: saves.tandemonium_slingshot, daily: saves.tandemonium_daily, wallet: saves.tandemonium_wallet });
  assert.equal(K.finishes, 99);
  assert.equal(K.slingBest, 2000);
  assert.equal(K.coinsEarned, 1e5);
  assert.equal(K.days, 42);                      // + 09-11 and 09-12
  assert.deepEqual([...K.golds].sort(), ['daily', 'grandma']);
  assert.ok(K.dayList.includes('2026-08-01'));
  // A rebuilt wallet proves every upgrade was maxed.
  const R = seedStats(emptyStats(), { wallet: { earned: 0, lv: {}, rebuilds: 2 } });
  assert.equal(R.maxedAll, true);
  assert.ok(R.upgrades > 0 && R.coinsSpent > 1000);
  // No saves: nothing changes.
  assert.deepEqual(seedStats(emptyStats(), {}), emptyStats());
});

test('manager: an old player is granted what their saves already prove, once (m21)', async () => {
  globalThis.localStorage = fakeStorage({
    ...(await synthSaves()),
    tandemonium_achievements: JSON.stringify([{ id: 'home_sweet', earnedAt: 1 }]),
    tandemonium_achievement_stats: JSON.stringify({ cumulativeDistance: 1200 }),
  });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  const ids = m.getEarnedIds();
  for (const id of ['home_sweet', 'first_km', 'first_finish', 'new_best', 'medal_key', 'coop_first', 'sling_first',
    'sling_stage1', 'sling_stage3', 'coin_first', 'coins_1000', 'first_upgrade', 'big_spender',
    'rides_10', 'days_3', 'daily_streak_3']) {
    assert.ok(ids.includes(id), `${id} should be granted (${ids.join(',')})`);
  }
  for (const id of ['sling_40', 'all_gold', 'garage_royalty', 'days_7']) assert.ok(!ids.includes(id), `${id} is not proven`);
  const saved = JSON.parse(localStorage.getItem('tandemonium_achievement_stats'));
  assert.equal(saved.v, STATS_VERSION);
  assert.equal(saved.cumulativeDistance, 1200);
  assert.equal(saved.slingBest, 540);
  // Seeding happens on migration only: a v2 save is read as is.
  localStorage.setItem('tandemonium_slingshot', JSON.stringify({ v: 3, best: 900, runs: 40, stage: 6 }));
  const again = new AchievementManager();
  assert.equal(again.getStats().slingBest, 540);
  // A brand-new player with no saves writes nothing.
  globalThis.localStorage = fakeStorage();
  const fresh = new AchievementManager();
  assert.equal(fresh.getEarnedIds().length, 0);
  assert.equal(localStorage.getItem('tandemonium_achievement_stats'), null);
});

test('manager: the demo never awards a full-game-only achievement', async () => {
  globalThis.localStorage = fakeStorage();
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = true;
  const got = m.record('coins', { amount: 20000 }).map(a => a.id);
  // #641: coin_first, coins_1000 and coins_10000 are all full-game only now.
  assert.ok(!got.includes('coin_first'));
  assert.ok(!got.includes('coins_10000'));
  assert.ok(m.getAllDefinitions().find(d => d.id === 'coins_10000').demoLocked);
  m.demo = false;
  const caught = m.record('share').map(a => a.id);
  assert.ok(caught.includes('coins_10000') && caught.includes('coin_first'), 'the full game catches up');
});

test('the Steam sync script describes every achievement', () => {
  const sync = fs.readFileSync(new URL('../../scripts/sync-steam-achievements.js', import.meta.url), 'utf8');
  assert.match(sync, /achievement-defs\.js/);
  for (const a of ACHIEVEMENTS) {
    assert.ok(new RegExp(`\\b${a.id}:`).test(sync), `${a.id} has no Steam description`);
  }
});

// #540 follow-up: a medal is a time, and each difficulty has its own. The medal
// achievements say so, and carry the hint the detail card prints the times from.
test('medal achievements say which time they mean and point the card at it', () => {
  const medal = ACHIEVEMENTS.filter(a => a.medal);
  assert.deepEqual(medal.map(a => a.id).sort(), ['daily_gold', 'grandma_bronze', 'grandma_gold', 'grandma_silver']);
  for (const a of medal) {
    assert.ok(MEDAL_LEVELS.includes(a.medal.level), `${a.id}: medal level ${a.medal.level} awards medals`);
    assert.ok(['bronze', 'silver', 'gold'].includes(a.medal.rank), `${a.id}: a real rank`);
    assert.match(a.desc, new RegExp(`${a.medal.rank} time`), `${a.id}: the description names the ${a.medal.rank} time`);
    assert.match(a.desc, /each difficulty has its own/, `${a.id}: says the time is per difficulty`);
  }
  const allGold = ACHIEVEMENTS.find(a => a.id === 'all_gold');
  assert.match(allGold.desc, /Grandma's and the Daily Ride/, 'Gilded Goose names both timed roads');
  const key = ACHIEVEMENTS.find(a => a.id === 'medal_key');
  assert.match(key.desc, /bronze on Grandma's for stage 4, gold for stage 7/, 'Medal Key names the gates');
});

// ---- #575 · todays_launch → daily_launch -----------------------------------

test('#575: an earned todays_launch moves to daily_launch once, keeping the earlier unlock', () => {
  for (const [from, to] of Object.entries(RENAMED_IDS)) {
    assert.ok(getDefinition(to), `${to} is a current achievement`);
    assert.equal(getDefinition(from), null, `${from} is gone from the list`);
  }
  const old = [
    { id: 'todays_launch', name: "Today's Launch", icon: '🌅', earnedAt: 100 },
    { id: 'launch_week', name: 'Launch Week', icon: '📅', earnedAt: 200 },
  ];
  const m = migrateEarned(old);
  assert.equal(m.changed, true, 'the stored list is rewritten');
  assert.deepEqual(m.list.map(a => a.id), ['daily_launch', 'launch_week']);
  assert.equal(m.list[0].name, 'Daily Launch', 'takes the new name');
  assert.equal(m.list[0].icon, '🌅');
  assert.equal(m.list[0].earnedAt, 100, 'keeps when it was earned');
  assert.deepEqual(m.list[1], old[1], 'other entries are untouched');

  // Already migrated: nothing to write.
  const again = migrateEarned(m.list);
  assert.equal(again.changed, false);
  assert.deepEqual(again.list, m.list);

  // Earned on two devices, under both ids: one row, the earlier unlock wins.
  const both = migrateEarned([{ id: 'daily_launch', earnedAt: 300 }, { id: 'todays_launch', earnedAt: 100 }]);
  assert.equal(both.changed, true);
  assert.equal(both.list.length, 1);
  assert.equal(both.list[0].id, 'daily_launch');
  assert.equal(both.list[0].earnedAt, 100);

  // A fresh or unreadable store.
  assert.deepEqual(migrateEarned(null), { list: [], changed: false });
  assert.deepEqual(migrateEarned([]), { list: [], changed: false });
});
