// @ts-check
// ============================================================
// <uf-account-notice> — "the Discord account … was linked", with undo
// ============================================================
//
//   const el = document.createElement('uf-account-notice');
//   el.notice = notice;                     // from IdentityClient.notices()
//   el.addEventListener('uf-notice-undo', (e) => client.undo(e.detail.id));
//   el.addEventListener('uf-notice-ok', (e) => client.seen(e.detail.id));
//
// Shows one notice: what was linked or combined, until when it can be undone, and two
// buttons, the undo first (it is the one that matters). A notice already marked seen keeps
// only its undo. `busy` disables both while the
// host talks to the server; `error` shows why an undo failed.

import { IdentityElement, SHARED_STYLES, esc } from './base.js';
import { noticeText } from '../text.js';

export class UfAccountNotice extends IdentityElement {
  /** @override */ static tag = 'uf-account-notice';
  /** @override */ static styles = SHARED_STYLES + `
    uf-account-notice { display: block; box-sizing: border-box; padding: var(--uf-space-3, 12px); border-radius: var(--uf-radius-md, 10px);
      background: var(--uf-color-surface-1, #221c2c); border: 1px solid var(--uf-color-warn, #ffb454); }
    uf-account-notice[hidden] { display: none; }
    uf-account-notice .uf-id-error { margin: var(--uf-space-2, 8px) 0 0; color: var(--uf-color-danger, #ff9b8a); font: 600 var(--uf-size-sm, 14px)/1.4 var(--uf-font-ui, system-ui, sans-serif); }
  `;

  constructor() {
    super();
    /** @type {import('../client.js').AccountNotice|null} */ this._notice = null;
    this._busy = false;
    this._error = '';
    this.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
      if (!btn || !this._notice || this._busy) return;
      this.emit(btn.dataset.act === 'undo' ? 'uf-notice-undo' : 'uf-notice-ok', { id: this._notice.id, kind: this._notice.kind });
    });
  }

  get notice() { return this._notice; }
  set notice(v) { this._notice = v || null; this._error = ''; this.requestUpdate(); }

  get busy() { return this._busy; }
  set busy(v) { this._busy = !!v; this.requestUpdate(); }

  get error() { return this._error; }
  set error(v) { this._error = String(v || ''); this.requestUpdate(); }

  /** @override */
  render() {
    const n = this._notice;
    if (!n) return '';
    const t = noticeText(n, { locale: this.getAttribute('locale') || undefined });
    const off = this._busy ? ' disabled' : '';
    return `<p class="uf-id-text" role="status">${esc(t.text)}</p>
      ${this._error ? `<p class="uf-id-error" role="alert">${esc(this._error)}</p>` : ''}
      <div class="uf-id-actions">
        <button type="button" class="uf-id-btn" data-act="undo" data-tone="danger"${off}>${esc(t.undo)}</button>
        ${n.seen ? '' : `<button type="button" class="uf-id-btn" data-act="ok"${off}>${esc(t.ok)}</button>`}
      </div>`;
  }
}

UfAccountNotice.define();
