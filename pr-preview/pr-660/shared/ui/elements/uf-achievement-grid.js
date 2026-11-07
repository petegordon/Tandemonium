// @ts-check
// ============================================================
// <uf-achievement-grid> — every achievement as a grid of buttons, by section.
// ============================================================
//
//   const grid = document.createElement('uf-achievement-grid');
//   grid.sections = [{ id: 'firsts', title: 'Firsts' }, { id: 'streaks', title: 'Streaks' }];
//   grid.achievements = [
//     { id: 'first_roll', name: 'First Roll', description: 'Roll the dice', icon: '🎲', section: 'firsts', earnedAt: '2026-11-07 15:00:00' },
//     { id: 'hot_hand', name: 'Hot Hand', description: 'Score 3 in a row', icon: '🔥', section: 'streaks', progress: [1, 3] },
//   ];
//   grid.addEventListener('uf-achievement-grid:select', (e) => openCard(e.detail.id));
//
// The count on top ("2 / 22 Unlocked"), then one titled block per section with
// its own count, each badge a <button> (tap, Enter, or a controller's A — the
// FocusController clicks the focused element). Earned badges glow green,
// locked ones are dimmed; a counter shows its progress ("1/3"). Items with no
// `section` (or no `sections` given) go in one untitled block.
//
// Data comes in as properties, never game strings: the same grid shows
// Tandemonium's 100 badges and 7, 11, Doubles' 22.
//
// Replaces: Tandemonium's #lb-achievements markup (.lb-ach-*) built in lobby.js.

import { UfElement, prop, esc } from '../uf-element.js';

/**
 * One achievement, as every achievements element takes it.
 * @typedef {Object} AchievementItem
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {string} [icon]                 an emoji (or short text)
 * @property {string} [section]              a section id from `sections`
 * @property {boolean} [earned]              earned (implied by a truthy earnedAt)
 * @property {string|number|null} [earnedAt] ms since epoch, an ISO date, or SQLite "YYYY-MM-DD HH:MM:SS" (UTC)
 * @property {[number, number]} [progress]   a counter's [done, needed]
 * @property {string} [unit]                 the counter's unit ("days", "rides")
 * @property {boolean} [secret]              hidden until earned (pass the name/icon you want shown, e.g. "???")
 * @property {string} [unavailable]          a reason it can't be earned here (e.g. "Full game")
 * @property {string} [unavailableNote]      the detail card's line for it ("Unlocks in the full game")
 */

/** @typedef {{ id: string, title: string }} AchievementSection */

/** @param {AchievementItem} a */
export const isEarned = (a) => !!(a && (a.earned || a.earnedAt));

const fmt = (/** @type {number} */ v) => Math.floor(v).toLocaleString('en-US');

/** "3/7 days" for a started counter, '' otherwise. @param {AchievementItem} a */
export function progressText(a) {
  if (!a.progress || !(a.progress[0] > 0) || isEarned(a)) return '';
  return fmt(a.progress[0]) + '/' + fmt(a.progress[1]) + (a.unit ? ' ' + a.unit : '');
}

export class UfAchievementGrid extends UfElement {
  /** @override */ static tag = 'uf-achievement-grid';

  /** @override */ static props = {
    heading: prop.string('Unlocked'),
    // tv: bigger badges for a TV across the room.
    size: prop.enum(/** @type {const} */ (['md', 'tv']), 'md'),
  };

  /** @override */ static styles = `
    uf-achievement-grid { display: block; font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    :where(uf-achievement-grid, .uag-host) .uag-count { text-align: center; font-size: var(--uf-size-sm); color: color-mix(in srgb, var(--uf-color-fg) 50%, transparent); margin: 0 0 var(--uf-space-2); }
    :where(uf-achievement-grid, .uag-host) .uag-count span { font-weight: 700; color: var(--uf-color-accent); }
    uf-achievement-grid[size="tv"] .uag-count { font-size: var(--uf-size-md); }
    :where(uf-achievement-grid, .uag-host) .uag-section-title { font-size: var(--uf-size-md); font-weight: 700; color: color-mix(in srgb, var(--uf-color-fg) 85%, transparent); text-align: left; margin: .9em 4px .5em; }
    :where(uf-achievement-grid, .uag-host) .uag-section-count { font-weight: 400; color: color-mix(in srgb, var(--uf-color-fg) 45%, transparent); }
    :where(uf-achievement-grid, .uag-host) .uag-grid { display: flex; flex-wrap: wrap; gap: var(--uf-space-2); justify-content: center; margin-bottom: var(--uf-space-3); }
    :where(uf-achievement-grid, .uag-host) .uag-item { --_w: 64px; display: flex; flex-direction: column; align-items: center; width: var(--_w); padding: 6px 4px; box-sizing: border-box;
      border-radius: var(--uf-radius-md); border: 1.5px solid var(--uf-color-line-soft); background: var(--uf-color-surface-3);
      font-family: inherit; color: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: background-color var(--uf-motion-base) var(--uf-ease), border-color var(--uf-motion-base) var(--uf-ease), box-shadow var(--uf-motion-base) var(--uf-ease), opacity var(--uf-motion-base) var(--uf-ease); }
    uf-achievement-grid[size="tv"] .uag-item { --_w: 92px; padding: 8px 6px; }
    :where(uf-achievement-grid, .uag-host) .uag-icon { font-size: 22px; line-height: 1; margin-bottom: 3px; }
    uf-achievement-grid[size="tv"] .uag-icon { font-size: 32px; }
    :where(uf-achievement-grid, .uag-host) .uag-name { font-size: 8px; line-height: 1.2; text-align: center; word-break: break-word; color: color-mix(in srgb, var(--uf-color-fg) 50%, transparent); }
    uf-achievement-grid[size="tv"] .uag-name { font-size: var(--uf-size-xs); }
    :where(uf-achievement-grid, .uag-host) .uag-progress { font-size: 8px; margin-top: 2px; color: color-mix(in srgb, var(--uf-color-accent-2) 90%, transparent); }
    :where(uf-achievement-grid, .uag-host) .uag-item.earned { background: var(--uf-color-accent-soft); border-color: var(--uf-color-accent-line); box-shadow: 0 0 8px var(--uf-color-accent-soft); }
    :where(uf-achievement-grid, .uag-host) .uag-item.earned .uag-name { color: var(--uf-color-accent); }
    :where(uf-achievement-grid, .uag-host) .uag-item.locked { opacity: .35; border-color: color-mix(in srgb, var(--uf-color-fg) 8%, transparent); }
    :where(uf-achievement-grid, .uag-host) .uag-item:focus { outline: none; }
    :where(uf-achievement-grid, .uag-host) .uag-item:focus-visible, uf-achievement-grid .uag-item.gamepad-focus {
      opacity: 1; outline: 2px solid var(--uf-color-accent); outline-offset: 2px; box-shadow: var(--uf-glow-accent); }
    :where(uf-achievement-grid, .uag-host) .uag-item:hover { opacity: 1; }
  `;

  /** @type {AchievementItem[]} */ #achievements = [];
  /** @type {AchievementSection[]} */ #sections = [];

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }
  /** @returns {'md' | 'tv'} */ get size() { return this.get('size'); }
  /** @param {'md' | 'tv'} v */ set size(v) { this.set('size', v); }

  /** Every achievement, in display order. @returns {AchievementItem[]} */
  get achievements() { return this.#achievements; }
  /** @param {AchievementItem[]} v */
  set achievements(v) { this.#achievements = Array.isArray(v) ? v.filter((a) => a && typeof a.id === 'string') : []; this.requestUpdate(); }

  /** Section titles, in order. @returns {AchievementSection[]} */
  get sections() { return this.#sections; }
  /** @param {AchievementSection[]} v */
  set sections(v) { this.#sections = Array.isArray(v) ? v : []; this.requestUpdate(); }

  get earnedCount() { return this.#achievements.filter(isEarned).length; }
  get total() { return this.#achievements.length; }

  /** The badge button for `id`. @param {string} id @returns {HTMLButtonElement|null} */
  tile(id) {
    return /** @type {HTMLButtonElement|null} */ (Array.from(this.querySelectorAll('.uag-item')).find((b) => /** @type {HTMLElement} */ (b).dataset.ach === id) || null);
  }

  /** Every badge button, for a FocusController. @returns {HTMLElement[]} */
  focusables() { return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('.uag-item'))); }

  /** @override */
  onConnect() {
    if (this.dataset.ufWired) return;
    this.dataset.ufWired = '1';
    this.addEventListener('click', (e) => {
      const tile = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.('.uag-item'));
      if (tile && this.contains(tile)) this.emit('uf-achievement-grid:select', { id: tile.dataset.ach });
    });
  }

  /** @override */
  render() {
    const all = this.#achievements;
    const groups = this.#groups();
    let html = `<div class="uag-count"><span>${this.earnedCount}</span> / ${all.length} ${esc(this.heading)}</div>`;
    for (const g of groups) {
      const got = g.items.filter(isEarned).length;
      html += `<div class="uag-section"${g.id ? ` data-section="${esc(g.id)}"` : ''}>`;
      if (g.title) html += `<div class="uag-section-title">${esc(g.title)} <span class="uag-section-count">${got}/${g.items.length}</span></div>`;
      html += '<div class="uag-grid">';
      for (const a of g.items) {
        const earned = isEarned(a);
        const cls = (earned ? 'earned' : 'locked') + (a.secret ? ' secret' : '') + (a.unavailable ? ' unavailable' : '');
        const prog = progressText(a);
        const tip = (a.description || '') + (a.unavailable ? ` (${a.unavailable})` : '');
        html += `<button type="button" class="uag-item ${cls}" data-ach="${esc(a.id)}" title="${esc(tip)}"` +
          ` aria-label="${esc(a.name + (earned ? ', unlocked' : ', locked'))}">` +
          `<span class="uag-icon" aria-hidden="true">${esc(a.icon || '🏅')}</span>` +
          `<span class="uag-name">${esc(a.name)}</span>` +
          (prog ? `<span class="uag-progress">${esc(prog)}</span>` : '') +
          '</button>';
      }
      html += '</div></div>';
    }
    return html;
  }

  /** Items grouped by section, in `sections` order; the rest in one untitled group at the end. */
  #groups() {
    const all = this.#achievements;
    if (!this.#sections.length) return [{ id: '', title: '', items: all }];
    const known = new Set(this.#sections.map((s) => s.id));
    const groups = this.#sections.map((s) => ({ id: s.id, title: s.title, items: all.filter((a) => a.section === s.id) })).filter((g) => g.items.length);
    const rest = all.filter((a) => !a.section || !known.has(a.section));
    if (rest.length) groups.push({ id: '', title: '', items: rest });
    return groups;
  }
}

UfAchievementGrid.define();
