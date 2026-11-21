// @ts-check
// ============================================================
// <uf-profile-card> — the account's logins, one line each
// ============================================================
//
//   <uf-profile-card signout></uf-profile-card>
//   el.user = client.user;
//   el.addEventListener('uf-profile-link', (e) => client.linkRedirect(e.detail.provider));
//   el.addEventListener('uf-profile-signout', () => client.signOut());
//
// One line per login the account can have (attribute `providers`, default "discord steam"):
//   linked      the provider's mark, the name there, and its picture
//   not linked  a "Link Steam" button
// Plain lines, not pills: a linked login is not a button. `signout` adds Sign out.
//
//   el.busy = 'steam'      that Link button is waiting on the server (aria-disabled: it keeps its focus)
//   el.error = '…'         why a link did not start
//   el.note = '…'          a line under the logins (say, what linking the other one does)
//
// Size and width (lab #152). Every size inside is in em, so the card scales as one piece:
//   size="sm" | "lg"       smaller or larger than the default (13px, 22px; default 16px)
//   style="font-size: …"   any other size
//   block                  the lines fill the width of the card (a narrow popup, a phone)
//   signout="danger"       Sign out in the danger colour
//
// Parts (stable names; el.named(name)): login-<provider> (the line), link-<provider>,
// pic-<provider>, signout, error, note. el.button('link', provider) and el.button('signout')
// give the buttons; el.buttons() lists them top to bottom for a host that keeps its own
// focus list. Setting user, busy, error or note keeps the nodes that are still wanted, so
// focus stays where it was, and a picture the host swapped for a cached copy stays until
// the address the card was given changes.

import { IdentityElement, esc } from './base.js';
import { TEXT, providerName } from '../text.js';
import { providerIcon, PROVIDER_COLORS } from './icons.js';

const KNOWN = ['discord', 'steam', 'google'];

export class UfProfileCard extends IdentityElement {
  /** @override */ static tag = 'uf-profile-card';
  /** @override */ static styles = `
    uf-profile-card { display: flex; flex-direction: column; align-items: center; gap: .75em; color: var(--uf-color-fg, #f4efe6); font-family: var(--uf-font-ui, system-ui, sans-serif); font-size: var(--uf-size-md, 16px); }
    uf-profile-card[size="sm"] { font-size: 13px; }
    uf-profile-card[size="lg"] { font-size: 22px; }
    uf-profile-card[hidden] { display: none; }
    uf-profile-card [hidden] { display: none !important; }
    uf-profile-card ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .625em; align-items: stretch; width: fit-content; max-width: 100%; }
    uf-profile-card li { display: flex; align-items: center; gap: .625em; min-width: 0; font-size: 1em; }
    uf-profile-card .uf-id-icon { flex: none; opacity: .75; width: 1.125em; height: 1.125em; }
    uf-profile-card .uf-id-login-name { flex: 1; min-width: 0; margin-right: .375em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    uf-profile-card .uf-id-login-pic { flex: none; width: 2.75em; height: 2.75em; border-radius: 50%; object-fit: cover; box-sizing: border-box;
      border: 2px solid var(--uf-id-provider, var(--uf-color-line, #5b5068)); background: #171a21; }
    uf-profile-card .uf-id-link { font: inherit; font-size: .875em; padding: .36em 1em; border-radius: 999px; cursor: pointer; background: transparent;
      color: inherit; border: 1px dashed var(--uf-id-provider, var(--uf-color-line, #5b5068)); }
    uf-profile-card[block] { align-items: stretch; }
    uf-profile-card[block] ul { width: 100%; }
    uf-profile-card[block] li[data-linked="false"] { justify-content: center; }
    uf-profile-card[block] .uf-id-out { align-self: center; }
    uf-profile-card[signout="danger"] .uf-id-out { border-color: var(--uf-color-danger, #ff9b8a); color: var(--uf-color-danger, #ff9b8a); }
    uf-profile-card .uf-id-link:hover { border-style: solid; }
    uf-profile-card .uf-id-link[aria-disabled="true"] { opacity: .6; cursor: wait; }
    uf-profile-card .uf-id-link:focus-visible, uf-profile-card .uf-id-out:focus-visible, uf-profile-card .uf-focus { outline: 3px solid var(--uf-color-focus, #ffd36b); outline-offset: 2px; }
    uf-profile-card .uf-id-note { margin: 0; font-size: .875em; line-height: 1.45; opacity: .8; text-align: center; max-width: 34em; }
    uf-profile-card .uf-id-error { margin: 0; color: var(--uf-color-danger, #ff9b8a); font: 600 .875em/1.4 var(--uf-font-ui, system-ui, sans-serif); text-align: center; }
    uf-profile-card .uf-id-out { font: 600 .875em/1 var(--uf-font-ui, system-ui, sans-serif); padding: .64em 1.14em; border-radius: var(--uf-radius-md, 10px); cursor: pointer;
      background: transparent; color: inherit; border: 1px solid var(--uf-color-line, #5b5068); }
  `;

  constructor() {
    super();
    /** @type {import('../client.js').IdentityUser|null} */ this._user = null;
    this._busy = '';
    this._error = '';
    this._note = '';
    this.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-act]'));
      if (!btn || this._busy) return;
      if (btn.dataset.act === 'link') this.emit('uf-profile-link', { provider: btn.dataset.provider });
      else this.emit('uf-profile-signout');
    });
  }

  /** The logins to show, in order (attribute `providers`, default "discord steam"). */
  get providers() {
    const list = String(this.getAttribute('providers') || 'discord steam').split(/[\s,]+/).filter((p) => KNOWN.includes(p));
    return list.length ? list : ['discord', 'steam'];
  }

  get user() { return this._user; }
  set user(v) { this._user = v || null; this.requestUpdate(); }

  /** The provider whose link is starting ('' for none). */
  get busy() { return this._busy; }
  set busy(v) { this._busy = String(v || ''); this.requestUpdate(); }

  get error() { return this._error; }
  set error(v) { this._error = String(v || ''); this._busy = ''; this.requestUpdate(); }

  get note() { return this._note; }
  set note(v) { this._note = String(v || ''); this.requestUpdate(); }

  /**
   * A button of the card, or null when it is not showing: button('link', 'steam'), button('signout').
   * @param {'link'|'signout'} which @param {string} [provider]
   */
  button(which, provider) { return this.named(which === 'link' ? 'link-' + provider : 'signout'); }

  /** @override */
  render() {
    const user = this._user;
    if (!user) return '';
    const ids = user.identities || {};
    const rows = this.providers.map((p) => {
      const login = ids[p];
      const tint = PROVIDER_COLORS[p] ? ` style="--uf-id-provider:${PROVIDER_COLORS[p]}"` : '';
      if (!login) {
        return `<li data-part="login-${esc(p)}" data-provider="${esc(p)}" data-linked="false"${tint}>
          <button type="button" class="uf-id-link" data-part="link-${esc(p)}" data-act="link" data-provider="${esc(p)}"${this._busy ? ' aria-disabled="true"' : ''}${this._busy === p ? ' aria-busy="true"' : ''}>${esc(TEXT.link(p))}</button></li>`;
      }
      const pic = login.avatar
        ? `<img class="uf-id-login-pic" data-part="pic-${esc(p)}" src="${esc(login.avatar)}" alt="" referrerpolicy="no-referrer">`
        : `<span class="uf-id-login-pic" data-part="pic-${esc(p)}"></span>`;
      return `<li data-part="login-${esc(p)}" data-provider="${esc(p)}" data-linked="true"${tint}>
        ${providerIcon(p, 18)}<span class="uf-id-login-name" title="${esc(providerName(p))}">${esc(login.name || 'linked')}</span>${pic}</li>`;
    }).join('');
    return `<ul aria-label="Linked accounts">${rows}</ul>
      ${this._error ? `<p class="uf-id-error" data-part="error" role="alert">${esc(this._error)}</p>` : ''}
      ${this._note ? `<p class="uf-id-note" data-part="note">${esc(this._note)}</p>` : ''}
      ${this.hasAttribute('signout') ? `<button type="button" class="uf-id-out" data-part="signout" data-act="signout">${esc(TEXT.signOut)}</button>` : ''}`;
  }
}

UfProfileCard.define();
