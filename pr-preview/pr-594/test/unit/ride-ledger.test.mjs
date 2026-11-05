// M2 · the regular-ride payout ledger is keyed by RIDE, not by RaceManager.
// A ride runs from the start line, through any restarts, to its finish or
// abandon. game.js keeps the ride in Game._rideRef (a new object per ride, the
// same one across a retry of segment 1, which builds a new RaceManager) and
// pays at the top of _resetGame, before the bike goes back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installEconomyMode } from '../../js/economy-mode.js';
import { RIDE_PAY } from '../../js/economy.js';

globalThis.document = globalThis.document || { getElementById: () => null };

const memStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) };
};

class FakeGame {
  constructor() {
    this.store = memStore();
    this.isSlingshot = false;
    this.mode = 'solo';
    this.lobby = { selectedLevel: { id: 'grandma', distance: 1000 } };
    this.bike = { distanceTraveled: 0 };
    this.collectibleManager = { collected: 0 };
    this.events = [];
  }
  _slingStore() { return this.store; }
  _economyEventLog(type, detail) { this.events.push({ type, ...detail }); }
  /** What game.js does in _startCountdown: a new ride unless it is a retry of segment 1. */
  startRide(sameRide = false) {
    if (!sameRide || !this._rideRef) this._rideRef = {};
    this.raceManager = { id: Math.random() };    // every start builds a new RaceManager
    this.bike.distanceTraveled = 0;
    this.collectibleManager = { collected: 0 };
  }
}
installEconomyMode(FakeGame);
// Capture the economy events instead of dispatching them on window.
FakeGame.prototype._economyEvent = function (type, detail) { this._economyEventLog(type, detail); };

const coins = g => g._loadWallet().coins;

test('M2: an abandon before checkpoint 1 pays its metres', () => {
  const g = new FakeGame();
  g.startRide();
  g.bike.distanceTraveled = 110;
  g._payoutAbandon();               // the top of _resetGame, before fullReset
  assert.equal(coins(g), Math.floor(110 / RIDE_PAY.metresPerCoin));
});

test('M2: a retry of segment 1 does not re-pay re-ridden metres or pickups, and is one ride', () => {
  const g = new FakeGame();
  g.startRide();
  g.bike.distanceTraveled = 110;
  g.collectibleManager.collected = 2;
  g._payoutAbandon();
  const after1 = coins(g);
  // Crash/timeout → back to the start line: same ride, new RaceManager.
  g.startRide(true);
  g.bike.distanceTraveled = 110;
  g.collectibleManager.collected = 2;
  g._payoutAbandon();
  assert.equal(coins(g), after1, 'the same metres and pickups pay nothing twice');
  g.bike.distanceTraveled = 160;
  g._payoutAbandon();
  assert.equal(coins(g) - after1, Math.floor(160 / 5) - Math.floor(110 / 5), 'only the new metres pay');
  const rides = g.events.filter(e => e.type === 'ride' && e.newRide).length;
  assert.equal(rides, 1, 'one ride, not one per attempt');
  // Restart from the beginning (or a new level): a new ride.
  g.startRide(false);
  g.bike.distanceTraveled = 50;
  g._payoutAbandon();
  assert.equal(g.events.filter(e => e.type === 'ride' && e.newRide).length, 2);
});
