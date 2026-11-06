// #512 · Tandem Tokens on the road: where the runs go.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planTokenRuns, runsFor, choiceKinds, flocksFrom, runLength, maxTokenPay,
  KIND, CHOICE_KINDS, TOKEN_VALUE, DOUBLE_VALUE, TOKENS_PER_RUN, TOKEN_SPACING, ARC_SPACING,
  MAX_OFFSET, START_CLEAR, FINISH_CLEAR, CLEARANCE, WINDOW, CHECKPOINT_CLEAR, LANE, EDGE_LANE,
} from '../../js/token-runs.js';
import { clashes } from '../../js/token-runs.js';
import { itemSeed, deriveSeed, seedFromKey, SALT } from '../../js/daily-seed.js';

// A road the way the managers lay it out: presents every ~20 m at ±2, pylons
// every ~25 m at ±1.5, goose flocks of 3-8 on the verge (3.3-7 m) every 16-46 m.
function makeRng(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
function road(distance, seed, { presentSpacing = 20, pylonSpacing = 25 } = {}) {
  const rng = makeRng(seed);
  const presents = [], obstacles = [], geese = [];
  for (let d = presentSpacing; d < distance - 20; d += presentSpacing + rng() * presentSpacing * 0.5) presents.push({ d, offset: (rng() - 0.5) * 4 });
  for (let d = pylonSpacing * 1.5; d < distance - 50; d += pylonSpacing + rng() * pylonSpacing * 0.4) obstacles.push({ d, offset: (rng() - 0.5) * 3 });
  for (let d = 40; d < distance - 40; d += 16 + rng() * 30) {
    const side = rng() < 0.5 ? -1 : 1, n = 3 + Math.floor(rng() * 6);
    for (let k = 0; k < n; k++) geese.push({ d: d + rng() * 7, offset: side * (3.3 + rng() * 3.7) });
  }
  return { presents, obstacles, geese };
}
const checkpointsOf = (distance, interval) => { const c = []; for (let d = interval; d < distance; d += interval) c.push(d); return c; };
const LEVELS = {
  tutorial: { distance: 150, interval: 150 },
  grandma: { distance: 250, interval: 62 },
  daily: { distance: 500, interval: 125 },
};
function plan(levelId, seed, extra = {}) {
  const L = LEVELS[levelId];
  return planTokenRuns({ levelId, distance: L.distance, seed, ...road(L.distance, seed + 7), checkpoints: checkpointsOf(L.distance, L.interval), ...extra });
}
const inWindow = (it, r) => it.d >= r.start - WINDOW && it.d <= r.end + WINDOW;

test('runs per road: tutorial 1, Grandma\'s 4, Daily Ride 8; a token is worth 5, the late run 10', () => {
  assert.equal(runsFor('tutorial', 150), 1);
  assert.equal(runsFor('grandma', 250), 4);
  assert.equal(runsFor('daily', 500), 8);
  assert.equal(runsFor('somewhere', 1000), 16, 'an unknown road: about one run per 60 m');
  assert.equal(runsFor('somewhere', 40), 0, 'too short for a run');
  assert.equal(TOKEN_VALUE, 5);
  assert.equal(DOUBLE_VALUE, 10);
  assert.equal(TOKENS_PER_RUN, 5);
  for (const id of ['tutorial', 'grandma', 'daily']) {
    const p = plan(id, 1234);
    assert.equal(p.runs.length, runsFor(id, LEVELS[id].distance), id);
    assert.equal(p.available, p.runs.length * TOKENS_PER_RUN);
    assert.equal(p.tokens.length, p.available);
  }
  assert.equal(plan('tutorial', 1).maxPay, 25);
  assert.equal(plan('grandma', 1).maxPay, 3 * 25 + 50, 'Grandma\'s: 3 runs at 5 and the double run');
  assert.equal(plan('daily', 1).maxPay, 7 * 25 + 50);
});

test('the same seed lays the same runs; another seed moves them', () => {
  const a = plan('daily', 99), b = plan('daily', 99), c = plan('daily', 100);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.tokens.map(t => t.d), c.tokens.map(t => t.d));
  // The Daily Ride's seed comes from the day key through daily-seed.js, with its own salt.
  const level = { id: 'daily', seed: seedFromKey('2026-11-04') };
  assert.equal(itemSeed(level, SALT.tokens, 0, 1), deriveSeed(level.seed, SALT.tokens));
  assert.notEqual(itemSeed(level, SALT.tokens, 0, 1), itemSeed(level, SALT.collectibles, 0, 1), 'tokens do not move with the presents');
  assert.equal(SALT.tokens, 10);
});

test('about half the runs are choices: the last is the double run near the finish, the rest a mix', () => {
  const rng = () => 0.5;
  assert.deepEqual(choiceKinds(1, rng), [], 'the tutorial run is a free one that teaches the pickup');
  for (const n of [4, 8]) {
    const kinds = choiceKinds(n, makeRng(n));
    assert.equal(kinds.length, Math.floor(n / 2));
    assert.equal(kinds[0], KIND.DOUBLE);
    assert.equal(kinds.filter(k => k === KIND.DOUBLE).length, 1);
  }
  for (const k of CHOICE_KINDS) assert.ok(choiceKinds(8, makeRng(42)).includes(k), `8 runs include a ${k} run`);
  for (let seed = 1; seed < 40; seed++) {
    const p = plan('daily', seed);
    const dbl = p.runs[p.runs.length - 1];
    assert.equal(dbl.kind, KIND.DOUBLE);
    assert.ok(dbl.end >= 500 - FINISH_CLEAR - 40, `double run near the finish (ends ${dbl.end})`);
    assert.ok(dbl.tokens.every(t => t.value === DOUBLE_VALUE));
    assert.ok(p.runs.slice(0, -1).every(r => r.tokens.every(t => t.value === TOKEN_VALUE)));
    assert.ok(p.runs.filter(r => r.kind !== KIND.FREE).length <= 4);
    assert.ok(p.runs.filter(r => r.kind === KIND.FREE).length >= 4, 'at least half the runs are free');
  }
});

test('every token is inside the road, clear of the start, the finish and the checkpoint gates', () => {
  for (const id of ['tutorial', 'grandma', 'daily']) {
    for (let seed = 1; seed < 60; seed++) {
      const p = plan(id, seed);
      const cps = checkpointsOf(LEVELS[id].distance, LEVELS[id].interval);
      for (const t of p.tokens) {
        assert.ok(Math.abs(t.offset) <= MAX_OFFSET + 1e-9, `${id} seed ${seed}: offset ${t.offset}`);
        assert.ok(t.d >= START_CLEAR && t.d <= LEVELS[id].distance - FINISH_CLEAR, `${id} seed ${seed}: d ${t.d}`);
      }
      for (const r of p.runs) {
        assert.equal(r.tokens.length, TOKENS_PER_RUN);
        const spacing = r.kind === KIND.ARC ? ARC_SPACING : TOKEN_SPACING;
        for (let k = 1; k < r.tokens.length; k++) assert.ok(Math.abs(r.tokens[k].d - r.tokens[k - 1].d - spacing) < 1e-9);
        assert.ok(!cps.some(c => c > r.start - CHECKPOINT_CLEAR && c < r.end + CHECKPOINT_CLEAR), `${id} seed ${seed}: ${r.kind} run ${r.start}-${r.end} on a checkpoint`);
      }
      // Runs never overlap each other.
      const sorted = p.runs.slice().sort((a, b) => a.start - b.start);
      for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k].start > sorted[k - 1].end, `${id} seed ${seed}: runs overlap`);
    }
  }
});

test('choice runs never sit on a present or a pylon: tokens-or-present keeps the present in the other lane', () => {
  let presentRuns = 0, gooseRuns = 0, arcRuns = 0;
  for (let seed = 1; seed < 120; seed++) {
    const L = LEVELS.daily, r0 = road(L.distance, seed + 7);
    const p = planTokenRuns({ levelId: 'daily', distance: L.distance, seed, ...r0, checkpoints: checkpointsOf(L.distance, L.interval) });
    for (const r of p.runs) {
      if (r.kind === KIND.FREE) continue;
      const items = [...r0.presents, ...r0.obstacles].filter(it => inWindow(it, r));
      if (r.kind === KIND.PRESENT) {
        presentRuns++;
        const pres = r0.presents.find(it => it.d === r.present.d && it.offset === r.present.offset);
        assert.equal(clashes([...r0.presents, ...r0.obstacles], r.tokens, pres), 0, `seed ${seed}: something else on the tokens`);
        assert.ok(r.present, 'a tokens-or-present run names its present');
        assert.ok(Math.abs(r.present.offset) >= 1 && Math.sign(r.present.offset) !== Math.sign(r.lane), `seed ${seed}: present at ${r.present.offset}, tokens at ${r.lane}`);
        assert.ok(Math.abs(r.present.offset - r.lane) >= 2.5, 'a bike on the tokens cannot reach the present (collect radius 2 m)');
        assert.ok(Math.abs(r.present.d - (r.start + r.end) / 2) < 0.01, 'the present sits level with the middle token');
        const others = items.filter(it => !(it.d === r.present.d && it.offset === r.present.offset));
        assert.ok(others.every(it => Math.abs(it.offset - r.lane) >= CLEARANCE), `seed ${seed}: something else in the token lane`);
      } else if (r.kind === KIND.ARC) {
        arcRuns++;
        assert.equal(clashes(items, r.tokens), 0, `seed ${seed}: nothing sits on the arc's tokens`);
        const offs = r.tokens.map(t => t.offset);
        assert.equal(offs[0], 0); assert.equal(offs[4], 0);
        assert.ok(Math.abs(Math.abs(offs[2]) - LANE) < 1e-9, 'the arc reaches a full lane at its middle');
        assert.ok(Math.abs(offs[1]) > 0.5 && Math.abs(offs[1]) < LANE);
      } else {
        if (r.kind === KIND.GOOSE) {
          gooseRuns++;
          assert.ok(Math.abs(Math.abs(r.lane) - EDGE_LANE) < 1e-9, 'a goose run hugs the road edge');
          const flock = r0.geese.filter(g => g.d >= r.start - 4 && g.d <= r.end + 4 && Math.sign(g.offset) === Math.sign(r.lane));
          assert.ok(flock.length >= 3, `seed ${seed}: a goose run runs beside a flock (${flock.length} geese)`);
        }
        assert.ok(items.every(it => Math.abs(it.offset - r.lane) >= CLEARANCE), `seed ${seed}: ${r.kind} run has something in its lane`);
        assert.equal(clashes(items, r.tokens), 0);
      }
    }
  }
  assert.ok(presentRuns > 60 && gooseRuns > 60 && arcRuns > 60, `the choice kinds all get placed (${presentRuns}/${gooseRuns}/${arcRuns})`);
});

test('a road with no presents or geese still lays every run (the choice falls back to a free run)', () => {
  const p = planTokenRuns({ levelId: 'daily', distance: 500, seed: 5 });
  assert.equal(p.runs.length, 8);
  assert.ok(!p.runs.some(r => r.kind === KIND.PRESENT || r.kind === KIND.GOOSE));
  assert.equal(p.runs[7].kind, KIND.DOUBLE);
  assert.deepEqual(planTokenRuns({}), { runs: [], tokens: [], available: 0, maxPay: 0 });
  assert.equal(planTokenRuns({ levelId: 'tourist', distance: 30, seed: 1 }).runs.length, 0);
});

test('the tutorial\'s one run is free, straight down the middle of the phase-2 runway, clear of its presents and pylons', () => {
  // js/game.js · TUTORIAL_ITEMS
  const presents = [{ d: 38, offset: 1 }, { d: 53, offset: 1 }, { d: 68, offset: -1 }, { d: 78, offset: -1 },
                    { d: 105, offset: 1.8 }, { d: 120, offset: -1.8 }, { d: 135, offset: 1.8 }];
  const obstacles = [{ d: 112, offset: -1 }, { d: 127, offset: 1 }, { d: 142, offset: -1 }];
  const p = planTokenRuns({ levelId: 'tutorial', distance: 150, seed: 7, presents, obstacles, checkpoints: [] });
  assert.equal(p.runs.length, 1);
  const r = p.runs[0];
  assert.equal(r.kind, KIND.FREE);
  const items = [...presents, ...obstacles].filter(it => inWindow(it, r));
  assert.ok(items.every(it => Math.abs(it.offset - r.lane) >= CLEARANCE), `run ${r.start}-${r.end} lane ${r.lane} clashes`);
});

test('flocks: geese within 10 m on the same verge are one flock', () => {
  const f = flocksFrom([{ d: 50, offset: 4 }, { d: 53, offset: 5 }, { d: 57, offset: 3.5 }, { d: 90, offset: -4 }, { d: 95, offset: -6 }, { d: 140, offset: 4 }]);
  assert.deepEqual(f, [{ start: 50, end: 57, side: 1 }, { start: 90, end: 95, side: -1 }, { start: 140, end: 140, side: 1 }]);
  assert.equal(runLength(KIND.FREE), 12);
  assert.equal(runLength(KIND.ARC), 16);
  assert.equal(maxTokenPay([]), 0);
});
