// #611 · special bikes: the Time Warp unlock (any 90 of the 95 non-calendar achievements), which GLB a
// chooser pick rides, and its effect clip's bones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ACHIEVEMENTS } from '../../js/achievement-defs.js';
import { timeWarpProgress, isCalendarAchievement, TIME_WARP_SLACK } from '../../js/rewards.js';
import { bikeModelPathFor, TIME_WARP_BIKE_KEY, TIME_WARP_BIKE_MODEL_PATH, SOLO_FLIGHT_BIKE_KEY, SPECIAL_BIKES, SPECIAL_BIKE_KEYS, isSpecialBike, isRigTwin } from '../../js/special-bikes.js';
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
  assert.deepEqual(SPECIAL_BIKE_KEYS, [SOLO_FLIGHT_BIKE_KEY, TIME_WARP_BIKE_KEY], 'the reward ladder: Solo Flight, then Time Warp');
  assert.equal(SPECIAL_BIKES.solo_flight.reward, 'playerBots');
  assert.equal(SPECIAL_BIKES.solo_flight.rideable, false, 'Solo Flight is chooser-only until #644');
  assert.equal(SPECIAL_BIKES.time_warp.reward, 'timeWarp');
  for (const d of Object.values(SPECIAL_BIKES)) assert.ok(fs.existsSync(d.model), d.model);
  assert.equal(bikeModelPathFor(true, 'solo_flight', GOOSE_BIKE_MODEL_PATH), GOOSE_BIKE_MODEL_PATH, 'not ridden yet');
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
