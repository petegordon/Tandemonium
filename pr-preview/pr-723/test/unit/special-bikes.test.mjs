// #611 · special bikes: the Time Warp unlock (any 90 of the 95 non-calendar achievements), which GLB a
// chooser pick rides, and its effect clip's bones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACHIEVEMENTS } from '../../js/achievement-defs.js';
import { timeWarpProgress, goldStandardProgress, rewardProgress, isCalendarAchievement, TIME_WARP_SLACK } from '../../js/rewards.js';
import { bikeModelPathFor, TIME_WARP_BIKE_KEY, TIME_WARP_BIKE_MODEL_PATH, SOLO_FLIGHT_BIKE_KEY, SOLO_FLIGHT_BIKE_MODEL_PATH, GOLD_STANDARD_BIKE_KEY, GOLD_STANDARD_BIKE_MODEL_PATH, SPECIAL_BIKES, SPECIAL_BIKE_KEYS, isSpecialBike, isRigTwin, ridesWithBot } from '../../js/special-bikes.js';
import { GOOSE_BIKE_MODEL_PATH, CHOOSER_MODEL_PATH, FUSED_RIDERS_MODEL_PATH } from '../../js/config.js';
import { boneFilterFor } from '../../js/goose-rider-clips.js';

const nonCal = ACHIEVEMENTS.filter(a => !isCalendarAchievement(a)).map(a => a.id);
const cal = ACHIEVEMENTS.filter(a => isCalendarAchievement(a)).map(a => a.id);

test('Time Warp: any 90 of the 95 non-calendar achievements; calendar ones never count', () => {
  const total = nonCal.length;
  assert.equal(TIME_WARP_SLACK, 5);
  assert.deepEqual(timeWarpProgress([]), { have: 0, need: total - 5, total, unlocked: false });
  assert.equal(timeWarpProgress(nonCal.slice(6)).unlocked, false, 'six short');
  assert.equal(timeWarpProgress(nonCal.slice(5)).unlocked, true, 'any five can be skipped');
  assert.equal(timeWarpProgress(nonCal.slice(0, -5)).unlocked, true, 'whichever five');
  assert.equal(timeWarpProgress([...nonCal.slice(6), ...cal]).unlocked, false, 'calendar ones do not count');
  assert.equal(timeWarpProgress([...nonCal.slice(5), ...nonCal.slice(5)]).have, total - 5, 'duplicates count once');
});

test('the chooser pick picks the GLB: Time Warp only with Show Riders on the goose tandem', () => {
  assert.deepEqual(SPECIAL_BIKE_KEYS, [SOLO_FLIGHT_BIKE_KEY, TIME_WARP_BIKE_KEY, GOLD_STANDARD_BIKE_KEY],
    'the reward ladder: Solo Flight, Time Warp, then Gold Standard');
  assert.equal(SPECIAL_BIKES.solo_flight.reward, 'playerBots');
  assert.equal(SPECIAL_BIKES.solo_flight.rideable, true, '#644: Solo Flight rides');
  assert.equal(SPECIAL_BIKES.solo_flight.soloOnly, true, 'a solo bike: the bot takes the back seat');
  assert.equal(SPECIAL_BIKES.time_warp.reward, 'timeWarp');
  for (const d of Object.values(SPECIAL_BIKES)) assert.ok(fs.existsSync(d.model), d.model);
  assert.equal(bikeModelPathFor(true, 'solo_flight', GOOSE_BIKE_MODEL_PATH), SOLO_FLIGHT_BIKE_MODEL_PATH, '#644: a solo ride on the Penny-Farthing');
  for (const mode of ['local', 'captain', 'stoker', 'versus']) {
    assert.equal(bikeModelPathFor(true, 'solo_flight', GOOSE_BIKE_MODEL_PATH, mode), GOOSE_BIKE_MODEL_PATH, `${mode}: the goose tandem`);
    assert.equal(ridesWithBot('solo_flight', mode), false, `${mode}: no bot`);
  }
  assert.equal(bikeModelPathFor(false, 'solo_flight', GOOSE_BIKE_MODEL_PATH), CHOOSER_MODEL_PATH, 'riders off: the plain frame');
  assert.ok(ridesWithBot('solo_flight', 'solo') && !ridesWithBot('time_warp', 'solo') && !ridesWithBot('default', 'solo'));
  assert.ok(isRigTwin(SOLO_FLIGHT_BIKE_MODEL_PATH), 'sized like the goose tandem (same geese)');
  assert.ok(isSpecialBike('time_warp') && !isSpecialBike('bike_red') && !isSpecialBike('default'));
  assert.equal(bikeModelPathFor(true, 'time_warp', GOOSE_BIKE_MODEL_PATH), TIME_WARP_BIKE_MODEL_PATH);
  assert.equal(bikeModelPathFor(true, 'bike_red', GOOSE_BIKE_MODEL_PATH), GOOSE_BIKE_MODEL_PATH);
  assert.equal(bikeModelPathFor(true, null, GOOSE_BIKE_MODEL_PATH), GOOSE_BIKE_MODEL_PATH);
  assert.equal(bikeModelPathFor(false, 'time_warp', GOOSE_BIKE_MODEL_PATH), CHOOSER_MODEL_PATH, 'riders off: the plain frame');
  assert.equal(bikeModelPathFor(true, 'time_warp', FUSED_RIDERS_MODEL_PATH), FUSED_RIDERS_MODEL_PATH, '?riders=fused has no rig twin');
  assert.ok(isRigTwin(TIME_WARP_BIKE_MODEL_PATH) && !isRigTwin(GOOSE_BIKE_MODEL_PATH));
  assert.ok(fs.existsSync(TIME_WARP_BIKE_MODEL_PATH), TIME_WARP_BIKE_MODEL_PATH);
});

test('TimeWarpFX drives only the clock hands and flames', () => {
  const keep = boneFilterFor('TimeWarpFX');
  for (const b of ['ClockM_L', 'ClockH_R', 'FlameB_0', 'FlameO_3']) assert.ok(keep(b), b);
  for (const b of ['Crank_F', 'Wheel_R', 'Pedal_FL', 'Seat_Captain', 'Steer', 'LeftLeg']) assert.ok(!keep(b), b);
});

test('the Time Warp GLB keeps the tandem rig and carries its effect clip', () => {
  const b = fs.readFileSync(TIME_WARP_BIKE_MODEL_PATH);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  const names = new Set(j.nodes.map(n => n.name));
  for (const n of ['Bike_root', 'Steer', 'Wheel_F', 'Wheel_R', 'Crank_F', 'Crank_R', 'Seat_Captain', 'Seat_Stoker',
    'Grip_C_L', 'Grip_S_R', 'PedalPin_FL', 'PedalPin_RR', 'ClockM_L', 'FlameB_0', 'FlameO_3',
    'seat_cycle_0', 'seat.001_cycle_0', 'TW_Wheel_R']) assert.ok(names.has(n), n);
  assert.deepEqual(j.animations.map(a => a.name).sort(), ['Pedal', 'TimeWarpFX', 'WheelSpin']);
});

test('Gold Standard: every achievement, ridden on the tandem rig in every mode but versus paint', () => {
  const all = ACHIEVEMENTS.map(a => a.id);
  assert.equal(all.length, 100, 'the 100');
  assert.deepEqual(goldStandardProgress([]), { have: 0, need: 100, total: 100, unlocked: false });
  assert.equal(goldStandardProgress(all.slice(1)).unlocked, false, 'one short');
  assert.equal(goldStandardProgress([...all, ...all, 'not_an_achievement']).have, 100, 'duplicates and unknown ids ignored');
  assert.equal(goldStandardProgress(all).unlocked, true);
  assert.deepEqual(rewardProgress('goldStandard', all), goldStandardProgress(all));
  const d = SPECIAL_BIKES.gold_standard;
  assert.equal(d.reward, 'goldStandard');
  assert.equal(d.rideable, true);
  assert.ok(!d.soloOnly && !d.fx);
  assert.equal(bikeModelPathFor(true, GOLD_STANDARD_BIKE_KEY, GOOSE_BIKE_MODEL_PATH), GOLD_STANDARD_BIKE_MODEL_PATH);
  assert.equal(bikeModelPathFor(true, GOLD_STANDARD_BIKE_KEY, GOOSE_BIKE_MODEL_PATH, 'local'), GOLD_STANDARD_BIKE_MODEL_PATH, 'co-op rides it too');
  assert.equal(bikeModelPathFor(false, GOLD_STANDARD_BIKE_KEY, GOOSE_BIKE_MODEL_PATH), CHOOSER_MODEL_PATH, 'riders off: the plain frame');
  assert.ok(isRigTwin(GOLD_STANDARD_BIKE_MODEL_PATH), 'sized like the goose tandem (same geese)');
  assert.ok(!ridesWithBot(GOLD_STANDARD_BIKE_KEY, 'solo'));
});

test('the Gold Standard GLB keeps the tandem rig', () => {
  const b = fs.readFileSync(GOLD_STANDARD_BIKE_MODEL_PATH);
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const names = new Set(j.nodes.map(n => n.name));
  for (const n of ['Bike_root', 'Steer', 'Wheel_F', 'Wheel_R', 'Crank_F', 'Crank_R', 'Seat_Captain', 'Seat_Stoker',
    'Grip_C_L', 'Grip_S_R', 'PedalPin_FL', 'PedalPin_RR', 'seat_cycle_0', 'seat.001_cycle_0', 'GS_frame', 'GS_Wheel_R']) assert.ok(names.has(n), n);
  assert.deepEqual(j.animations.map(a => a.name).sort(), ['Pedal', 'WheelSpin']);
  assert.ok(!(j.extensionsUsed || []).includes('KHR_draco_mesh_compression'), 'the chooser preview loads it without Draco');
});

test('Gold Standard mirror gold: full metal, its own sky to reflect (else it reads black)', async () => {
  const { isMirrorBike } = await import('../../js/special-bikes.js');
  const { isMirrorMaterial } = await import('../../js/mirror-env.js');
  assert.ok(isMirrorBike(GOLD_STANDARD_BIKE_MODEL_PATH) && !isMirrorBike(TIME_WARP_BIKE_MODEL_PATH) && !isMirrorBike(GOOSE_BIKE_MODEL_PATH));
  const b = fs.readFileSync(GOLD_STANDARD_BIKE_MODEL_PATH);
  const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const pbr = n => j.materials.find(m => m.name === n).pbrMetallicRoughness;
  const metal = p => (p.metallicFactor === undefined ? 1 : p.metallicFactor);
  assert.ok(metal(pbr('gs_gold')) >= 0.95 && pbr('gs_gold').roughnessFactor <= 0.15, 'the gold is polished full metal');
  assert.ok(metal(pbr('gs_gold_deep')) < 0.95, 'the deep-gold panel keeps the scene light (stays brown)');
  assert.ok(isMirrorMaterial({ isMeshStandardMaterial: true, metalness: 1 }));
  assert.ok(!isMirrorMaterial({ isMeshStandardMaterial: true, metalness: 0.75 }));
});
