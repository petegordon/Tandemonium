// #644 step 2 · race a bot ghost team on Solo Flight: the race → the versus result → the versus achievements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BotRace, RACE_CHOICES, RACE_TIERS, SEAT_EMPTY, ghostTeamFor, ghostTeamName, ghostTargetMs, ghostRunFor,
  scaleTrack, ghostLateral, raceableLevel, loadRaceChoice, saveRaceChoice, GHOST_LANE,
} from '../../js/bot-race.js';
import { BOT_GHOST_RUNS } from '../../js/bot-ghost-runs.js';
import { emptyStats, applyEvent, ACHIEVEMENTS, FULL_HOUSE_MODES } from '../../js/achievement-defs.js';
import { getLevelById, getMedals } from '../../js/race-config.js';
import { NO_BOT, loadBotChoice, saveBotChoice } from '../../js/player-bots.js';

const grandma = getLevelById('grandma');
const daily = getLevelById('daily');
const VERSUS = ['versus_first', 'versus_win', 'versus_2v2', 'versus_comeback', 'versus_10', 'versus_underdog', 'versus_clean'];
const ach = id => ACHIEVEMENTS.find(a => a.id === id);
const earned = (L) => VERSUS.filter(id => ach(id).condition({}, L));

function memStore() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

/** A race where the player finishes in `timeMs`; returns the race. */
function ride(race, timeMs, { step = 0.1 } = {}) {
  const T = timeMs / 1000;
  // a quick start (ahead at halfway), at the line on T
  for (let t = 0; t <= T; t += step) race.frame(t, race.raceDistance * Math.sqrt(Math.min(1, t / T)));
  return race;
}

const newRace = (o = {}) => new BotRace({ level: grandma, difficulty: 'adventurous', tier: 'medium', seatBot: 'bolt', runs: BOT_GHOST_RUNS, ...o });

test('the ghost team is the two bots not on your back seat; an empty seat races Bolt and Rivet', () => {
  assert.deepEqual(ghostTeamFor('bolt'), ['rivet', 'sprocket']);
  assert.deepEqual(ghostTeamFor('rivet'), ['bolt', 'sprocket']);
  assert.deepEqual(ghostTeamFor('sprocket'), ['bolt', 'rivet']);
  assert.deepEqual(ghostTeamFor(SEAT_EMPTY), ['bolt', 'rivet']);
  assert.equal(ghostTeamName(['rivet', 'sprocket']), 'Rivet & Sprocket');
});

test('tiers finish on the medal times: Easy = bronze (a warm-up), Medium = silver, Hard = gold (both count)', () => {
  assert.deepEqual(RACE_CHOICES, ['off', 'easy', 'medium', 'hard']);
  for (const diff of ['chill', 'adventurous', 'daredevil']) {
    for (const lv of ['grandma', 'daily']) {
      const m = getMedals(lv, diff);
      assert.equal(ghostTargetMs(lv, diff, 'easy'), m.bronze);
      assert.equal(ghostTargetMs(lv, diff, 'medium'), m.silver);
      assert.equal(ghostTargetMs(lv, diff, 'hard'), m.gold);
      assert.ok(m.gold < m.silver && m.silver < m.bronze, `${lv} ${diff}: hard is faster than medium than easy`);
    }
  }
  assert.equal(RACE_TIERS.easy.counts, false);
  assert.equal(RACE_TIERS.medium.counts, true);
  assert.equal(RACE_TIERS.hard.counts, true);
  assert.equal(ghostTargetMs('tutorial', 'chill', 'hard'), 0, 'no race on the tutorial');
});

test('races run on Grandma\'s and the Daily Ride only', () => {
  assert.ok(raceableLevel(grandma));
  assert.ok(raceableLevel(daily));
  assert.ok(!raceableLevel(getLevelById('tutorial')));
  assert.ok(!raceableLevel({ ...grandma, isTourist: true }));
  assert.ok(!raceableLevel(null));
});

test('the shipped runs: three real rides per road, each a continuous line to the finish', () => {
  for (const lv of [grandma, daily]) {
    const runs = BOT_GHOST_RUNS[lv.id];
    assert.equal(runs.length, 3, lv.id);
    for (const r of runs) {
      assert.equal(r.data.length, r.count * 3);
      let prev = -1;
      for (let i = 0; i < r.count; i++) {
        const d = r.data[i * 3];
        assert.ok(d >= prev - 0.05, `${lv.id}: road distance never goes backwards (a restart would)`);
        prev = d;
      }
      assert.ok(Math.abs(prev - lv.distance) < 2, `${lv.id}: ends at the finish (${prev})`);
      assert.ok(Math.abs(r.count / r.hz - r.recordedMs / 1000) < 0.5, 'one sample every 1/hz s of the ride');
    }
  }
  assert.ok(JSON.stringify(BOT_GHOST_RUNS).length < 60 * 1024, 'small enough to ship in the bundle');
  assert.equal(ghostRunFor(BOT_GHOST_RUNS, 'grandma', 'hard'), BOT_GHOST_RUNS.grandma[2]);
  assert.equal(ghostRunFor(BOT_GHOST_RUNS, 'nowhere', 'easy'), BOT_GHOST_RUNS.grandma[0], 'an unknown road falls back');
});

test('a run is stretched to end at the finish on the target time; its shape is kept', () => {
  const run = BOT_GHOST_RUNS.grandma[1];
  const t = scaleTrack(run, 50000, 250);
  assert.equal(t.count, run.count);
  assert.ok(Math.abs((t.count - 1) / t.hz - 50) < 1e-9);
  assert.ok(Math.abs(t.data[(t.count - 1) * 3] - 250) < 1e-9);
  assert.equal(t.data[1], run.data[1], 'lateral unchanged');
  assert.equal(scaleTrack(null, 1000, 250), null);
  assert.equal(scaleTrack(run, 0, 250), null);
});

test('the ghost rides its own lane, weaving a little, on the road', () => {
  assert.equal(ghostLateral(0), GHOST_LANE);
  assert.ok(ghostLateral(5) <= 2.2 && ghostLateral(-9) >= -2.2);
  const race = newRace();
  const g0 = race.at(0), mid = race.at(race.targetMs / 2000), end = race.at(race.targetMs / 1000 + 1);
  assert.ok(g0.roadD < 1 && !g0.finished);
  assert.ok(mid.roadD > 30 && mid.roadD < 230 && mid.speed > 0);
  assert.ok(end.finished && Math.abs(end.roadD - 250) < 1e-6);
  assert.ok(race.ghostFinished(race.targetMs / 1000) && !race.ghostFinished(race.targetMs / 1000 - 0.1));
});

test('a 2v2 win (a bot on your back seat): Rivals, Crown the Goose, Royal Court, Clean Sweep and the versus mode', () => {
  const race = newRace();
  assert.equal(race.solo, false);
  assert.deepEqual(race.team, ['rivet', 'sprocket']);
  const t = race.targetMs - 3000;
  const r = ride(race, t).result({ timeMs: t, crashes: 0, speed: 7 });
  assert.equal(r.won, true);
  assert.equal(r.win, true);
  assert.equal(r.twoVtwo, true);
  assert.equal(r.oneVtwo, false);
  assert.equal(r.clean, true);
  assert.equal(r.counts, true);
  assert.ok(Math.abs(r.marginMs - 3000) <= 1);
  const L = applyEvent(emptyStats(), 'versus', r, '2026-11-07');
  assert.deepEqual(earned(L), ['versus_first', 'versus_win', 'versus_2v2', 'versus_clean']);
  assert.ok(L.modesFinished.includes('versus') && FULL_HOUSE_MODES.includes('versus'), 'Full House: the versus mode');
});

test('a win riding alone (the back seat empty) is Underdog: one goose beats a two-goose tandem', () => {
  const race = newRace({ seatBot: NO_BOT });
  assert.equal(race.solo, true);
  assert.deepEqual(race.team, ['bolt', 'rivet']);
  const t = race.targetMs - 500;
  const r = ride(race, t).result({ timeMs: t, crashes: 1, speed: 6 });
  assert.equal(r.won, true);
  assert.equal(r.oneVtwo, true);
  assert.equal(r.twoVtwo, false);
  assert.equal(r.clean, false, 'a crash: no Clean Sweep');
  const L = applyEvent(emptyStats(), 'versus', r, '2026-11-07');
  assert.deepEqual(earned(L), ['versus_first', 'versus_win', 'versus_underdog']);
});

test('trailing the ghost at halfway, then winning, is Comeback Geese; leading all the way is not', () => {
  const comeback = newRace();
  const T = comeback.targetMs / 1000 - 1;
  // slow first half (the ghost leads when it crosses halfway), a sprint after
  for (let t = 0; t <= T; t += 0.05) {
    const u = t / T;
    const d = u < 0.6 ? 0.3 * (u / 0.6) : 0.3 + 0.7 * ((u - 0.6) / 0.4);
    comeback.frame(t, 250 * d);
  }
  assert.equal(comeback.halfLeader, 'ghost');
  const r = comeback.result({ timeMs: Math.round(T * 1000), crashes: 0, speed: 9 });
  assert.equal(r.won && r.comeback, true);
  assert.ok(earned(applyEvent(emptyStats(), 'versus', r, '2026-11-07')).includes('versus_comeback'));

  const ahead = newRace();
  const T2 = ahead.targetMs / 1000 - 8;
  for (let t = 0; t <= T2; t += 0.05) ahead.frame(t, 250 * Math.min(1, (t / T2) * 1.05));
  assert.equal(ahead.halfLeader, 'you');
  assert.equal(ahead.result({ timeMs: Math.round(T2 * 1000) }).comeback, false);
});

test('a loss is a finished versus race (Rivals, as on the couch) but no win', () => {
  const race = newRace();
  const t = race.targetMs + 2000;
  const r = ride(race, t).result({ timeMs: t, crashes: 0 });
  assert.equal(r.won, false);
  assert.equal(r.win, false);
  assert.ok(Math.abs(r.marginMs - 2000) <= 1);
  const L = applyEvent(emptyStats(), 'versus', r, '2026-11-07');
  assert.equal(L.versusRaces, 1);
  assert.equal(L.versusWins, 0);
  assert.deepEqual(earned(L), ['versus_first']);
  // a dead heat goes to the ghost
  assert.equal(newRace().result({ timeMs: newRace().targetMs }).won, false);
});

test('ten wins is House Champion', () => {
  let L = emptyStats();
  for (let i = 0; i < 10; i++) {
    const race = newRace({ tier: i % 2 ? 'hard' : 'medium' });
    L = applyEvent(L, 'versus', ride(race, race.targetMs - 100).result({ timeMs: race.targetMs - 100 }), '2026-11-07');
    assert.equal(ach('versus_10').condition({}, L), i === 9);
  }
});

test('Easy is a warm-up: its result does not count as a versus race', () => {
  const race = newRace({ tier: 'easy' });
  const r = ride(race, race.targetMs - 1000).result({ timeMs: race.targetMs - 1000 });
  assert.equal(r.won, true);
  assert.equal(r.counts, false);   // the game records no versus event for it
});

test('the race and the back seat are saved per device; "Nobody" is a back seat choice', () => {
  const s = memStore();
  assert.equal(loadRaceChoice(s), 'off');
  assert.equal(saveRaceChoice(s, 'hard'), 'hard');
  assert.equal(loadRaceChoice(s), 'hard');
  saveRaceChoice(s, 'nonsense');
  assert.equal(loadRaceChoice(s), 'off');
  assert.equal(saveBotChoice(s, NO_BOT), NO_BOT);
  assert.equal(loadBotChoice(s), NO_BOT);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadRaceChoice(broken), 'off');
});
