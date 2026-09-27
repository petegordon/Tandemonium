// ============================================================
// SLINGSHOT UI — garage, results, in-ride strip and pull meter
// ============================================================
//
// DOM only; every number comes from js/slingshot.js. Each render returns the
// buttons in focus order so game.js can hand them to the overlay FocusController.

import { UPGRADES, upgradeCost, stageGoal, slingStats } from './slingshot.js';

const $ = id => document.getElementById(id);
const fmt = n => Math.floor(n).toLocaleString('en-US');
export const COIN = '🪙';

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function pips(level, max) {
  return '●'.repeat(level) + '○'.repeat(max - level);
}

/**
 * The garage. `onBuy(id)` re-renders on success; `onLaunch` / `onLobby` leave.
 * Returns buttons in focus order: launch first, then upgrades, then lobby.
 */
export function renderGarage(save, { onBuy, onLaunch, onLobby }) {
  const root = $('sling-garage');
  root.innerHTML = '';
  const stats = slingStats(save.lv);
  root.appendChild(el('h2', null, '🎯 SLINGSHOT GARAGE'));
  root.appendChild(el('div', 'sling-wallet', `${COIN} ${fmt(save.coins)} Chaos Coins`));
  root.appendChild(el('div', 'sling-sub',
    `Stage ${save.stage}: reach <b>${fmt(stageGoal(save.stage))} m</b>` +
    ` · best ${fmt(save.best)} m · ×${stats.coinMult.toFixed(2)} coins<br>` +
    'Touch and drag back to stretch the slingshot, left or right to aim, and let go. ' +
    'Then steer: sweep the Chaos Coins, do not crash, and reset any time to go ' +
    'back to the slingshot.'));

  const launch = el('button', 'lobby-btn lobby-btn-accent', 'LAUNCH!');
  launch.addEventListener('click', onLaunch);
  const top = el('div', 'sling-buttons');
  top.appendChild(launch);
  root.appendChild(top);

  const list = el('div', 'sling-list');
  const buttons = [launch];
  for (const u of UPGRADES) {
    const lvl = save.lv[u.id] || 0;
    const maxed = lvl >= u.max;
    const price = maxed ? 0 : upgradeCost(u, lvl);
    const b = el('button', 'sling-up',
      `<span class="ico">${u.icon}</span>` +
      `<span class="txt"><b>${u.name}</b><small>${u.desc}</small><br><span class="pips">${pips(lvl, u.max)}</span></span>` +
      `<span class="price">${maxed ? 'MAX' : `${COIN} ${fmt(price)}`}</span>`);
    b.disabled = maxed || save.coins < price;
    b.addEventListener('click', () => onBuy(u.id));
    list.appendChild(b);
    buttons.push(b);
  }
  root.appendChild(list);

  const lobby = el('button', 'lobby-btn', 'LOBBY');
  lobby.addEventListener('click', onLobby);
  const bottom = el('div', 'sling-buttons');
  bottom.appendChild(lobby);
  root.appendChild(bottom);
  buttons.push(lobby);

  root.classList.add('visible');
  return buttons;
}

export function hideGarage() { $('sling-garage').classList.remove('visible'); }

const CAUSE = {
  stall: 'You rolled to a stop',
  crash: 'Chaos! You crashed',
  goal: 'Stage goal reached!',
  jackpot: 'JACKPOT! Double pay',
};

/** One launch's payout. Returns [again, garage, lobby]. */
export function renderResults({ cause, score, run, save, stageCleared }, { onAgain, onGarage, onLobby }) {
  const root = $('sling-results');
  root.innerHTML = '';
  root.appendChild(el('h2', null, CAUSE[cause] || CAUSE.stall));
  root.appendChild(el('div', 'sling-big', `${fmt(score.distance)} m`));
  const badges = el('div');
  if (score.isRecord) badges.appendChild(el('span', 'sling-badge', 'NEW RECORD'));
  if (stageCleared) badges.appendChild(el('span', 'sling-badge', `STAGE ${save.stage - 1} CLEARED`));
  root.appendChild(badges);
  root.appendChild(el('div', 'sling-sub', `Top speed ${Math.round(run.topSpeed * 3.6)} km/h`));

  const rows = el('div', 'sling-rows');
  const row = (label, v, cls = 'row') => rows.appendChild(el('div', cls, `<span>${label}</span><span>${v}</span>`));
  row('Distance', `${COIN} ${fmt(score.distPay)}`);
  row(`Chaos Coins (${run.coins})`, `${COIN} ${fmt(score.coinPay)}`);
  if (score.recordPay) row('Record bonus', `${COIN} ${fmt(score.recordPay)}`);
  if (score.stagePay) row('Stage bonus', `${COIN} ${fmt(score.stagePay)}`);
  if (score.jackpotPay) row('Jackpot', `${COIN} ${fmt(score.jackpotPay)}`);
  if (score.multiplier !== 1) row('Multiplier', `×${score.multiplier.toFixed(2)}`);
  row('Earned', `${COIN} ${fmt(score.total)}`, 'row total');
  root.appendChild(rows);
  root.appendChild(el('div', 'sling-wallet', `Wallet: ${COIN} ${fmt(save.coins)}`));

  const box = el('div', 'sling-buttons');
  const mk = (label, cls, fn) => { const b = el('button', cls, label); b.addEventListener('click', fn); box.appendChild(b); return b; };
  const again = mk('LAUNCH AGAIN', 'lobby-btn lobby-btn-accent', onAgain);
  const garage = mk('GARAGE', 'lobby-btn', onGarage);
  const lobby = mk('LOBBY', 'lobby-btn', onLobby);
  root.appendChild(box);
  root.classList.add('visible');
  // The tap that skipped the tally must not land on LAUNCH AGAIN.
  root.style.pointerEvents = 'none';
  setTimeout(() => { root.style.pointerEvents = ''; }, 400);
  return [again, garage, lobby];
}

export function hideResults() { $('sling-results').classList.remove('visible'); }

// ---- In-ride ------------------------------------------------

let _hudText = '';
/** A Chaos Coin was grabbed: bump the counter and float the payout up from it. */
export function coinPop(amount) {
  const c = document.querySelector('#sling-hud .sling-coins');
  if (c) { c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
  const f = document.createElement('div');
  f.className = 'sling-coin-float';
  f.textContent = `+${amount} ${COIN}`;
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

export function updateHud({ coins, distance, goal }) {
  const hud = $('sling-hud');
  // Built once, then only the text changes — rebuilding the spans would cut
  // the coin counter's pop animation off on the frame it starts.
  if (!hud.querySelector('.sling-coins')) {
    hud.innerHTML = '<span class="sling-coins"></span><span class="sling-togo"></span>';
  }
  const text = `${COIN} ${coins}|🏁 ${fmt(Math.max(0, goal - distance))} m to go`;
  if (text !== _hudText) {
    const [c, g] = text.split('|');
    hud.querySelector('.sling-coins').textContent = c;
    hud.querySelector('.sling-togo').textContent = g;
    _hudText = text;
  }
  hud.classList.add('visible');
}

export function hideHud() {
  $('sling-hud').classList.remove('visible');
  _hudText = '';
}

let _predictText = null;
/** The pull meter, and while pulling, how far this launch should roll. */
export function showPull(pull, { predicted = 0, best = 0 } = {}) {
  const p = $('sling-pull');
  p.classList.add('visible');
  p.classList.toggle('pulling', pull > 0);   // the words are for before you touch it
  p.querySelector('i').style.width = `${Math.round(pull * 100)}%`;
  const text = pull > 0 ? `≈ ${fmt(predicted)} m${best ? ` · best ${fmt(best)} m` : ''}` : '';
  if (text !== _predictText) {
    const el = p.querySelector('.sling-predict');
    if (el) el.textContent = text;
    _predictText = text;
  }
}

export function hidePull() { $('sling-pull').classList.remove('visible'); }

/** Power readout floating ~90 px above the dragging finger, out from under the thumb. */
export function showFinger(x, y, pull, predicted) {
  const f = $('sling-finger');
  if (!f) return;
  f.textContent = `${Math.round(pull * 100)}% · ≈ ${fmt(predicted)} m`;
  f.style.left = `${Math.round(x)}px`;
  f.style.top = `${Math.round(Math.max(8, y - 90))}px`;
  f.classList.add('visible');
}

export function hideFinger() { const f = $('sling-finger'); if (f) f.classList.remove('visible'); }

/** After the first launch the words go; the meter stays. */
export function markLearned() { $('sling-pull').classList.add('learned'); }

let _toastTimer = null;
/** A short centred message (e.g. a cancelled pull). */
export function toast(text) {
  const t = $('sling-toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('visible'), 1100);
}

// ---- End of the ride: the distance, then the coins it earns ---------------

let _tally = null;

/**
 * The end-of-ride signal: the metres count up, then turn into the Chaos
 * Coins they pay. `onTick(kind)` fires as the numbers roll ('m' / 'coin') for
 * sound; `onDone` fires once, after ~2.5 s or on a tap/click/key.
 */
export function showTally({ distance, coins, label = '' }, { onTick = () => {}, onDone = () => {} } = {}) {
  hideTally();
  const root = $('sling-tally');
  root.innerHTML =
    (label ? `<div class="tally-label">${label}</div>` : '') +
    '<div class="tally-dist"><span class="tally-m">0</span> m</div>' +
    `<div class="tally-coins">+<span class="tally-c">0</span> ${COIN}</div>` +
    '<div class="tally-skip">tap to continue</div>';
  root.classList.add('visible');
  const mEl = root.querySelector('.tally-m'), cEl = root.querySelector('.tally-c'), coinRow = root.querySelector('.tally-coins');
  const DIST_S = 1.1, COIN_S = 0.7, HOLD_S = 0.7;
  const t0 = performance.now();
  let lastM = -1, lastC = -1, done = false, raf = 0;
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointerdown', finish, true);
    window.removeEventListener('keydown', finish, true);
    onDone();
  };
  const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
  const frame = () => {
    const t = (performance.now() - t0) / 1000;
    const m = Math.round(distance * ease(t / DIST_S));
    if (m !== lastM) { mEl.textContent = fmt(m); if (Math.floor(m / 25) !== Math.floor(lastM / 25)) onTick('m'); lastM = m; }
    if (t >= DIST_S) {
      coinRow.classList.add('shown');
      const c = Math.round(coins * ease((t - DIST_S) / COIN_S));
      if (c !== lastC) { cEl.textContent = fmt(c); if (Math.floor(c / 10) !== Math.floor(lastC / 10)) onTick('coin'); lastC = c; }
    }
    if (t >= DIST_S + COIN_S + HOLD_S) { finish(); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  // A tap skips to the results, which carry the same totals (and more).
  setTimeout(() => {
    window.addEventListener('pointerdown', finish, true);
    window.addEventListener('keydown', finish, true);
  }, 300);
  _tally = { finish };
}

export function hideTally() {
  const root = $('sling-tally');
  if (root) root.classList.remove('visible');
  _tally = null;
}
