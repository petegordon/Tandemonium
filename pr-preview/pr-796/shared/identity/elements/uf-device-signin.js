// @ts-check
// ============================================================
// <uf-device-signin> — a QR, a code, three steps (TV and desktop builds)
// ============================================================
//
//   const el = document.createElement('uf-device-signin');
//   const dev = await client.startDevice({
//     onStatus: (s) => { el.status = s === 'confirming' ? 'confirming' : 'waiting'; },
//     onDone: (user, info) => { … },
//   });
//   el.url = dev.url; el.code = dev.code;
//
// The player scans the QR with their phone, signs in with Discord there, and TYPES the code
// this screen shows (the phone never shows it: a link someone sent them can't sign a
// stranger's screen in). `open-here` adds a button for a desktop build that can open the
// system browser instead; it emits `uf-open-here`.
//
// The QR is drawn by <uf-qr> from @usersfirst/ui when the host has registered it (`qr-size`
// is its side in pixels, 168 by default: give a TV more); without it the address is shown
// as text.

import { IdentityElement, SHARED_STYLES, esc } from './base.js';
import { TEXT } from '../text.js';

const STATUS = /** @type {const} */ ({
  getting: TEXT.deviceGetting, waiting: TEXT.deviceWaiting, confirming: TEXT.deviceConfirming,
  expired: TEXT.deviceExpired, cancelled: TEXT.deviceCancelled,
});

export class UfDeviceSignin extends IdentityElement {
  /** @override */ static tag = 'uf-device-signin';
  /** @override */ static styles = SHARED_STYLES + `
    uf-device-signin { display: grid; grid-template-columns: auto 1fr; gap: var(--uf-space-4, 16px); align-items: center; color: var(--uf-color-fg, #f4efe6); font-family: var(--uf-font-ui, system-ui, sans-serif); }
    uf-device-signin[hidden] { display: none; }
    uf-device-signin .uf-id-qr-box { background: #fff; border-radius: var(--uf-radius-md, 10px); padding: 8px; box-sizing: border-box; display: grid; place-items: center; }
    uf-device-signin .uf-id-qr-text { color: #17131f; font: 600 11px/1.3 var(--uf-font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
    uf-device-signin ol { margin: 0; padding-left: 1.3em; font-size: var(--uf-size-md, 16px); line-height: 1.6; }
    uf-device-signin .uf-id-code { display: block; font: 800 var(--uf-size-2xl, 40px)/1.1 var(--uf-font-mono, ui-monospace, monospace); letter-spacing: .25em; color: var(--uf-color-accent, #ffd36b); }
    uf-device-signin .uf-id-status { margin: var(--uf-space-2, 8px) 0 0; font-size: var(--uf-size-sm, 14px); opacity: .85; }
    @media (max-width: 520px) { uf-device-signin { grid-template-columns: 1fr; justify-items: center; text-align: center; } uf-device-signin ol { text-align: left; } }
  `;

  constructor() {
    super();
    this._url = '';
    this._code = '';
    /** @type {keyof typeof STATUS} */ this._status = 'getting';
    this.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('button[data-act="open"]')) this.emit('uf-open-here', { url: this._url });
    });
  }

  get url() { return this._url; }
  set url(v) { this._url = String(v || ''); this.requestUpdate(); }

  get code() { return this._code; }
  set code(v) { this._code = String(v || ''); this.requestUpdate(); }

  /** 'getting' | 'waiting' | 'confirming' | 'expired' | 'cancelled' */
  get status() { return this._status; }
  set status(v) { this._status = v in STATUS ? /** @type {keyof typeof STATUS} */ (v) : 'waiting'; this.requestUpdate(); }

  /** @override */
  render() {
    const hasQr = typeof customElements !== 'undefined' && !!customElements.get('uf-qr');
    const size = Math.max(96, Math.min(640, Number(this.getAttribute('qr-size')) || 168));
    const box = (/** @type {string} */ inner) => `<div class="uf-id-qr-box" style="width:${size}px;height:${size}px">${inner}</div>`;
    const qr = !this._url ? box('') : hasQr
      ? `<uf-qr value="${esc(this._url)}" size="${size}"></uf-qr>`
      : box(`<span class="uf-id-qr-text">${esc(this._url.replace(/^https?:\/\//, ''))}</span>`);
    const [scan, signIn, type] = TEXT.deviceSteps;
    return `<div class="uf-id-qr">${qr}</div>
      <div>
        <ol>
          <li>${esc(scan)}</li>
          <li>${esc(signIn)}</li>
          <li>${esc(type)} <span class="uf-id-code" aria-label="Code">${esc(this._code)}</span></li>
        </ol>
        <p class="uf-id-status" role="status">${esc(STATUS[this._status])}</p>
        ${this.hasAttribute('open-here') && this._url ? `<div class="uf-id-actions"><button type="button" class="uf-id-btn" data-act="open">${esc(TEXT.openOnThisComputer)}</button></div>` : ''}
      </div>`;
  }
}

UfDeviceSignin.define();
