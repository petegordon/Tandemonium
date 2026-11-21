// @ts-check
// ============================================================
// <uf-stat> — one figure: icon, value, label (end-of-ride grids, team results).
// ============================================================
//
//   <uf-stat icon="⏱️" value="18s" label="Time"></uf-stat>
//   <uf-stat icon="🥇" value="Gold" label="Medal" tone="gold" emphasis></uf-stat>
//   <uf-stat variant="card" tone="team-a" label="Team blue" value="11s" detail="0 crashes · 🎁 0"></uf-stat>
//
// variant="inline" (default): icon + value with the label under it, for a grid
// of figures. variant="card": a framed result in the tone's colour (versus
// team results). `emphasis` makes the value larger (the headline figure).
// Lay several out with a parent grid.
//
// Replaces: the game's victory stat rows (.stat-*), the versus result boxes
// and the slingshot tally rows (docs/UI-KIT-TV-COMPONENTS.md, kit 0.4).

import { UfElement, prop, esc } from '../uf-element.js';

export class UfStat extends UfElement {
  /** @override */ static tag = 'uf-stat';

  /** @override */ static props = {
    icon: prop.string(''),
    value: prop.string(''),
    label: prop.string(''),
    detail: prop.string(''),
    variant: prop.enum(/** @type {const} */ (['inline', 'card']), 'inline'),
    tone: prop.enum(/** @type {const} */ (['neutral', 'accent', 'gold', 'danger', 'team-a', 'team-b']), 'neutral'),
    emphasis: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-stat { --_tone: var(--uf-color-fg); text-align: left; display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "icon value" "icon label";
      column-gap: var(--uf-space-3); align-items: center; font-family: var(--uf-font-ui); color: var(--uf-color-fg); min-width: 0; }
    uf-stat[tone="accent"] { --_tone: var(--uf-color-accent); } uf-stat[tone="gold"] { --_tone: var(--uf-color-accent-2); }
    uf-stat[tone="danger"] { --_tone: var(--uf-color-danger); } uf-stat[tone="team-a"] { --_tone: var(--uf-color-team-a); } uf-stat[tone="team-b"] { --_tone: var(--uf-color-team-b); }
    uf-stat .ust-icon { grid-area: icon; font-size: calc(var(--uf-size-xl) * 1.1); line-height: 1; }
    uf-stat .ust-icon:empty { display: none; }
    uf-stat .ust-value { grid-area: value; font: 800 var(--uf-size-xl)/1.1 var(--uf-font-ui); color: var(--_tone); font-variant-numeric: tabular-nums; }
    uf-stat[emphasis] .ust-value { font-size: var(--uf-size-2xl); }
    uf-stat .ust-label { grid-area: label; font-size: var(--uf-size-sm); color: var(--uf-color-fg-muted); }
    uf-stat .ust-detail { grid-column: 1 / -1; font-size: var(--uf-size-xs); color: var(--uf-color-fg-muted); }
    uf-stat .ust-detail:empty { display: none; }
    uf-stat[variant="card"] { grid-template-columns: minmax(0, 1fr); grid-template-areas: "label" "value"; justify-items: center; text-align: center; row-gap: var(--uf-space-1);
      padding: var(--uf-space-3) var(--uf-space-4); border-radius: var(--uf-radius-md); border: 2px solid color-mix(in srgb, var(--_tone) 60%, transparent); background: color-mix(in srgb, var(--_tone) 8%, transparent); }
    uf-stat[variant="card"] .ust-label { font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--_tone); }
    uf-stat[variant="card"] .ust-value { color: var(--uf-color-fg); }
    uf-stat[variant="card"] .ust-icon { display: none; }
  `;

  /** @returns {string} */ get icon() { return this.get('icon'); }
  /** @param {string} v */ set icon(v) { this.set('icon', v); }
  /** @returns {string} */ get value() { return this.get('value'); }
  /** @param {string} v */ set value(v) { this.set('value', v); }
  /** @returns {string} */ get label() { return this.get('label'); }
  /** @param {string} v */ set label(v) { this.set('label', v); }
  /** @returns {string} */ get detail() { return this.get('detail'); }
  /** @param {string} v */ set detail(v) { this.set('detail', v); }
  /** @returns {'inline' | 'card'} */ get variant() { return this.get('variant'); }
  /** @param {'inline' | 'card'} v */ set variant(v) { this.set('variant', v); }
  /** @returns {'neutral' | 'accent' | 'gold' | 'danger' | 'team-a' | 'team-b'} */ get tone() { return this.get('tone'); }
  /** @param {'neutral' | 'accent' | 'gold' | 'danger' | 'team-a' | 'team-b'} v */ set tone(v) { this.set('tone', v); }
  /** @returns {boolean} */ get emphasis() { return this.get('emphasis'); }
  /** @param {boolean} v */ set emphasis(v) { this.set('emphasis', v); }

  /** @override */
  render() {
    return `<span class="ust-icon" aria-hidden="true">${esc(this.icon)}</span>` +
      `<span class="ust-value">${esc(this.value)}</span>` +
      `<span class="ust-label">${esc(this.label)}</span>` +
      `<span class="ust-detail">${esc(this.detail)}</span>`;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) { this.setAttribute('role', 'group'); this.setAttribute('aria-label', `${this.label}: ${this.value}`); }
}

UfStat.define();
