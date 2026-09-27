// Slingshot mode · economy, launch, course and save.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPGRADES, upgradeCost, slingStats, launchSpeed, coastDecel,
  stageGoal, stageBonus, scoreRun, emptySave, loadSave, writeSave, applyRun,
  buyUpgrade, planCoinTrails, COINS_PER_TRAIL, STORAGE_KEY,
  runDistance, dragToAim, aimPose, MIN_LAUNCH_PULL,
  SLING_POST_D, SLING_REST_D, SLING_PULL_BACK, SLING_MAX_LATERAL, SLING_MAX_AIM
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

test('coasting drag grows with speed and the centre strip rolls easier', () => {
  const s = slingStats({});
  assert.ok(coastDecel(s, 20) > coastDecel(s, 5));
  assert.ok(coastDecel(s, 10, true) < coastDecel(s, 10, false));
  assert.ok(coastDecel(s, 0) > 0, 'a rolling bike always stops eventually');
});

test('a fresh full pull on a flat road coasts short of stage 1, as intended', () => {
  // Numerical coast with no pedaling or slope.
  const s = slingStats({});
  let v = launchSpeed(s, 1), d = 0;
  const dt = 1 / 60;
  while (v > 0.05) { v = Math.max(0, v - coastDecel(s, v) * dt); d += v * dt; }
  assert.ok(d > 60 && d < stageGoal(1), `coasted ${d.toFixed(0)} m`);
});

test('stage goals rise and continue past the table', () => {
  assert.equal(stageGoal(1), 300);
  assert.equal(stageGoal(0), 300, 'clamped to stage 1');
  let prev = 0;
  for (let n = 1; n < 12; n++) { assert.ok(stageGoal(n) > prev); prev = stageGoal(n); }
  assert.equal(stageGoal(8) - stageGoal(7), 1200);
  assert.equal(stageBonus(3), 150);
});

test('score: distance, coins, no record bonus on the first run', () => {
  const r = scoreRun({ distance: 253.9, coins: 7 }, emptySave());
  assert.equal(r.distance, 253);
  assert.equal(r.distPay, 50);
  assert.equal(r.coinPay, 35);
  assert.equal(r.recordPay, 0);
  assert.equal(r.isRecord, true);
  assert.equal(r.total, 85);
  assert.equal(r.gatePay, undefined, 'no checkpoints, no checkpoint pay');
});

test('score: record bonus, stage bonus and the coin multiplier', () => {
  const save = { ...emptySave(), best: 200, runs: 3, stage: 2, lv: { magnet: 2 } };
  const r = scoreRun({ distance: 600, coins: 0, stageCleared: true }, save);
  assert.equal(r.recordPay, 100);
  assert.equal(r.stagePay, 100);
  assert.equal(r.subtotal, 120 + 0 + 100 + 100);
  assert.equal(r.multiplier, 1.5);
  assert.equal(r.total, Math.floor(320 * 1.5));
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
  const s = { coins: 42, best: 310, runs: 5, stage: 2, lv: { sling: 3 } };
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
