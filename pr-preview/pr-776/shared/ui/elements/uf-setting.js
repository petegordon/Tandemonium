// @ts-check
// ============================================================
// <uf-setting> — one setting row: label, description, and On/Off or a value.
// ============================================================
//
//   <uf-setting label="Stick steering" description="Lean with the left stick" checked></uf-setting>
//   <uf-setting label="Gyro steering" description="Tilt the controller to lean">
//     <div slot="detail">…feel slider · <uf-button size="sm">Recalibrate</uf-button></div>
//   </uf-setting>
//   <uf-setting kind="value" label="Button prompts" value="Automatic"></uf-setting>
//
// kind="toggle" (default): confirm / click flips `checked` and emits `change`
// ({ checked }). kind="value": shows `value` with a › and emits `uf-setting:open`
// on confirm, for a host that opens a picker. The row itself is the focus
// target (role switch / button); children with slot="detail" render as an
// indented sub-row (shown while checked for toggles, always for values).
//
// Replaces: the game's Stick / Gyro / ALL / Music round toggles and the Motion
// popup's slider row (docs/UI-KIT-TV-COMPONENTS.md §10).

import { UfElement, prop } from '../uf-element.js';

export class UfSetting extends UfElement {
  /** @override */ static tag = 'uf-setting';

  /** @override */ static props = {
    label: prop.string(''),
    description: prop.string(''),
    kind: prop.enum(/** @type {const} */ (['toggle', 'value']), 'toggle'),
    checked: prop.boolean(false),
    value: prop.string(''),
    disabled: prop.boolean(false),
    onLabel: prop.string('On'),
    offLabel: prop.string('Off'),
  };

  /** @override */ static styles = `
    uf-setting { display: block; font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-setting > .uf-setting__row { display: flex; align-items: center; gap: var(--uf-space-4); padding: var(--uf-space-3) var(--uf-space-4);
      border-radius: var(--uf-radius-md); background: var(--uf-color-surface-3); border: 2px solid transparent; cursor: pointer; }
    uf-setting.gamepad-focus > .uf-setting__row, uf-setting:focus-visible > .uf-setting__row { border-color: var(--uf-color-accent); box-shadow: var(--uf-glow-accent); }
    uf-setting:focus-visible { outline: none; }
    uf-setting .uf-setting__text { flex: 1; min-width: 0; }
    uf-setting .uf-setting__label { display: block; font: 700 var(--uf-size-md)/1.25 var(--uf-font-ui); }
    uf-setting .uf-setting__desc { display: block; font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); margin-top: 2px; }
    uf-setting .uf-setting__pill { min-width: 4.6em; text-align: center; padding: .45em .9em; border-radius: 999px; font: 700 var(--uf-size-sm)/1 var(--uf-font-ui);
      background: var(--uf-color-surface-2); color: var(--uf-color-fg-muted); }
    uf-setting[checked] .uf-setting__pill { background: var(--uf-color-accent-soft); color: var(--uf-color-accent); }
    uf-setting .uf-setting__value { font-size: var(--uf-size-md); color: var(--uf-color-fg); white-space: nowrap; }
    uf-setting > .uf-setting__detail { padding: var(--uf-space-2) var(--uf-space-4) var(--uf-space-1) calc(var(--uf-space-4) * 2.5); display: flex; align-items: center; gap: var(--uf-space-3); flex-wrap: wrap; font-size: var(--uf-size-sm); }
    uf-setting:not([kind="value"]):not([checked]) > .uf-setting__detail { display: none; }
    uf-setting > .uf-setting__detail:empty { display: none; }
    uf-setting[disabled] { opacity: .45; pointer-events: none; }
  `;

  /** @type {HTMLElement|null} */ #row = null;
  /** @type {HTMLElement|null} */ #detail = null;
  #wired = false;

  /** @returns {string} */ get label() { return this.get('label'); }
  /** @param {string} v */ set label(v) { this.set('label', v); }

  /** @returns {string} */ get description() { return this.get('description'); }
  /** @param {string} v */ set description(v) { this.set('description', v); }

  /** @returns {'toggle' | 'value'} */ get kind() { return this.get('kind'); }
  /** @param {'toggle' | 'value'} v */ set kind(v) { this.set('kind', v); }

  /** @returns {boolean} */ get checked() { return this.get('checked'); }
  /** @param {boolean} v */ set checked(v) { this.set('checked', v); }

  /** @returns {string} */ get value() { return this.get('value'); }
  /** @param {string} v */ set value(v) { this.set('value', v); }

  /** @returns {boolean} */ get disabled() { return this.get('disabled'); }
  /** @param {boolean} v */ set disabled(v) { this.set('disabled', v); }

  /** @returns {string} */ get onLabel() { return this.get('onLabel'); }
  /** @param {string} v */ set onLabel(v) { this.set('onLabel', v); }

  /** @returns {string} */ get offLabel() { return this.get('offLabel'); }
  /** @param {string} v */ set offLabel(v) { this.set('offLabel', v); }

  /** Confirm: flip a toggle, or ask the host to open a value picker. */
  activate() {
    if (this.disabled) return;
    if (this.kind === 'toggle') { this.checked = !this.checked; this.emit('change', { checked: this.checked }); }
    else this.emit('uf-setting:open', { value: this.value });
  }

  /** @override */
  onConnect() {
    this.setAttribute('data-focusable', '');
    if (!this.hasAttribute('tabindex')) this.setAttribute('tabindex', '0');
    if (this.#wired) return;
    this.#wired = true;
    // Clicks inside the detail row (a slider, a Recalibrate button) are theirs, not a toggle.
    this.addEventListener('click', (e) => { if (!(/** @type {HTMLElement} */ (e.target)).closest('.uf-setting__detail')) this.activate(); });
    this.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === this) { e.preventDefault(); this.activate(); }
    });
  }

  /** @override */ render() { return null; }
  /** @override @param {Set<string>} _changed */ update(_changed) { return false; }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    if (!this.#row) {
      const row = document.createElement('div'); row.className = 'uf-setting__row';
      const detail = document.createElement('div'); detail.className = 'uf-setting__detail';
      for (const n of Array.from(this.children)) if (n.getAttribute('slot') === 'detail') detail.append(...Array.from(n.childNodes));
      for (const n of Array.from(this.children)) if (n.getAttribute('slot') === 'detail') n.remove();
      this.append(row, detail);
      this.#row = row; this.#detail = detail;
    }
    const span = (/** @type {string} */ cls, /** @type {string} */ text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    const text = span('uf-setting__text', '');
    text.append(span('uf-setting__label', this.label));
    if (this.description) text.append(span('uf-setting__desc', this.description));
    const end = this.kind === 'toggle'
      ? span('uf-setting__pill', this.checked ? this.onLabel : this.offLabel)
      : span('uf-setting__value', `${this.value} ›`);
    this.#row.replaceChildren(text, end);
    this.setAttribute('role', this.kind === 'toggle' ? 'switch' : 'button');
    if (this.kind === 'toggle') this.setAttribute('aria-checked', String(this.checked)); else this.removeAttribute('aria-checked');
    this.setAttribute('aria-label', this.label);
    this.setAttribute('aria-disabled', String(this.disabled));
  }

  /** The detail row (for hosts that build it in script). */
  get detail() { this.requestUpdate(); return this.#detail; }
}

UfSetting.define();
