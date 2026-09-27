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
  return [again, garage, lobby];
}

export function hideResults() { $('sling-results').classList.remove('visible'); }

// ---- In-ride ------------------------------------------------

let _hudText = '';
export function updateHud({ coins, distance, goal }) {
  const hud = $('sling-hud');
  const text = `<span class="sling-coins">${COIN} ${coins}</span>` +
    `<span>🏁 ${fmt(Math.max(0, goal - distance))} m to go</span>`;
  if (text !== _hudText) { hud.innerHTML = text; _hudText = text; }
  hud.classList.add('visible');
}

export function hideHud() {
  $('sling-hud').classList.remove('visible');
  _hudText = '';
}

export function showPull(pull) {
  const p = $('sling-pull');
  p.classList.add('visible');
  p.classList.toggle('pulling', pull > 0);   // the words are for before you touch it
  p.querySelector('i').style.width = `${Math.round(pull * 100)}%`;
}

export function hidePull() { $('sling-pull').classList.remove('visible'); }

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
