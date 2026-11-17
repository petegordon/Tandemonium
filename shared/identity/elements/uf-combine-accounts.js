// @ts-check
// ============================================================
// <uf-combine-accounts> — both accounts side by side, Combine or Cancel
// ============================================================
//
//   const el = document.createElement('uf-combine-accounts');
//   el.question = result;       // IdentityClient.resume() / completeLink(): { provider, other, into }
//   el.addEventListener('uf-combine', (e) => client.combine(result.id, e.detail.ok));
//
// Shown when the login being linked already has its own account. Nothing combines without
// this choice. Cancel is the safe default (it has the focus; Escape picks it in a dialog).

import { IdentityElement, SHARED_STYLES, esc } from './base.js';
import { TEXT, providerName, summaryLines } from '../text.js';

/** @typedef {{ provider: string, other: import('../client.js').AccountSummary, into: import('../client.js').AccountSummary }} CombineQuestion */

export class UfCombineAccounts extends IdentityElement {
  /** @override */ static tag = 'uf-combine-accounts';
  /** @override */ static styles = SHARED_STYLES + `
    uf-combine-accounts { display: block; box-sizing: border-box; color: var(--uf-color-fg, #f4efe6); font-family: var(--uf-font-ui, system-ui, sans-serif); }
    uf-combine-accounts h2 { margin: 0 0 var(--uf-space-3, 12px); font: 800 var(--uf-size-lg, 20px)/1.25 var(--uf-font-ui, system-ui, sans-serif); }
    uf-combine-accounts .uf-id-pair { display: grid; grid-template-columns: 1fr auto 1fr; gap: var(--uf-space-2, 8px); align-items: stretch; margin-bottom: var(--uf-space-3, 12px); }
    uf-combine-accounts .uf-id-arrow { align-self: center; font-size: var(--uf-size-lg, 20px); opacity: .7; }
    uf-combine-accounts .uf-id-acct { background: var(--uf-color-surface-1, #221c2c); border: 1px solid var(--uf-color-line-soft, #3a3147); border-radius: var(--uf-radius-md, 10px); padding: var(--uf-space-3, 12px); text-align: center; min-width: 0; }
    uf-combine-accounts .uf-id-label { font: 700 var(--uf-size-xs, 12px)/1 var(--uf-font-ui, system-ui, sans-serif); letter-spacing: .08em; text-transform: uppercase; opacity: .65; margin-bottom: var(--uf-space-2, 8px); }
    uf-combine-accounts .uf-id-pic { width: 48px; height: 48px; border-radius: 50%; display: block; margin: 0 auto var(--uf-space-1, 4px); }
    uf-combine-accounts .uf-id-name { font-weight: 700; overflow-wrap: anywhere; }
    uf-combine-accounts .uf-id-logins, uf-combine-accounts .uf-id-stats { font-size: var(--uf-size-sm, 14px); opacity: .85; }
    uf-combine-accounts .uf-id-error { color: var(--uf-color-danger, #ff9b8a); font-weight: 600; }
    @media (max-width: 520px) { uf-combine-accounts .uf-id-pair { grid-template-columns: 1fr; } uf-combine-accounts .uf-id-arrow { transform: rotate(90deg); justify-self: center; } }
  `;

  constructor() {
    super();
    /** @type {CombineQuestion|null} */ this._q = null;
    this._busy = false;
    this._error = '';
    this.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
      if (!btn || this._busy) return;
      this.emit('uf-combine', { ok: btn.dataset.act === 'yes' });
    });
  }

  get question() { return this._q; }
  set question(v) { this._q = v || null; this._error = ''; this._busy = false; this.requestUpdate(); }

  get busy() { return this._busy; }
  set busy(v) { this._busy = !!v; this.requestUpdate(); }

  get error() { return this._error; }
  set error(v) { this._error = String(v || ''); this._busy = false; this.requestUpdate(); }

  /** @param {string} label @param {import('../client.js').AccountSummary} a */
  _card(label, a) {
    const acct = a || /** @type {any} */ ({ logins: [], rides: 0, badges: 0 });
    const logins = (acct.logins || []).map((/** @type {{ provider: string }} */ l) => providerName(l.provider)).join(' + ');
    return `<div class="uf-id-acct">
      <div class="uf-id-label">${esc(label)}</div>
      ${acct.avatar ? `<img class="uf-id-pic" src="${esc(acct.avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
      <div class="uf-id-name">${esc(acct.name || 'House Tandem player')}</div>
      ${logins ? `<div class="uf-id-logins">${esc(logins)}</div>` : ''}
      ${summaryLines(acct).map((l) => `<div class="uf-id-stats">${esc(l)}</div>`).join('')}
    </div>`;
  }

  /** @override */
  render() {
    const q = this._q;
    if (!q) return '';
    const into = (q.into && q.into.name) || 'this account';
    const off = this._busy ? ' disabled' : '';
    return `<h2>${esc(TEXT.combineTitle(q.provider))}</h2>
      <div class="uf-id-pair">
        ${this._card(providerName(q.provider) + ' account', q.other)}
        <div class="uf-id-arrow" aria-hidden="true">&rarr;</div>
        ${this._card('This account', q.into)}
      </div>
      <p class="uf-id-text">${esc(TEXT.combineAsk(into))}</p>
      ${this._error ? `<p class="uf-id-text uf-id-error" role="alert">${esc(this._error)}</p>` : ''}
      <div class="uf-id-actions">
        <button type="button" class="uf-id-btn" data-act="no"${off}>${esc(TEXT.combineNo)}</button>
        <button type="button" class="uf-id-btn" data-act="yes" data-tone="accent"${off}>${esc(TEXT.combineYes)}</button>
      </div>`;
  }

  /** @override */
  afterRender() {
    // Cancel is where the focus rests: combining takes a deliberate move.
    if (this.hasAttribute('autofocus')) /** @type {HTMLElement|null} */ (this.querySelector('button[data-act="no"]'))?.focus();
  }
}

UfCombineAccounts.define();
