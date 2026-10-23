// @ts-check
// ============================================================
// <uf-system-bar> — the bottom bar: Back on the left, everything else in pills.
// ============================================================
//
//   <uf-system-bar flow="lobby-flow">
//     <uf-button size="pill" slot="start"><svg…/>Help</uf-button>
//     <uf-button size="pill" slot="start">Leaderboard</uf-button>
//     <uf-button size="pill" slot="end" id="controls-pill">…</uf-button>
//     <uf-button size="pill" slot="end">Music</uf-button>
//   </uf-system-bar>
//
// Layout: a fixed strip along the bottom of the stage (it stops at
// --uf-stage-inset). Left: "◯ Back", shown only while the linked <uf-flow>
// (`flow` = its id) can go back, or always/never with back="show|hide".
// Children with slot="start" sit after Back; slot="end" sit at the right.
//
// Navigation (decided 2026-10-20): no dedicated button. The bar is a focus row
// under the step — ↓ (d-pad or left stick) from the step's last row reaches
// it, ← → move along it, ↑ returns. focusables() lists its pills so a host can
// add them to the step's spatial scope (uf-flow.attachFocus does this when the
// bar names the flow). Back itself stays on ◯ / B.
//
// Replaces: the game's .lobby-toggle-col round icons, .gamepad-back-hint and
// the .lobby-credits footer (docs/UI-KIT-TV-COMPONENTS.md §9).

import { UfElement, prop } from '../uf-element.js';

export class UfSystemBar extends UfElement {
  /** @override */ static tag = 'uf-system-bar';

  /** @override */ static props = {
    flow: prop.string(''),
    back: prop.enum(/** @type {const} */ (['auto', 'show', 'hide']), 'auto'),
    backLabel: prop.string('Back'),
  };

  /** @override */ static styles = `
    uf-system-bar { position: fixed; left: 0; right: var(--uf-stage-inset, 0px); bottom: 0; z-index: var(--uf-z-hud);
      box-sizing: border-box; display: flex; align-items: center; gap: var(--uf-space-3);
      min-height: calc(var(--uf-size-md) * 3.3); padding: var(--uf-space-2) max(var(--uf-space-5), env(safe-area-inset-right, 0px)) calc(var(--uf-space-2) + env(safe-area-inset-bottom, 0px)) max(var(--uf-space-5), env(safe-area-inset-left, 0px));
      background: color-mix(in srgb, var(--uf-color-surface) 94%, transparent); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-top: 1px solid var(--uf-color-line-soft);
      font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-system-bar[hidden] { display: none; }
    uf-system-bar .uf-bar__back { display: inline-flex; align-items: center; gap: .45em; font-size: var(--uf-size-md); color: var(--uf-color-fg-muted);
      background: none; border: none; font-family: inherit; cursor: pointer; padding: .3em .5em; border-radius: var(--uf-radius-sm); }
    uf-system-bar .uf-bar__back[hidden] { display: none; }
    uf-system-bar .uf-bar__group { display: flex; align-items: center; gap: var(--uf-space-2); flex-wrap: wrap; }
    uf-system-bar .uf-bar__end { margin-left: auto; justify-content: flex-end; }
  `;

  /** @type {HTMLElement|null} */ #start = null;
  /** @type {HTMLElement|null} */ #end = null;
  /** @type {HTMLButtonElement|null} */ #backBtn = null;
  /** @type {HTMLElement|null} */ #flowEl = null;
  #onFlow = () => this.#syncBack();
  /** @type {MutationObserver|null} */ #mo = null;

  /** @returns {string} */ get flow() { return this.get('flow'); }
  /** @param {string} v */ set flow(v) { this.set('flow', v); }

  /** @returns {'auto' | 'show' | 'hide'} */ get back() { return this.get('back'); }
  /** @param {'auto' | 'show' | 'hide'} v */ set back(v) { this.set('back', v); }

  /** @returns {string} */ get backLabel() { return this.get('backLabel'); }
  /** @param {string} v */ set backLabel(v) { this.set('backLabel', v); }

  /** The bar's pills (visible, enabled), left to right. @returns {HTMLElement[]} */
  focusables() {
    this.#build();
    return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('.uf-bar__group > uf-button, .uf-bar__group > button, .uf-bar__group > [data-focusable]'))).filter((el) => {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  /** @override */ render() { return null; }
  /** @override @param {Set<string>} _changed */ update(_changed) { return false; }

  /** @override @param {Set<string>} changed */
  afterRender(changed) {
    this.#build();
    this.setAttribute('role', 'toolbar');
    if (changed.has('flow') || !this.#flowEl) this.#linkFlow();
    this.#syncBack();
  }

  /** @override */
  onDisconnect() {
    this.#flowEl?.removeEventListener('uf-flow:change', this.#onFlow);
    this.#flowEl = null;
    this.#mo?.disconnect(); this.#mo = null;
  }

  #linkFlow() {
    this.#flowEl?.removeEventListener('uf-flow:change', this.#onFlow);
    this.#flowEl = this.flow ? document.getElementById(this.flow) : null;
    this.#flowEl?.addEventListener('uf-flow:change', this.#onFlow);
  }

  #syncBack() {
    const btn = this.#backBtn;
    if (!btn) return;
    const label = /** @type {HTMLElement} */ (btn.querySelector(':scope > span'));   // not the glyph's own span
    label.textContent = this.backLabel;
    const f = /** @type {any} */ (this.#flowEl);
    btn.hidden = this.back === 'hide' || (this.back === 'auto' && !(f && f.canBack));
  }

  #build() {
    if (this.#start) return;
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'uf-bar__back';
    const glyph = document.createElement('uf-controller-glyph'); glyph.setAttribute('button', 'back');
    back.append(glyph, document.createElement('span'));
    back.addEventListener('click', () => { const f = /** @type {any} */ (this.#flowEl); if (f && f.canBack) f.back(); this.emit('uf-system-bar:back'); });
    const start = document.createElement('div'); start.className = 'uf-bar__group uf-bar__start';
    const end = document.createElement('div'); end.className = 'uf-bar__group uf-bar__end';
    const place = (/** @type {Node} */ n) => {
      if (!(n instanceof HTMLElement)) return;
      (n.getAttribute('slot') === 'end' ? end : start).append(n);
    };
    for (const n of Array.from(this.children)) place(n);
    this.append(back, start, end);
    this.#start = start; this.#end = end; this.#backBtn = back;
    if (typeof MutationObserver !== 'undefined') {
      this.#mo = new MutationObserver((recs) => {
        for (const r of recs) for (const n of Array.from(r.addedNodes)) if (n.parentNode === this && n !== back && n !== start && n !== end) place(n);
      });
      this.#mo.observe(this, { childList: true });
    }
  }
}

UfSystemBar.define();
