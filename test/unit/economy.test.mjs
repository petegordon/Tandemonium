// #400 D4/D5/D11 · one wallet, every mode pays, stage gates, Today's Launch, prestige.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLET_KEY, WALLET_VERSION, emptyWallet, loadWallet, writeWallet, deposit, coinMultiplier,
  prestigeBonus, canRebuild, rebuild, REBUILD_BONUS, sanitizeWallet,
} from '../../js/wallet.js';
import {
  STORAGE_KEY as SLING_KEY, UPGRADES, upgradeCost, buyUpgrade, loadSave, writeSave, emptySave,
  STAGE_GATES, stageLock, todaysLaunchCourse, todaysLaunchSeed, todaysLaunchStatus, applyTodaysLaunch,
  TODAYS_LAUNCH_LENGTH, SLING_REST_D, scoreRun, upgradeGain, slingStats, predictCoast, spentOn,
} from '../../js/slingshot.js';
import { scoreRide, RIDE_PAY, newLedger, ledgerStep, gateProgress } from '../../js/economy.js';
import { dailyKey } from '../../js/daily-seed.js';
import { getMedals } from '../../js/race-config.js';
import { DEMO_RULES, FULL_RULES } from '../../js/edition.js';

const memStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), m };
};
const maxed = () => Object.fromEntries(UPGRADES.map(u => [u.id, u.max]));

// ---- Wallet + migration ------------------------------------------------

test('wallet: empty, round-trips, survives garbage', () => {
  const store = memStore();
  assert.deepEqual(loadWallet(store), emptyWallet());
  const w = { v: WALLET_VERSION, coins: 120, earned: 300, lv: { sling: 2, magnet: 1 }, rebuilds: 1 };
  writeWallet(store, w);
  assert.deepEqual(loadWallet(store), w);
  store.set(WALLET_KEY, '{nope');
  assert.deepEqual(loadWallet(store), emptyWallet());
  const g = sanitizeWallet({ coins: -4, earned: 'x', lv: { sling: 99, rocket: 3 }, rebuilds: -1 });
  assert.deepEqual(g, { ...emptyWallet(), lv: { sling: 10 } });
});

test('migration: a v2 Slingshot save hands its coins and upgrades to the wallet, once', () => {
  const store = memStore();
  store.set(SLING_KEY, JSON.stringify({ v: 2, coins: 250, best: 410, runs: 9, stage: 3, lv: { sling: 3, wheels: 1, aero: 1, magnet: 2 } }));
  const w = loadWallet(store);
  assert.equal(w.coins, 250 + spentOn(50, 1), 'Aero folded into Tyres & frame: refunded');
  assert.deepEqual(w.lv, { sling: 3, wheels: 1, magnet: 2 });
  const s = loadSave(store);
  assert.deepEqual({ best: s.best, runs: s.runs, stage: s.stage }, { best: 410, runs: 9, stage: 3 }, 'progress stays put');
  const raw = JSON.parse(store.get(SLING_KEY));
  assert.equal(raw.coins, undefined, 'no coins left behind in the Slingshot save');
  assert.equal(raw.lv, undefined);
  assert.equal(raw.v, 3);
  // Idempotent: loading again moves nothing twice.
  assert.deepEqual(loadWallet(store), w);
});

test('migration: an old build banking more coins in the Slingshot save gets them carried over', () => {
  const store = memStore();
  writeWallet(store, { ...emptyWallet(), coins: 100, lv: { sling: 4 } });
  store.set(SLING_KEY, JSON.stringify({ v: 2, coins: 30, best: 0, runs: 1, stage: 1, lv: { sling: 2, magnet: 1 } }));
  const w = loadWallet(store);
  assert.equal(w.coins, 130);
  assert.deepEqual(w.lv, { sling: 4, magnet: 1 }, 'levels keep the higher, never bought twice');
});

test('migration: a fresh player and a v3 save migrate nothing', () => {
  const store = memStore();
  writeSave(store, { ...emptySave(), stage: 2 });
  assert.deepEqual(loadWallet(store), emptyWallet());
  assert.equal(loadSave(store).stage, 2);
});

test('wallet: deposit counts lifetime earnings; buying debits the one wallet', () => {
  let w = deposit(emptyWallet(), 99.7);
  assert.equal(w.coins, 99);
  assert.equal(w.earned, 99);
  const r = buyUpgrade(w, 'sling');
  assert.ok(r.ok);
  assert.equal(r.save.coins, 99 - upgradeCost(UPGRADES[0], 0));
  assert.equal(r.save.earned, 99, 'spending is not un-earning');
  assert.equal(buyUpgrade(emptyWallet(), 'sling').reason, 'poor');
  assert.equal(buyUpgrade(emptyWallet(), 'aero').reason, 'unknown', 'Aero is no longer sold');
});

// ---- Garage (D5) ---------------------------------------------------------

test('garage: three upgrades; Tyres & frame cuts rolling AND air drag', () => {
  assert.deepEqual(UPGRADES.map(u => u.id), ['sling', 'wheels', 'magnet']);
  const s0 = slingStats({}), s3 = slingStats({ wheels: 3 });
  assert.ok(s3.crr < s0.crr && s3.drag < s0.drag);
  assert.equal(slingStats({ aero: 5 }).drag, s0.drag, 'a stray aero level does nothing');
});

test('garage: every buy button can say how many metres it adds', () => {
  const g = upgradeGain({}, 'sling');
  assert.ok(g > 30, `sling L1 adds ${g.toFixed(1)} m`);
  assert.ok(upgradeGain({}, 'wheels') > 10);
  assert.equal(upgradeGain({}, 'magnet'), 0, 'the Coin multiplier buys coins, not metres');
  assert.equal(upgradeGain({ sling: 10 }, 'sling'), 0, 'maxed');
  const lv = { sling: 2 };
  assert.ok(Math.abs(upgradeGain(lv, 'sling') -
    (predictCoast(slingStats({ sling: 3 }), 1, 'dirt') - predictCoast(slingStats(lv), 1, 'dirt'))) < 1e-9);
});

// ---- Regular rides pay (D4) ---------------------------------------------

test('scoreRide: distance, pickups, finish, medal, new best, times the multiplier', () => {
  const r = scoreRide({ distance: 250, pickups: 6, finished: true, medal: 'silver', newBest: true, multiplier: 1 });
  assert.equal(r.distPay, 50);
  assert.equal(r.pickupPay, 30);
  assert.equal(r.finishPay, RIDE_PAY.finish);
  assert.equal(r.medalPay, 50);
  assert.equal(r.bestPay, 50);
  assert.equal(r.total, 50 + 30 + 25 + 50 + 50);
  const doubled = scoreRide({ distance: 250, pickups: 6, finished: true, medal: 'silver', newBest: true, multiplier: 2 });
  assert.equal(doubled.total, 2 * r.total);
  assert.equal(scoreRide({ distance: 250, finished: true, medal: 'gold' }).medalPay, 100);
  assert.equal(scoreRide({ distance: 250, finished: true, medal: 'bronze' }).medalPay, 25);
});

test('scoreRide: a crashed or abandoned ride still pays its distance, nothing more', () => {
  const r = scoreRide({ distance: 137, pickups: 2, finished: false, medal: 'gold', newBest: true, multiplier: 1.5 });
  assert.equal(r.distPay, 27);
  assert.equal(r.finishPay + r.medalPay + r.bestPay, 0, 'no finish, no finish bonuses');
  assert.equal(r.total, Math.floor((27 + 10) * 1.5));
  assert.equal(scoreRide({}).total, 0);
});

test('one Grandma\'s finish buys the first Slingshot level (target: 1 ride)', () => {
  const cheapest = Math.min(...UPGRADES.map(u => upgradeCost(u, 0)));
  // 250 m, no medal, no presents: the worst finish.
  assert.ok(scoreRide({ distance: 250, finished: true, multiplier: 1 }).total >= cheapest);
  // The tutorial (225 m) does too.
  assert.ok(scoreRide({ distance: 225, finished: true, multiplier: 1 }).total >= cheapest);
});

test('ledger: a game-over, a restart and the finish pay each metre once', () => {
  let L = newLedger('ride-1');
  let s = ledgerStep(L, { distance: 140, pickups: 3 });
  assert.deepEqual(s.pay, { distance: 140, paidDistance: 0, pickups: 3, finished: false });
  L = s.ledger;
  // RESTART from the 125 m checkpoint; pickups after it were taken back and re-collected.
  s = ledgerStep(L, { distance: 130, pickups: 3 });
  assert.equal(scoreRide({ ...s.pay, multiplier: 1 }).total, 0, 'nothing new, nothing paid');
  L = s.ledger;
  s = ledgerStep(L, { distance: 250, pickups: 5, finished: true });
  assert.deepEqual(s.pay, { distance: 250, paidDistance: 140, pickups: 2, finished: true });
  const r = scoreRide({ ...s.pay, multiplier: 1 });
  assert.equal(r.distPay, 50 - 28);
  assert.equal(r.metres, 110);
  L = s.ledger;
  assert.equal(ledgerStep(L, { distance: 250, pickups: 5, finished: true }).pay.finished, false, 'finish pays once');
});

test('the Coin multiplier and the prestige bonus multiply every payout', () => {
  const w = { ...emptyWallet(), lv: { magnet: 4 }, rebuilds: 2 };
  assert.equal(prestigeBonus(w), 1 + 2 * REBUILD_BONUS);
  assert.ok(Math.abs(coinMultiplier(w) - 2 * 1.2) < 1e-9);
  assert.equal(coinMultiplier(emptyWallet()), 1);
  // Slingshot's scoreRun takes the same multiplier.
  assert.equal(scoreRun({ distance: 100 }, emptySave(), coinMultiplier(w)).total, Math.floor(50 * 2.4));
});

// ---- Prestige (D11c) -------------------------------------------------------

test('prestige: only when everything is maxed; resets upgrades, keeps coins and stage', () => {
  const store = memStore();
  assert.equal(canRebuild(emptyWallet()), false);
  assert.equal(rebuild({ ...emptyWallet(), lv: { sling: 10 } }).ok, false);
  const w = { ...emptyWallet(), coins: 777, earned: 30000, lv: maxed() };
  assert.equal(canRebuild(w), true);
  const r = rebuild(w);
  assert.ok(r.ok);
  assert.deepEqual(r.wallet.lv, {});
  assert.equal(r.wallet.coins, 777);
  assert.equal(r.wallet.rebuilds, 1);
  writeSave(store, { ...emptySave(), stage: 8 });
  writeWallet(store, r.wallet);
  assert.equal(loadWallet(store).rebuilds, 1, 'the rebuild count is saved');
  assert.equal(loadSave(store).stage, 8, 'stage progress untouched');
  assert.ok(coinMultiplier(r.wallet) > coinMultiplier({ ...emptyWallet() }));
});

// ---- Stage gates (D11a) + demo cap -----------------------------------------

test('gates: stage 4 needs bronze on Grandma\'s, 6 any finished Today\'s Road, 7 gold on Grandma\'s', () => {
  assert.deepEqual(Object.keys(STAGE_GATES).map(Number), [4, 6, 7]);
  for (const st of [1, 2, 3, 5, 8]) assert.equal(stageLock(st, {}), null, `stage ${st} is open`);
  assert.equal(stageLock(4, {}).kind, 'medal');
  assert.equal(stageLock(4, {}).level, 'grandma');
  assert.equal(stageLock(4, { medals: { grandma: 'bronze' } }), null);
  assert.equal(stageLock(4, { medals: { grandma: 'gold' } }), null, 'better than bronze counts');
  assert.equal(stageLock(6, {}).kind, 'daily');
  assert.equal(stageLock(6, { dailyFinished: true }), null);
  assert.equal(stageLock(7, { medals: { grandma: 'silver' } }).kind, 'medal');
  assert.equal(stageLock(7, { medals: { grandma: 'gold' } }), null);
});

test('demo cap: past the edition\'s maxStage every stage is the demo\'s end', () => {
  const cap = DEMO_RULES.slingshot.maxStage;
  assert.ok(Number.isInteger(cap) && cap >= 1);
  assert.equal(stageLock(cap, {}, { maxStage: cap }), null);
  assert.equal(stageLock(cap + 1, { medals: { grandma: 'gold' }, dailyFinished: true }, { maxStage: cap }).kind, 'demo');
  assert.equal(FULL_RULES.slingshot.maxStage, null);
  assert.equal(stageLock(20, { medals: { grandma: 'gold' }, dailyFinished: true }, { maxStage: FULL_RULES.slingshot.maxStage }), null);
});

test('gate progress: medals from any mode/difficulty record, Today\'s Road from either store', () => {
  const m = getMedals('grandma', 'chill');
  const records = {
    'grandma|chill|coop': { timeMs: m.silver - 1 },
    'grandma|adventurous|solo': { timeMs: getMedals('grandma', 'adventurous').bronze - 1 },
    'tutorial|tutorial|solo': { timeMs: 1000 },
  };
  assert.deepEqual(gateProgress(records, {}), { medals: { grandma: 'silver' }, dailyFinished: false });
  assert.equal(gateProgress({}, { '2026-10-01': { practice: 1, best: 90000 } }).dailyFinished, true);
  assert.equal(gateProgress({}, { '2026-10-01': { practice: 0, ranked: { solo: { dnf: true } } } }).dailyFinished, false, 'a DNF is not a finish');
  assert.equal(gateProgress({}, { '2026-10-01': { practice: 0, ranked: { pair: { timeMs: 99000 } } } }).dailyFinished, true);
  assert.equal(gateProgress({ 'daily:2026-10-01|adventurous|solo': { timeMs: 90000 } }, {}).dailyFinished, true);
  assert.deepEqual(gateProgress(null, null), { medals: {}, dailyFinished: false });
});

test('#403 gate progress: a helped (🛟) best counts as bronze at most, and a helped daily finish is a finish', () => {
  const m = getMedals('grandma', 'chill');
  const records = { 'grandma|chill|solo': { timeMs: m.gold - 1, helped: true } };
  assert.deepEqual(gateProgress(records, {}).medals, { grandma: 'bronze' });
  assert.equal(gateProgress({ 'daily:2026-10-01|adventurous|solo': { timeMs: 90000, helped: true } }, {}).dailyFinished, true);
});

// ---- Today's Launch (D11b) -----------------------------------------------

test('Today\'s Launch: the same course all day, a different one tomorrow', () => {
  const a = dailyKey(new Date('2026-10-04T12:00:00Z'));
  const b = dailyKey(new Date('2026-10-05T12:00:00Z'));
  assert.notEqual(a, b);
  assert.deepEqual(todaysLaunchCourse(a), todaysLaunchCourse(a));
  assert.equal(todaysLaunchSeed(a), todaysLaunchSeed(a));
  assert.notDeepEqual(todaysLaunchCourse(a), todaysLaunchCourse(b));
  // A week of days: all different from each other.
  const keys = Array.from({ length: 7 }, (_, i) => dailyKey(new Date(Date.UTC(2026, 9, 4 + i, 12))));
  const layouts = new Set(keys.map(k => JSON.stringify(todaysLaunchCourse(k))));
  assert.equal(layouts.size, 7);
  // It is a real course: coins to the end, a jackpot, ramps, all inside one lap.
  const c = todaysLaunchCourse(a);
  assert.ok(c.jackpot && c.ramps.length > 2 && c.coins.length > 20);
  for (const x of c.coins) assert.ok(x.d < TODAYS_LAUNCH_LENGTH + SLING_REST_D);
  assert.ok(TODAYS_LAUNCH_LENGTH + SLING_REST_D < 1200);
});

test('Today\'s Launch: the day\'s best and record bonus, reset by a new day', () => {
  let save = emptySave();
  const k = '2026-10-04';
  let st = todaysLaunchStatus(save, k);
  assert.deepEqual(st, { key: k, best: 0, runs: 0 });
  const first = scoreRun({ distance: 300 }, st, 1);
  assert.equal(first.recordPay, 0, 'no record bonus on the first run of the day');
  save = applyTodaysLaunch(save, k, first);
  st = todaysLaunchStatus(save, k);
  assert.deepEqual(st, { key: k, best: 300, runs: 1 });
  const second = scoreRun({ distance: 400 }, st, 1);
  assert.equal(second.recordPay, 25);
  save = applyTodaysLaunch(save, k, second);
  save = applyTodaysLaunch(save, k, scoreRun({ distance: 100 }, todaysLaunchStatus(save, k), 1));
  assert.equal(todaysLaunchStatus(save, k).best, 400, 'a shorter run keeps the best');
  assert.equal(save.stage, 1, 'Today\'s Launch never moves the stage');
  assert.deepEqual(todaysLaunchStatus(save, '2026-10-05'), { key: '2026-10-05', best: 0, runs: 0 });
  const store = memStore();
  writeSave(store, save);
  assert.deepEqual(loadSave(store).daily, { key: k, best: 400, runs: 3 });
});
