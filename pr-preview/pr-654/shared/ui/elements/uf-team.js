// @ts-check
// ============================================================
// <uf-team> — the team box: a titled, tinted frame around its seats.
// ============================================================
//
//   <uf-team tone="team-a" title="TEAM BLUE"> <uf-seat …></uf-seat> <uf-seat …></uf-seat> </uf-team>
//   <uf-team tone="coop" title="YOUR TANDEM"> <uf-seat seat="Captain" tone="captain" …> <uf-seat seat="Stoker" tone="stoker" …> </uf-team>
//
// Keeps its authored children (the seats the app renders) and adds a title
// row. `layout` row lays the seats side by side (TV), column stacks them
// (narrow), auto picks row unless the box is narrower than ~2 seats.
// Versus uses two (with a "VS" between them, from the parent layout); local
// co-op uses one.
//
// Replaces: the game's .versus-team / .versus-team-title / .versus-team-slots
// and the lab lobby's .team / .team-title / .team-slots / .tandem /
// .tandem-title / .tandem-seats (docs/UI-KIT-TV-COMPONENTS.md §6).

import { UfElement, prop } from '../uf-element.js';

export class UfTeam extends UfElement {
  /** @override */ static tag = 'uf-team';

  /** @override */ static props = {
    // "heading", not "title": a `title` property would shadow HTMLElement.title (the tooltip).
    heading: prop.string(''),
    tone: prop.enum(/** @type {const} */ (['team-a', 'team-b', 'coop']), 'coop'),
    layout: prop.enum(/** @type {const} */ (['auto', 'row', 'column']), 'auto'),
  };

  /** @override */ static styles = `
    uf-team {
      --_tone: var(--uf-color-captain);
      box-sizing: border-box; display: flex; flex-wrap: wrap; gap: var(--uf-space-3); align-content: flex-start; align-items: stretch; min-width: 0;
      padding: var(--uf-space-3); border-radius: var(--uf-radius-lg);
      border: 2px solid color-mix(in srgb, var(--_tone) 50%, transparent);
      background: color-mix(in srgb, var(--_tone) 8%, transparent);
    }
    uf-team[tone="team-a"] { --_tone: var(--uf-color-team-a); }
    uf-team[tone="team-b"] { --_tone: var(--uf-color-team-b); }
    /* The title takes its own line; seats share the next. auto wraps seats below ~9 lines of text wide. */
    uf-team > .uf-team__title { flex: 1 0 100%; text-align: center; font: 800 var(--uf-size-sm)/1.1 var(--uf-font-mono); letter-spacing: .16em; text-transform: uppercase; color: var(--_tone); }
    uf-team > uf-seat { flex: 1 1 calc(var(--uf-size-lg) * 9); min-width: 0; }
    /* row: basis 0 keeps every seat on the one line after the title. */
    uf-team[layout="row"] > uf-seat { flex: 1 1 0; }
    uf-team[layout="column"] > uf-seat { flex-basis: 100%; }
  `;

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }

  /** @returns {'team-a' | 'team-b' | 'coop'} */ get tone() { return this.get('tone'); }
  /** @param {'team-a' | 'team-b' | 'coop'} v */ set tone(v) { this.set('tone', v); }

  /** @returns {'auto' | 'row' | 'column'} */ get layout() { return this.get('layout'); }
  /** @param {'auto' | 'row' | 'column'} v */ set layout(v) { this.set('layout', v); }

  /** The seats in this box, in order. @returns {HTMLElement[]} */
  seats() { return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll(':scope > uf-seat'))); }

  /** @type {MutationObserver|null} */ #mo = null;

  /** An app that rewrites the seats (innerHTML) must not lose the title row. @override */
  onConnect() {
    if (this.#mo || typeof MutationObserver === 'undefined') return;
    this.#mo = new MutationObserver(() => { if (this.heading && !this.querySelector(':scope > .uf-team__title')) this.afterRender(new Set()); });
    this.#mo.observe(this, { childList: true });
  }

  /** @override */
  onDisconnect() { this.#mo?.disconnect(); this.#mo = null; }

  /** @override */
  render() { return null; }   // keep the seats the app rendered

  /** @override @param {Set<string>} _changed */
  update(_changed) { return false; }

  /** Keep one title row first. @override @param {Set<string>} _changed */
  afterRender(_changed) {
    let t = /** @type {HTMLElement|null} */ (this.querySelector(':scope > .uf-team__title'));
    if (!this.heading) { t?.remove(); return; }
    if (!t) { t = document.createElement('div'); t.className = 'uf-team__title'; }
    if (t.textContent !== this.heading) t.textContent = this.heading;
    if (this.firstElementChild !== t) this.prepend(t);
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', this.heading);
  }
}

UfTeam.define();
