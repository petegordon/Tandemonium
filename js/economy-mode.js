// ============================================================
// ECONOMY MODE — every ride pays, one wallet, one garage (#400 D4)
// ============================================================
//
// Game methods, installed like js/slingshot-mode.js, so game.js only holds
// one-line call sites:
//   _showVictory      → _showRideCoins('victory', 'finish', { summary })
//   _showGameOver     → _showRideCoins('gameover', 'crash')
//   _tutorialComplete → _showRideCoins('tutorial', 'finish', …)
//   versus results    → _showVersusCoins()
//   _resetGame (top) / _startCountdown (top) / _returnToLobby / _returnToRoom
//                     → _payoutRide('abandon')
//
// HOOK FOR ACHIEVEMENTS (#401): every economy event goes through ONE method,
// _economyEvent(type, detail), which also dispatches a window CustomEvent
// 'tandemonium:economy' with { type, ...detail }. Types:
//   'coins'         { amount, mode, kind, total }  every deposit, every mode
//   'upgrade'       { id, level, price }
//   'rebuild'       { rebuilds }
//   'todaysLaunch'  { key, distance, best, earned }
//   'stageCleared'  { stage }  (the stage just cleared)
//   'bigAir'        { seconds }
//   'jackpot'       { stage }
//   'ride'          { mode, kind, newRide, metres, finished, earned }  every
//                   regular-ride payout (metres/earned: only what is new)
//   'slingLaunch'   { stage, daily }   the bands let go
//   'slingRun'      { distance, record, jackpot, fullTrails, straight, daily }
// Pure rules: js/economy.js (scoreRide), js/wallet.js, js/slingshot.js.

import * as analytics from './analytics.js';
import { LEVELS } from './race-config.js';
import * as walletLib from './wallet.js';
import { scoreRide, newLedger, ledgerStep } from './economy.js';
import { COIN, toast } from './slingshot-ui.js';

const fmt = n => Math.floor(n).toLocaleString('en-US');

class EconomyMode {
  /** The one place economy events leave the economy. See the header. */
  _economyEvent(type, detail = {}) {
    try {
      if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('tandemonium:economy', { detail: { type, ...detail } }));
      }
    } catch (_) { /* never let a listener break a payout */ }
  }

  /** The wallet, fresh from storage (migrating an old Slingshot save first). */
  _loadWallet() {
    this._wallet = walletLib.loadWallet(this._slingStore());
    return this._wallet;
  }

  /** Bank coins in the one wallet. Every mode deposits through here. */
  _depositCoins(amount, detail = {}) {
    const w = walletLib.deposit(this._loadWallet(), amount);
    walletLib.writeWallet(this._slingStore(), w);
    this._wallet = w;
    if (amount > 0) this._economyEvent('coins', { amount: Math.floor(amount), total: w.coins, ...detail });
    return w;
  }

  /** What the current ride has done, for a payout — or null when there is no ride. */
  _rideSnapshot(kind, opts = {}) {
    const level = this.lobby && this.lobby.selectedLevel;
    if (this.mode === 'versus') {
      const rigs = this.versusRigs;
      if (!rigs || !rigs.length || !rigs[0].raceManager) return null;
      const cap = level ? level.distance : Infinity;
      const distance = Math.max(...rigs.map(r => Math.min(cap, r.bike.distanceTraveled || 0)));
      // One device: paid once per race, on the furthest team, plus the finish.
      return { ref: rigs[0].raceManager, distance, pickups: 0, finished: rigs.some(r => r.finished), mode: 'versus' };
    }
    if (opts.tutorial) {
      return { ref: this._rideRef || this.raceManager || {}, distance: level ? level.distance : 0,
               pickups: opts.pickups || 0, finished: true, mode: 'tutorial' };
    }
    if (!this.raceManager || !level) return null;
    const summary = opts.summary;
    // #403: a ride with the Royal Shortcut taken reaches the finish but is paid
    // for its distance and pickups only — no finish bonus, medal or best.
    const skipped = !!(this._helpFlags && this._helpFlags().skipped);
    const finished = kind === 'finish' && !skipped;
    const cap = level.distance || Infinity;
    const distance = Math.min(cap, kind === 'finish' && summary ? summary.distance
      : (this.bike ? this.bike.distanceTraveled || 0 : 0));
    const pickups = summary && summary.collectibles != null ? summary.collectibles
      : (this.collectibleManager ? this.collectibleManager.collected : (this.raceManager.collectiblesCount || 0));
    const outcome = finished ? this._lastRecordOutcome : null;
    const mode = this._touristRoute ? 'tourist'
      : level.isTutorial ? 'tutorial'
      : level.isDaily ? (this._rankedRunActive ? 'daily-ranked' : 'daily')
      : this.mode;
    // M2: one ledger per ride (Game._rideRef), not per RaceManager — a retry of
    // segment 1 builds a new RaceManager but is the same ride.
    return { ref: this._rideRef || this.raceManager, distance, pickups, finished,
             medal: outcome ? outcome.medal : null, newBest: !!(outcome && outcome.isNewBest), mode };
  }

  /**
   * THE payout for every regular ride (#400 D4). kind: 'finish' | 'crash' |
   * 'abandon'. A ride can pay more than once (a game-over, RESTART, then the
   * finish); the ledger makes each metre, pickup and bonus pay once.
   * Slingshot pays through its own scoreRun (js/slingshot-mode.js).
   * @returns {{ score, wallet } | null}
   */
  _payoutRide(kind, opts = {}) {
    if (this.isSlingshot) return null;
    const ride = this._rideSnapshot(kind, opts);
    this._lastRecordOutcome = null;
    if (!ride) return null;
    const newRide = !this._rideLedger || this._rideLedger.ref !== ride.ref;
    if (newRide) this._rideLedger = { ref: ride.ref, ledger: newLedger() };
    const step = ledgerStep(this._rideLedger.ledger, ride);
    this._rideLedger.ledger = step.ledger;
    const w = this._loadWallet();
    const score = scoreRide({ ...step.pay, medal: ride.medal, newBest: ride.newBest, multiplier: walletLib.coinMultiplier(w) });
    if (score.total > 0) {
      this._depositCoins(score.total, { mode: ride.mode, kind });
      try { analytics.trackEvent('ride_coins', { mode: ride.mode, kind, earned: score.total, metres: score.metres }); } catch (_) { /* offline */ }
    }
    // #401: the ride itself — distance, rides, days, Payday — for the achievements.
    this._economyEvent('ride', { mode: ride.mode, kind, newRide, metres: score.metres,
                                 finished: !!step.pay.finished, earned: score.total });
    return { score, wallet: this._wallet };
  }

  /** A ride left without an end screen still pays its distance; say so briefly. */
  _payoutAbandon() {
    const p = this._payoutRide('abandon');
    if (p && p.score.total > 0) toast(`+${fmt(p.score.total)} ${COIN} for the ride`);
  }

  /**
   * Pay this ride and show the coin tally on an end screen ('victory' |
   * 'gameover' | 'tutorial'). Returns the GARAGE → button when it is shown,
   * for the overlay's gamepad focus list.
   */
  _showRideCoins(which, kind, opts = {}) {
    const box = this._rideCoinsBox(which);
    const garage = document.getElementById('btn-' + which + '-garage');
    if (garage) garage.style.display = 'none';
    const p = this._payoutRide(kind, opts);
    if (!box) return [];
    if (!p) { box.innerHTML = ''; box.style.display = 'none'; return []; }
    this._renderRideCoins(box, p.score, p.wallet);
    // The garage is a solo screen: leaving a shared ride for it would end the
    // ride for the partner too.
    if (garage && !this.net && this.mode !== 'versus') {
      garage.style.display = '';
      return [garage];
    }
    return [];
  }

  _rideCoinsBox(which) {
    if (which === 'tutorial') {
      const stats = document.getElementById('tutorial-complete-stats');
      if (!stats) return null;
      const box = document.createElement('div');
      box.className = 'ride-coins';
      stats.appendChild(box);
      return box;
    }
    return document.getElementById(which + '-coins');
  }

  /** Versus: one payout per race, on the results card. */
  _showVersusCoins() {
    const card = this.versusHud && this.versusHud.resultsEl && this.versusHud.resultsEl.querySelector('.vr-card');
    const p = this._payoutRide('finish');
    if (!card || !p) return;
    const box = document.createElement('div');
    box.className = 'ride-coins';
    const btn = card.querySelector('button');
    card.insertBefore(box, btn || null);
    this._renderRideCoins(box, p.score, p.wallet);
  }

  /**
   * The Slingshot tally's look for a regular ride: metres → coins, pickups,
   * bonuses, the multiplier, and the count rolling up to what was earned.
   */
  _renderRideCoins(box, s, wallet) {
    const rows = [];
    const row = (label, v, cls = 'row') => rows.push(`<div class="${cls}"><span>${label}</span><span>${v}</span></div>`);
    row(`Distance (${fmt(s.metres)} m)`, `${COIN} ${fmt(s.distPay)}`);
    if (s.pickupPay) row(`Pickups (${s.pickups})`, `${COIN} ${fmt(s.pickupPay)}`);
    if (s.finishPay) row('Finished', `${COIN} ${fmt(s.finishPay)}`);
    if (s.medalPay) row(`${s.medal[0].toUpperCase()}${s.medal.slice(1)} medal`, `${COIN} ${fmt(s.medalPay)}`);
    if (s.bestPay) row('New best', `${COIN} ${fmt(s.bestPay)}`);
    if (s.multiplier !== 1) row('Multiplier', `×${s.multiplier.toFixed(2)}`);
    row('Earned', `${COIN} <span class="ride-coins-earned">0</span>`, 'row total');
    box.innerHTML =
      `<div class="ride-coins-head">+<span class="ride-coins-big">0</span> ${COIN} Chaos Coins</div>` +
      `<div class="sling-rows">${rows.join('')}</div>` +
      `<div class="ride-coins-wallet">Wallet: ${COIN} ${fmt(wallet.coins)}</div>`;
    box.style.display = '';
    const big = box.querySelector('.ride-coins-big'), earned = box.querySelector('.ride-coins-earned');
    const total = s.total, t0 = performance.now(), DUR = 1100;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / DUR);
      const v = fmt(Math.round(total * (1 - Math.pow(1 - k, 3))));
      big.textContent = v;
      earned.textContent = v;
      if (k < 1 && box.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** GARAGE → from an end screen: end the ride like END RIDE, then the garage. */
  _openGarageFromRide(which) {
    if (which === 'victory') this._hideVictory(); else this._hideGameOver();
    if (analytics.getCurrentRideId()) {
      analytics.endRide({ completed: false, abandon_reason: 'garage', distance: this.bike ? this.bike.distanceTraveled : 0 });
    }
    this._returnToLobby();
    this.lobby._hideLobby();
    this._openSlingGarage(0, { standalone: true });
  }

  /** The lobby's GARAGE button: the one garage, without a launch. */
  _openGarageFromLobby() {
    this._openSlingGarage(0, { standalone: true });
    analytics.trackEvent('garage_open', { from: 'lobby' });
  }

  /** A stage gate's "RIDE GRANDMA'S →": back to the lobby with that level picked. */
  _goRideLevel(levelId) {
    this._clearOverlayButtons();
    this._returnToLobby();
    const card = document.querySelector('#level-cards .level-card[data-level-id="' + levelId + '"]:not(.level-locked)');
    if (card) card.click();
    else if (LEVELS.some(l => l.id === levelId)) this.lobby.selectedLevel = LEVELS.find(l => l.id === levelId);
    const solo = document.getElementById('btn-solo');
    if (solo) solo.click();
  }

  /** Wire the end screens' GARAGE → buttons once. */
  _wireEconomyButtons() {
    for (const which of ['victory', 'gameover']) {
      this._onTap('btn-' + which + '-garage', () => this._openGarageFromRide(which));
    }
  }
}

/** Copy the methods onto Game's prototype (they run as Game methods). */
export function installEconomyMode(GameClass) {
  for (const key of Object.getOwnPropertyNames(EconomyMode.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(GameClass.prototype, key)) {
      throw new Error(`economy-mode: Game already has ${key}`);
    }
    Object.defineProperty(GameClass.prototype, key, Object.getOwnPropertyDescriptor(EconomyMode.prototype, key));
  }
}
