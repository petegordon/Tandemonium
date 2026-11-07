// @ts-check
// ============================================================
// <uf-achievement-detail> — one achievement's detail card.
// ============================================================
//
//   const card = document.createElement('uf-achievement-detail');
//   card.achievement = { id: 'snake_eyes', name: 'Snake Eyes', description: 'Roll double 1s', icon: '🐍', earnedAt: '2026-11-07 15:00:00' };
//   card.number = 5; card.total = 22;     // "No. 5 of 22" (omit number to hide it)
//
// The badge large in a ring, a kicker over it (Achievement unlocked · Locked ·
// In progress · Hidden · or the item's `unavailable` reason), the name, what
// to do, the status (Unlocked November 7, 2026 · Not yet · 3 / 7 days with a
// bar), its number, and its ID in small mono text (show-id="false" hides it).
// `extraHtml` adds a game's own trusted line under the description
// (Tandemonium's medal times); it is not escaped.
//
// Replaces: Tandemonium's #ach-detail-card markup (.ach-detail-*) built in lobby.js.

import { UfElement, prop, esc } from '../uf-element.js';
import { isEarned } from './uf-achievement-grid.js';

/** @typedef {import('./uf-achievement-grid.js').AchievementItem} AchievementItem */

/** "November 1, 2026" from ms, an ISO date, or SQLite "2026-11-01 15:00:00" (UTC); '' if unreadable. @param {unknown} when */
export function longDate(when) {
  try {
    let v = /** @type {any} */ (when);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) v = v.replace(' ', 'T') + 'Z';
    if (v === true || v == null) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return ''; }
}

const fmt = (/** @type {number} */ v) => Math.floor(v).toLocaleString('en-US');

/**
 * The card's state, kicker and status line for an achievement.
 * @param {AchievementItem} a
 * @returns {{ state: 'earned'|'secret'|'full'|'progress'|'locked', kicker: string, status: string }}
 */
export function detailState(a) {
  if (isEarned(a)) {
    const date = longDate(a.earnedAt);
    return { state: 'earned', kicker: 'Achievement unlocked', status: date ? 'Unlocked ' + date : 'Unlocked' };
  }
  if (a.secret) return { state: 'secret', kicker: 'Hidden', status: 'Revealed when you earn it' };
  if (a.unavailable) return { state: 'full', kicker: a.unavailable, status: a.unavailableNote || 'Not available here' };
  if (a.progress && a.progress[0] > 0) {
    return { state: 'progress', kicker: 'In progress', status: fmt(a.progress[0]) + ' / ' + fmt(a.progress[1]) + (a.unit ? ' ' + a.unit : '') };
  }
  return { state: 'locked', kicker: 'Locked', status: 'Not yet' };
}

export class UfAchievementDetail extends UfElement {
  /** @override */ static tag = 'uf-achievement-detail';

  /** @override */ static props = {
    showId: prop.boolean(true),
    number: prop.number(0),
    total: prop.number(0),
  };

  /** @override */ static styles = `
    uf-achievement-detail { display: flex; flex-direction: column; align-items: center; text-align: center;
      padding: var(--uf-space-2) 0 var(--uf-space-3); font-size: var(--uf-size-md); font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-achievement-detail .uad-kicker { font-size: var(--uf-size-sm); font-weight: 700; letter-spacing: .28em; text-transform: uppercase; color: var(--uf-color-fg-muted); }
    uf-achievement-detail[data-state="earned"] .uad-kicker { color: var(--uf-color-accent-2); }
    uf-achievement-detail .uad-badge { width: 6em; height: 6em; margin: .9em 0 .7em; border-radius: 50%; display: grid; place-items: center; font-size: var(--uf-size-xl);
      background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--uf-color-surface) 70%, #6a5a90) 0%, var(--uf-color-surface) 70%);
      border: .18em solid color-mix(in srgb, var(--uf-color-fg) 25%, transparent); box-shadow: 0 .6em 2em rgba(0,0,0,.5);
      animation: uad-pop var(--uf-motion-base) var(--uf-ease); }
    uf-achievement-detail .uad-badge span { font-size: 3.2em; line-height: 1; }
    uf-achievement-detail[data-state="earned"] .uad-badge { border-color: var(--uf-color-accent-2);
      box-shadow: 0 0 0 .4em color-mix(in srgb, var(--uf-color-accent-2) 18%, transparent), 0 .6em 2em rgba(0,0,0,.55); }
    uf-achievement-detail[data-state="locked"] .uad-badge, uf-achievement-detail[data-state="progress"] .uad-badge,
    uf-achievement-detail[data-state="full"] .uad-badge { border-style: dashed; }
    uf-achievement-detail[data-state="locked"] .uad-badge span, uf-achievement-detail[data-state="full"] .uad-badge span { filter: grayscale(1); opacity: .6; }
    uf-achievement-detail[data-state="secret"] .uad-badge span { opacity: .7; }
    uf-achievement-detail .uad-name { font-size: var(--uf-size-2xl); font-weight: 800; line-height: 1.1; color: var(--uf-color-fg); }
    uf-achievement-detail[data-state="earned"] .uad-name { color: var(--uf-color-accent-2); }
    uf-achievement-detail .uad-desc { margin-top: .4em; font-size: var(--uf-size-lg); font-style: italic; color: color-mix(in srgb, var(--uf-color-fg) 85%, transparent); max-width: 24em; }
    uf-achievement-detail .uad-desc:empty { display: none; }
    uf-achievement-detail .uad-status { margin-top: 1em; font-size: var(--uf-size-md); font-weight: 600; color: color-mix(in srgb, var(--uf-color-fg) 70%, transparent); }
    uf-achievement-detail[data-state="earned"] .uad-status { color: var(--uf-color-accent); }
    uf-achievement-detail[data-state="progress"] .uad-status { color: var(--uf-color-accent-2); }
    uf-achievement-detail .uad-bar { width: min(16em, 80%); height: .45em; margin-top: .5em; border-radius: var(--uf-radius-pill); background: color-mix(in srgb, var(--uf-color-fg) 12%, transparent); overflow: hidden; }
    uf-achievement-detail .uad-bar i { display: block; height: 100%; background: var(--uf-color-accent-2); }
    uf-achievement-detail .uad-count { margin-top: 1em; font-size: var(--uf-size-sm); letter-spacing: .12em; color: color-mix(in srgb, var(--uf-color-fg) 45%, transparent); }
    uf-achievement-detail .uad-id { margin-top: .35em; font: var(--uf-size-xs)/1.3 var(--uf-font-mono); letter-spacing: .02em; color: color-mix(in srgb, var(--uf-color-fg) 40%, transparent);
      user-select: all; overflow-wrap: anywhere; }
    @keyframes uad-pop { from { transform: scale(.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { uf-achievement-detail .uad-badge { animation: none; } }
  `;

  /** @type {AchievementItem|null} */ #achievement = null;
  #extraHtml = '';

  /** @returns {boolean} */ get showId() { return this.get('showId'); }
  /** @param {boolean} v */ set showId(v) { this.set('showId', v); }
  /** Its number in the full list (1-based); 0 hides "No. n of N". @returns {number} */ get number() { return this.get('number'); }
  /** @param {number} v */ set number(v) { this.set('number', v); }
  /** @returns {number} */ get total() { return this.get('total'); }
  /** @param {number} v */ set total(v) { this.set('total', v); }

  /** @returns {AchievementItem|null} */ get achievement() { return this.#achievement; }
  /** @param {AchievementItem|null} v */ set achievement(v) { this.#achievement = v && typeof v.id === 'string' ? v : null; this.requestUpdate(); }

  /** A trusted HTML line under the description (not escaped). @returns {string} */ get extraHtml() { return this.#extraHtml; }
  /** @param {string} v */ set extraHtml(v) { this.#extraHtml = String(v || ''); this.requestUpdate(); }

  /** @override */
  render() {
    const a = this.#achievement;
    if (!a) { delete this.dataset.state; return ''; }
    const { state, kicker, status } = detailState(a);
    this.dataset.state = state;
    const bar = state === 'progress' && a.progress
      ? `<div class="uad-bar"><i style="width:${Math.round(100 * a.progress[0] / Math.max(1, a.progress[1]))}%"></i></div>` : '';
    return `<div class="uad-kicker">${esc(kicker)}</div>` +
      `<div class="uad-badge" aria-hidden="true"><span>${esc(a.icon || '🏅')}</span></div>` +
      `<div class="uad-name">${esc(a.name)}</div>` +
      `<div class="uad-desc">${esc(a.description || '')}</div>` +
      this.#extraHtml +
      `<div class="uad-status">${esc(status)}</div>` + bar +
      (this.number > 0 ? `<div class="uad-count">No. ${this.number}${this.total > 0 ? ' of ' + this.total : ''}</div>` : '') +
      (this.showId ? `<div class="uad-id" title="Achievement ID">${esc(a.id)}</div>` : '');
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    const a = this.#achievement;
    if (a) this.setAttribute('aria-label', `${a.name}: ${detailState(a).status}`);
  }
}

UfAchievementDetail.define();
