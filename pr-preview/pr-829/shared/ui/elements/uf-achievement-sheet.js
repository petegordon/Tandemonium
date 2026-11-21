// @ts-check
// ============================================================
// <uf-achievement-sheet> — the achievements sheet: the grid, and a detail card per badge.
// ============================================================
//
//   <uf-achievement-sheet id="ach" heading="Achievements"></uf-achievement-sheet>
//   const sheet = document.getElementById('ach');
//   sheet.sections = [...]; sheet.achievements = [...];   // AchievementItem[] (uf-achievement-grid.js)
//   sheet.show();                    // the grid
//   sheet.showDetail('snake_eyes');  // straight to one card
//   sheet.attachFocus(focusController);   // optional: a controller drives it (A opens, B goes back)
//
// Two <uf-sheet>s it builds itself: the grid (size lg) and, over it, one
// badge's card (size md, headed with the badge's section). Picking a badge
// lifts it off the grid toward the middle of the screen while the grid dims,
// then the card shows. Back on the card (B, Esc, the scrim, its Close)
// returns to the grid with focus on the same badge; Back on the grid closes
// everything and focus returns to whatever opened it.
//
// Events: uf-achievement-sheet:select ({ id }) when a card opens,
//         uf-achievement-sheet:close when the whole sheet closes.
//
// Replaces: Tandemonium's #achievements-modal + #ach-detail sheets and their
// open/close/lift/focus handling in lobby.js.

import { UfElement, prop } from '../uf-element.js';
import './uf-sheet.js';
import './uf-achievement-grid.js';
import './uf-achievement-detail.js';

/** @typedef {import('./uf-achievement-grid.js').AchievementItem} AchievementItem */
/** @typedef {import('./uf-achievement-grid.js').AchievementSection} AchievementSection */

export class UfAchievementSheet extends UfElement {
  /** @override */ static tag = 'uf-achievement-sheet';

  /** @override */ static props = {
    heading: prop.string('Achievements'),
    // Shown as the card's heading when a badge has no section title.
    detailHeading: prop.string('Achievement'),
    size: prop.enum(/** @type {const} */ (['md', 'tv']), 'md'),
  };

  /** @override */ static styles = `
    uf-achievement-sheet { display: contents; }
    uf-achievement-sheet .uas-list .uf-sheet__body { transition: filter 420ms ease; scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--uf-color-fg) 22%, transparent) transparent; scrollbar-gutter: stable; }
    uf-achievement-sheet .uas-list .uf-sheet__body.uas-dim { filter: blur(6px) brightness(.5); }
    uf-achievement-sheet .uag-item.uas-lifting { visibility: hidden; }
    .uag-host .uas-lift.uag-item { position: fixed; z-index: calc(var(--uf-z-modal) + 2); margin: 0; box-sizing: border-box; pointer-events: none; opacity: 1;
      background: color-mix(in srgb, var(--uf-color-surface) 92%, var(--uf-color-fg)); border-color: var(--uf-color-accent-2) !important;
      box-shadow: 0 0 30px color-mix(in srgb, var(--uf-color-accent-2) 45%, transparent), 0 30px 60px rgba(0,0,0,.6); transform-origin: 50% 50%; }
    .uag-host .uas-lift .uag-name { color: color-mix(in srgb, var(--uf-color-fg) 92%, transparent) !important; }
  `;

  /** @type {AchievementItem[]} */ #achievements = [];
  /** @type {AchievementSection[]} */ #sections = [];
  /** @type {any} */ #list = null;
  /** @type {any} */ #detail = null;
  /** @type {any} */ #grid = null;
  /** @type {any} */ #card = null;
  /** @type {string|null} */ #detailId = null;
  /** @type {HTMLElement|null} */ #opener = null;
  /** @type {import('../focus-controller.js').FocusController|null} */ #focus = null;
  #lifting = false;

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }
  /** @returns {string} */ get detailHeading() { return this.get('detailHeading'); }
  /** @param {string} v */ set detailHeading(v) { this.set('detailHeading', v); }
  /** @returns {'md' | 'tv'} */ get size() { return this.get('size'); }
  /** @param {'md' | 'tv'} v */ set size(v) { this.set('size', v); }

  /** @returns {AchievementItem[]} */ get achievements() { return this.#achievements; }
  /** @param {AchievementItem[]} v */
  set achievements(v) { this.#achievements = Array.isArray(v) ? v : []; this.#build(); this.#grid.achievements = this.#achievements; this.#refreshCard(); }
  /** @returns {AchievementSection[]} */ get sections() { return this.#sections; }
  /** @param {AchievementSection[]} v */
  set sections(v) { this.#sections = Array.isArray(v) ? v : []; this.#build(); this.#grid.sections = this.#sections; }

  /** The grid's sheet is open. */
  get open() { return !!(this.#list && this.#list.open); }
  /** A card is open. */
  get detailOpen() { return !!(this.#detail && this.#detail.open); }
  /** The id the card shows (null when closed). */
  get detailId() { return this.#detailId; }
  /** The inner elements, for a page that wants to style or extend them. */
  get gridElement() { this.#build(); return this.#grid; }
  get detailElement() { this.#build(); return this.#card; }

  /** Open the grid. Focus returns to the element that had it when the sheet closes. */
  show() {
    this.#build();
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    this.#opener = active && active !== document.body ? active : null;
    this.#list.show();
    if (this.#list.body) this.#list.body.scrollTop = 0;
    const first = this.#grid.focusables()[0];
    if (first && !this.#focus) requestAnimationFrame(() => first.focus({ preventScroll: true }));
  }

  /** Close everything. */
  close() {
    if (this.detailOpen) this.#detail.close();
    if (this.open) this.#list.close();
  }

  /** Open one badge's card (from the grid, or straight from elsewhere). @param {string} id */
  showDetail(id) {
    this.#build();
    const a = this.#achievements.find((x) => x.id === id);
    if (!a || this.detailOpen || this.#lifting) return;
    this.#detailId = id;
    this.#renderCard(a);
    const tile = this.open ? this.#grid.tile(id) : null;
    const show = () => {
      const sec = this.#sections.find((s) => s.id === a.section);
      this.#detail.heading = sec ? sec.title : this.detailHeading;
      // Esc on the card goes back to the grid, not out of both.
      this.#list.dismissible = false;
      this.#detail.show();
      if (!this.#focus) requestAnimationFrame(() => /** @type {HTMLElement|null} */ (this.#detail.querySelector('.uf-sheet__close'))?.focus({ preventScroll: true }));
      this.emit('uf-achievement-sheet:select', { id });
    };
    this.#lift(tile, show);
  }

  /**
   * Let a FocusController drive the sheet: the badges and Close are its scope,
   * A opens a card, B goes back (card → grid → closed).
   * @param {import('../focus-controller.js').FocusController | null} controller
   */
  attachFocus(controller) {
    this.#build();
    this.#focus = controller;
    this.#list.attachFocus(controller);
    this.#detail.attachFocus(controller);
    return this;
  }

  /** @override */
  render() { return null; }

  /** @override */
  onConnect() { this.#build(); }

  /** @override @param {Set<string>} changed */
  afterRender(changed) {
    this.#build();
    if (changed.has('heading')) this.#list.heading = this.heading;
    if (changed.has('size')) this.#grid.size = this.size;
  }

  #build() {
    if (this.#list) return;
    const list = /** @type {any} */ (document.createElement('uf-sheet'));
    list.className = 'uas-list';
    list.setAttribute('size', 'lg');
    list.heading = this.heading;
    const grid = /** @type {any} */ (document.createElement('uf-achievement-grid'));
    grid.size = this.size;
    list.append(grid);
    const detail = /** @type {any} */ (document.createElement('uf-sheet'));
    detail.className = 'uas-detail';
    detail.setAttribute('size', 'md');
    detail.heading = this.detailHeading;
    const card = /** @type {any} */ (document.createElement('uf-achievement-detail'));
    detail.append(card);
    this.append(list, detail);
    this.#list = list; this.#grid = grid; this.#detail = detail; this.#card = card;

    grid.addEventListener('uf-achievement-grid:select', (/** @type {CustomEvent} */ e) => { e.stopPropagation(); this.showDetail(e.detail.id); });
    detail.addEventListener('uf-sheet:close', () => this.#onDetailClosed());
    list.addEventListener('uf-sheet:close', () => this.#onListClosed());
    // A uf-sheet:open/close from the inner sheets is this element's business, not the page's.
    for (const s of [list, detail]) {
      s.addEventListener('uf-sheet:open', (/** @type {Event} */ e) => e.stopPropagation());
      s.addEventListener('uf-sheet:close', (/** @type {Event} */ e) => e.stopPropagation());
    }
  }

  /** @param {AchievementItem} a */
  #renderCard(a) {
    this.#card.total = this.#achievements.length;
    this.#card.number = this.#achievements.indexOf(a) + 1;
    this.#card.achievement = a;
  }

  #refreshCard() {
    if (!this.#detailId) return;
    const a = this.#achievements.find((x) => x.id === this.#detailId);
    if (a) this.#renderCard(a);
  }

  #onDetailClosed() {
    this.#undim();
    this.#list.dismissible = true;
    this.querySelectorAll('.uas-lift-host').forEach((el) => el.remove());
    this.querySelectorAll('.uas-lifting').forEach((el) => el.classList.remove('uas-lifting'));
    const id = this.#detailId;
    this.#detailId = null;
    if (!this.open) return;
    const tile = id ? this.#grid.tile(id) : null;
    // Back to the grid with focus on the same badge (the controller's scope too).
    requestAnimationFrame(() => {
      if (this.#focus && this.open) this.#focus.setSpatial(this.#list.focusables(), tile);
      if (tile) tile.focus({ preventScroll: true });
    });
  }

  #onListClosed() {
    if (this.detailOpen) this.#detail.close();
    this.#undim();
    this.#list.dismissible = true;
    const opener = this.#opener;
    this.#opener = null;
    if (opener && opener.isConnected && !this.#focus) opener.focus({ preventScroll: true });
    this.emit('uf-achievement-sheet:close');
  }

  #undim() {
    const body = this.#list && this.#list.body;
    if (!body) return;
    body.getAnimations?.().forEach((/** @type {Animation} */ a) => a.cancel());
    body.classList.remove('uas-dim');
  }

  /**
   * The badge lifts off the grid toward the middle of the screen (the grid
   * dims), then `done` shows the card. Skipped without a tile or with reduced motion.
   * @param {HTMLElement|null} tile @param {() => void} done
   */
  #lift(tile, done) {
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = tile ? tile.getBoundingClientRect() : null;
    if (!tile || !r || !r.width || reduce || typeof tile.animate !== 'function') { done(); return; }
    this.querySelectorAll('.uas-lift-host').forEach((el) => el.remove());
    const c = /** @type {HTMLElement} */ (tile.cloneNode(true));
    c.classList.add('uas-lift');
    c.classList.remove('gamepad-focus');
    c.removeAttribute('data-ach');
    Object.assign(c.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    // Outside the grid (its body blurs while the card opens), in a host the badge styles match.
    const host = document.createElement('div');
    host.className = 'uag-host uas-lift-host';
    host.append(c);
    this.append(host);
    tile.classList.add('uas-lifting');
    const W = innerWidth, H = innerHeight;
    const S = Math.min(0.6 * W / r.width, 0.45 * H / r.height);
    const dx = W / 2 - (r.left + r.width / 2), dy = H / 2 - (r.top + r.height / 2);
    const anim = c.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${S})`, opacity: 0.35 },
    ], { duration: 420, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' });
    this.#list.body?.classList.add('uas-dim');
    this.#lifting = true;
    let fired = false;
    const finish = () => { if (fired) return; fired = true; this.#lifting = false; host.remove(); tile.classList.remove('uas-lifting'); done(); };
    anim.finished.then(finish, finish);
    setTimeout(finish, 700);   // a dropped animation never leaves the badge in limbo
  }
}

UfAchievementSheet.define();
