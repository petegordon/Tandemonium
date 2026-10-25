// @ts-check
// ============================================================
// <uf-qr> — a QR code sized to scan from the couch.
// ============================================================
//
//   <uf-qr value="https://tandemonium.housetandem.com?room=TNDM-K9NE" caption="Scan to join" link="tandemonium.housetandem.com"></uf-qr>
//   <uf-qr value="https://…/remote/?pad=AS64W5&seat=1#secret" link="tandemonium.housetandem.com/remote" reveal></uf-qr>
//
// Draws `value` with the vendored qrcode-generator (MIT) into an SVG on a white
// quiet zone, `size` px square (default 420 — readable by a phone 2–3 m from a
// 1080p TV; the #428 review measured today's at 180–192px). `link` is the short
// readable address under it; with `reveal`, a "Can't scan?" control shows the
// full `value` (which may carry a session secret) instead of printing it.
// A host that already has an SVG can set the `svg` property instead of value.
//
// Used by: the room invite (online multiplayer) and phone as remote controller
// (docs/UI-KIT-TV-COMPONENTS.md §13; decided: lives in the lab).

import { UfElement, prop, esc } from '../uf-element.js';
import qrcode from '../third_party/qrcode-generator.js';

/**
 * QR SVG markup for `text` (or '' if it can't be encoded).
 * @param {string} text @param {'L'|'M'|'Q'|'H'} [level]
 */
export function qrSvg(text, level = 'M') {
  if (!text) return '';
  try {
    const q = qrcode(0, level);
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch { return ''; }
}

export class UfQr extends UfElement {
  /** @override */ static tag = 'uf-qr';

  /** @override */ static props = {
    value: prop.string(''),
    caption: prop.string(''),
    link: prop.string(''),
    size: prop.number(420),
    reveal: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-qr { display: inline-grid; gap: var(--uf-space-2); justify-items: center; font-family: var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-qr .uqr-code { box-sizing: border-box; width: var(--_size); height: var(--_size); max-width: 100%; padding: calc(var(--_size) * .045); background: #fff; border-radius: var(--uf-radius-lg); }
    uf-qr .uqr-code svg { display: block; width: 100%; height: 100%; }
    uf-qr .uqr-caption { font-size: var(--uf-size-md); font-weight: 700; }
    uf-qr .uqr-link { font: var(--uf-size-sm)/1.3 var(--uf-font-mono); color: var(--uf-color-fg-muted); overflow-wrap: break-word; text-align: center; max-width: var(--_size); }
    uf-qr .uqr-reveal { background: none; border: none; font: inherit; font-size: var(--uf-size-sm); color: var(--uf-color-info-fg); cursor: pointer; text-decoration: underline; padding: 0; }
    uf-qr .uqr-full { font: var(--uf-size-xs)/1.35 var(--uf-font-mono); color: var(--uf-color-fg-muted); overflow-wrap: anywhere; max-width: var(--_size); user-select: all; }
    uf-qr .uqr-empty { display: grid; place-items: center; color: #666; font-size: var(--uf-size-sm); }
  `;

  /** @type {string} */ #svg = '';
  #shown = false;

  /** @returns {string} */ get value() { return this.get('value'); }
  /** @param {string} v */ set value(v) { this.set('value', v); }

  /** @returns {string} */ get caption() { return this.get('caption'); }
  /** @param {string} v */ set caption(v) { this.set('caption', v); }

  /** @returns {string} */ get link() { return this.get('link'); }
  /** @param {string} v */ set link(v) { this.set('link', v); }

  /** @returns {number} */ get size() { return this.get('size'); }
  /** @param {number} v */ set size(v) { this.set('size', v); }

  /** @returns {boolean} */ get reveal() { return this.get('reveal'); }
  /** @param {boolean} v */ set reveal(v) { this.set('reveal', v); }

  /** Prebuilt SVG markup (overrides drawing `value`). @returns {string} */
  get svg() { return this.#svg; }
  /** @param {string} v */ set svg(v) { this.#svg = String(v || ''); this.requestUpdate(); }

  #wired = false;

  /** @override */
  onConnect() {
    if (this.#wired) return;
    this.#wired = true;
    this.addEventListener('click', (e) => {
      if ((/** @type {HTMLElement} */ (e.target)).closest('.uqr-reveal')) { this.#shown = !this.#shown; this.requestUpdate(); }
    });
  }

  /** @override */
  render() {
    const svg = this.#svg || qrSvg(this.value);
    const code = svg ? `<div class="uqr-code" role="img" aria-label="QR code${this.caption ? ': ' + esc(this.caption) : ''}">${svg}</div>`
      : `<div class="uqr-code uqr-empty">No link yet</div>`;
    return `${code}` +
      (this.caption ? `<div class="uqr-caption">${esc(this.caption)}</div>` : '') +
      (this.link ? `<div class="uqr-link">${esc(this.link)}</div>` : '') +
      (this.reveal && this.value ? `<button type="button" class="uqr-reveal">${this.#shown ? 'Hide link' : 'Can’t scan? Show the full link'}</button>` +
        (this.#shown ? `<div class="uqr-full">${esc(this.value)}</div>` : '') : '');
  }

  /** @override @param {Set<string>} _changed */
  afterRender(_changed) { this.style.setProperty('--_size', `${Math.max(120, this.size)}px`); }
}

UfQr.define();
