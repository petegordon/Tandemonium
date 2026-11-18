// @ts-check
// ============================================================
// <uf-flow> — hosts uf-steps; exactly one is active; go()/back() with history.
// ============================================================
//
// The single owner of "which screen is showing" (plan §3 D4). Replaces the
// lab's showScreen() and, later, the game's _showStep(): instead of each
// screen hiding every other screen by hand, the flow sets `active` on one
// <uf-step> child and clears it on the rest.
//
//   <uf-flow id="lobby" current="mode">
//     <uf-step id="mode">…</uf-step>
//     <uf-step id="seats">… <uf-button data-flow-back>← Back</uf-button></uf-step>
//   </uf-flow>
//
//   flow.go('seats')           push onto history, activate
//   flow.back()                → true if it went somewhere
//   flow.current               id of the active step (reflected attribute)
//   flow.addEventListener('uf-flow:change', e => e.detail /* {from, to, back} */)
//
// Declarative wiring: a click on any descendant with [data-flow-go="id"]
// calls go(id); with [data-flow-back] calls back(). Side effects a screen
// needs on entry/exit (start a monitor, clear input edges) hang off the
// change event, not off the navigation code.

import { UfElement, prop } from '../uf-element.js';

export class UfFlow extends UfElement {
  /** @override */ static tag = 'uf-flow';

  /** @override */ static props = {
    current: prop.string(''),
  };

  /** @override */ static styles = `
    uf-flow { display: block; width: 100%; }
  `;

  /** @type {string[]} */ #history = [];
  #wired = false;
  #applying = false;
  /** the id whose step currently carries [active]; '' before the first apply */
  #applied = '';

  /** @returns {string} */ get current() { return this.get('current'); }
  /** @param {string} v */ set current(v) { this.set('current', v); }

  /** The flow's step elements, in document order. */
  steps() { return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll(':scope > uf-step'))); }

  /** @param {string} id @returns {import('./uf-step.js').UfStep | null} */
  step(id) { return /** @type {import('./uf-step.js').UfStep | null} */ (this.steps().find((s) => s.id === id) || null); }

  /** @returns {readonly string[]} ids visited before the current one */
  get history() { return this.#history; }
  get canBack() { return this.#history.length > 0; }

  /**
   * Activate a step. Returns false if no such step.
   * @param {string} id @param {{ push?: boolean }} [opts] push=false replaces instead of stacking (default true)
   */
  go(id, opts = {}) {
    const to = this.step(id);
    if (!to) { console.warn(`[uf-flow] no step "${id}"`); return false; }
    const from = this.#applied;
    if (from === id) return true;
    if (from && opts.push !== false) this.#history.push(from);
    this.#apply(id);
    this.emit('uf-flow:change', { from, to: id, back: false });
    return true;
  }

  /** Go to the previous step. Returns false at the root. */
  back() {
    const prev = this.#history.pop();
    if (!prev) return false;
    const from = this.#applied;
    this.#apply(prev);
    this.emit('uf-flow:change', { from, to: prev, back: true });
    return true;
  }

  /** Forget the history (e.g. after a hand-off to the game). */
  reset() { this.#history = []; }

  /** @type {import('../focus-controller.js').FocusController | null} */ #focus = null;

  /**
   * Bind a FocusController: on every step change the active step's
   * focusables() become the controller's spatial scope, and B (back) walks the
   * flow's history unless the controller has its own onBack. Call poll() on
   * the controller from your frame loop as usual. Pass null to detach.
   * @param {import('../focus-controller.js').FocusController | null} controller
   */
  attachFocus(controller) {
    this.#focus = controller;
    if (controller) this.#syncFocus();
    return this;
  }

  /** Rebuild the focus scope for the current step (after its focusables changed). */
  refreshFocus() {
    const step = this.step(this.current);
    if (this.#focus && step) this.#focus.refreshSpatial(this.#scope(step));
  }

  /**
   * The active step's focusables plus the pills of any <uf-system-bar> linked
   * to this flow (flow="<id>"): the bar is a focus row under the step, reached
   * with ↓ and left with ↑ (spatial nearest-neighbour does the rest).
   * @param {import('./uf-step.js').UfStep} step @returns {HTMLElement[]}
   */
  #scope(step) {
    const items = step.focusables();
    if (!this.id) return items;
    for (const bar of Array.from(document.querySelectorAll(`uf-system-bar[flow="${CSS.escape(this.id)}"]`))) {
      const fn = /** @type {any} */ (bar).focusables;
      if (typeof fn === 'function') items.push(...fn.call(bar));
    }
    return items;
  }

  #syncFocus() {
    const step = this.step(this.current);
    if (!this.#focus || !step) return;
    // Layout settles after the step shows (display toggles): take the scope on the next frame.
    const take = () => { const s = this.step(this.current); if (this.#focus && s === step) this.#focus.setSpatial(this.#scope(step)); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(take); else take();
  }

  /** @param {string} id */
  #apply(id) {
    for (const s of this.steps()) s.toggleAttribute('active', s.id === id);
    this.#applied = id;
    this.#applying = true;
    try { this.current = id; } finally { this.#applying = false; }
    this.#syncFocus();
  }

  /** @override */
  onConnect() {
    if (!this.#wired) {
      this.#wired = true;
      this.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        const go = t?.closest('[data-flow-go]');
        if (go && this.contains(go)) { const id = go.getAttribute('data-flow-go'); if (id) this.go(id); return; }
        if (t?.closest('[data-flow-back]')) this.back();
      });
    }
    // Initial step: the `current` attribute, else the first child marked active, else the first child.
    queueMicrotask(() => {
      const steps = this.steps();
      const initial = this.current || steps.find((s) => s.hasAttribute('active'))?.id || steps[0]?.id || '';
      if (initial) this.#apply(initial);
    });
  }

  /**
   * `current` set from outside (attribute or property) navigates without
   * stacking. By the time this runs the prop already holds the new id, so the
   * step is applied directly against the last APPLIED id (not via go(), which
   * would see from === to and do nothing).
   * @override @param {Set<string>} changed
   */
  update(changed) {
    if (changed.has('current') && !this.#applying) {
      const to = this.current, from = this.#applied;
      if (to && to !== from) {
        if (!this.step(to)) { console.warn(`[uf-flow] no step "${to}"`); return true; }
        this.#apply(to);
        this.emit('uf-flow:change', { from, to, back: false });
      }
    }
    return true;
  }
}

UfFlow.define();
