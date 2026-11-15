// @ts-check
// ============================================================
// <uf-person> — who is playing: their picture, a small badge for where the
// sign-in came from (Discord, Steam), and their name.
// ============================================================
//
//   <uf-person name="Sam" pic="https://cdn.discordapp.com/…" source="discord"></uf-person>
//   <uf-person name="Pete" source="steam" size="sm"></uf-person>   (no picture: the badge alone)
//
// Seats and controller rosters use it next to the controller's name, so a
// signed-in player shows as a person rather than a pad (#612).

import { UfElement, prop, esc } from '../uf-element.js';

/** The sign-in sources this element knows a badge for (24×24 brand marks). */
export const PERSON_SOURCES = {
  discord: { label: 'Discord', color: '#5865f2', path: 'M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.028C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.182 0-2.157-1.086-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z' },
  steam: { label: 'Steam', color: '#1b2838', path: 'M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z' },
};

export class UfPerson extends UfElement {
  /** @override */ static tag = 'uf-person';

  /** @override */ static props = {
    name: prop.string(''),
    pic: prop.string(''),
    source: prop.string(''),
    size: prop.enum(/** @type {const} */ (['sm', 'md']), 'md'),
  };

  /** @override */ static styles = `
    uf-person { display: inline-flex; align-items: center; gap: .4em; min-width: 0; vertical-align: middle; }
    uf-person .uf-person__pic { position: relative; flex: none; width: 1.6em; height: 1.6em; }
    uf-person[size="sm"] .uf-person__pic { width: 1.3em; height: 1.3em; }
    uf-person .uf-person__pic img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; box-shadow: 0 0 0 2px var(--_src, var(--uf-color-line-soft)); background: var(--uf-color-surface-3); }
    uf-person .uf-person__src { position: absolute; right: -.25em; bottom: -.2em; width: .8em; height: .8em; padding: .1em; border-radius: 50%; background: var(--_src); color: #fff; display: block; }
    uf-person .uf-person__pic.uf-person__pic--bare .uf-person__src { position: static; width: 100%; height: 100%; padding: .22em; box-sizing: border-box; }
    uf-person .uf-person__src svg { width: 100%; height: 100%; display: block; fill: currentColor; }
    uf-person .uf-person__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  `;

  /** @returns {string} */ get name() { return this.get('name'); }
  /** @param {string} v */ set name(v) { this.set('name', v); }
  /** Picture URL ('' = the source badge alone). @returns {string} */ get pic() { return this.get('pic'); }
  /** @param {string} v */ set pic(v) { this.set('pic', v); }
  /** 'discord' | 'steam' | '' @returns {string} */ get source() { return this.get('source'); }
  /** @param {string} v */ set source(v) { this.set('source', v); }
  /** @returns {'sm' | 'md'} */ get size() { return this.get('size'); }
  /** @param {'sm' | 'md'} v */ set size(v) { this.set('size', v); }

  /** @override */
  render() {
    const src = PERSON_SOURCES[/** @type {keyof typeof PERSON_SOURCES} */ (this.source)] || null;
    this.style.setProperty('--_src', src ? src.color : '');
    this.title = src ? `${this.name} · ${src.label}` : this.name;
    const badge = src ? `<i class="uf-person__src" aria-label="${src.label}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${src.path}"/></svg></i>` : '';
    const pic = this.pic
      ? `<span class="uf-person__pic"><img src="${esc(this.pic)}" alt="" referrerpolicy="no-referrer">${badge}</span>`
      : (badge ? `<span class="uf-person__pic uf-person__pic--bare">${badge}</span>` : '');
    return pic + `<span class="uf-person__name">${esc(this.name)}</span>`;
  }
}

/** Markup for a <uf-person> (for elements that render strings). @param {{ name?: string, pic?: string, source?: string }|null|undefined} p @param {'sm'|'md'} [size] */
export function personTag(p, size = 'md') {
  if (!p) return '';
  return `<uf-person name="${esc(p.name || '')}" pic="${esc(p.pic || '')}" source="${esc(p.source || '')}" size="${size}"></uf-person>`;
}

UfPerson.define();
