// @ts-check
// ============================================================
// <uf-pips> — a level as dots: 3 of 10.
// ============================================================
//
//   <uf-pips value="3" max="10"></uf-pips>
//
// Filled dots up to `value`, empty after, in the tone's colour. For upgrade
// levels (Garage), difficulty, a small progress count. Announced as "3 of 10".
//
// Replaces: the Garage's ◦◦◦◦◦◦ level strings (docs/UI-KIT-TV-COMPONENTS.md, kit 0.4).

import { UfElement, prop } from '../uf-element.js';

export class UfPips extends UfElement {
  /** @override */ static tag = 'uf-pips';

  /** @override */ static props = {
    value: prop.number(0),
    max: prop.number(5),
    tone: prop.enum(/** @type {const} */ (['accent', 'gold', 'neutral']), 'gold'),
  };

  /** @override */ static styles = `
    uf-pips { --_tone: var(--uf-color-accent-2); display: inline-flex; gap: .3em; align-items: center; vertical-align: middle; }
    uf-pips[tone="accent"] { --_tone: var(--uf-color-accent); } uf-pips[tone="neutral"] { --_tone: var(--uf-color-fg); }
    uf-pips i { width: .55em; height: .55em; border-radius: 50%; border: 1.5px solid var(--_tone); box-sizing: border-box; font-size: var(--uf-size-md); }
    uf-pips i.on { background: var(--_tone); }
  `;

  /** @returns {number} */ get value() { return this.get('value'); }
  /** @param {number} v */ set value(v) { this.set('value', v); }
  /** @returns {number} */ get max() { return this.get('max'); }
  /** @param {number} v */ set max(v) { this.set('max', v); }
  /** @returns {'accent' | 'gold' | 'neutral'} */ get tone() { return this.get('tone'); }
  /** @param {'accent' | 'gold' | 'neutral'} v */ set tone(v) { this.set('tone', v); }

  /** @override */
  render() {
    const max = Math.max(0, Math.min(40, Math.floor(this.max)));
    const v = Math.max(0, Math.min(max, Math.floor(this.value)));
    let s = ''; for (let i = 0; i < max; i++) s += `<i class="${i < v ? 'on' : ''}"></i>`;
    return s;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    this.setAttribute('role', 'meter');
    this.setAttribute('aria-valuenow', String(this.value)); this.setAttribute('aria-valuemin', '0'); this.setAttribute('aria-valuemax', String(this.max));
    this.setAttribute('aria-label', `${this.value} of ${this.max}`);
  }
}

UfPips.define();
