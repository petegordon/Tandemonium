// @ts-check
// ============================================================
// <uf-chip> — a small status tag (READY, ASSIGNED, AVAILABLE, P1).
// ============================================================
//
//   <uf-chip label="READY" tone="accent"></uf-chip>
//   <uf-chip tone="info">AVAILABLE</uf-chip>        (children used when label is empty)
//
// Replaces: the lab's .cp-tag.{ready,assigned,active,available}, .badge,
// .lc-badge; the game's .ranked-badge-style pills.

import { UfElement, prop, esc } from '../uf-element.js';

export class UfChip extends UfElement {
  /** @override */ static tag = 'uf-chip';

  /** @override */ static props = {
    label: prop.string(''),
    tone: prop.enum(/** @type {const} */ (['neutral', 'accent', 'info', 'warn', 'danger']), 'neutral'),
  };

  /** @override */ static styles = `
    uf-chip { display: inline-block; box-sizing: border-box; font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); letter-spacing: .8px; text-transform: uppercase;
              padding: 3px 7px; border-radius: var(--uf-radius-sm); color: var(--uf-color-fg); background: var(--uf-color-surface-2); border: 1px solid var(--uf-color-line-soft); white-space: nowrap; }
    uf-chip[tone="accent"] { color: var(--uf-color-fg-on-accent); background: var(--uf-color-accent); border-color: var(--uf-color-accent); box-shadow: 0 0 10px -2px var(--uf-color-accent); }
    uf-chip[tone="info"]   { color: var(--uf-color-info-fg); background: var(--uf-color-info-soft); border-color: var(--uf-color-info-line); }
    uf-chip[tone="warn"]   { color: var(--uf-color-fg-on-accent); background: var(--uf-color-warn); border-color: var(--uf-color-warn); }
    uf-chip[tone="danger"] { color: var(--uf-color-fg); background: var(--uf-color-danger-soft); border-color: var(--uf-color-danger); }
  `;

  /** @returns {string} */ get label() { return this.get('label'); }
  /** @param {string} v */ set label(v) { this.set('label', v); }

  /** @returns {'neutral' | 'accent' | 'info' | 'warn' | 'danger'} */ get tone() { return this.get('tone'); }
  /** @param {'neutral' | 'accent' | 'info' | 'warn' | 'danger'} v */ set tone(v) { this.set('tone', v); }

  /** @override */
  render() { return this.label ? esc(this.label) : null; }

  /** @override @param {Set<string>} changed */
  update(changed) { if (changed.has('label') && this.label) this.textContent = this.label; return true; }
}

UfChip.define();
