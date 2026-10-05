// #401 · the 100 achievements: the list, the stats, the rules, the demo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ACHIEVEMENTS, RETIRED_IDS, SECTIONS, DEMO_UNEARNABLE, MEDAL_LEVELS,
  emptyStats, migrateStats, applyEvent, RideTracker, versusResult, opensMedalGate,
  STATS_VERSION, stageForDistance,
} from '../../js/achievement-defs.js';
import { DEMO_RULES, FULL_RULES } from '../../js/edition.js';
import { completedTrails, isStraightShot, COINS_PER_TRAIL, planCourse } from '../../js/slingshot.js';

// The 23 achievements on main before #401 — their ids (Steam API names) must not change.
const EXISTING = [
  'first_500m', 'first_km', 'five_k', 'speed_demon', 'perfect_sync', 'collector', 'hoarder',
  'home_sweet', 'grandma_default', 'grandma_orange', 'grandma_magenta', 'grandma_red',
  'grandma_blue', 'grandma_green', 'grandma_yellow', 'perfect_1k', 'team_player',
  'daily_first', 'daily_streak_7', 'daily_streak_30', 'pair_10_rides', 'pair_100km',
  'distance_between_us',
];

// The spec's Demo column "—" (issue #401), plus sling_stage5: the spec marks it
// ✓, but the demo's Slingshot stops at stage 3 (DEMO_RULES.slingshot.maxStage),
// so the edition rules win. double_down (m4): a stage-mode jackpot run ends
// at ~118 m, short of any stage-2+ best, so only Today's Launch can earn it.
const SPEC_FULL_ONLY = [
  'sling_stage5', 'double_down',
  'century', 'days_30', 'all_gold', 'sling_stage7', 'sling_1000', 'todays_launch', 'launch_week',
  'coins_10000', 'max_upgrade', 'garage_royalty', 'rebuilt', 'ship_of_theseus', 'daily_first',
  'daily_streak_30', 'pair_100km', 'standing_date', 'distance_between_us', 'grand_tour',
];

// Rows per section, in the spec's order.
const SPEC_SECTIONS = { first: 7, distance: 7, back: 4, medals: 9, clean: 6, speed: 4, collect: 4, sling: 16,
  coins: 10, daily: 6, together: 7, versus: 6, chaos: 5, explore: 2, retired: 7 };

test('exactly 100 achievements, unique ids, 93 visible + 7 retired', () => {
  assert.equal(ACHIEVEMENTS.length, 100);
  assert.equal(new Set(ACHIEVEMENTS.map(a => a.id)).size, 100);
  const visible = ACHIEVEMENTS.filter(a => !RETIRED_IDS.has(a.id));
  assert.equal(visible.length, 93);
  assert.equal(RETIRED_IDS.size, 7);
  for (const id of RETIRED_IDS) {
    assert.match(id, /^grandma_/);
    assert.ok(ACHIEVEMENTS.some(a => a.id === id), `${id} must stay defined`);
  }
});

test('the 23 existing ids are kept unchanged (77 new)', () => {
  const ids = new Set(ACHIEVEMENTS.map(a => a.id));
  for (const id of EXISTING) assert.ok(ids.has(id), `${id} is missing`);
  assert.equal(ACHIEVEMENTS.filter(a => !EXISTING.includes(a.id)).length, 77);
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
  return L;
}

const finishBase = { collectibles: 12, totalCollectibles: 12, crashes: 1, restarts: 0, medal: 'gold',
  newBest: true, difficulty: 'adventurous', offroadT: 0, treeHits: 0, assistDeclined: true,
  dailyRanked: true, dailyStreak: 30, pairRides: 10, pairDistanceKm: 100, pairWeekStreak: 4,
  touristFinished: true, isMultiplayer: true, safePct: 90 };
const CANDIDATES = [
  {},                                                        // an event: lifetime stats only
  { speed: 19, offsetScore: 0.95, syncDuration: 12, steadyBest: 61, stripBest: 31, boostBest: 11,
    collectibles: 12, totalCollectibles: 12, isMultiplayer: true, safePct: 85 },   // a ride frame
  { ...finishBase, finishedLevel: 'daily' },
  { ...finishBase, finishedLevel: 'grandma', crashes: 0, bikeKey: 'default' },
  { ...finishBase, finishedLevel: 'grandma', difficulty: 'daredevil' },
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

test('the demo-unearnable list is the spec Demo column + the stage cap (20 full-only, 80 demo)', () => {
  assert.deepEqual([...DEMO_UNEARNABLE].sort(), [...SPEC_FULL_ONLY].sort());
  assert.equal(ACHIEVEMENTS.filter(a => a.demo).length, 80);
});

test('each full-only reason matches the edition rules', () => {
  for (const a of ACHIEVEMENTS.filter(x => !x.demo)) {
    switch (a.full) {
      case 'tourist': assert.equal(DEMO_RULES.tourist, false); assert.equal(FULL_RULES.tourist, true); break;
      case 'ranked': assert.equal(DEMO_RULES.ranked, false); assert.equal(FULL_RULES.ranked, true); break;
      case 'todaysLaunch': assert.equal(DEMO_RULES.isDemo, true); break;   // slingshot-mode · _todaysLaunchOn
      case 'slingStage':
        assert.ok(a.stage > DEMO_RULES.slingshot.maxStage, `${a.id}: stage ${a.stage} is inside the demo`);
        assert.equal(FULL_RULES.slingshot.maxStage, null);
        break;
      case 'scope': break;   // a long-haul goal the spec keeps for the full game
      default: assert.fail(`${a.id} has no reason to be full-only (${a.full})`);
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

test("stats: Today's Road day streak and medal keys", () => {
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
  L = applyEvent(L, 'todaysLaunch', { key: '2026-10-04' });
  L = applyEvent(L, 'todaysLaunch', { key: '2026-10-04' });
  L = applyEvent(L, 'stageCleared', { stage: 3 });
  L = applyEvent(L, 'slingRun', { distance: 130, jackpot: true, record: true, fullTrails: 2, straight: false });
  assert.equal(L.coinsEarned, 120);
  assert.equal(L.coinsSpent, 940);
  assert.equal(L.upgrades, 2);
  assert.equal(L.maxedAny, true);
  assert.equal(L.maxedAll, true);
  assert.equal(L.rebuilds, 2);
  assert.deepEqual(L.launchDays, ['2026-10-04']);
  assert.equal(L.slingStage, 3);
  assert.equal(L.doubleDowns, 1);
  assert.equal(L.fullTrails, 2);
  assert.equal(L.straightShots, 0);
});

// ── the ride tracker ─────────────────────────────────────────────

const frame = (over = {}) => ({ ref: 'r1', playing: true, fallen: false, speed: 6, lateralOffset: 0,
  onCenterStrip: false, boosting: false, shaking: false, assistOn: false, ...over });

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

test('ride tracker: off-road, centre strip, boost chain, steady hands, assist', () => {
  const t = new RideTracker();
  for (let i = 0; i < 31; i++) t.frame(1, frame({ onCenterStrip: true, boosting: i < 11 }));
  t.frame(1, frame({ shaking: true }));
  for (let i = 0; i < 5; i++) t.frame(1, frame({ lateralOffset: 3 }));
  const s = t.snapshot();
  assert.equal(s.stripBest, 31);
  assert.equal(s.boostBest, 11);
  assert.equal(s.steadyBest, 31);
  assert.equal(s.offroadT, 5);
  t.assistOffered = true;
  assert.equal(t.snapshot().assistDeclined, true);
  t.frame(1, frame({ assistOn: true }));
  assert.equal(t.snapshot().assistDeclined, false);
  // A new ride starts clean.
  t.frame(1, frame({ ref: 'r2' }));
  assert.equal(t.snapshot().offroadT, 0);
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
  assert.deepEqual(m.getEarnedIds().sort(), ['grandma_red', 'home_sweet']);
  assert.equal(m.getCumulativeDistance(), 600);
  assert.equal(JSON.parse(localStorage.getItem('tandemonium_achievement_stats')).v, STATS_VERSION);
  // The next event earns what the old distance already deserved.
  const got = m.record('coins', { amount: 5 }).map(a => a.id);
  assert.ok(got.includes('first_500m') && got.includes('coin_first'), got.join(','));
  assert.ok(m.getEarnedIds().includes('grandma_red'));
});

test('manager: badge screen — 93 rows, hidden as ???, retired never, progress', async () => {
  globalThis.localStorage = fakeStorage({ tandemonium_achievements: JSON.stringify([{ id: 'grandma_blue', earnedAt: 1 }]) });
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = false;
  m.record('ride', { mode: 'solo', newRide: true, metres: 50 });
  const defs = m.getAllDefinitions();
  assert.equal(defs.length, 93);
  assert.ok(!defs.some(d => RETIRED_IDS.has(d.id)), 'retired never show, even when earned');
  const fs10 = defs.find(d => d.id === 'false_start');
  assert.equal(fs10.name, '???');
  assert.equal(fs10.secret, true);
  assert.deepEqual(defs.find(d => d.id === 'days_7').progress, [1, 7]);
  assert.equal(m.getSections().length, 14);
  m.record('crash', { falseStart: true });
  assert.equal(m.getAllDefinitions().find(d => d.id === 'false_start').name, 'False Start');
});

test('manager: the demo never awards a full-game-only achievement', async () => {
  globalThis.localStorage = fakeStorage();
  const { AchievementManager } = await import('../../js/achievements.js');
  const m = new AchievementManager();
  m.demo = true;
  const got = m.record('coins', { amount: 20000 }).map(a => a.id);
  assert.ok(got.includes('coins_1000'));
  assert.ok(!got.includes('coins_10000'));
  assert.ok(m.getAllDefinitions().find(d => d.id === 'coins_10000').demoLocked);
  m.demo = false;
  assert.ok(m.record('share').map(a => a.id).includes('coins_10000'), 'the full game catches up');
});

test('the Steam sync script describes every achievement', () => {
  const sync = fs.readFileSync(new URL('../../scripts/sync-steam-achievements.js', import.meta.url), 'utf8');
  assert.match(sync, /achievement-defs\.js/);
  for (const a of ACHIEVEMENTS) {
    assert.ok(new RegExp(`\\b${a.id}:`).test(sync), `${a.id} has no Steam description`);
  }
});
