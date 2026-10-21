// @ts-check
// ============================================================
// <uf-achievement> — one achievement: icon, name, description, state.
// ============================================================
//
//   <uf-achievement icon="🏠" name="Home Sweet Home" description="Reach Grandma's" state="new"></uf-achievement>
//   <uf-achievement icon="❔" name="???" description="A hidden achievement" state="locked"></uf-achievement>
//   <uf-achievement icon="🍪" name="Cookie" state="earned" size="sm"></uf-achievement>
//
// state: earned · new (just unlocked — gold, "Unlocked!") · locked (dimmed)
// · progress (with `progress` 0–1 drawn as a bar). size sm is the one-line
// row used in an "unlocked this ride" list; md shows the description. A
// parent grid lays several out (the room's profile, the end-of-ride list).
//
// Replaces: the game's achievement toasts (.ach-toast) in the end-screen list,
// the profile/leaderboard achievement rows.

import { UfElement, prop, esc } from '../uf-element.js';

export class UfAchievement extends UfElement {
  /** @override */ static tag = 'uf-achievement';

  /** @override */ static props = {
    icon: prop.string('🏅'),
    name: prop.string(''),
    description: prop.string(''),
    state: prop.enum(/** @type {const} */ (['earned', 'new', 'locked', 'progress']), 'earned'),
    progress: prop.number(0),
    size: prop.enum(/** @type {const} */ (['sm', 'md']), 'md'),
  };

  /** @override */ static styles = `
    uf-achievement { --_tone: var(--uf-color-line-soft); display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--uf-space-3); align-items: center;
      padding: var(--uf-space-2) var(--uf-space-3); border-radius: var(--uf-radius-md); border: 1.5px solid var(--_tone); background: var(--uf-color-surface-3);
      font-family: var(--uf-font-ui); color: var(--uf-color-fg); min-width: 0; }
    uf-achievement[state="new"] { --_tone: var(--uf-color-accent-2); background: color-mix(in srgb, var(--uf-color-accent-2) 10%, var(--uf-color-surface-3)); }
    uf-achievement[state="locked"] { opacity: .5; border-style: dashed; }
    uf-achievement .ua-icon { grid-row: span 3; font-size: calc(var(--uf-size-xl) * 1.1); line-height: 1; }
    uf-achievement[size="sm"] .ua-icon { font-size: var(--uf-size-lg); grid-row: span 2; }
    uf-achievement .ua-name { font: 700 var(--uf-size-md)/1.2 var(--uf-font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    uf-achievement[size="sm"] .ua-name { font-size: var(--uf-size-sm); }
    uf-achievement .ua-desc { font-size: var(--uf-size-xs); color: var(--uf-color-fg-muted); }
    uf-achievement .ua-desc:empty { display: none; }
    uf-achievement[size="sm"] .ua-desc { display: none; }
    uf-achievement .ua-new { font: 700 var(--uf-size-xs)/1 var(--uf-font-ui); color: var(--uf-color-accent-2); }
    uf-achievement .ua-bar { height: 5px; border-radius: 3px; background: var(--uf-color-surface-2); overflow: hidden; margin-top: 4px; }
    uf-achievement .ua-bar i { display: block; height: 100%; background: var(--uf-color-accent); }
  `;

  /** @returns {string} */ get icon() { return this.get('icon'); }
  /** @param {string} v */ set icon(v) { this.set('icon', v); }
  /** @returns {string} */ get name() { return this.get('name'); }
  /** @param {string} v */ set name(v) { this.set('name', v); }
  /** @returns {string} */ get description() { return this.get('description'); }
  /** @param {string} v */ set description(v) { this.set('description', v); }
  /** @returns {'earned' | 'new' | 'locked' | 'progress'} */ get state() { return this.get('state'); }
  /** @param {'earned' | 'new' | 'locked' | 'progress'} v */ set state(v) { this.set('state', v); }
  /** @returns {number} */ get progress() { return this.get('progress'); }
  /** @param {number} v */ set progress(v) { this.set('progress', v); }
  /** @returns {'sm' | 'md'} */ get size() { return this.get('size'); }
  /** @param {'sm' | 'md'} v */ set size(v) { this.set('size', v); }

  /** @override */
  render() {
    const p = Math.max(0, Math.min(1, this.progress));
    return `<span class="ua-icon" aria-hidden="true">${esc(this.icon)}</span>` +
      `<span class="ua-name">${esc(this.name)}</span>` +
      (this.state === 'new' ? `<span class="ua-new">Unlocked!</span>` : `<span class="ua-desc">${esc(this.description)}</span>`) +
      (this.state === 'progress' ? `<span class="ua-bar"><i style="width:${Math.round(p * 100)}%"></i></span>` : '');
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    this.setAttribute('role', 'listitem');
    this.setAttribute('aria-label', `${this.name}${this.state === 'locked' ? ' (locked)' : this.state === 'new' ? ' (unlocked)' : ''}`);
  }
}

UfAchievement.define();
