// @ts-check
// ============================================================
// <uf-join-code> — a short join code, shown or typed.
// ============================================================
//
//   <uf-join-code mode="display" value="TNDM-K9NE"></uf-join-code>          the host's room code
//   <uf-join-code mode="entry" code-prefix="TNDM–" length="4"></uf-join-code>    the joiner's slots
//   code.type('K'); code.backspace(); code.clear();  code.code → 'K'
//
// Both screens use the same element, so the code the host reads out and the
// slots the joiner fills look the same (#428). In entry mode the slots start
// empty (never a pre-filled "AAAA"), the next one carries a cursor, and only
// characters in `alphabet` are accepted (default: the room-code set — no I, O,
// 0 or 1). A focused entry also takes typing from a physical keyboard
// (letters, Backspace, Enter).
// Events: input ({ code }), complete ({ code }) when every slot is filled,
// submit ({ code }) on Enter when complete.
//
// Pair with <uf-keypad for="…"> for d-pad entry (docs/UI-KIT-TV-COMPONENTS.md §12).

import { UfElement, prop, esc } from '../uf-element.js';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class UfJoinCode extends UfElement {
  /** @override */ static tag = 'uf-join-code';

  /** @override */ static props = {
    mode: prop.enum(/** @type {const} */ (['display', 'entry']), 'display'),
    value: prop.string(''),
    codePrefix: prop.string(''),
    length: prop.number(4),
    alphabet: prop.string(ROOM_CODE_ALPHABET),
  };

  /** @override */ static styles = `
    uf-join-code { display: inline-flex; align-items: center; gap: .35em; font: 800 calc(var(--uf-size-2xl) * 1.3)/1 var(--uf-font-mono); color: var(--uf-color-accent); }
    uf-join-code[mode="display"] { letter-spacing: .12em; text-shadow: 0 0 18px color-mix(in srgb, var(--uf-color-accent) 45%, transparent); }
    uf-join-code .ujc-prefix { color: color-mix(in srgb, var(--uf-color-accent) 55%, transparent); letter-spacing: .08em; margin-right: .15em; }
    uf-join-code .ujc-slot { box-sizing: border-box; display: inline-grid; place-items: center; width: 1.45em; height: 1.75em; border-radius: var(--uf-radius-md);
      background: var(--uf-color-surface-3); border: 2px solid var(--uf-color-line-soft); }
    uf-join-code .ujc-slot.cur { border-color: var(--uf-color-accent); box-shadow: inset 0 -.12em 0 var(--uf-color-accent); }
    uf-join-code:focus-visible { outline: none; }
    uf-join-code:focus-visible .ujc-slot.cur, uf-join-code.gamepad-focus .ujc-slot.cur { box-shadow: inset 0 -.12em 0 var(--uf-color-accent), var(--uf-glow-accent); }
  `;

  #wired = false;

  /** @returns {'display' | 'entry'} */ get mode() { return this.get('mode'); }
  /** @param {'display' | 'entry'} v */ set mode(v) { this.set('mode', v); }

  /** Display: the whole code. Entry: the characters typed so far. @returns {string} */
  get value() { return this.get('value'); }
  /** @param {string} v */ set value(v) { this.set('value', v); }

  /** @returns {string} */ get codePrefix() { return this.get('codePrefix'); }
  /** @param {string} v */ set codePrefix(v) { this.set('codePrefix', v); }

  /** @returns {number} */ get length() { return this.get('length'); }
  /** @param {number} v */ set length(v) { this.set('length', v); }

  /** @returns {string} */ get alphabet() { return this.get('alphabet'); }
  /** @param {string} v */ set alphabet(v) { this.set('alphabet', v); }

  /** The typed characters (entry) or the code (display). */
  get code() { return this.value; }
  /** True when every entry slot is filled. */
  get complete() { return this.mode === 'entry' ? this.value.length >= this.length : !!this.value; }

  /** Add one character (ignored if not in the alphabet or already full). @param {string} ch @returns {boolean} accepted */
  type(ch) {
    const c = String(ch || '').toUpperCase();
    if (c.length !== 1 || !this.alphabet.includes(c) || this.value.length >= this.length) return false;
    this.value = this.value + c;
    this.emit('input', { code: this.value });
    if (this.complete) this.emit('complete', { code: this.value });
    return true;
  }
  /** Remove the last character. */
  backspace() { if (!this.value) return; this.value = this.value.slice(0, -1); this.emit('input', { code: this.value }); }
  /** Empty every slot. */
  clear() { if (!this.value) return; this.value = ''; this.emit('input', { code: '' }); }
  /** Ask the host to join with the code (only when complete). */
  submit() { if (this.complete) this.emit('submit', { code: this.value }); }

  /** @override */
  onConnect() {
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('keydown', (e) => {
      if (this.mode !== 'entry' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace') { e.preventDefault(); this.backspace(); }
      else if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
      else if (e.key.length === 1 && this.type(e.key)) e.preventDefault();
    });
  }

  /** @override */
  render() {
    const pre = this.codePrefix ? `<span class="ujc-prefix">${esc(this.codePrefix)}</span>` : '';
    if (this.mode === 'display') return pre + `<span class="ujc-code">${esc(this.value)}</span>`;
    let slots = '';
    for (let i = 0; i < this.length; i++) {
      const ch = this.value[i] || '';
      slots += `<span class="ujc-slot${i === this.value.length ? ' cur' : ''}">${esc(ch)}</span>`;
    }
    return pre + slots;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    if (this.mode === 'entry') {
      if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
      this.setAttribute('role', 'textbox');
      this.setAttribute('aria-label', `${this.codePrefix}${this.value} (${this.value.length} of ${this.length})`);
    } else {
      this.setAttribute('role', 'text');
      this.setAttribute('aria-label', `${this.codePrefix}${this.value}`);
    }
  }
}

UfJoinCode.define();
