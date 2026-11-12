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
//   'dailyLaunch'  { key, distance, best, earned }
//   'stageCleared'  { stage }  (the stage just cleared)
//   'bigAir'        { seconds }
//   'pot'           { stage }  a pot of gold collected (#546)
//   'ride'          { mode, kind, newRide, metres, finished, earned, tokens }
//                   every regular-ride payout (metres/earned/tokens: only what is new)
//   'slingLaunch'   { stage, daily }   the bands let go
//   'slingRun'      { distance, record, pot, fullTrails, straight, daily }
// Pure rules: js/economy.js (scoreRide), js/wallet.js, js/slingshot.js.

import * as analytics from './analytics.js';
import { LEVELS } from './race-config.js';
import * as walletLib from './wallet.js';
import { scoreRide, newLedger, ledgerStep } from './economy.js';
import { COIN, toast } from './slingshot-ui.js';
import { humanTeams } from './versus/versus-bot.js';
import { CollectibleManager } from './collectibles.js';
import { SparkleBurst } from './slingshot-fx.js';
import { planTokenRuns } from './token-runs.js';
import { itemSeed, SALT } from './daily-seed.js';

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

  // ---- #512 · Tandem Tokens on the road ----------------------------------

  /**
   * Lay this ride's token runs (js/token-runs.js) around the presents, pylons
   * and geese the managers just placed, and build their CollectibleManager.
   * `layout` overrides the presents/obstacles (the tutorial places its items
   * later, from TUTORIAL_ITEMS). No tokens in Slingshot (its coins are its
   * own) or Map Tourist (no road line).
   */
  _setupTokens(level, difficultyName, camera, layout = null) {
    if (this.tokenManager) { this.tokenManager.destroy(); this.tokenManager = null; }
    this._tokenPlan = null;
    if (!level || this.isSlingshot || level.isTourist || !this.world || !this.world.roadPath) {
      if (this.hud) this.hud.hideTokens();
      return;
    }
    const pos = items => (items || []).map(it => ({ d: it.absoluteD, offset: it.lateralOffset }));
    const presents = layout ? layout.presents : pos(this.collectibleManager && this.collectibleManager._items);
    const obstacles = layout ? layout.obstacles : pos(this.obstacleManager && this.obstacleManager._items);
    const geese = ((this.geeseManager && this.geeseManager._items) || []).map(g => ({ d: g.homeD ?? g.absoluteD, offset: g.homeLat ?? g.lateralOffset }));
    const rm0 = this.mode === 'versus' ? (this.versusRigs && this.versusRigs[0] && this.versusRigs[0].raceManager) : this.raceManager;
    const checkpoints = rm0 && Array.isArray(rm0.checkpoints) ? rm0.checkpoints.slice() : [];
    // Seeded like the other managers (B-4): the Daily Ride from the day seed
    // with its own salt, so everyone meets the same runs; other roads move
    // with the placement salt the captain shares.
    const seed = itemSeed(level, SALT.tokens, this._placementSalt || 0, level.id.charCodeAt(0) * 3000 + 29);
    const plan = planTokenRuns({ levelId: level.id, distance: level.distance, seed, presents, obstacles, geese, checkpoints });
    this._tokenPlan = plan;
    if (!plan.available) { if (this.hud) this.hud.hideTokens(); return; }
    this.tokenManager = new CollectibleManager(this.scene, this.world.roadPath, { ...level, collectibles: 'tokens' },
      camera, difficultyName, 0, { items: plan.tokens.map(t => ({ d: t.d, offset: t.offset, value: t.value })) });
    if (level.isTutorial) this.tokenManager._tutorialRadius = 2.8;   // as forgiving as the tutorial's presents
    const rms = this.mode === 'versus' ? (this.versusRigs || []).map(r => r.raceManager) : [this.raceManager];
    for (const rm of rms) if (rm) rm.setTokensTotal(plan.available);
    if (this.hud) this.hud.showTokens(plan.available);
  }

  /** Solo / co-op: advance the tokens and pay out any the bike rode through. */
  _updateTokens(dt) {
    if (!this.tokenManager || !this.bike) return;
    const got = this.tokenManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    if (got.length) this._onTokens(got);
    if (this._tokenFx) this._tokenFx.update(dt);
  }

  /**
   * Tokens grabbed this frame (item indices): tally them on the race manager
   * (solo/co-op) or the team rig (versus), burst sparkles at the bike, pop
   * the HUD. No boost — that is the presents' job.
   */
  _onTokens(indices, rig = null) {
    const mgr = this.tokenManager;
    if (!mgr || !indices.length) return;
    let value = 0;
    for (const i of indices) value += (mgr._items[i] && mgr._items[i].value) || 0;
    if (rig) {
      rig.tokens = (rig.tokens || 0) + indices.length;
      rig.tokenValue = (rig.tokenValue || 0) + value;
      if (rig.raceManager) rig.raceManager.setTokens(rig.tokens, rig.tokenValue);
    } else {
      this._syncTokenTally(value);
    }
    const bike = rig ? rig.bike : this.bike;
    if (bike && this.scene) {
      if (!this._tokenFx) this._tokenFx = new SparkleBurst(this.scene);
      const h = bike.heading || 0;
      this._tokenFx.burst({ x: bike.position.x + Math.sin(h) * 1.5, y: bike.position.y + 1.1, z: bike.position.z + Math.cos(h) * 1.5 });
    }
    this._playBeep(1500, 0.05);
    try {
      analytics.trackRideEvent('collectible', bike ? bike.distanceTraveled : 0,
        { collectible_type: 'token', count: indices.length, value, ...(rig ? { team: rig.id } : {}) });
    } catch (_) { /* offline */ }
  }

  /** The solo/co-op token tally, from the manager, onto the race manager and HUD. */
  _syncTokenTally(gained = 0) {
    const mgr = this.tokenManager;
    if (!mgr) return;
    if (this.raceManager) this.raceManager.setTokens(mgr.collected, mgr.collectedValue());
    if (this.hud) this.hud.updateTokens(mgr.collected, mgr.getTotalItems(), gained);
  }

  /** What the current ride has done, for a payout — or null when there is no ride. */
  _rideSnapshot(kind, opts = {}) {
    const level = this.lobby && this.lobby.selectedLevel;
    const tm = this.tokenManager;
    if (this.mode === 'versus') {
      const all = this.versusRigs;
      if (!all || !all.length || !all[0].raceManager) return null;
      // m19: a ?versusbot=1 team pays nothing (it would be AFK-farmable).
      const rigs = humanTeams(all);
      if (!rigs.length) return null;
      const cap = level ? level.distance : Infinity;
      const distance = Math.max(...rigs.map(r => Math.min(cap, r.bike.distanceTraveled || 0)));
      // One device: paid once per race, on the furthest team, plus the finish.
      // #512: every token a human team on this device took pays this wallet.
      const sum = key => rigs.reduce((a, r) => a + (r[key] || 0), 0);
      return { ref: all[0].raceManager, distance, pickups: 0, finished: rigs.some(r => r.finished), mode: 'versus',
               tokens: sum('tokens'), tokenValue: sum('tokenValue'), tokensTotal: tm ? tm.getTotalItems() : 0 };
    }
    if (opts.tutorial) {
      return { ref: this._rideRef || this.raceManager || {}, distance: level ? level.distance : 0,
               pickups: opts.pickups || 0, finished: true, mode: 'tutorial',
               tokens: tm ? tm.collected : 0, tokenValue: tm ? tm.collectedValue() : 0, tokensTotal: tm ? tm.getTotalItems() : 0 };
    }
    if (!this.raceManager || !level) return null;
    const summary = opts.summary;
    // #403: a ride with the Royal Shortcut taken reaches the finish but is paid
    // for its distance and pickups only — no finish bonus, medal or best.
    const skipped = !!(this._helpFlags && this._helpFlags().skipped);
    const finished = kind === 'finish' && !skipped;
    const cap = level.payCapM || level.distance || Infinity;   // payCapM: open-world Tourist (B3)
    const distance = Math.min(cap, kind === 'finish' && summary ? summary.distance
      : (this.bike ? this.bike.distanceTraveled || 0 : 0));
    const pickups = summary && summary.collectibles != null ? summary.collectibles
      : (this.collectibleManager ? this.collectibleManager.collected : (this.raceManager.collectiblesCount || 0));
    // #512: the stoker's finish takes the captain's token numbers (finishStats);
    // everything else reads the local manager.
    const tokens = summary && summary.tokens != null ? summary.tokens : (tm ? tm.collected : 0);
    const tokenValue = summary && summary.tokenValue != null ? summary.tokenValue : (tm ? tm.collectedValue() : 0);
    const tokensTotal = summary && summary.tokensTotal ? summary.tokensTotal : (tm ? tm.getTotalItems() : 0);
    const outcome = finished ? this._lastRecordOutcome : null;
    const mode = this._touristRoute ? 'tourist'
      : level.isTutorial ? 'tutorial'
      : level.isDaily ? 'daily'
      : this.mode;
    // M2: one ledger per ride (Game._rideRef), not per RaceManager — a retry of
    // segment 1 builds a new RaceManager but is the same ride.
    return { ref: this._rideRef || this.raceManager, distance, pickups, finished, tokens, tokenValue, tokensTotal,
             medal: outcome ? outcome.medal : null, newBest: !!(outcome && outcome.isNewBest), mode,
             dailyBonus: finished && level.isDaily ? this._dailyBonusInfo || null : null };
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
    this._dailyBonusInfo = null;
    if (!ride) return null;
    const newRide = !this._rideLedger || this._rideLedger.ref !== ride.ref;
    if (newRide) this._rideLedger = { ref: ride.ref, ledger: newLedger() };
    const step = ledgerStep(this._rideLedger.ledger, ride);
    this._rideLedger.ledger = step.ledger;
    this._loadWallet();
    // #512: no multiplier here — the garage's Token multiplier is Slingshot's.
    const score = scoreRide({ ...step.pay, medal: ride.medal, newBest: ride.newBest,
                              tokens: ride.tokens, tokensTotal: ride.tokensTotal, dailyBonus: ride.dailyBonus });
    if (score.total > 0) {
      this._depositCoins(score.total, { mode: ride.mode, kind });
      try {
        analytics.trackEvent('ride_coins', { mode: ride.mode, kind, earned: score.total, metres: score.metres,
          tokens: score.tokens, tokens_total: score.tokensTotal, token_pay: score.tokenPay, daily_pay: score.dailyPay + score.streakPay });
      } catch (_) { /* offline */ }
    }
    // #401: the ride itself — distance, rides, days, Payday — for the achievements.
    this._economyEvent('ride', { mode: ride.mode, kind, newRide, metres: score.metres,
                                 finished: !!step.pay.finished, earned: score.total, tokens: score.tokenPay });
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
    this._lastRidePayout = p;   // #657: the result card's Tandem Tokens
    if (!box) return [];
    if (!p) { box.innerHTML = ''; box.style.display = 'none'; return []; }
    this._renderRideCoins(box, p.score, p.wallet);
    // The garage lives in Slingshot only, which has its own results screen.
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
    const btn = card.querySelector('uf-button, button');
    card.insertBefore(box, btn || null);
    this._renderRideCoins(box, p.score, p.wallet);
  }

  /**
   * The finish tally for a regular ride (#512): distance, tokens n/N,
   * presents, finish, medal, new best, the Daily Ride bonus and its streak,
   * and the total rolling up to what was earned. The lines of a kit <uf-ledger>.
   */
  _renderRideCoins(box, s, wallet) {
    box.replaceChildren();
    const ledger = /** @type {any} */ (document.createElement('uf-ledger'));
    Object.assign(ledger, { heading: 'Tandem Tokens', unit: COIN });
    ledger.items = rideTallyItems(s);
    ledger.balance = wallet.coins;
    ledger.total = 0;
    box.appendChild(ledger);
    box.style.display = '';
    // Count the total up to what was earned.
    const total = s.total, t0 = performance.now(), DUR = 1100;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / DUR);
      ledger.total = Math.round(total * (1 - Math.pow(1 - k, 3)));
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

/**
 * The tally's lines for a scoreRide() result (#512), pure so it can be tested:
 * distance, tokens n/N (always, when the road has tokens), presents, finish,
 * medal, new best, Daily Ride bonus, streak. Zero lines are left out except
 * the tokens — "0/20" is the point of the line.
 */
export function rideTallyItems(s) {
  const items = [{ label: `Distance (${fmt(s.metres)} m)`, amount: s.distPay }];
  if (s.tokensTotal > 0 || s.tokenPay) items.push({ label: `Tokens (${s.tokens}/${s.tokensTotal})`, amount: s.tokenPay });
  if (s.pickupPay) items.push({ label: `Presents (${s.pickups})`, amount: s.pickupPay });
  if (s.finishPay) items.push({ label: 'Finished', amount: s.finishPay });
  if (s.medalPay) items.push({ label: `${s.medal[0].toUpperCase()}${s.medal.slice(1)} medal`, amount: s.medalPay });
  if (s.bestPay) items.push({ label: 'New best', amount: s.bestPay });
  if (s.dailyPay) items.push({ label: 'First Daily Ride today', amount: s.dailyPay });
  if (s.streakPay) items.push({ label: `Streak (${s.streakDays} days)`, amount: s.streakPay });
  return items;
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
