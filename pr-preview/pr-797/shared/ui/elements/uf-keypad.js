// @ts-check
// ============================================================
// <uf-keypad> — an on-screen keyboard for a d-pad.
// ============================================================
//
//   <uf-join-code id="code" mode="entry" code-prefix="TNDM–"></uf-join-code>
//   <uf-keypad for="code"></uf-keypad>
//
// A grid of keys built from `alphabet` (default: the 32 room-code characters,
// which fill an 8 × 4 grid exactly — any key is a few d-pad moves away, where
// a wrapping spinner took up to 16 presses per character), plus Delete and
// Done. Keys are focusable (FocusController picks them up through
// uf-step.focusables() / [data-focusable]); confirm on a key types it into the
// linked <uf-join-code> (`for` = its id). Done is enabled once the code is
// complete and calls its submit().
// Events: key ({ key }) for every press, including 'Delete' and 'Done'.
//
// Replaces: the game's four .code-spinner + .room-code-prefix-vert
// (docs/UI-KIT-TV-COMPONENTS.md §12).

import { UfElement, prop, esc } from '../uf-element.js';
import { ROOM_CODE_ALPHABET } from './uf-join-code.js';

export class UfKeypad extends UfElement {
  /** @override */ static tag = 'uf-keypad';

  /** @override */ static props = {
    for: prop.string(''),
    alphabet: prop.string(ROOM_CODE_ALPHABET),
    columns: prop.number(8),
    deleteLabel: prop.string('⌫ Delete'),
    doneLabel: prop.string('JOIN'),
  };

  /** @override */ static styles = `
    uf-keypad { display: grid; gap: var(--uf-space-3); justify-items: center; font-family: var(--uf-font-ui); }
    uf-keypad .ukp-grid { display: grid; grid-template-columns: repeat(var(--_cols), calc(var(--uf-size-xl) * 2.3)); gap: var(--uf-space-2); }
    uf-keypad .ukp-key { box-sizing: border-box; display: grid; place-items: center; height: calc(var(--uf-size-xl) * 2); border-radius: var(--uf-radius-md);
      background: var(--uf-color-surface-3); border: 1px solid var(--uf-color-line-soft); color: var(--uf-color-fg);
      font: 700 var(--uf-size-xl)/1 var(--uf-font-mono); cursor: pointer; user-select: none; }
    uf-keypad .ukp-key.gamepad-focus, uf-keypad .ukp-key:focus-visible { outline: none; background: var(--uf-color-accent-soft); border: 3px solid var(--uf-color-accent); box-shadow: var(--uf-glow-accent); }
    uf-keypad .ukp-actions { display: flex; gap: var(--uf-space-3); }
    uf-keypad .ukp-actions uf-button { min-width: 9em; }
  `;

  #wired = false;
  /** @type {HTMLElement|null} */ #target = null;
  #onTargetInput = () => this.#syncDone();

  /** @returns {string} */ get for() { return this.get('for'); }
  /** @param {string} v */ set for(v) { this.set('for', v); }

  /** @returns {string} */ get alphabet() { return this.get('alphabet'); }
  /** @param {string} v */ set alphabet(v) { this.set('alphabet', v); }

  /** @returns {number} */ get columns() { return this.get('columns'); }
  /** @param {number} v */ set columns(v) { this.set('columns', v); }

  /** @returns {string} */ get deleteLabel() { return this.get('deleteLabel'); }
  /** @param {string} v */ set deleteLabel(v) { this.set('deleteLabel', v); }

  /** @returns {string} */ get doneLabel() { return this.get('doneLabel'); }
  /** @param {string} v */ set doneLabel(v) { this.set('doneLabel', v); }

  /** The linked <uf-join-code>, if any. */
  get target() { return /** @type {any} */ (this.#target); }

  /** Press a key by its character, 'Delete' or 'Done'. @param {string} key */
  press(key) {
    const t = /** @type {any} */ (this.#target);
    if (key === 'Delete') t?.backspace?.();
    else if (key === 'Done') t?.submit?.();
    else t?.type?.(key);
    this.emit('key', { key });
    this.#syncDone();
  }

  /** Keys + action buttons, for a FocusController scope. @returns {HTMLElement[]} */
  focusables() { return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('.ukp-key, .ukp-actions uf-button:not([disabled])'))); }

  /** @override */
  onConnect() {
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('click', (e) => {
      const el = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest('[data-key]'));
      if (el && !el.hasAttribute('disabled')) this.press(/** @type {string} */ (el.dataset.key));
    });
    this.addEventListener('keydown', (e) => {
      const el = /** @type {HTMLElement} */ (e.target);
      if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('ukp-key')) { e.preventDefault(); this.press(/** @type {string} */ (el.dataset.key)); }
    });
  }

  /** @override */
  onDisconnect() { this.#target?.removeEventListener('input', this.#onTargetInput); this.#target = null; }

  /** @override */
  render() {
    const keys = [...this.alphabet].map((c) => `<span class="ukp-key" data-key="${esc(c)}" data-focusable tabindex="0" role="button" aria-label="${esc(c)}">${esc(c)}</span>`).join('');
    return `<div class="ukp-grid" style="--_cols:${Math.max(1, Math.floor(this.columns))}">${keys}</div>` +
      `<div class="ukp-actions"><uf-button data-key="Delete">${esc(this.deleteLabel)}</uf-button>` +
      `<uf-button variant="accent" data-key="Done">${esc(this.doneLabel)}</uf-button></div>`;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    const next = this.for ? document.getElementById(this.for) : null;
    if (next !== this.#target) {
      this.#target?.removeEventListener('input', this.#onTargetInput);
      this.#target = next;
      this.#target?.addEventListener('input', this.#onTargetInput);
    }
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'On-screen keyboard');
    this.#syncDone();
  }

  #syncDone() {
    const done = /** @type {any} */ (this.querySelector('uf-button[data-key="Done"]'));
    const t = /** @type {any} */ (this.#target);
    if (done) done.disabled = !(t && t.complete);
  }
}

UfKeypad.define();
