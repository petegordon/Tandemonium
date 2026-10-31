// @ts-check
// ============================================================
// <uf-step> — one screen of a flow: optional prompt above and hint below the authored content.
// ============================================================
//
// Decorates, never replaces: the children you write (buttons, seat grids,
// inputs with ids the app looks up) stay exactly where they are. The element
// only prepends a prompt and appends a hint when those props are set, and
// hides itself unless `active` — which a parent <uf-flow> manages.
//
// Markup:   <uf-step id="mode" prompt="How do you want to ride?" hint="<b>A</b> choose · <b>B</b> back">
//             <uf-button …>…</uf-button>
//           </uf-step>
// `hint` is authored HTML (controller glyphs are <b>A</b>), not escaped.
// Replaces: the game's .lobby-step + .lobby-prompt, the lab's .step + .prompt + .hint.

import { UfElement, prop, esc } from '../uf-element.js';

export class UfStep extends UfElement {
  /** @override */ static tag = 'uf-step';

  /** @override */ static props = {
    prompt: prop.string(''),
    hint: prop.string(''),
    active: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-step { display: flex; flex-direction: column; align-items: center; gap: var(--uf-space-3); width: 100%; box-sizing: border-box;
              animation: uf-step-rise var(--uf-motion-base) var(--uf-ease) both; }
    uf-step:not([active]) { display: none; }
    uf-step > .uf-step__prompt { margin: 0 0 var(--uf-space-1); font: 700 var(--uf-size-xl)/1.25 var(--uf-font-ui); color: var(--uf-color-fg); text-align: center; }
    uf-step > .uf-step__hint { margin: var(--uf-space-1) 0 0; font: var(--uf-size-sm)/1.4 var(--uf-font-ui); color: var(--uf-color-fg-muted); text-align: center; }
    uf-step > .uf-step__hint b, uf-step > .uf-step__hint strong { color: var(--uf-color-fg); }
    @keyframes uf-step-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { uf-step { animation: none; } }
  `;

  /** @returns {string} */ get prompt() { return this.get('prompt'); }
  /** @param {string} v */ set prompt(v) { this.set('prompt', v); }

  /** @returns {string} */ get hint() { return this.get('hint'); }
  /** @param {string} v */ set hint(v) { this.set('hint', v); }

  /** @returns {boolean} */ get active() { return this.get('active'); }
  /** @param {boolean} v */ set active(v) { this.set('active', v); }

  /**
   * The controller-navigable items on this screen, in document order:
   * every visible uf-button, native button, range input, or [data-focusable]
   * that is not disabled. What a FocusController's spatial scope is built from
   * (see uf-flow.attachFocus).
   * @returns {HTMLElement[]}
   */
  focusables() {
    const sel = 'uf-button, button, input[type="range"], [data-focusable]';
    return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll(sel))).filter((el) => {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  /** @override */
  render() { return null; }   // keep the authored children

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    this.#sync('prompt', 'afterbegin', esc(this.prompt));
    this.#sync('hint', 'beforeend', this.hint);
  }

  /** @override @param {Set<string>} changed */
  update(changed) {
    if (changed.has('prompt')) this.#sync('prompt', 'afterbegin', esc(this.prompt));
    if (changed.has('hint')) this.#sync('hint', 'beforeend', this.hint);
    return true;
  }

  /** @param {'prompt'|'hint'} kind @param {'afterbegin'|'beforeend'} where @param {string} html */
  #sync(kind, where, html) {
    let el = this.querySelector(`:scope > .uf-step__${kind}`);
    if (!html) { el?.remove(); return; }
    if (!el) { el = document.createElement('p'); el.className = `uf-step__${kind}`; this.insertAdjacentElement(where, el); }
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}

UfStep.define();
