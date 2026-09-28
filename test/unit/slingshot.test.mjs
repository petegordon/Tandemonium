// Slingshot mode · economy, launch, course and save.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPGRADES, upgradeCost, slingStats, launchSpeed, coastDecel, surfaceAt, SURFACE_RR, predictCoast,
  stageGoal, stageBonus, STAGE_GOALS, scoreRun, emptySave, loadSave, writeSave, applyRun,
  buyUpgrade, planCoinTrails, planCourse, LANES, COINS_PER_TRAIL, STORAGE_KEY, SAVE_VERSION, spentOn, RETIRED_UPGRADES,
  runDistance, dragToAim, aimPose, roadExitDistance, MIN_LAUNCH_PULL, jackpotBonus,
  SLING_POST_D, SLING_REST_D, SLING_PULL_BACK, SLING_MAX_LATERAL, SLING_MAX_AIM, ROAD_HALF_WIDTH
} from '../../js/slingshot.js';

const memStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), m };
};

test('upgrade prices climb and are rounded to 5', () => {
  for (const u of UPGRADES) {
    let prev = 0;
    for (let l = 0; l < u.max; l++) {
      const c = upgradeCost(u, l);
      assert.equal(c % 5, 0);
      assert.ok(c >= prev, `${u.id} L${l} must not get cheaper`);
      prev = c;
    }
  }
});

test('upgrades make the bike launch harder and roll further', () => {
  const s0 = slingStats({});
  const s5 = slingStats({ sling: 5, wheels: 5, aero: 5, magnet: 4 });
  assert.ok(s5.launchMax > s0.launchMax);
  assert.ok(s5.crr < s0.crr);
  assert.ok(s5.drag < s0.drag);
  assert.equal(s0.coinMult, 1);
  assert.equal(s5.coinMult, 2);
});

test('launch speed is the pull: none for no pull, launchMax for a full one', () => {
  const s = slingStats({});
  assert.equal(launchSpeed(s, 0), 0);
  assert.equal(launchSpeed(s, 0.5), s.launchMax / 2);
  assert.equal(launchSpeed(s, 1), s.launchMax);
  assert.equal(launchSpeed(s, 5), s.launchMax, 'clamped');
  assert.ok(MIN_LAUNCH_PULL > 0 && MIN_LAUNCH_PULL < 0.3, 'a flick is a cancel, a real pull fires');
});

test('coasting drag grows with speed, and the surface sets the rolling part', () => {
  const s = slingStats({});
  assert.ok(coastDecel(s, 20) > coastDecel(s, 5));
  assert.ok(coastDecel(s, 10, 'strip') < coastDecel(s, 10, 'dirt'));
  assert.ok(coastDecel(s, 10, 'dirt') < coastDecel(s, 10, 'edge'));
  assert.ok(coastDecel(s, 10, 'edge') < coastDecel(s, 10, 'grass'));
  assert.ok(coastDecel(s, 0, 'strip') > 0, 'a rolling bike always stops eventually');
  assert.equal(surfaceAt(0.2), 'strip');
  assert.equal(surfaceAt(-1.6), 'dirt', 'a lane is ordinary dirt');
  assert.equal(surfaceAt(2.3), 'edge');
  assert.equal(surfaceAt(-3), 'grass');
  assert.deepEqual(Object.keys(SURFACE_RR).sort(), ['dirt', 'edge', 'grass', 'strip']);
});

test('farther: a fresh full pull rolls more than twice what it used to', () => {
  // The first build coasted 162 m on dirt from a fresh full pull.
  const fresh = predictCoast(slingStats({}), 1, 'dirt');
  assert.ok(fresh > 2 * 162, `rolled ${fresh.toFixed(0)} m`);
  assert.ok(predictCoast(slingStats({}), 1, 'strip') > fresh, 'the centre strip rolls further');
  assert.ok(predictCoast(slingStats({}), 0.5, 'dirt') < fresh, 'a half pull rolls less');
});

test('steering is cheap: sweeping a coin trail on the edge costs under 10 m', () => {
  // Same launch twice; the second spends 12 m on the edge surface at 45 m out.
  const roll = (edgeFrom, edgeTo) => {
    const st = slingStats({});
    let v = launchSpeed(st, 1), d = 0; const dt = 1 / 120;
    while (v > 0.3) {
      const surf = d >= edgeFrom && d < edgeTo ? 'edge' : 'dirt';
      v = Math.max(0, v - coastDecel(st, v, surf) * dt); d += v * dt;
    }
    return d;
  };
  const cost = roll(Infinity, Infinity) - roll(45, 57);
  assert.ok(cost > 0 && cost <= 10, `the detour cost ${cost.toFixed(1)} m`);
  // …and the 5 coins pay far more than that distance would have.
  assert.ok(COINS_PER_TRAIL * 5 > cost / 2, 'coins are worth the swerve');
});

test('stage goals rise, fit inside one lap of the road, and hold at the last', () => {
  assert.equal(stageGoal(1), 300);
  assert.equal(stageGoal(0), 300, 'clamped to stage 1');
  let prev = 0;
  for (let n = 1; n <= STAGE_GOALS.length; n++) { assert.ok(stageGoal(n) > prev); prev = stageGoal(n); }
  assert.equal(stageGoal(STAGE_GOALS.length + 5), STAGE_GOALS[STAGE_GOALS.length - 1]);
  for (const g of STAGE_GOALS) assert.ok(g + SLING_REST_D < 1200, `goal ${g} m would lap into the slingshot`);
  assert.equal(stageBonus(3), 150);
});

test('score: distance, coins, no record bonus on the first run', () => {
  const r = scoreRun({ distance: 253.9, coins: 7 }, emptySave());
  assert.equal(r.distance, 253);
  assert.equal(r.distPay, 126);
  assert.equal(r.coinPay, 35);
  assert.equal(r.recordPay, 0);
  assert.equal(r.isRecord, true);
  assert.equal(r.total, 161);
  assert.equal(r.gatePay, undefined, 'no checkpoints, no checkpoint pay');
});

test('score: record bonus, stage bonus and the coin multiplier', () => {
  const save = { ...emptySave(), best: 200, runs: 3, stage: 2, lv: { magnet: 2 } };
  const r = scoreRun({ distance: 600, coins: 0, stageCleared: true }, save);
  assert.equal(r.recordPay, 100);
  assert.equal(r.stagePay, 100);
  assert.equal(r.subtotal, 300 + 0 + 100 + 100);
  assert.equal(r.multiplier, 1.5);
  assert.equal(r.total, Math.floor(500 * 1.5));
});

test('the jackpot: a flat bonus, then the whole run pays double', () => {
  const save = { ...emptySave(), stage: 3 };
  const r = scoreRun({ distance: 120, coins: 5, jackpot: true }, save);
  assert.equal(r.jackpotPay, jackpotBonus(3));
  assert.equal(r.multiplier, 2);
  assert.equal(r.total, (60 + 25 + 250) * 2);
  // A good jackpot beats rolling on to the stage-1 distance.
  const rolled = scoreRun({ distance: 300 }, save).total;
  assert.ok(r.total > rolled, `jackpot ${r.total} vs rolling ${rolled}`);
});

test('a short run is not a record and pays no record bonus', () => {
  const save = { ...emptySave(), best: 500, runs: 4 };
  const r = scoreRun({ distance: 100 }, save);
  assert.equal(r.isRecord, false);
  assert.equal(r.recordPay, 0);
});

test('applyRun banks coins, bumps runs/best/stage without mutating', () => {
  const s = emptySave();
  const run = { distance: 320, stageCleared: true };
  const score = scoreRun(run, s);
  const n = applyRun(s, run, score);
  assert.equal(n.coins, score.total);
  assert.equal(n.runs, 1);
  assert.equal(n.best, 320);
  assert.equal(n.stage, 2);
  assert.deepEqual(s, emptySave(), 'input untouched');
});

test('buying: spends coins, refuses when poor or maxed', () => {
  let s = { ...emptySave(), coins: 1000 };
  const r = buyUpgrade(s, 'sling');
  assert.equal(r.ok, true);
  assert.equal(r.save.lv.sling, 1);
  assert.equal(r.save.coins, 1000 - upgradeCost(UPGRADES[0], 0));
  assert.equal(buyUpgrade({ ...emptySave(), coins: 0 }, 'sling').reason, 'poor');
  assert.equal(buyUpgrade({ ...emptySave(), coins: 1e9, lv: { magnet: 8 } }, 'magnet').reason, 'maxed');
  assert.equal(buyUpgrade(s, 'rocket').reason, 'unknown');
});

test('save round-trips and survives garbage', () => {
  const store = memStore();
  const s = { v: 2, coins: 42, best: 310, runs: 5, stage: 2, lv: { sling: 3 } };
  writeSave(store, s);
  assert.deepEqual(loadSave(store), s);
  store.set(STORAGE_KEY, '{nope');
  assert.deepEqual(loadSave(store), emptySave());
  store.set(STORAGE_KEY, JSON.stringify({ coins: -5, stage: 0, lv: { sling: 99, bogus: 3 } }));
  const g = loadSave(store);
  assert.equal(g.coins, 0);
  assert.equal(g.stage, 1);
  assert.deepEqual(g.lv, { sling: 10 });
});

test('coin trails: whole trails, deterministic, on the road, after the start', () => {
  const a = planCoinTrails(1200, 7, { start: 65 });
  assert.deepEqual(a, planCoinTrails(1200, 7, { start: 65 }));
  assert.ok(a.length > 0 && a.length % COINS_PER_TRAIL === 0);
  for (const c of a) {
    assert.ok(c.d >= 65, `coin at ${c.d} is before the start`);
    assert.ok(Math.abs(c.offset) <= 1.8);
    assert.ok(c.d < 1200);
  }
  assert.notDeepEqual(a, planCoinTrails(1200, 8));
});

test('the slingshot: the bike rests past the fork and pulls back behind it', () => {
  assert.ok(SLING_REST_D > SLING_POST_D, 'rear wheel in the pouch, bike ahead of the fork');
  assert.deepEqual(aimPose(0, 0), { d: SLING_REST_D, lateral: 0, angle: -0 });
  assert.equal(aimPose(1, 0).d, SLING_REST_D - SLING_PULL_BACK);
  assert.ok(aimPose(1, 0).d > 0, 'a full pull stays on the road, not across the loop seam');
  assert.equal(aimPose(9, 0).d, aimPose(1, 0).d, 'clamped');
  assert.ok(aimPose(0.5, 0).d < aimPose(0.2, 0).d, 'more pull, further back');
});

test('aim: the bike follows the finger aside and flies back through the forks', () => {
  const left = aimPose(1, -1);
  assert.equal(left.lateral, -SLING_MAX_LATERAL, 'dragged left, the bike sits left');
  assert.equal(left.angle, SLING_MAX_AIM, 'and aims right, through the gap');
  const right = aimPose(1, 1);
  assert.equal(right.lateral, SLING_MAX_LATERAL);
  assert.equal(right.angle, -SLING_MAX_AIM);
  assert.equal(aimPose(0, -1).lateral === 0, true, 'no pull, no sideways stretch');
  assert.ok(Math.abs(aimPose(1, 0.5).angle) < SLING_MAX_AIM);
});

test('run distance is measured from the rest point, never negative', () => {
  assert.equal(runDistance(SLING_REST_D), 0);
  assert.equal(runDistance(SLING_REST_D + 100), 100);
  assert.equal(runDistance(1), 0, 'a bike still drawn back has flown nowhere');
  assert.equal(runDistance(undefined), 0);
});

test('no checkpoint upgrade is sold any more', () => {
  assert.equal(UPGRADES.find(u => u.id === 'gate'), undefined);
  assert.equal(slingStats({}).gateBoost, undefined);
});

test('drag to aim: back (down the screen) pulls, sideways aims, both clamped', () => {
  const W = 1000, H = 1000; // full pull = 300 px down, full side = 250 px across
  assert.deepEqual(dragToAim(0, 0, W, H), { pull: 0, side: 0 });
  assert.equal(dragToAim(0, 150, W, H).pull, 0.5);
  assert.equal(dragToAim(0, 900, W, H).pull, 1, 'clamped');
  assert.equal(dragToAim(0, -80, W, H).pull, 0, 'dragging forward never pushes');
  assert.equal(dragToAim(-125, 300, W, H).side, -0.5);
  assert.equal(dragToAim(900, 300, W, H).side, 1, 'clamped');
});

test('no pedaling upgrades: the slingshot is the only push', () => {
  for (const id of ['legs', 'stamina']) assert.equal(UPGRADES.find(u => u.id === id), undefined);
  const st = slingStats({ legs: 5, stamina: 5 });
  assert.equal(st.strokes, undefined);
  assert.equal(st.pedalMult, undefined);
});

test('an old save gets its coins back for upgrades that no longer exist', () => {
  const store = memStore();
  // A tester on an earlier build bought Pedal power 2, Stamina 1, Checkpoint boost 3.
  writeSave(store, { coins: 7, best: 120, runs: 4, stage: 1, lv: { sling: 1, legs: 2, stamina: 1, gate: 3 } });
  const s = loadSave(store);
  const refund = spentOn(45, 2) + spentOn(40, 1) + spentOn(45, 3);
  assert.equal(refund, 45 + 70 + 40 + 45 + 70 + 110);
  assert.equal(s.coins, 7 + refund);
  assert.deepEqual(s.lv, { sling: 1 }, 'retired upgrades are gone, live ones kept');
  assert.equal(s.v, SAVE_VERSION);
  // Saving and loading again must not refund twice.
  writeSave(store, s);
  assert.equal(loadSave(store).coins, s.coins);
  assert.deepEqual(Object.keys(RETIRED_UPGRADES).sort(), ['gate', 'legs', 'stamina']);
});

test('aim: every drag stays on the road for at least 40 m unsteered', () => {
  for (let side = -1; side <= 1.0001; side += 0.25) {
    for (const pull of [0.2, 0.6, 1]) {
      const pose = aimPose(pull, side);
      const exit = roadExitDistance(pose.lateral, pose.angle);
      assert.ok(exit >= 40, `pull ${pull} side ${side.toFixed(2)} leaves the road at ${exit.toFixed(1)} m`);
    }
  }
  assert.equal(roadExitDistance(0, 0), Infinity, 'dead straight never leaves');
  assert.equal(roadExitDistance(ROAD_HALF_WIDTH + 0.1, 0), 0, 'already off');
});

test('aim: a full swing reaches the far lane by the first gate (45 m)', () => {
  const pose = aimPose(1, -1);
  const at45 = pose.lateral + (45 + SLING_REST_D - pose.d) * Math.tan(pose.angle);
  assert.ok(at45 >= 1.2, `only reached ${at45.toFixed(2)} m across`);
  const straight = aimPose(1, 0);
  assert.equal(straight.lateral + 45 * Math.tan(straight.angle), 0, 'no swing, centre lane');
  assert.ok(Math.abs(aimPose(0.3, -1).angle) < Math.abs(aimPose(1, -1).angle), 'aim grows with the pull');
});

test('course: fixed per stage, lanes that make a choice, jackpot from stage 2', () => {
  const goal = stageGoal(3) + SLING_REST_D;
  assert.deepEqual(planCourse(3, goal), planCourse(3, goal), 'the same layout every launch');
  assert.notDeepEqual(planCourse(3, goal), planCourse(4, goal), 'a different layout per stage');
  for (let st = 1; st <= 7; st++) {
    const g = stageGoal(st) + SLING_REST_D;
    const c = planCourse(st, g);
    assert.equal(c.hay.length, 2);
    const gate1Coins = c.coins.filter(x => x.d < SLING_REST_D + 60);
    assert.equal(gate1Coins.length, COINS_PER_TRAIL);
    assert.notEqual(gate1Coins[0].offset, c.hay[0].offset, 'coins and hay never share a lane');
    for (const h of c.hay) assert.ok(LANES.includes(h.offset));
    for (const x of c.coins) { assert.ok(x.d < g, 'every coin before the goal'); assert.ok(Math.abs(x.offset) <= 1.8); }
    if (st === 1) assert.equal(c.jackpot, null, 'stage 1 teaches the lanes first');
    else {
      assert.ok(c.jackpot && LANES.includes(c.jackpot.offset));
      assert.notEqual(c.jackpot.offset, c.hay[1].offset);
    }
  }
});

/** A player who gets `skill` of the ideal distance and buys the cheapest upgrade they can. */
function simulate(skill, coinsPerRun = 5, maxRuns = 300) {
  let save = emptySave(); const perStage = []; let n = 0;
  for (let r = 0; r < maxRuns && save.stage <= STAGE_GOALS.length; r++) {
    const reach = predictCoast(slingStats(save.lv), 1, 'dirt') * skill;
    const goal = stageGoal(save.stage);
    const run = { distance: Math.min(reach, goal), coins: coinsPerRun, stageCleared: reach >= goal };
    save = applyRun(save, run, scoreRun(run, save)); n++;
    if (run.stageCleared) { perStage.push(n); n = 0; }
    for (;;) {
      const opts = UPGRADES.filter(u => (save.lv[u.id] || 0) < u.max)
        .map(u => ({ u, c: upgradeCost(u, save.lv[u.id] || 0) })).sort((a, b) => a.c - b.c);
      if (!opts.length || opts[0].c > save.coins) break;
      save = buyUpgrade(save, opts[0].u.id).save;
    }
  }
  return perStage;
}

test('progression: a decent player clears every stage in 1-4 launches, and it takes a while', () => {
  const runs = simulate(0.8);
  assert.equal(runs.length, STAGE_GOALS.length, `only cleared ${runs.length} stages: ${runs.join(' ')}`);
  for (const [i, n] of runs.entries()) assert.ok(n >= 1 && n <= 4, `stage ${i + 1} took ${n} launches`);
  assert.ok(runs.reduce((a, b) => a + b, 0) >= 12, `too quick: ${runs.join(' ')}`);
  // The first launch pays for the first upgrade.
  const first = scoreRun({ distance: predictCoast(slingStats({}), 1, 'dirt') * 0.8, coins: 0 }, emptySave()).total;
  assert.ok(first >= Math.min(...UPGRADES.map(u => upgradeCost(u, 0))));
});

test('progression: a maxed bike clears the last goal even riding the edge', () => {
  const max = Object.fromEntries(UPGRADES.map(u => [u.id, u.max]));
  const d = predictCoast(slingStats(max), 1, 'edge');
  assert.ok(d >= STAGE_GOALS[STAGE_GOALS.length - 1], `maxed edge roll ${d.toFixed(0)} m`);
});

test('the systems table: what a normal ride runs that this mode does not', async () => {
  const { SLING_SYSTEMS_OFF } = await import('../../js/slingshot.js');
  for (const name of ['achievements', 'ghost', 'disruptions', 'dda', 'coach', 'cruise', 'rideAnalytics']) {
    assert.ok(SLING_SYSTEMS_OFF.has(name), `${name} should be off in Slingshot`);
  }
  assert.equal(SLING_SYSTEMS_OFF.has('collectibles'), false, 'coins are the point');
});

test('air: ramps launch faster bikes higher, and a long flight is Big Air', async () => {
  const S = await import('../../js/slingshot.js');
  assert.ok(S.rampLaunch(12) > S.rampLaunch(6));
  assert.ok(S.rampLaunch(100) <= 8, 'capped');
  assert.ok(S.airTime(S.rampLaunch(12)) >= S.BIG_AIR_S, 'a good launch is big air');
  assert.ok(S.airTime(S.rampLaunch(4)) < S.BIG_AIR_S, 'a crawl off a ramp is a hop');
  const st = S.slingStats({});
  assert.ok(S.coastDecel(st, 10, 'grass', true) < S.coastDecel(st, 10, 'strip', false), 'no rolling drag in the air');
  // Clearing the hay 7 m past the ramp needs real speed.
  const heightAt = (v, dx) => { const vy = S.rampLaunch(v), t = dx / v; return vy * t - 4.9 * t * t; };
  assert.ok(heightAt(12, 7) > S.HAY_CLEAR_H, 'fast: over the bale');
  assert.ok(heightAt(8, 7) < S.HAY_CLEAR_H, 'slow: into it');
  const r = S.scoreRun({ distance: 100, bigAirs: 2 }, S.emptySave());
  assert.equal(r.airPay, 2 * S.BIG_AIR_PAY);
});

test('course: ramps in lanes, one set up to jump gate 2\'s bale, none under a coin', async () => {
  const S = await import('../../js/slingshot.js');
  for (let st = 1; st <= 7; st++) {
    const goal = S.stageGoal(st) + S.SLING_REST_D;
    const c = S.planCourse(st, goal);
    assert.ok(c.ramps.length >= 1);
    for (const r of c.ramps) {
      assert.ok(S.LANES.includes(r.offset) && r.d < goal);
      assert.ok(!c.coins.some(x => Math.abs(x.d - r.d) < 4 && Math.abs(x.offset - r.offset) < 1.2), 'no coin on a ramp');
    }
    const jump = c.ramps[0], bale = c.hay[1];
    assert.equal(jump.offset, bale.offset);
    assert.equal(Math.round(bale.d - jump.d), 7);
  }
});

test('stick: pull back, aim, let go — fires with the strongest pull and its aim', async () => {
  const S = await import('../../js/slingshot.js');
  const t = S.stickTracker();
  for (const p of [0.3, 0.7, 1]) assert.equal(S.stickUpdate(t, p, -0.2), null, 'pulling back');
  assert.equal(S.stickUpdate(t, 1, -0.7), null, 'aiming while held');
  // Let go: the stick passes back through smaller pulls on its way home.
  assert.equal(S.stickUpdate(t, 0.6, -0.4), null);
  assert.equal(S.stickUpdate(t, 0.2, -0.1), null);
  assert.deepEqual(S.stickUpdate(t, 0, 0), { pull: 1, side: -0.7 });
  assert.equal(S.stickUpdate(t, 0, 0), null, 'fires once');
});

test('stick: no timer — a slow return home fires just the same', async () => {
  const S = await import('../../js/slingshot.js');
  const t = S.stickTracker();
  S.stickUpdate(t, 0.9, 0.3);
  for (let p = 0.88; p > 0.12; p -= 0.01) S.stickUpdate(t, p, 0.3);   // eased back over many frames, aim kept
  assert.deepEqual(S.stickUpdate(t, 0, 0), { pull: 0.9, side: 0.3 });
});

test('stick: pull back less for a softer shot', async () => {
  const S = await import('../../js/slingshot.js');
  const t = S.stickTracker();
  S.stickUpdate(t, 0.5, 0);
  assert.deepEqual(S.stickUpdate(t, 0, 0), { pull: 0.5, side: 0 });
});

test('stick: a flick under the launch pull, or a stick still held, never fires', async () => {
  const S = await import('../../js/slingshot.js');
  const t = S.stickTracker();
  S.stickUpdate(t, S.MIN_LAUNCH_PULL - 0.02, 0);
  assert.equal(S.stickUpdate(t, 0, 0), null, 'too small a pull');
  S.stickUpdate(t, 0.8, 0);
  assert.equal(S.stickUpdate(t, 0.8, 0), null, 'still held back');
});