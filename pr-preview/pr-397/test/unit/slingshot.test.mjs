// Slingshot mode · economy, launch, course and save.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPGRADES, upgradeCost, slingStats, addPull, launchSpeed, MIN_PULL, coastDecel,
  stageGoal, stageBonus, scoreRun, emptySave, loadSave, writeSave, applyRun,
  buyUpgrade, planCoinTrails, GATE_SPACING, COINS_PER_TRAIL, STORAGE_KEY
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

test('pull accumulates pedal work, clamps to 1, and ignores non-positive input', () => {
  let p = 0;
  p = addPull(p, 3);
  assert.equal(p, 0.5);
  assert.equal(addPull(p, 0), p);
  assert.equal(addPull(p, -1), p);
  assert.equal(addPull(p, 100), 1);
});

test('even an unpulled sling launches; a full pull hits launchMax', () => {
  const s = slingStats({});
  assert.equal(launchSpeed(s, 0), s.launchMax * MIN_PULL);
  assert.equal(launchSpeed(s, 1), s.launchMax);
  assert.equal(launchSpeed(s, 5), s.launchMax, 'clamped');
});

test('coasting drag grows with speed and the centre strip rolls easier', () => {
  const s = slingStats({});
  assert.ok(coastDecel(s, 20) > coastDecel(s, 5));
  assert.ok(coastDecel(s, 10, true) < coastDecel(s, 10, false));
  assert.ok(coastDecel(s, 0) > 0, 'a rolling bike always stops eventually');
});

test('a fresh full pull on a flat road coasts short of stage 1, as intended', () => {
  // Numerical coast with no pedaling, gates or slope.
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

test('score: distance, gates, coins, no record bonus on the first run', () => {
  const r = scoreRun({ distance: 253.9, gatesPassed: 2, coins: 7 }, emptySave());
  assert.equal(r.distance, 253);
  assert.equal(r.distPay, 50);
  assert.equal(r.gatePay, 20);
  assert.equal(r.coinPay, 35);
  assert.equal(r.recordPay, 0);
  assert.equal(r.isRecord, true);
  assert.equal(r.total, 105);
});

test('score: record bonus, stage bonus and the coin multiplier', () => {
  const save = { ...emptySave(), best: 200, runs: 3, stage: 2, lv: { magnet: 2 } };
  const r = scoreRun({ distance: 600, gatesPassed: 5, coins: 0, stageCleared: true }, save);
  assert.equal(r.recordPay, 100);
  assert.equal(r.stagePay, 100);
  assert.equal(r.subtotal, 120 + 50 + 0 + 100 + 100);
  assert.equal(r.multiplier, 1.5);
  assert.equal(r.total, Math.floor(370 * 1.5));
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

test('coin trails: whole trails, deterministic, clear of the gates, on the road', () => {
  const a = planCoinTrails(1200, 7);
  assert.deepEqual(a, planCoinTrails(1200, 7));
  assert.ok(a.length > 0 && a.length % COINS_PER_TRAIL === 0);
  for (const c of a) {
    const toGate = Math.min(c.d % GATE_SPACING, GATE_SPACING - (c.d % GATE_SPACING));
    assert.ok(toGate >= 12, `coin at ${c.d} is ${toGate} m from a gate`);
    assert.ok(Math.abs(c.offset) <= 1.8);
    assert.ok(c.d < 1200);
  }
  assert.notDeepEqual(a, planCoinTrails(1200, 8));
});
