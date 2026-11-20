// @ts-check
// ============================================================
// <uf-signin> — "Sign in with Discord", "Sign in with Steam"
// ============================================================
//
//   <uf-signin providers="discord steam"></uf-signin>
//   el.addEventListener('uf-signin', (e) => client.signInRedirect(e.detail.provider));
//
// One button per provider, each in that provider's own colours with its mark. A browser on
// the same device; a TV or a desktop build uses <uf-device-signin>.
//
//   el.links = { discord: authorizeUrl }
// makes that button a plain link to the provider's own address (IdentityClient.begin()
// answers with `authorize_url`). On a phone, a tap on a discord.com link can open the
// Discord app, already signed in, where a redirect through our API lands on Discord's web
// login. `uf-signin` still fires (detail.direct is true), and the tap follows the link.
//
//   el.busy = 'steam'      that button is waiting on the server
//   el.error = 'Steam sign-in is unavailable right now'
//   new-tab                links open in a new tab (a phone: this page stays put)
//
// Size and width (lab #152). Every size inside is in em, so the element scales as one piece:
//   size="sm" | "lg"       smaller or larger than the default (13px, 22px; default 16px)
//   style="font-size: …"   any other size
//   block                  the buttons fill the width of the element (a narrow popup, a phone)
//
// Parts (stable names; el.named(name), or el.button(provider)): signin-discord, signin-steam, error.
// el.buttons() lists the buttons top to bottom for a host that keeps its own focus list.
// Setting busy, error or links keeps the same button nodes, so focus stays where it was.

import { IdentityElement, esc } from './base.js';
import { TEXT } from '../text.js';
import { providerIcon } from './icons.js';

const KNOWN = ['discord', 'steam'];

export class UfSignin extends IdentityElement {
  /** @override */ static tag = 'uf-signin';
  /** @override */ static styles = `
    uf-signin { display: flex; flex-direction: column; align-items: center; gap: .5em; font-family: var(--uf-font-ui, system-ui, sans-serif); font-size: var(--uf-size-md, 16px); }
    uf-signin[size="sm"] { font-size: 13px; }
    uf-signin[size="lg"] { font-size: 22px; }
    uf-signin[hidden] { display: none; }
    /* a host may hide one button (set its hidden property); it stays hidden across renders */
    uf-signin [hidden] { display: none !important; }
    uf-signin .uf-id-provider { display: inline-flex; align-items: center; justify-content: center; gap: .625em; box-sizing: border-box; min-width: 15.5em; max-width: 100%;
      padding: .8em 1.5em; border-radius: var(--uf-radius-md, 10px); border: 1px solid transparent; cursor: pointer; text-decoration: none;
      font: 700 1em/1.2 var(--uf-font-ui, system-ui, sans-serif); color: #fff; }
    uf-signin .uf-id-provider .uf-id-icon { width: 1.375em; height: 1.375em; flex: none; }
    uf-signin[block] { align-items: stretch; }
    /* (less side padding: in a narrow box the words must stay on one line) */
    uf-signin[block] .uf-id-provider { min-width: 0; width: 100%; padding-left: .75em; padding-right: .75em; }
    uf-signin .uf-id-provider[data-provider="discord"] { background: #5865f2; }
    uf-signin .uf-id-provider[data-provider="discord"]:hover { background: #4752c4; }
    uf-signin .uf-id-provider[data-provider="steam"] { background: #171a21; border-color: #66c0f4; }
    uf-signin .uf-id-provider[data-provider="steam"]:hover { background: #2a475e; }
    uf-signin .uf-id-provider:focus-visible, uf-signin .uf-id-provider.uf-focus { outline: 3px solid var(--uf-color-focus, #ffd36b); outline-offset: 2px; }
    uf-signin .uf-id-provider[aria-disabled="true"], uf-signin .uf-id-provider[disabled] { opacity: .6; cursor: wait; }
    uf-signin .uf-id-error { margin: 0; color: var(--uf-color-danger, #ff9b8a); font: 600 .875em/1.4 var(--uf-font-ui, system-ui, sans-serif); text-align: center; }
  `;

  constructor() {
    super();
    /** @type {Record<string, string>} */ this._links = {};
    this._busy = '';
    this._error = '';
    this.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-provider]'));
      if (!btn) return;
      if (this._busy) { e.preventDefault(); return; }
      this.emit('uf-signin', { provider: btn.dataset.provider, direct: btn.tagName === 'A' });
    });
  }

  /** The providers to offer, in order (attribute `providers`, default "discord steam"). */
  get providers() {
    const list = String(this.getAttribute('providers') || 'discord steam').split(/[\s,]+/).filter((p) => KNOWN.includes(p));
    return list.length ? list : KNOWN;
  }

  get links() { return this._links; }
  set links(v) { this._links = v && typeof v === 'object' ? { ...v } : {}; this.requestUpdate(); }

  /** The provider whose sign-in is starting ('' for none). */
  get busy() { return this._busy; }
  set busy(v) { this._busy = String(v || ''); this.requestUpdate(); }

  get error() { return this._error; }
  set error(v) { this._error = String(v || ''); this._busy = ''; this.requestUpdate(); }

  /** The button (or link) of one provider, or null when it is not offered. @param {string} provider */
  button(provider) { return this.named('signin-' + provider); }

  /** @override */
  render() {
    const tab = this.hasAttribute('new-tab') ? ' target="_blank" rel="noopener"' : '';
    const buttons = this.providers.map((p) => {
      const inner = `${providerIcon(p, 22)}<span>${esc(TEXT.signInWith(p))}</span>`;
      const href = this._links[p];
      // Only an https address at the provider itself is followed as a link.
      if (href && /^https:\/\//.test(href)) {
        return `<a class="uf-id-provider" data-part="signin-${esc(p)}" data-provider="${esc(p)}" href="${esc(href)}" rel="nofollow noopener"${tab}${this._busy ? ' aria-disabled="true"' : ''}>${inner}</a>`;
      }
      // (busy is aria-disabled, never disabled: a browser drops the focus of a button that becomes disabled)
      return `<button type="button" class="uf-id-provider" data-part="signin-${esc(p)}" data-provider="${esc(p)}"${this._busy ? ' aria-disabled="true"' : ''}${this._busy === p ? ' aria-busy="true"' : ''}>${inner}</button>`;
    }).join('');
    return buttons + (this._error ? `<p class="uf-id-error" data-part="error" role="alert">${esc(this._error)}</p>` : '');
  }
}

UfSignin.define();

