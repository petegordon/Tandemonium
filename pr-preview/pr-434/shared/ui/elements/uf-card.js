// @ts-check
// ============================================================
// <uf-card> — a selectable content card (levels, garage items, upgrades).
// ============================================================
//
//   <uf-card icon="🏠" heading="Grandma's" description="Grandma called — she needs her presents!"
//            footer="No ride yet · 🥇 at 0:58" selected></uf-card>
//   <uf-card icon="🚴" heading="Tutorial" description="Master pedaling and steering!" tone="muted"></uf-card>
//   <uf-card icon="📅" heading="Today's Road" tone="gold" locked footer="Sign in to ride"></uf-card>
//
// The host is the button (role button, Enter/Space/click, focusable), like
// <uf-button>. A parent lays cards out in a row or grid; the card fills its
// cell and keeps its parts on the same lines as its neighbours (icon · title ·
// description · footer), so a row of cards reads as one table.
// Tones: neutral · accent · gold · muted (dashed). `selected` marks the
// current choice; `locked` dims and disables it.
//
// Replaces: the game's .level-card (+ .selected / .level-card-tutorial /
// daily gold) (docs/UI-KIT-TV-COMPONENTS.md §11; #428 finding 1).

import { UfElement, prop, esc } from '../uf-element.js';

export class UfCard extends UfElement {
  /** @override */ static tag = 'uf-card';

  /** @override */ static props = {
    heading: prop.string(''),
    description: prop.string(''),
    footer: prop.string(''),
    icon: prop.string(''),
    tone: prop.enum(/** @type {const} */ (['neutral', 'accent', 'gold', 'muted']), 'neutral'),
    selected: prop.boolean(false),
    locked: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-card { --_tone: var(--uf-color-line-soft);
      box-sizing: border-box; display: grid; grid-template-rows: auto auto 1fr auto; gap: var(--uf-space-2); align-content: start; min-width: 0;
      padding: var(--uf-space-4) var(--uf-space-4); border-radius: var(--uf-radius-lg); cursor: pointer; text-align: left;
      background: var(--uf-color-surface-3); border: 2px solid var(--_tone); color: var(--uf-color-fg); font-family: var(--uf-font-ui);
      transition: transform var(--uf-motion-fast) var(--uf-ease), box-shadow var(--uf-motion-fast), border-color var(--uf-motion-fast); }
    uf-card[tone="accent"] { --_tone: var(--uf-color-accent-line); }
    uf-card[tone="gold"]   { --_tone: color-mix(in srgb, var(--uf-color-accent-2) 65%, transparent); }
    uf-card[tone="muted"]  { border-style: dashed; --_tone: color-mix(in srgb, var(--uf-color-accent) 35%, transparent); }
    uf-card[selected] { --_tone: var(--uf-color-accent); background: color-mix(in srgb, var(--uf-color-accent) 12%, var(--uf-color-surface-3)); }
    uf-card[locked] { opacity: .45; cursor: default; }
    uf-card.gamepad-focus, uf-card:focus-visible { outline: none; box-shadow: var(--uf-focus-ring); transform: translateY(-2px); }
    uf-card .uf-card__icon { font-size: calc(var(--uf-size-2xl) * 1.2); line-height: 1; }
    uf-card .uf-card__title { font: 800 var(--uf-size-xl)/1.15 var(--uf-font-ui); margin: 0; }
    uf-card .uf-card__desc { font-size: var(--uf-size-md); line-height: 1.35; color: var(--uf-color-fg-muted); }
    uf-card .uf-card__foot { font: 700 var(--uf-size-md)/1.3 var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-card .uf-card__foot:empty, uf-card .uf-card__icon:empty { display: none; }
  `;

  #wired = false;

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }

  /** @returns {string} */ get description() { return this.get('description'); }
  /** @param {string} v */ set description(v) { this.set('description', v); }

  /** @returns {string} */ get footer() { return this.get('footer'); }
  /** @param {string} v */ set footer(v) { this.set('footer', v); }

  /** @returns {string} */ get icon() { return this.get('icon'); }
  /** @param {string} v */ set icon(v) { this.set('icon', v); }

  /** @returns {'neutral' | 'accent' | 'gold' | 'muted'} */ get tone() { return this.get('tone'); }
  /** @param {'neutral' | 'accent' | 'gold' | 'muted'} v */ set tone(v) { this.set('tone', v); }

  /** @returns {boolean} */ get selected() { return this.get('selected'); }
  /** @param {boolean} v */ set selected(v) { this.set('selected', v); }

  /** @returns {boolean} */ get locked() { return this.get('locked'); }
  /** @param {boolean} v */ set locked(v) { this.set('locked', v); }

  /** @override */
  onConnect() {
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });
    this.addEventListener('click', (e) => { if (this.locked) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }

  /** @override */
  render() {
    return `<span class="uf-card__icon" aria-hidden="true">${esc(this.icon)}</span>` +
      `<div class="uf-card__title" role="heading" aria-level="3">${esc(this.heading)}</div>` +
      `<span class="uf-card__desc">${esc(this.description)}</span>` +
      `<span class="uf-card__foot">${esc(this.footer)}</span>`;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    this.setAttribute('role', 'button');
    this.setAttribute('tabindex', this.locked ? '-1' : '0');
    this.setAttribute('aria-disabled', String(this.locked));
    if (this.selected) this.setAttribute('aria-pressed', 'true'); else this.removeAttribute('aria-pressed');
    this.toggleAttribute('data-focusable', !this.locked);
  }
}

UfCard.define();
