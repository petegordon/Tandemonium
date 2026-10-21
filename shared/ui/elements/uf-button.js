// @ts-check
// ============================================================
// <uf-button> — the one button: every CTA, menu entry and option in both repos.
// ============================================================
//
// The host element IS the button. There is no inner <button>: the game's
// lobby/game code writes `btn.textContent = …`, `btn.innerHTML = …`, toggles
// classes, reads `.disabled`, calls `.click()` and attaches `click` listeners
// directly on the element it got from getElementById — all of that keeps
// working unchanged when `<button class="lobby-btn">` becomes `<uf-button>`.
// The element adds role/tabindex/keyboard activation itself.
//
// Replaces: the game's .lobby-btn / .lobby-btn-accent / .lobby-btn-versus and
// the lab's .mode-btn / .cta / .subtle-btn / .pairbtn. Modifier classes a
// screen still needs (.cta-btn, .lobby-btn-p2-gp, .role-locked) stay as
// classes on the host; they only restyle, they never carry state.
//
// Markup:   <uf-button variant="accent" size="lg" id="btn-start">START RIDE</uf-button>
//           <uf-button label="PLAY AGAIN"></uf-button>          (label prop wins over children)
//           <uf-button selected data-mode="versus"><b>VERSUS</b><small>2v2</small></uf-button>
//           <uf-button size="lg" align="start" sub="Couch co-op, online or versus">RIDE TOGETHER</uf-button>
//           <uf-button size="pill"><svg …></svg>Help</uf-button>          (system-bar pill: icon + label)
// Script:   const b = document.createElement('uf-button'); b.variant = 'ghost';
//           (typed: 'primary' | 'accent' | 'ghost' | 'danger' | 'versus' — see elements.d.ts)
// Events:   a plain `click` (mouse, touch, Enter/Space, or el.click()); suppressed while disabled.

import { UfElement, prop, esc } from '../uf-element.js';

export class UfButton extends UfElement {
  /** @override */ static tag = 'uf-button';

  /** @override */ static props = {
    label: prop.string(''),
    variant: prop.enum(/** @type {const} */ (['primary', 'accent', 'ghost', 'danger', 'versus']), 'primary'),
    size: prop.enum(/** @type {const} */ (['xs', 'sm', 'md', 'lg', 'pill']), 'md'),
    // A second, smaller line under the label (mode buttons, CTAs). Rendered as a
    // trailing <small class="uf-button__sub"> the element owns, so it survives
    // `label` changes; a host that rewrites textContent should set sub again.
    sub: prop.string(''),
    align: prop.enum(/** @type {const} */ (['center', 'start']), 'center'),
    disabled: prop.boolean(false),
    selected: prop.boolean(false),
  };

  /** @override */ static styles = `
    /* inline-block, not flex: authored labels use <br> and inline icons/spans
       (START A RIDE<br><span class="lobby-role-desc">…</span>), which flex would
       reflow into one row. Vertical centring comes from padding + line-height. */
    uf-button {
      display: inline-block; box-sizing: border-box; vertical-align: middle;
      text-align: center; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
      font: 700 var(--uf-size-md)/1.3 var(--uf-font-ui); letter-spacing: .3px;
      color: var(--uf-color-fg); background: var(--uf-color-surface-2);
      border: 2px solid var(--uf-color-line); border-radius: var(--uf-radius-lg);
      padding: var(--uf-space-3) var(--uf-space-4); min-height: 44px; cursor: pointer;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      transition: transform var(--uf-motion-fast) var(--uf-ease), box-shadow var(--uf-motion-fast) var(--uf-ease), background var(--uf-motion-fast), border-color var(--uf-motion-fast);
    }
    uf-button[size="sm"] { font-size: var(--uf-size-sm); font-weight: 400; padding: var(--uf-space-1) var(--uf-space-3); min-height: 32px; border-radius: var(--uf-radius-sm); }
    /* xs: icon / close buttons (×, ⚙) whose host page sets an explicit size; no minimum, no backdrop. */
    uf-button[size="xs"] { font-size: var(--uf-size-xs); font-weight: 400; padding: 2px 6px; min-height: 0; border-width: 1px; border-radius: var(--uf-radius-sm); backdrop-filter: none; -webkit-backdrop-filter: none; }
    uf-button[size="lg"] { font-size: var(--uf-size-lg); font-weight: 800; padding: var(--uf-space-4) var(--uf-space-5); min-height: 56px; width: 100%; }
    /* pill: the system-bar button — leading icon (svg or uf-controller-glyph) + label, one row. */
    uf-button[size="pill"] { display: inline-flex; align-items: center; gap: var(--uf-space-2); border-radius: 999px; min-height: calc(var(--uf-size-md) * 2.2); padding: 0 var(--uf-space-4) 0 var(--uf-space-3); font-size: var(--uf-size-md); font-weight: 600; white-space: nowrap; }
    uf-button[size="pill"] > svg { width: 1.1em; height: 1.1em; flex: none; }
    uf-button[align="start"] { text-align: left; }
    uf-button > .uf-button__sub { display: block; width: 100%; margin-top: .2em; font-size: .62em; font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--uf-color-fg-muted); }
    uf-button[variant="accent"][selected] > .uf-button__sub { color: inherit; opacity: .8; }
    uf-button[variant="accent"]  { background: var(--uf-color-accent-soft); border-color: var(--uf-color-accent-line); }
    uf-button[variant="accent"][selected], uf-button[variant="accent"].ready { background: var(--uf-color-accent); border-color: var(--uf-color-accent); color: var(--uf-color-fg-on-accent); }
    uf-button[variant="ghost"]   { background: transparent; border-color: transparent; color: var(--uf-color-fg-muted); backdrop-filter: none; -webkit-backdrop-filter: none; }
    uf-button[variant="danger"]  { background: var(--uf-color-danger-soft); border-color: var(--uf-color-danger); }
    uf-button[variant="versus"]  { background: var(--uf-color-versus-soft); border-color: var(--uf-color-versus-line); color: var(--uf-color-versus); }
    uf-button[selected] { transform: translateY(-2px); border-color: var(--uf-color-fg); box-shadow: var(--uf-shadow-card); }
    uf-button[variant="versus"][selected] { border-color: var(--uf-color-versus); box-shadow: 0 0 0 1px var(--uf-color-versus), var(--uf-shadow-card); }
    uf-button[variant="accent"][selected] { box-shadow: 0 0 0 1px var(--uf-color-accent), var(--uf-shadow-card); }
    @media (hover: hover) { uf-button:hover:not([disabled]) { filter: brightness(1.15); } }
    uf-button:active:not([disabled]) { transform: translateY(1px); filter: brightness(1.25); }
    uf-button[disabled] { opacity: .45; cursor: default; pointer-events: none; }
    /* Controller focus: the game's FocusController toggles .gamepad-focus on the element it was handed. */
    uf-button.gamepad-focus, uf-button:focus-visible { outline: none; box-shadow: var(--uf-focus-ring); }
    uf-button small, uf-button .sub, uf-button .lobby-role-desc { display: block; width: 100%; font-size: var(--uf-size-sm); font-weight: 400; color: var(--uf-color-fg-muted); }
    uf-button b, uf-button .big { font-weight: 800; }
  `;

  /** @returns {string} */ get label() { return this.get('label'); }
  /** @param {string} v */ set label(v) { this.set('label', v); }

  /** @returns {'primary' | 'accent' | 'ghost' | 'danger' | 'versus'} */ get variant() { return this.get('variant'); }
  /** @param {'primary' | 'accent' | 'ghost' | 'danger' | 'versus'} v */ set variant(v) { this.set('variant', v); }

  /** @returns {'xs' | 'sm' | 'md' | 'lg' | 'pill'} */ get size() { return this.get('size'); }
  /** @param {'xs' | 'sm' | 'md' | 'lg' | 'pill'} v */ set size(v) { this.set('size', v); }

  /** @returns {string} */ get sub() { return this.get('sub'); }
  /** @param {string} v */ set sub(v) { this.set('sub', v); }

  /** @returns {'center' | 'start'} */ get align() { return this.get('align'); }
  /** @param {'center' | 'start'} v */ set align(v) { this.set('align', v); }

  // disabled / selected sync their ARIA + tabindex synchronously (not on the
  // batched DOM pass): a focus engine reading aria-disabled right after
  // `btn.disabled = true` must see it.
  /** @returns {boolean} */ get disabled() { return this.get('disabled'); }
  /** @param {boolean} v */ set disabled(v) { this.set('disabled', v); this.#syncA11y(); }

  /** @returns {boolean} */ get selected() { return this.get('selected'); }
  /** @param {boolean} v */ set selected(v) { this.set('selected', v); this.#syncA11y(); }

  /** @override @param {string} attr @param {string|null} old @param {string|null} val */
  attributeChangedCallback(attr, old, val) {
    super.attributeChangedCallback(attr, old, val);
    if (attr === 'disabled' || attr === 'selected') this.#syncA11y();
  }

  #wired = false;

  /** @override */
  onConnect() {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'button');
    this.#syncA11y();
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.click();
    });
    // Belt and braces with the CSS pointer-events rule: a synthetic click on a
    // disabled button (el.click() from a focus controller) must not fire handlers.
    this.addEventListener('click', (e) => { if (this.disabled) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }

  #syncA11y() {
    this.setAttribute('aria-disabled', String(this.disabled));
    this.setAttribute('tabindex', this.disabled ? '-1' : (this.getAttribute('data-tabindex') ?? '0'));
    if (this.selected) this.setAttribute('aria-pressed', 'true'); else this.removeAttribute('aria-pressed');
  }

  /** First paint: the `label` prop, if any, replaces the authored children. @override */
  render() { return this.label ? esc(this.label) : null; }

  /** @override @param {Set<string>} changed */
  update(changed) {
    if (changed.has('label') && this.label) this.textContent = this.label;
    if (changed.has('label') || changed.has('sub')) this.#syncSub();
    if (changed.has('disabled') || changed.has('selected')) this.#syncA11y();
    return true;   // variant/size are styled off the host attributes; nothing to patch
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) { this.#syncA11y(); this.#syncSub(); }

  /** Keep exactly one trailing .uf-button__sub matching the `sub` prop. */
  #syncSub() {
    let el = /** @type {HTMLElement|null} */ (this.querySelector(':scope > .uf-button__sub'));
    if (!this.sub) { el?.remove(); return; }
    if (!el) { el = document.createElement('small'); el.className = 'uf-button__sub'; }
    if (el.textContent !== this.sub) el.textContent = this.sub;
    if (el !== this.lastElementChild || el.nextSibling) this.appendChild(el);
  }

  /** @override */
  click() { if (!this.disabled) super.click(); }
}

UfButton.define();
