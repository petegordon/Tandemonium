// VERSUS BOTS: the rival team, the pace, and the versus result → the versus achievements.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RACE_CHOICES, RACE_TIERS, SEAT_EMPTY, botTeamFor, botTeamName, botTargetMs, raceableLevel, loadRaceChoice, saveRaceChoice,
} from '../../js/bot-race.js';
import { botPush, botWantSpeed, BOT_MAX_PUSH } from '../../js/versus/bot-pace.js';
import { emptyStats, applyEvent, versusResult, ACHIEVEMENTS, FULL_HOUSE_MODES } from '../../js/achievement-defs.js';
import { getLevelById, getMedals } from '../../js/race-config.js';
import { NO_BOT, loadBotChoice, saveBotChoice } from '../../js/player-bots.js';

const VERSUS = ['versus_first', 'versus_win', 'versus_2v2', 'versus_comeback', 'versus_10', 'versus_underdog', 'versus_clean'];
const ach = id => ACHIEVEMENTS.find(a => a.id === id);
const earned = (L) => VERSUS.filter(id => ach(id).condition({}, L));
const day = '2026-11-21';

function memStore() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const you = (bot = true, crashes = 0) => ({ id: 'A', members: bot ? [{ type: 'keyboard' }, { type: 'bot' }] : [{ type: 'keyboard' }],
  distance: 250, speed: 7, crashes });
const bots = (distance = 200) => ({ id: 'B', members: [{ type: 'bot' }, { type: 'bot' }], distance, speed: 5, crashes: 0 });

test('the rival team is the two bots not on your back seat; an empty seat races Bolt and Rivet', () => {
  assert.deepEqual(botTeamFor('bolt'), ['rivet', 'sprocket']);
  assert.deepEqual(botTeamFor('rivet'), ['bolt', 'sprocket']);
  assert.deepEqual(botTeamFor('sprocket'), ['bolt', 'rivet']);
  assert.deepEqual(botTeamFor(SEAT_EMPTY), ['bolt', 'rivet']);
  assert.equal(botTeamName(['rivet', 'sprocket']), 'Rivet & Sprocket');
});

test('tiers finish on the medal times: Easy = bronze, Medium = silver, Hard = gold', () => {
  assert.deepEqual(RACE_CHOICES, ['off', 'easy', 'medium', 'hard']);
  assert.deepEqual(Object.keys(RACE_TIERS), ['easy', 'medium', 'hard']);
  for (const diff of ['chill', 'adventurous', 'daredevil']) {
    for (const lv of ['grandma', 'daily']) {
      const m = getMedals(lv, diff);
      assert.equal(botTargetMs(lv, diff, 'easy'), m.bronze);
      assert.equal(botTargetMs(lv, diff, 'medium'), m.silver);
      assert.equal(botTargetMs(lv, diff, 'hard'), m.gold);
    }
  }
});

test('races run on Grandma\'s and the Daily Ride only', () => {
  assert.equal(raceableLevel(getLevelById('grandma')), true);
  assert.equal(raceableLevel(getLevelById('daily')), true);
  assert.equal(raceableLevel(getLevelById('tutorial')), false);
});

test('the pace: behind schedule pushes harder, ahead eases off, and it never stops short of the line', () => {
  const at = { elapsedMs: 30000, targetMs: 60000, raceDistance: 250 };
  assert.ok(botWantSpeed({ ...at, distance: 50 }) > botWantSpeed({ ...at, distance: 200 }));
  assert.ok(botWantSpeed({ ...at, elapsedMs: 59990, distance: 249.9 }) >= 3);
  assert.equal(botPush({ ...at, distance: 240, speed: 12, dt: 1 / 60 }), 0);
  assert.ok(botPush({ ...at, distance: 0, speed: 0, dt: 1 / 60 }) <= BOT_MAX_PUSH / 60);
});

test('a 2v2 win: Rivals, Crown the Goose, Royal Court, Clean Sweep and the versus mode', () => {
  const r = versusResult({ winner: you(), loser: bots(), raceDistance: 250, halfLeader: 'A' });
  const L = applyEvent(emptyStats(), 'versus', r, day);
  assert.deepEqual(earned(L), ['versus_first', 'versus_win', 'versus_2v2', 'versus_clean']);
  assert.ok(L.modesFinished.includes('versus') && FULL_HOUSE_MODES.includes('versus'));
});

test('a win alone is Underdog; from behind at halfway is Comeback Geese; a crash is no Clean Sweep', () => {
  const r = versusResult({ winner: you(false, 1), loser: bots(), raceDistance: 250, halfLeader: 'B' });
  const L = applyEvent(emptyStats(), 'versus', r, day);
  assert.deepEqual(earned(L), ['versus_first', 'versus_win', 'versus_comeback', 'versus_underdog']);
});

test('a loss is a finished versus race (Rivals) but no win', () => {
  const r = versusResult({ winner: { ...bots(250) }, loser: { ...you(), distance: 200 }, raceDistance: 250, halfLeader: 'B' });
  const L = applyEvent(emptyStats(), 'versus', r, day);
  assert.equal(L.versusRaces, 1);
  assert.equal(L.versusWins, 0);
  assert.deepEqual(earned(L), ['versus_first']);
});

test('ten Medium or Hard wins is House Champion; ten Easy wins earn the rest but not it', () => {
  const win = versusResult({ winner: you(), loser: bots(), raceDistance: 250, halfLeader: 'A' });
  let hard = emptyStats(), easy = emptyStats();
  for (let i = 0; i < 10; i++) {
    hard = applyEvent(hard, 'versus', win, day);
    assert.equal(ach('versus_10').condition({}, hard), i === 9);
    easy = applyEvent(easy, 'versus', { ...win, easy: true }, day);
  }
  assert.equal(easy.versusWins, 10);
  assert.equal(easy.versusEasyWins, 10);
  assert.equal(ach('versus_win').condition({}, easy), true);
  assert.equal(ach('versus_2v2').condition({}, easy), true);
  assert.equal(ach('versus_clean').condition({}, easy), true);
  assert.equal(ach('versus_10').condition({}, easy), false);
  assert.deepEqual(ach('versus_10').progress(easy), [0, 10]);
});

test('a bot on your back seat counts as a co-op partner', () => {
  let L = emptyStats();
  for (const p of ['bot:bolt', 'bot:rivet', 'bot:sprocket', 'bot:bolt']) L = applyEvent(L, 'botPartner', { partnerKey: p }, day);
  assert.equal(L.coopFinishes, 4);
  assert.deepEqual(L.partners, ['bot:bolt', 'bot:rivet', 'bot:sprocket']);
  assert.ok(L.modesFinished.includes('coop'));
  assert.equal(ach('social_goose').condition({}, L), true);
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
});
