// #644 · player bots on Solo Flight: three named bots, each its own partner (partner keys, local pair stats),
// the bot's sync (the player's own steadiness), its colours, the unlock gate and the Penny-Farthing clip packs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BOTS, BOT_IDS, DEFAULT_BOT, botPartnerKey, isBotPartnerKey, normalizeBot, botStokerLook, loadBotChoice, saveBotChoice,
  botPairStats, recordBotRide, BotSync, botMaterialRole, tintBot, untintBot, BOT_PAIRS_KEY,
} from '../../js/player-bots.js';
import { ACHIEVEMENTS, emptyStats, applyEvent } from '../../js/achievement-defs.js';
import { playerBotsProgress, soloAchievementIds } from '../../js/rewards.js';
import { resolveRider } from '../../js/goose-outfits.js';
import { pfClipPackFor, pfClipPacks, pfPedalTime, turnTime } from '../../js/goose-rider-clips.js';

/** A localStorage stand-in. */
function memStore() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

const def = id => ACHIEVEMENTS.find(a => a.id === id);

test('three named bots, each its own partner key', () => {
  assert.deepEqual(BOT_IDS, ['bolt', 'rivet', 'sprocket']);
  assert.deepEqual(BOT_IDS.map(id => BOTS[id].name), ['Bolt', 'Rivet', 'Sprocket']);
  assert.equal(new Set(BOT_IDS.map(id => BOTS[id].color)).size, 3, 'each in its own colour');
  assert.deepEqual(BOT_IDS.map(botPartnerKey), ['bot:bolt', 'bot:rivet', 'bot:sprocket']);
  assert.ok(BOT_IDS.every(id => isBotPartnerKey(botPartnerKey(id))));
  for (const k of ['local:p2', 'name:Pete', '42', 'bot:', 'bot:robo', null, undefined]) assert.ok(!isBotPartnerKey(k), String(k));
  assert.equal(normalizeBot('nope'), DEFAULT_BOT);
  assert.equal(botPartnerKey('nope'), 'bot:bolt');
});

test('each bot rides the back seat as a robot goose (the robot rider files exist for both bodies)', () => {
  for (const id of BOT_IDS) {
    const look = botStokerLook(id);
    assert.equal(look.outfit, 'robot');
    const r = resolveRider('Stoker', look.outfit, look.body, () => {});
    assert.ok(!r.fallback && fs.existsSync(r.path), r.path);
    assert.ok(/robot/.test(r.path));
  }
  assert.notEqual(botStokerLook('bolt').body, botStokerLook('rivet').body, 'a gander and a lady among them');
});

test('the bot choice is saved per device', () => {
  const s = memStore();
  assert.equal(loadBotChoice(s), 'bolt');
  assert.equal(saveBotChoice(s, 'sprocket'), 'sprocket');
  assert.equal(loadBotChoice(s), 'sprocket');
  saveBotChoice(s, 'junk');
  assert.equal(loadBotChoice(s), 'bolt');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadBotChoice(broken), 'bolt', 'a blocked store falls back');
  assert.equal(saveBotChoice(broken, 'rivet'), 'rivet');
});

test('pair stats per bot live on this device: Regulars (10 rides) and 5K Together (5 km) with the same bot', () => {
  const s = memStore();
  assert.deepEqual(botPairStats(s, 'bolt'), { rides: 0, distance: 0 });
  for (let i = 0; i < 9; i++) recordBotRide(s, 'bolt', 500);
  recordBotRide(s, 'rivet', 1200);
  let bolt = recordBotRide(s, 'bolt', 500);
  assert.deepEqual(bolt, { rides: 10, distance: 5000 });
  assert.deepEqual(botPairStats(s, 'rivet'), { rides: 1, distance: 1200 }, 'each bot is its own pair');
  assert.deepEqual(botPairStats(s, 'sprocket'), { rides: 0, distance: 0 });
  const st = { pairRides: bolt.rides, pairDistanceKm: bolt.distance / 1000 };
  assert.ok(def('pair_10_rides').condition(st, emptyStats()), 'Regulars');
  assert.ok(def('pair_100km').condition(st, emptyStats()), '5K Together');
  assert.ok(!def('pair_10_rides').condition({ pairRides: 1 }, emptyStats()));
  s.setItem(BOT_PAIRS_KEY, '{not json');
  assert.deepEqual(botPairStats(s, 'bolt'), { rides: 0, distance: 0 }, 'a broken record starts again');
});

test('Social Goose: finishing with Bolt, Rivet and Sprocket is three different partners; The Two of Us; Full House co-op', () => {
  let L = emptyStats();
  const finish = (bot) => { L = applyEvent(L, 'finish', { finishedLevel: 'grandma', isCoop: true, partnerKey: botPartnerKey(bot) }); };
  finish('bolt');
  finish('bolt');
  assert.deepEqual(L.partners, ['bot:bolt'], 'the same bot twice is one partner');
  assert.ok(def('coop_first').condition({}, L), 'The Two of Us');
  assert.ok(!def('social_goose').condition({}, L));
  finish('rivet');
  finish('sprocket');
  assert.deepEqual(L.partners, ['bot:bolt', 'bot:rivet', 'bot:sprocket']);
  assert.ok(def('social_goose').condition({}, L), 'Social Goose');
  assert.ok(L.modesFinished.includes('coop'), 'a bot ride counts as co-op for Full House');
});

test('Team Player with a bot: the player\'s own safe riding has to reach 80%', () => {
  assert.ok(def('team_player').condition({ isMultiplayer: true, safePct: 85 }, emptyStats()));
  assert.ok(!def('team_player').condition({ isMultiplayer: true, safePct: 60 }, emptyStats()));
});

test('BotSync: steady alternate strokes build sync, a repeated foot or a ragged cadence does not', () => {
  const steady = new BotSync();
  for (let i = 0; i < 40; i++) { steady.feed([{ kind: 'solo', gap: 0.5 }]); steady.update(0.5); }
  assert.ok(steady.offsetScore > 0.9, `steady 2 strokes/s: ${steady.offsetScore}`);
  // ...and Perfect Sync needs it held 10 s (achievements.js counts the seconds above 0.9)
  assert.ok(def('perfect_sync').condition({ offsetScore: steady.offsetScore, syncDuration: 10 }, emptyStats()));

  const ragged = new BotSync();
  const gaps = [0.3, 0.9, 0.35, 0.8, 0.25, 0.95];
  for (let i = 0; i < 60; i++) { ragged.feed([{ kind: 'solo', gap: gaps[i % gaps.length] }]); ragged.update(0.5); }
  assert.ok(ragged.offsetScore < 0.5, `ragged cadence earns nothing: ${ragged.offsetScore}`);

  const masher = new BotSync();
  for (let i = 0; i < 40; i++) { masher.feed([{ kind: i % 2 ? 'wrong' : 'solo', gap: 0.2 }]); masher.update(0.2); }
  assert.ok(masher.offsetScore < 0.2, `the same foot again breaks sync: ${masher.offsetScore}`);

  const coaster = new BotSync();
  for (let i = 0; i < 20; i++) { coaster.feed([{ kind: 'solo', gap: 2.5 }]); coaster.update(2.5); }
  assert.ok(coaster.offsetScore < 0.5, 'slow pushes are coasting, not a cadence');

  const idle = new BotSync();
  idle.update(10);
  assert.ok(idle.offsetScore < 0.5, 'it decays with nobody pedalling');
});

test('tintBot paints the plates, lights and visor in the bot\'s colours, untintBot restores them', () => {
  const col = (hex) => ({ hex, set(h) { this.hex = typeof h === 'string' ? parseInt(h.slice(1), 16) : h; }, getHex() { return this.hex; }, setHex(h) { this.hex = h; } });
  const mats = {
    plate: { name: 'robot_white.005', color: col(0xdddddd), emissive: col(0) },
    light: { name: 'robot_light.009', color: col(0x28d7ff), emissive: col(0x28d7ff) },
    visor: { name: 'robot_visor.001', color: col(0x010203), emissive: col(0x1c97b3) },
    shirt: { name: 'outfit_male_robot_shirt.001', color: col(0xffffff), emissive: col(0xffffff) },
    chrome: { name: 'robot_chrome.009', color: col(0xf0f0f0), emissive: col(0) },
    body: { name: 'base_goose_game.002', color: col(0xffffff), emissive: col(0) },
  };
  const root = { traverse(fn) { for (const m of Object.values(mats)) fn({ isMesh: true, material: m }); } };
  assert.equal(botMaterialRole('robot_white.005'), 'plate');
  assert.equal(botMaterialRole('robot_orb_hot.003'), null, 'the hot core stays white-hot');
  tintBot(root, 'rivet');
  const hex = s => parseInt(s.slice(1), 16);
  assert.equal(mats.plate.color.hex, hex(BOTS.rivet.plate));
  assert.equal(mats.light.emissive.hex, hex(BOTS.rivet.light));
  assert.equal(mats.visor.emissive.hex, hex(BOTS.rivet.visor));
  assert.equal(mats.shirt.color.hex, 0xffffff, 'the printed suit keeps its colours');
  assert.equal(mats.chrome.color.hex, hex(BOTS.rivet.chrome), 'the chrome takes an anodised tint');
  assert.equal(mats.body.color.hex, 0xffffff, 'the goose stays a goose');
  tintBot(root, 'sprocket');
  assert.equal(mats.plate.color.hex, hex(BOTS.sprocket.plate), 'switching bots repaints');
  untintBot(root);
  assert.equal(mats.plate.color.hex, 0xdddddd);
  assert.equal(mats.light.emissive.hex, 0x28d7ff);
});

test('the unlock gate: player bots (Solo Flight) at any 80 of the 81 solo achievements', () => {
  const solo = soloAchievementIds();
  assert.equal(playerBotsProgress(solo.slice(2)).unlocked, false, 'two short');
  assert.equal(playerBotsProgress(solo.slice(1)).unlocked, true, 'any one can be skipped');
  assert.equal(playerBotsProgress(solo).unlocked, true);
  const multi = ACHIEVEMENTS.filter(a => ['together', 'versus'].includes(a.section)).map(a => a.id);
  assert.equal(playerBotsProgress([...solo.slice(2), ...multi]).unlocked, false, 'multiplayer ones never count');
});

test('Penny-Farthing pedal clips: a pack for every rider file, the robot ones included; the stoker plays it reversed', () => {
  for (const p of pfClipPacks()) assert.ok(fs.existsSync(p), p);
  const riders = fs.readdirSync('tandem-3d/goose').filter(f => /^goose_(captain|stoker).*\.glb$/.test(f));
  assert.ok(riders.length >= 20);
  for (const f of riders) assert.ok(pfClipPackFor('tandem-3d/goose/' + f), f);
  assert.equal(pfClipPackFor('tandem-3d/goose/goose_stoker_robot_m.glb'), 'tandem-3d/goose/pf/outfit_male_robot_pf.glb');
  assert.equal(pfClipPackFor('tandem-3d/goose/goose_stoker_robot_f.glb'), 'tandem-3d/goose/pf/outfit_female_robot_pf.glb');
  assert.equal(pfClipPackFor('tandem-3d/goose/goose_grandma.glb'), null);
  const d = 1;
  assert.equal(pfPedalTime('Captain', Math.PI / 2, d), turnTime(Math.PI / 2, d));
  assert.ok(Math.abs(pfPedalTime('Stoker', Math.PI / 2, d) - 0.75) < 1e-9, 'a quarter turn forward = three quarters of her clip');
  assert.equal(pfPedalTime('Stoker', 0, d), 0, 'both start with the rider-left pedal up');
});
