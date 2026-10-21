// @ts-check
// ============================================================
// <uf-ledger> — what you earned: line items, a total, and a balance.
// ============================================================
//
//   <uf-ledger heading="Chaos Coins" unit="🪙"></uf-ledger>
//   ledger.items = [{ label: 'Distance (40 m)', amount: 8 }, { label: 'Pickups (1)', amount: 5 }];
//   ledger.balance = 138;          // optional "Wallet" line
//
// Data in, markup out. The total is the sum of the items unless `total` is
// set; the header reads "+13 🪙 Chaos Coins". Amounts are tabular so the
// column lines up. Generic: coins, points, XP — the unit and words are the app's.
//
// Replaces: the game's end-of-ride coin breakdown (.ride-coins / .rc-*) on
// game over, victory, versus results and the slingshot tally.

import { UfElement, prop, esc } from '../uf-element.js';

/** @typedef {{ label: string, amount: number }} LedgerItem */

export class UfLedger extends UfElement {
  /** @override */ static tag = 'uf-ledger';

  /** @override */ static props = {
    heading: prop.string(''),
    unit: prop.string(''),
    totalLabel: prop.string('Earned'),
    balanceLabel: prop.string('Wallet'),
  };

  /** @override */ static styles = `
    uf-ledger { display: grid; gap: var(--uf-space-1); min-width: min(100%, 18em); font-family: var(--uf-font-ui); color: var(--uf-color-fg); font-variant-numeric: tabular-nums; }
    uf-ledger .ul-head { text-align: center; font: 800 var(--uf-size-lg)/1.2 var(--uf-font-ui); color: var(--uf-color-accent-2); margin-bottom: var(--uf-space-1); }
    uf-ledger .ul-row { display: flex; justify-content: space-between; gap: var(--uf-space-4); font-size: var(--uf-size-sm); padding: .2em 0; border-bottom: 1px solid var(--uf-color-line-soft); }
    uf-ledger .ul-row b { font-weight: 600; }
    uf-ledger .ul-total { font-weight: 800; color: var(--uf-color-accent-2); border-bottom: none; font-size: var(--uf-size-md); }
    uf-ledger .ul-balance { text-align: center; font-size: var(--uf-size-xs); color: var(--uf-color-fg-muted); margin-top: var(--uf-space-1); }
  `;

  /** @type {LedgerItem[]} */ #items = [];
  /** @type {number|null} */ #total = null;
  /** @type {number|null} */ #balance = null;

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }
  /** @returns {string} */ get unit() { return this.get('unit'); }
  /** @param {string} v */ set unit(v) { this.set('unit', v); }
  /** @returns {string} */ get totalLabel() { return this.get('totalLabel'); }
  /** @param {string} v */ set totalLabel(v) { this.set('totalLabel', v); }
  /** @returns {string} */ get balanceLabel() { return this.get('balanceLabel'); }
  /** @param {string} v */ set balanceLabel(v) { this.set('balanceLabel', v); }

  /** @returns {LedgerItem[]} */ get items() { return this.#items; }
  /** @param {LedgerItem[]} v */ set items(v) { this.#items = Array.isArray(v) ? v : []; this.requestUpdate(); }
  /** Explicit total (defaults to the sum of the items). @returns {number} */
  get total() { return this.#total ?? this.#items.reduce((a, i) => a + (Number(i.amount) || 0), 0); }
  /** @param {number|null} v */ set total(v) { this.#total = v == null ? null : Number(v); this.requestUpdate(); }
  /** @returns {number|null} */ get balance() { return this.#balance; }
  /** @param {number|null} v */ set balance(v) { this.#balance = v == null ? null : Number(v); this.requestUpdate(); }

  /** @override */
  render() {
    const u = this.unit ? ` ${esc(this.unit)}` : '';
    const sign = this.total >= 0 ? '+' : '';
    const rows = this.#items.map((i) => `<div class="ul-row"><span>${esc(i.label)}</span><b>${esc(i.amount)}${u}</b></div>`).join('');
    return `<div class="ul-head">${sign}${esc(this.total)}${u} ${esc(this.heading)}</div>` + rows +
      (this.#items.length ? `<div class="ul-row ul-total"><span>${esc(this.totalLabel)}</span><b>${esc(this.total)}${u}</b></div>` : '') +
      (this.#balance != null ? `<div class="ul-balance">${esc(this.balanceLabel)}: ${esc(this.#balance)}${u}</div>` : '');
  }
}

UfLedger.define();
