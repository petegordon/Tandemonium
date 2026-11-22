// @ts-check
// ============================================================
// askInPage — "Continue as …?" asked on the page, not in a browser box
// ============================================================
//
//   new IdentityClient({ confirmSwitch: askInPage, … })
//
// The question IdentityClient asks before a sign-in takes this browser: when a different
// account is signed in here, or when a link from another House Tandem site would sign in a
// browser where nobody is. Importing the package's index makes this the default; a client
// built from client.js alone keeps the browser's own confirm().
//
// It is a modal <dialog>: the page behind cannot be used until there is an answer. Cancel has
// the focus and Escape picks it, so yes is always a deliberate move. Where a page cannot show
// a modal dialog the browser's confirm() is asked instead, and with neither the answer is no.

import { SHARED_STYLES, esc } from './base.js';
import { TEXT } from '../text.js';

const STYLES = SHARED_STYLES + `
  dialog.uf-id-ask { box-sizing: border-box; width: min(360px, calc(100vw - 32px)); padding: var(--uf-space-4, 20px); border-radius: var(--uf-radius-lg, 14px);
    border: 1px solid var(--uf-color-line-soft, #3a3147); background: var(--uf-color-surface-1, #221c2c); color: var(--uf-color-fg, #f4efe6);
    font-family: var(--uf-font-ui, system-ui, sans-serif); text-align: center; }
  dialog.uf-id-ask::backdrop { background: rgba(8, 6, 12, .72); }
  dialog.uf-id-ask h2 { margin: 0 0 var(--uf-space-2, 8px); font: 800 var(--uf-size-lg, 20px)/1.25 var(--uf-font-ui, system-ui, sans-serif); overflow-wrap: anywhere; }
  dialog.uf-id-ask .uf-id-pic { width: 64px; height: 64px; border-radius: 50%; display: block; margin: 0 auto var(--uf-space-3, 12px); }
  dialog.uf-id-ask .uf-id-actions { justify-content: center; margin-top: var(--uf-space-4, 20px); }
  dialog.uf-id-ask .uf-id-btn { flex: 1 1 120px; min-height: 44px; }
`;

/** A picture address this page may show: https only. */
const safePicture = (/** @type {unknown} */ v) => (typeof v === 'string' && /^https:\/\//i.test(v) ? v : '');

/** What the question says. Pure, so it can be tested without a page. @param {{ from: { name?: string }|null, to: { name?: string, avatar?: string } }} q */
export function askMarkup({ from, to }) {
  const name = (to && to.name) || '';
  const pic = safePicture(to && to.avatar);
  return `${pic ? `<img class="uf-id-pic" src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : ''}
    <h2 data-part="title">${esc(TEXT.continueTitle(name))}</h2>
    <p class="uf-id-text" data-part="text">${esc(from && from.name ? TEXT.continueSwitch(from.name) : TEXT.continueWarn)}</p>
    <div class="uf-id-actions">
      <button type="button" class="uf-id-btn" data-part="no" value="no">${esc(TEXT.continueNo)}</button>
      <button type="button" class="uf-id-btn" data-part="yes" value="yes" data-tone="accent">${esc(TEXT.continueYes)}</button>
    </div>`;
}

/** The browser's own yes/no; none available: no. */
function askInBox({ from, to }) {
  const ask = /** @type {any} */ (globalThis).confirm;
  if (typeof ask !== 'function') return false;
  const name = (to && to.name) || '';
  return !!ask(`${TEXT.continueTitle(name)} ${from && from.name ? TEXT.continueSwitch(from.name) : TEXT.continueWarn}`);
}

/**
 * Ask on the page. → true only when the player chose to continue.
 * @param {{ from: { name?: string }|null, to: { name?: string, avatar?: string } }} q
 * @returns {Promise<boolean>}
 */
export function askInPage(q) {
  const doc = typeof document === 'undefined' ? null : document;
  const probe = doc && doc.body ? doc.createElement('dialog') : null;
  if (!doc || !probe || typeof probe.showModal !== 'function') return Promise.resolve(askInBox(q));
  if (!doc.querySelector('style[data-uf="uf-id-ask"]')) {
    const style = doc.createElement('style');
    style.dataset.uf = 'uf-id-ask';
    style.textContent = STYLES;
    doc.head.appendChild(style);
  }
  return new Promise((resolve) => {
    const dlg = probe;
    dlg.className = 'uf-id-ask';
    dlg.innerHTML = askMarkup(q);
    let answered = false;
    const done = (/** @type {boolean} */ yes) => {
      if (answered) return;
      answered = true;
      try { dlg.close(); } catch (e) { /* already closed */ }
      dlg.remove();
      resolve(yes);
    };
    dlg.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest ? /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('button[value]')) : null;
      if (btn) done(/** @type {HTMLButtonElement} */ (btn).value === 'yes');
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });   // Escape
    dlg.addEventListener('close', () => done(false));
    doc.body.appendChild(dlg);
    try {
      dlg.showModal();
      /** @type {HTMLElement|null} */ (dlg.querySelector('button[value="no"]'))?.focus();
    } catch (e) {
      // This page cannot open a modal (a sandboxed frame): fall back to the browser's box.
      answered = true;
      dlg.remove();
      resolve(askInBox(q));
    }
  });
}
