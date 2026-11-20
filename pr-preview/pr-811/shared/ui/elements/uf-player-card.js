// @ts-check
// ============================================================
// <uf-player-card> — who a player is: avatar, name, a line, a few stats.
// ============================================================
//
//   <uf-player-card name="Pete" avatar="https://…/p.png" subtitle="Captain · front seat" tone="captain"
//                   badge="P1" state="here"></uf-player-card>
//   card.stats = [{ value: '42', label: 'Rides' }, { value: '9', label: 'Golds' }];
//   <uf-player-card name="Waiting for partner…" state="waiting" tone="stoker"></uf-player-card>
//
// No avatar → initials on the tone colour. state: here · waiting (dashed,
// muted) · away. Children are kept and shown under the stats (e.g. a few
// <uf-achievement size="sm"> recently earned). Seat words (Captain…) are the
// app's: pass them in `subtitle` / `badge`.
//
// Replaces: the room step's video slots (video sharing is off since #400) and
// the profile popup's header (docs/UI-KIT-TV-COMPONENTS.md, kit 0.4).

import { UfElement, prop } from '../uf-element.js';

/** @typedef {{ value: string|number, label: string }} PlayerStat */

export class UfPlayerCard extends UfElement {
  /** @override */ static tag = 'uf-player-card';

  /** @override */ static props = {
    name: prop.string(''),
    avatar: prop.string(''),
    subtitle: prop.string(''),
    badge: prop.string(''),
    tone: prop.enum(/** @type {const} */ (['captain', 'stoker', 'team-a', 'team-b', 'accent']), 'captain'),
    state: prop.enum(/** @type {const} */ (['here', 'waiting', 'away']), 'here'),
  };

  /** @override */ static styles = `
    uf-player-card { --_tone: var(--uf-color-captain); position: relative; display: grid; gap: var(--uf-space-3); align-content: start; min-width: 0;
      padding: var(--uf-space-4); border-radius: var(--uf-radius-lg); border: 2px solid color-mix(in srgb, var(--_tone) 55%, transparent);
      background: color-mix(in srgb, var(--_tone) 7%, var(--uf-color-surface-3)); font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-player-card[tone="stoker"] { --_tone: var(--uf-color-stoker); } uf-player-card[tone="team-a"] { --_tone: var(--uf-color-team-a); }
    uf-player-card[tone="team-b"] { --_tone: var(--uf-color-team-b); } uf-player-card[tone="accent"] { --_tone: var(--uf-color-accent); }
    uf-player-card[state="waiting"] { border-style: dashed; background: transparent; }
    uf-player-card[state="away"] { opacity: .55; }
    uf-player-card > .upc-head { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--uf-space-3); align-items: center; }
    uf-player-card .upc-av { grid-row: span 2; width: calc(var(--uf-size-xl) * 2.2); height: calc(var(--uf-size-xl) * 2.2); border-radius: 50%; object-fit: cover;
      display: grid; place-items: center; background: var(--_tone); color: var(--uf-color-bg); font: 800 var(--uf-size-lg)/1 var(--uf-font-ui); }
    uf-player-card[state="waiting"] .upc-av { background: transparent; border: 2px dashed var(--_tone); color: var(--_tone); }
    uf-player-card .upc-name { font: 800 var(--uf-size-lg)/1.2 var(--uf-font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    uf-player-card[state="waiting"] .upc-name { color: var(--uf-color-fg-muted); font-weight: 600; }
    uf-player-card .upc-sub { font: 700 var(--uf-size-xs)/1.3 var(--uf-font-mono); letter-spacing: .1em; text-transform: uppercase; color: var(--_tone); }
    uf-player-card .upc-badge { position: absolute; top: 10px; right: 12px; font: 800 var(--uf-size-xs)/1 var(--uf-font-mono); padding: 3px 7px; border-radius: var(--uf-radius-sm); background: var(--_tone); color: var(--uf-color-bg); }
    uf-player-card > .upc-stats { display: flex; gap: var(--uf-space-5); flex-wrap: wrap; }
    uf-player-card > .upc-stats:empty { display: none; }
    uf-player-card .upc-stat b { display: block; font: 800 var(--uf-size-lg)/1.1 var(--uf-font-ui); font-variant-numeric: tabular-nums; }
    uf-player-card .upc-stat span { font-size: var(--uf-size-xs); color: var(--uf-color-fg-muted); }
    uf-player-card > .upc-extra { display: grid; gap: var(--uf-space-2); }
    uf-player-card > .upc-extra:empty { display: none; }
  `;

  /** @type {PlayerStat[]} */ #stats = [];
  /** @type {HTMLElement|null} */ #extra = null;

  /** @returns {string} */ get name() { return this.get('name'); }
  /** @param {string} v */ set name(v) { this.set('name', v); }
  /** @returns {string} */ get avatar() { return this.get('avatar'); }
  /** @param {string} v */ set avatar(v) { this.set('avatar', v); }
  /** @returns {string} */ get subtitle() { return this.get('subtitle'); }
  /** @param {string} v */ set subtitle(v) { this.set('subtitle', v); }
  /** @returns {string} */ get badge() { return this.get('badge'); }
  /** @param {string} v */ set badge(v) { this.set('badge', v); }
  /** @returns {'captain' | 'stoker' | 'team-a' | 'team-b' | 'accent'} */ get tone() { return this.get('tone'); }
  /** @param {'captain' | 'stoker' | 'team-a' | 'team-b' | 'accent'} v */ set tone(v) { this.set('tone', v); }
  /** @returns {'here' | 'waiting' | 'away'} */ get state() { return this.get('state'); }
  /** @param {'here' | 'waiting' | 'away'} v */ set state(v) { this.set('state', v); }

  /** @returns {PlayerStat[]} */ get stats() { return this.#stats; }
  /** @param {PlayerStat[]} v */ set stats(v) { this.#stats = Array.isArray(v) ? v : []; this.requestUpdate(); }

  /** The container for extra content (achievements…) under the stats. */
  get extra() { this.#build(); return /** @type {HTMLElement} */ (this.#extra); }

  /** @override */ render() { return null; }
  /** @override @param {Set<string>} _changed */ update(_changed) { return false; }

  #build() {
    if (this.#extra) return;
    const extra = document.createElement('div'); extra.className = 'upc-extra';
    extra.append(...Array.from(this.childNodes).filter((n) => !(n instanceof HTMLStyleElement)));
    const head = document.createElement('div'); head.className = 'upc-head';
    const stats = document.createElement('div'); stats.className = 'upc-stats';
    const badge = document.createElement('span'); badge.className = 'upc-badge';
    this.append(badge, head, stats, extra);
    this.#extra = extra;
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) {
    this.#build();
    const head = /** @type {HTMLElement} */ (this.querySelector(':scope > .upc-head'));
    const initials = (this.name || '?').replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
    const el = (/** @type {string} */ tag, /** @type {string} */ cls, /** @type {string} */ text = '') => { const e = document.createElement(tag); e.className = cls; if (text) e.textContent = text; return e; };
    let av;
    if (this.avatar && this.state !== 'waiting') {
      av = /** @type {HTMLImageElement} */ (el('img', 'upc-av')); av.src = this.avatar; av.alt = ''; av.referrerPolicy = 'no-referrer';
    } else {
      av = el('span', 'upc-av', this.state === 'waiting' ? '?' : initials); av.setAttribute('aria-hidden', 'true');
    }
    head.replaceChildren(av, el('span', 'upc-name', this.name), el('span', 'upc-sub', this.subtitle));
    const badge = /** @type {HTMLElement} */ (this.querySelector(':scope > .upc-badge'));
    badge.textContent = this.badge; badge.hidden = !this.badge;
    const stats = /** @type {HTMLElement} */ (this.querySelector(':scope > .upc-stats'));
    stats.replaceChildren(...this.#stats.map((s) => { const w = el('span', 'upc-stat'); w.append(el('b', '', String(s.value)), el('span', '', s.label)); return w; }));
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', `${this.subtitle ? this.subtitle + ': ' : ''}${this.name}`);
  }
}

UfPlayerCard.define();
