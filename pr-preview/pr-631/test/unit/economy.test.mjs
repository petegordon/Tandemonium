// #400 D4/D5/D11 · one wallet, every mode pays, stage gates, Today's Launch, prestige.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLET_KEY, WALLET_VERSION, emptyWallet, loadWallet, writeWallet, deposit, coinMultiplier,
  prestigeBonus, canRebuild, rebuild, REBUILD_BONUS, REBUILD_CAP, sanitizeWallet,
} from '../../js/wallet.js';
import {
  STORAGE_KEY as SLING_KEY, UPGRADES, upgradeCost, buyUpgrade, loadSave, writeSave, emptySave,
  STAGE_GATES, stageLock, dailyLaunchCourse, dailyLaunchSeed, dailyLaunchStatus, applyDailyLaunch,
  DAILY_LAUNCH_LENGTH, SLING_REST_D, scoreRun, upgradeGain, slingStats, predictCoast, spentOn,
} from '../../js/slingshot.js';
import { scoreRide, RIDE_PAY, newLedger, ledgerStep, gateProgress, dailyBonus } from '../../js/economy.js';
import { rideTallyItems } from '../../js/economy-mode.js';
import { TOKEN_VALUE, DOUBLE_VALUE } from '../../js/token-runs.js';
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
  assert.equal(upgradeGain({}, 'magnet'), 0, 'the Token multiplier buys tokens, not metres');
  assert.equal(upgradeGain({ sling: 10 }, 'sling'), 0, 'maxed');
  const lv = { sling: 2 };
  assert.ok(Math.abs(upgradeGain(lv, 'sling') -
    (predictCoast(slingStats({ sling: 3 }), 1, 'dirt') - predictCoast(slingStats(lv), 1, 'dirt'))) < 1e-9);
});

// ---- Regular rides pay (D4, re-tabled by #512) -----------------------------

test('#512 pay table: 1 per 10 m, presents 5, tokens 5 (late run 10), finish 25, medals 25/50/100, best 50, daily 50 + streak', () => {
  assert.equal(RIDE_PAY.metresPerCoin, 10);
  assert.equal(RIDE_PAY.perPickup, 5);
  assert.equal(RIDE_PAY.token, 5);
  assert.equal(RIDE_PAY.finish, 25);
  assert.deepEqual(RIDE_PAY.medal, { bronze: 25, silver: 50, gold: 100 });
  assert.equal(RIDE_PAY.newBest, 50);
  assert.equal(RIDE_PAY.dailyFirst, 50);
  assert.equal(RIDE_PAY.streakPerDay, 10);
  assert.equal(RIDE_PAY.streakCap, 100);
  assert.equal(TOKEN_VALUE, RIDE_PAY.token, 'the planner and the pay table agree on a token');
  assert.equal(DOUBLE_VALUE, 2 * TOKEN_VALUE);
});

test('scoreRide: distance, tokens, presents, finish, medal, new best — and no multiplier', () => {
  const r = scoreRide({ distance: 250, pickups: 6, tokens: 12, tokensTotal: 20, tokenValue: 65, finished: true, medal: 'silver', newBest: true });
  assert.equal(r.distPay, 25, '250 m at 1 per 10 m');
  assert.equal(r.pickupPay, 30);
  assert.equal(r.tokenPay, 65, 'tokens pay their pickup value (5 each, 10 on the late run)');
  assert.deepEqual([r.tokens, r.tokensTotal], [12, 20], 'for the "n/N" line');
  assert.equal(r.finishPay, RIDE_PAY.finish);
  assert.equal(r.medalPay, 50);
  assert.equal(r.bestPay, 50);
  assert.equal(r.dailyPay + r.streakPay, 0, 'not a Daily Ride');
  assert.equal(r.total, 25 + 30 + 65 + 25 + 50 + 50);
  // The garage multiplier is Slingshot's now: a stray `multiplier` changes nothing.
  const stray = scoreRide({ distance: 250, pickups: 6, tokenValue: 65, finished: true, medal: 'silver', newBest: true, multiplier: 3 });
  assert.equal(stray.total, r.total);
  assert.equal(stray.multiplier, undefined);
  assert.equal(scoreRide({ distance: 250, finished: true, medal: 'gold' }).medalPay, 100);
  assert.equal(scoreRide({ distance: 250, finished: true, medal: 'bronze' }).medalPay, 25);
});

test('scoreRide: a crashed or abandoned ride still pays its distance and what it picked up, nothing more', () => {
  const r = scoreRide({ distance: 137, pickups: 2, tokenValue: 25, finished: false, medal: 'gold', newBest: true, dailyBonus: { firstToday: true, streak: 5 } });
  assert.equal(r.distPay, 13);
  assert.equal(r.finishPay + r.medalPay + r.bestPay + r.dailyPay + r.streakPay, 0, 'no finish, no finish bonuses, no daily bonus');
  assert.equal(r.total, 13 + 10 + 25);
  assert.equal(scoreRide({}).total, 0);
});

test('#512 what the roads pay: a clean Grandma\'s ~120-200, a Daily Ride ~200-300, no medal needed', () => {
  // Grandma's, 250 m: every token (3 runs at 5 + the double run) and 6 presents is the ceiling;
  // a typical ride (half the tokens, 3 presents) sits in #574's 120-200.
  const perfect = scoreRide({ distance: 250, pickups: 6, tokenValue: 3 * 25 + 50, finished: true });
  assert.equal(perfect.total, 25 + 30 + 125 + 25);
  const grandma = scoreRide({ distance: 250, pickups: 3, tokenValue: 60, finished: true });
  assert.ok(grandma.total >= 120 && grandma.total <= 200, `Grandma's pays ${grandma.total}`);
  // A Daily Ride, 500 m, first of the day with a 3-day streak: every token (7 runs + the double) and
  // 12 presents is the ceiling; a typical ride (half the tokens, 6 presents) sits in #574's 200-300.
  const ceiling = scoreRide({ distance: 500, pickups: 12, tokenValue: 7 * 25 + 50, finished: true, dailyBonus: { firstToday: true, streak: 3 } });
  assert.equal(ceiling.total, 50 + 60 + 225 + 25 + 50 + 20);
  const daily = scoreRide({ distance: 500, pickups: 6, tokenValue: 110, finished: true, dailyBonus: { firstToday: true, streak: 3 } });
  assert.ok(daily.total >= 200 && daily.total <= 300, `a Daily Ride pays ${daily.total}`);
  // Surviving alone pays little: collecting is where the money is.
  assert.equal(scoreRide({ distance: 500, finished: true }).total, 50 + 25);
});

test('one Grandma\'s finish still buys the first Slingshot level (target: 1 ride)', () => {
  const cheapest = Math.min(...UPGRADES.map(u => upgradeCost(u, 0)));
  // 250 m, no medal, no presents, no tokens: the worst finish.
  assert.ok(scoreRide({ distance: 250, finished: true }).total >= cheapest);
  // The tutorial (150 m) with its one run of tokens does too.
  assert.ok(scoreRide({ distance: 150, tokenValue: 25, finished: true }).total >= cheapest);
});

test('#512 daily habit: +50 for the first Daily Ride finished today, +10 a streak day beyond the first, capped at +100', () => {
  assert.deepEqual(dailyBonus(), { first: 0, streakDays: 0, streakPay: 0 });
  assert.deepEqual(dailyBonus({ firstToday: false, streak: 9 }), { first: 0, streakDays: 0, streakPay: 0 }, 'a second ride today pays no bonus');
  assert.deepEqual(dailyBonus({ firstToday: true, streak: 1 }), { first: 50, streakDays: 1, streakPay: 0 }, 'day 1: the first-ride bonus alone');
  assert.deepEqual(dailyBonus({ firstToday: true, streak: 2 }), { first: 50, streakDays: 2, streakPay: 10 });
  assert.deepEqual(dailyBonus({ firstToday: true, streak: 11 }), { first: 50, streakDays: 11, streakPay: 100 });
  assert.deepEqual(dailyBonus({ firstToday: true, streak: 40 }), { first: 50, streakDays: 40, streakPay: 100 }, 'capped');
  const r = scoreRide({ distance: 500, finished: true, dailyBonus: { firstToday: true, streak: 4 } });
  assert.equal(r.dailyPay, 50);
  assert.equal(r.streakDays, 4);
  assert.equal(r.streakPay, 30);
  assert.equal(r.total, 50 + 25 + 50 + 30);
  assert.equal(scoreRide({ distance: 500, finished: false, dailyBonus: { firstToday: true, streak: 4 } }).dailyPay, 0, 'only a finish');
});

test('#512 finishedToday: practice or a non-DNF ranked run; a DNF is not a finish', async () => {
  const { recordPractice, recordRanked, finishedToday, STORAGE_KEY } = await import('../../js/daily-ride.js');
  const store = memStore();
  const k = '2026-11-04';
  assert.equal(finishedToday(store, k), false);
  recordRanked(store, k, 'solo', { dnf: true, distance: 120 });
  assert.equal(finishedToday(store, k), false, 'a ranked DNF');
  recordPractice(store, k, 90000);
  assert.equal(finishedToday(store, k), true);
  assert.equal(finishedToday(store, '2026-11-05'), false, 'tomorrow is a new day');
  const s2 = memStore();
  recordRanked(s2, k, 'pair', { timeMs: 100000, distance: 500 });
  assert.equal(finishedToday(s2, k), true);
  assert.ok(STORAGE_KEY);
});

test('ledger: a game-over, a restart and the finish pay each metre and each token once', () => {
  let L = newLedger('ride-1');
  let s = ledgerStep(L, { distance: 140, pickups: 3, tokenValue: 25 });
  assert.deepEqual(s.pay, { distance: 140, paidDistance: 0, pickups: 3, tokenValue: 25, finished: false });
  L = s.ledger;
  // RESTART from the 125 m checkpoint; pickups and tokens after it were taken back and re-collected.
  s = ledgerStep(L, { distance: 130, pickups: 3, tokenValue: 15 });
  assert.equal(scoreRide(s.pay).total, 0, 'nothing new, nothing paid');
  L = s.ledger;
  s = ledgerStep(L, { distance: 250, pickups: 5, tokenValue: 100, finished: true });
  assert.deepEqual(s.pay, { distance: 250, paidDistance: 140, pickups: 2, tokenValue: 75, finished: true });
  const r = scoreRide(s.pay);
  assert.equal(r.distPay, 25 - 14);
  assert.equal(r.tokenPay, 75);
  assert.equal(r.metres, 110);
  L = s.ledger;
  assert.equal(ledgerStep(L, { distance: 250, pickups: 5, tokenValue: 100, finished: true }).pay.finished, false, 'finish pays once');
  // An old ledger without the token field still steps.
  assert.equal(ledgerStep({ id: 'x', distance: 10, pickups: 0, finished: false }, { distance: 20, tokenValue: 5 }).pay.tokenValue, 5);
});

test('#512 the Token multiplier and the prestige bonus multiply Slingshot pay only', () => {
  const w = { ...emptyWallet(), lv: { magnet: 4 }, rebuilds: 2 };
  assert.equal(prestigeBonus(w), 1 + 2 * REBUILD_BONUS);
  assert.ok(Math.abs(coinMultiplier(w) - 2 * 1.2) < 1e-9);
  assert.equal(coinMultiplier(emptyWallet()), 1);
  // Slingshot's scoreRun takes it…
  assert.equal(scoreRun({ distance: 100 }, emptySave(), coinMultiplier(w)).total, Math.floor(50 * 2.4));
  // …a regular ride never does, whatever the wallet holds.
  assert.equal(scoreRide({ distance: 250, finished: true, multiplier: coinMultiplier(w) }).total,
               scoreRide({ distance: 250, finished: true }).total);
  assert.equal(UPGRADES.find(u => u.id === 'magnet').name, 'Token multiplier');
  assert.match(UPGRADES.find(u => u.id === 'magnet').desc, /Slingshot/);
});

test('#512 the finish tally lists every line: distance, tokens n/N, presents, finish, medal, new best, daily bonus, streak', () => {
  const s = scoreRide({ distance: 500, pickups: 4, tokens: 30, tokensTotal: 40, tokenValue: 175, finished: true, medal: 'gold', newBest: true,
                        dailyBonus: { firstToday: true, streak: 3 } });
  const items = rideTallyItems(s);
  assert.deepEqual(items.map(i => i.label), ['Distance (500 m)', 'Tokens (30/40)', 'Presents (4)', 'Finished', 'Gold medal', 'New best',
                                              'First Daily Ride today', 'Streak (3 days)']);
  assert.equal(items.reduce((a, i) => a + i.amount, 0), s.total, 'the lines add up to the total');
  assert.ok(items.every(i => i.display === undefined), 'no multiplier line any more');
  // A crash on a road with tokens still shows the tokens line, at 0 when none were taken.
  const crash = rideTallyItems(scoreRide({ distance: 90, tokens: 0, tokensTotal: 20 }));
  assert.deepEqual(crash.map(i => i.label), ['Distance (90 m)', 'Tokens (0/20)']);
  // A road without tokens (Tourist) has no tokens line.
  assert.deepEqual(rideTallyItems(scoreRide({ distance: 90 })).map(i => i.label), ['Distance (90 m)']);
});

// ---- Prestige (D11c) -------------------------------------------------------

test('B5: the rebuild bonus stops at REBUILD_CAP (5) rebuilds, +50 %', () => {
  assert.equal(REBUILD_CAP, 5);
  const at = n => prestigeBonus({ ...emptyWallet(), rebuilds: n });
  assert.ok(Math.abs(at(5) - 1.5) < 1e-9);
  assert.equal(at(6), at(5));
  assert.equal(at(40), at(5));
  assert.ok(at(4) < at(5));
  // Rebuilding past the cap is still allowed (it just adds nothing).
  const r = rebuild({ ...emptyWallet(), lv: maxed(), rebuilds: 7 });
  assert.ok(r.ok);
  assert.equal(r.wallet.rebuilds, 8);
});

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

test('M3: a slower unaided finish never re-locks a stage, and is not paid NEW BEST', async () => {
  const { recordRun, capMedal, medalFor } = await import('../../js/records.js');
  const m = getMedals('grandma', 'adventurous');
  const medalOf = rec => capMedal(medalFor(rec.timeMs, m), { helped: !!rec.helped });
  const store = {};
  const k = 'grandma|adventurous|solo';
  // A helped bronze opens stage 4…
  recordRun(store, k, { timeMs: m.gold - 1000, helped: true, medal: 'bronze' }, { medalOf });
  assert.equal(stageLock(4, gateProgress(store, {})), null);
  // …then an unaided finish 61 s slower with no medal replaces the 🛟 best.
  const slow = recordRun(store, k, { timeMs: m.bronze + 61000, medal: null }, { medalOf });
  assert.equal(slow.replacedHelped, true);
  assert.equal(slow.faster, false, 'slower: no NEW BEST pay');
  assert.equal(store[k].bestMedal, 'bronze', 'the best medal ever is kept');
  assert.equal(stageLock(4, gateProgress(store, {})), null, 'stage 4 stays open');
  // A faster run is a paid best and can raise the medal.
  const fast = recordRun(store, k, { timeMs: m.gold - 1, medal: 'gold' }, { medalOf });
  assert.equal(fast.faster, true);
  assert.equal(store[k].bestMedal, 'gold');
  assert.equal(stageLock(7, gateProgress(store, {})), null);
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
  assert.deepEqual(dailyLaunchCourse(a), dailyLaunchCourse(a));
  assert.equal(dailyLaunchSeed(a), dailyLaunchSeed(a));
  assert.notDeepEqual(dailyLaunchCourse(a), dailyLaunchCourse(b));
  // A week of days: all different from each other.
  const keys = Array.from({ length: 7 }, (_, i) => dailyKey(new Date(Date.UTC(2026, 9, 4 + i, 12))));
  const layouts = new Set(keys.map(k => JSON.stringify(dailyLaunchCourse(k))));
  assert.equal(layouts.size, 7);
  // It is a real course: coins to the end, a pot of gold, ramps, all inside one lap.
  const c = dailyLaunchCourse(a);
  assert.ok(c.pot && c.ramps.length > 2 && c.coins.length > 20);
  for (const x of c.coins) assert.ok(x.d < DAILY_LAUNCH_LENGTH + SLING_REST_D);
  assert.ok(DAILY_LAUNCH_LENGTH + SLING_REST_D < 1200);
});

test('Today\'s Launch: the day\'s best and record bonus, reset by a new day', () => {
  let save = emptySave();
  const k = '2026-10-04';
  let st = dailyLaunchStatus(save, k);
  assert.deepEqual(st, { key: k, best: 0, runs: 0, jackpot: false });
  const first = scoreRun({ distance: 300 }, st, 1);
  assert.equal(first.recordPay, 0, 'no record bonus on the first run of the day');
  save = applyDailyLaunch(save, k, first);
  st = dailyLaunchStatus(save, k);
  assert.deepEqual(st, { key: k, best: 300, runs: 1, jackpot: false });
  const second = scoreRun({ distance: 400 }, st, 1);
  assert.equal(second.recordPay, 25);
  save = applyDailyLaunch(save, k, second);
  save = applyDailyLaunch(save, k, scoreRun({ distance: 100 }, dailyLaunchStatus(save, k), 1));
  assert.equal(dailyLaunchStatus(save, k).best, 400, 'a shorter run keeps the best');
  assert.equal(save.stage, 1, 'Today\'s Launch never moves the stage');
  assert.deepEqual(dailyLaunchStatus(save, '2026-10-05'), { key: '2026-10-05', best: 0, runs: 0, jackpot: false });
  const store = memStore();
  writeSave(store, save);
  assert.deepEqual(loadSave(store).daily, { key: k, best: 400, runs: 3 });
});
