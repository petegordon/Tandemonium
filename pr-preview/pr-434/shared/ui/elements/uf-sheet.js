// @ts-check
// ============================================================
// <uf-sheet> — one shell for panels and dialogs.
// ============================================================
//
//   <uf-sheet id="controls" heading="Controls" size="md">
//     …body content (ids and listeners survive)…
//     <div slot="actions"><uf-button variant="accent">DONE</uf-button></div>
//   </uf-sheet>
//   sheet.show(); sheet.close();  sheet.open = true;
//
// On first paint the element moves its authored children into a card: a header
// (heading + a "◯ Close" control), a scrolling body, and an actions row (the
// children marked slot="actions"). Nodes are moved, not copied, so references
// the page captured keep working; children appended later land in the body.
//
// Behaviour:
//  - covers the stage only: the scrim stops at --uf-stage-inset, so a lobby's
//    art panel stays visible;
//  - Back closes it (Esc, a scrim click, the Close control, or — after
//    attachFocus(controller) — the controller's B), unless dismissible="false";
//  - attachFocus(controller): while open, the sheet's focusables are the
//    controller's spatial scope; on close the previous scope and focus return.
// Events: uf-sheet:open, uf-sheet:close ({ reason: 'back' | 'scrim' | 'escape' | 'close' | 'api' }).
//
// Replaces: the game's ~15 hand-made overlays (#phone-pad-panel, #help-modal,
// #leaderboard-modal, #profile-popup, #options-overlay, …) — each with its own
// backdrop, close rule and focus handling (docs/UI-KIT-TV-COMPONENTS.md §8).

import { UfElement, prop } from '../uf-element.js';

const FOCUSABLE = 'uf-button, button, input, [data-focusable]';

export class UfSheet extends UfElement {
  /** @override */ static tag = 'uf-sheet';

  /** @override */ static props = {
    heading: prop.string(''),
    open: prop.boolean(false),
    placement: prop.enum(/** @type {const} */ (['center', 'side', 'bottom']), 'center'),
    size: prop.enum(/** @type {const} */ (['sm', 'md', 'lg']), 'md'),
    dismissible: prop.boolean(true),
    // A result screen's headline: big, centred, in the tone's colour ('YOU MADE IT!', 'TEAM BLUE WINS!').
    tone: prop.enum(/** @type {const} */ (['neutral', 'accent', 'danger', 'gold', 'team-a', 'team-b']), 'neutral'),
    headline: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-sheet { position: fixed; inset: 0 var(--uf-stage-inset, 0px) 0 0; z-index: var(--uf-z-modal); display: none;
      background: var(--uf-color-scrim); font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-sheet[open] { display: grid; place-items: center; }
    uf-sheet[placement="side"][open] { place-items: stretch end; }
    uf-sheet[placement="bottom"][open] { place-items: end stretch; }
    uf-sheet > .uf-sheet__card { box-sizing: border-box; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: var(--uf-space-4);
      width: min(var(--_w), calc(100% - 2 * var(--uf-space-5))); max-height: calc(100dvh - 2 * var(--uf-space-5));   /* dvh, not %: the sheet's grid row is auto-sized, so % never limited it */
      padding: var(--uf-space-5) var(--uf-space-6); border-radius: var(--uf-radius-lg); font-size: var(--uf-size-md);
      background: var(--uf-color-surface); border: 1px solid var(--uf-color-line-soft); box-shadow: var(--uf-shadow-card), 0 30px 80px rgba(0,0,0,.55); }
    uf-sheet[size="sm"] { --_w: 26em; } uf-sheet[size="md"] { --_w: 36em; } uf-sheet[size="lg"] { --_w: 52em; }
    uf-sheet[placement="side"] > .uf-sheet__card { height: 100%; max-height: none; border-radius: 0; width: min(var(--_w), 100%); }
    uf-sheet[placement="bottom"] > .uf-sheet__card { width: 100%; border-radius: var(--uf-radius-lg) var(--uf-radius-lg) 0 0; }
    uf-sheet .uf-sheet__head { display: flex; align-items: center; justify-content: space-between; gap: var(--uf-space-4); }
    uf-sheet .uf-sheet__title { margin: 0; font: 800 var(--uf-size-xl)/1.15 var(--uf-font-ui); color: var(--_tone, var(--uf-color-fg)); }
    uf-sheet[tone="accent"] { --_tone: var(--uf-color-accent); } uf-sheet[tone="danger"] { --_tone: var(--uf-color-danger); } uf-sheet[tone="gold"] { --_tone: var(--uf-color-accent-2); }
    uf-sheet[tone="team-a"] { --_tone: var(--uf-color-team-a); } uf-sheet[tone="team-b"] { --_tone: var(--uf-color-team-b); }
    uf-sheet[headline] .uf-sheet__head { justify-content: center; position: relative; }
    uf-sheet[headline] .uf-sheet__title { font-size: calc(var(--uf-size-2xl) * 1.35); letter-spacing: .04em; text-align: center; text-transform: uppercase; }
    uf-sheet[headline] .uf-sheet__close { position: absolute; right: 0; top: 0; }
    uf-sheet .uf-sheet__close { display: inline-flex; align-items: center; gap: .45em; padding: .3em .6em; border-radius: var(--uf-radius-sm);
      font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); cursor: pointer; background: none; border: none; font-family: inherit; }
    uf-sheet .uf-sheet__close:hover { color: var(--uf-color-fg); }
    uf-sheet[dismissible="false"] .uf-sheet__close { display: none; }
    uf-sheet .uf-sheet__body { overflow: auto; min-height: 0; display: grid; gap: var(--uf-space-3); align-content: start; }
    uf-sheet .uf-sheet__actions { display: flex; flex-wrap: wrap; gap: var(--uf-space-3); justify-content: flex-end; align-items: center; }
    uf-sheet .uf-sheet__actions:empty { display: none; }
  `;

  /** @type {HTMLElement|null} */ #card = null;
  /** @type {HTMLElement|null} */ #body = null;
  /** @type {HTMLElement|null} */ #actions = null;
  /** @type {MutationObserver|null} */ #mo = null;
  /** @type {import('../focus-controller.js').FocusController|null} */ #focus = null;
  /** @type {{ items: HTMLElement[], el: HTMLElement|null, spatial: boolean, index: number }|null} */ #prevScope = null;
  /** @type {(() => void) | null} */ #prevBack = null;
  #wasOpen = false;
  #closeReason = 'api';
  /** @type {((e: KeyboardEvent) => void) | null} */ #onKey = null;

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }

  /** @returns {boolean} */ get open() { return this.get('open'); }
  /** @param {boolean} v */ set open(v) { this.set('open', v); }

  /** @returns {'center' | 'side' | 'bottom'} */ get placement() { return this.get('placement'); }
  /** @param {'center' | 'side' | 'bottom'} v */ set placement(v) { this.set('placement', v); }

  /** @returns {'sm' | 'md' | 'lg'} */ get size() { return this.get('size'); }
  /** @param {'sm' | 'md' | 'lg'} v */ set size(v) { this.set('size', v); }

  /** @returns {'neutral' | 'accent' | 'danger' | 'gold' | 'team-a' | 'team-b'} */ get tone() { return this.get('tone'); }
  /** @param {'neutral' | 'accent' | 'danger' | 'gold' | 'team-a' | 'team-b'} v */ set tone(v) { this.set('tone', v); }
  /** @returns {boolean} */ get headline() { return this.get('headline'); }
  /** @param {boolean} v */ set headline(v) { this.set('headline', v); }

  /** @returns {boolean} */ get dismissible() { return this.get('dismissible'); }
  /** @param {boolean} v */ set dismissible(v) { this.set('dismissible', v); }

  /** The card's body (append content here). */
  get body() { this.#build(); return /** @type {HTMLElement} */ (this.#body); }

  show() { this.#closeReason = 'api'; this.open = true; }
  /** @param {'back' | 'scrim' | 'escape' | 'close' | 'api'} [reason] */
  close(reason = 'api') { this.#closeReason = reason; this.open = false; }

  /** Back pressed: closes a dismissible open sheet. @returns {boolean} true if it closed */
  handleBack() {
    if (!this.open || !this.dismissible) return false;
    this.close('back');
    return true;
  }

  /** Visible, enabled focusables inside the card. @returns {HTMLElement[]} */
  focusables() {
    this.#build();
    const card = /** @type {HTMLElement} */ (this.#card);
    return /** @type {HTMLElement[]} */ (Array.from(card.querySelectorAll(FOCUSABLE))).filter((el) => {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  /**
   * Let a FocusController drive the sheet while it is open: its focusables
   * become the scope, B closes it, and the previous scope returns on close.
   * @param {import('../focus-controller.js').FocusController | null} controller
   */
  attachFocus(controller) {
    if (this.#focus && this.#prevBack !== null) this.#focus._onBack = this.#prevBack;
    this.#focus = controller;
    this.#prevBack = null;
    if (controller) {
      this.#prevBack = controller._onBack;
      const prev = this.#prevBack;
      controller._onBack = () => { if (!this.handleBack() && prev) prev(); };
      if (this.open) this.#takeFocus();
    }
    return this;
  }

  /** Re-read the sheet's focusables (after its content changed). */
  refreshFocus() { if (this.#focus && this.open) this.#focus.refreshSpatial(this.focusables()); }

  /** @override */
  onConnect() {
    this.#onKey = (e) => { if (e.key === 'Escape' && this.open && this.dismissible) { e.preventDefault(); this.close('escape'); } };
    document.addEventListener('keydown', this.#onKey);
    this.addEventListener('click', (e) => {
      if (e.target === this && this.dismissible) this.close('scrim');
    });
  }

  /** @override */
  onDisconnect() {
    if (this.#onKey) document.removeEventListener('keydown', this.#onKey);
    this.#mo?.disconnect(); this.#mo = null;
  }

  /** @override */
  render() { return null; }

  /** @override @param {Set<string>} _changed */
  update(_changed) { return false; }

  /** @override @param {Set<string>} changed */
  afterRender(changed) {
    this.#build();
    const title = /** @type {HTMLElement} */ (this.querySelector(':scope > .uf-sheet__card .uf-sheet__title'));
    title.textContent = this.heading;
    title.hidden = !this.heading;
    this.setAttribute('role', 'dialog');
    this.setAttribute('aria-modal', 'true');
    if (this.heading) this.setAttribute('aria-label', this.heading);
    this.setAttribute('dismissible', String(this.dismissible));
    if (changed.has('open') || this.open !== this.#wasOpen) {
      if (this.open && !this.#wasOpen) { this.#wasOpen = true; this.#takeFocus(); this.emit('uf-sheet:open'); }
      else if (!this.open && this.#wasOpen) { this.#wasOpen = false; this.#giveBackFocus(); this.emit('uf-sheet:close', { reason: this.#closeReason }); this.#closeReason = 'api'; }
    }
  }

  #build() {
    if (this.#card) return;
    const card = document.createElement('div'); card.className = 'uf-sheet__card';
    const head = document.createElement('div'); head.className = 'uf-sheet__head';
    const title = document.createElement('div'); title.className = 'uf-sheet__title';
    title.setAttribute('role', 'heading'); title.setAttribute('aria-level', '2');
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'uf-sheet__close';
    const glyph = document.createElement('uf-controller-glyph'); glyph.setAttribute('button', 'back'); glyph.setAttribute('size', 'sm');
    closeBtn.append(glyph, 'Close');
    head.append(title, closeBtn);
    const body = document.createElement('div'); body.className = 'uf-sheet__body';
    const actions = document.createElement('div'); actions.className = 'uf-sheet__actions';
    for (const n of Array.from(this.childNodes)) {
      if (n instanceof HTMLElement && n.getAttribute('slot') === 'actions') actions.append(n);
      else if (!(n instanceof HTMLStyleElement)) body.append(n);
    }
    card.append(head, body, actions);
    this.append(card);
    head.querySelector('.uf-sheet__close')?.addEventListener('click', () => this.close('close'));
    this.#card = card; this.#body = body; this.#actions = actions;
    // Children the page appends later go into the body (actions by slot).
    if (typeof MutationObserver !== 'undefined') {
      this.#mo = new MutationObserver((recs) => {
        for (const r of recs) for (const n of Array.from(r.addedNodes)) {
          if (n === card || n.parentNode !== this) continue;
          if (n instanceof HTMLElement && n.getAttribute('slot') === 'actions') actions.append(n); else body.append(n);
        }
      });
      this.#mo.observe(this, { childList: true });
    }
  }

  #takeFocus() {
    const fc = this.#focus;
    if (!fc) return;
    this.#prevScope = { items: fc.items.slice(), el: fc.focusedEl, spatial: fc._spatial, index: fc.index };
    // Start on the first thing in the body (a setting, a button), not the
    // header's Close: B already closes, so Close is the last resort.
    const take = () => {
      if (!this.open || this.#focus !== fc) return;
      const items = this.focusables();
      fc.setSpatial(items, items.find((el) => !el.classList.contains('uf-sheet__close')) || null);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(take); else take();
  }

  #giveBackFocus() {
    const fc = this.#focus, prev = this.#prevScope;
    this.#prevScope = null;
    if (!fc || !prev) return;
    if (prev.spatial) fc.setSpatial(prev.items, prev.el); else fc.setItems(prev.items, prev.index);
  }
}

UfSheet.define();
