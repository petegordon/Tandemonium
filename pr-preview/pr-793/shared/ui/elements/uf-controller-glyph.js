// @ts-check
// ============================================================
// <uf-controller-glyph> — a button prompt that matches the controller in hand.
// ============================================================
//
//   <uf-controller-glyph button="confirm"></uf-controller-glyph> Join
//   <uf-controller-glyph button="back" family="nintendo"></uf-controller-glyph>
//   <uf-controller-glyph button="lb"></uf-controller-glyph>
//
// `button` names a role or a physical control:
//   roles      confirm · back · alt · extra   (face buttons by meaning)
//   positions  south · east · west · north    (face buttons by place)
//   others     menu · view · home · lb · rb · lt · rt · ls · rs ·
//              dpad · dpad-h · dpad-v · up · down · left · right
// Roles map to positions the way the Gamepad API's standard mapping does —
// confirm = south (buttons[0]), back = east (buttons[1]), alt = west, extra =
// north — and `swap` (the controller's swapAB quirk) trades confirm and back.
// The label drawn is what is PRINTED at that position on that family's pad,
// so a Switch Pro shows "B" for confirm (its south button) and a DualSense "✕".
//
// `family="auto"` (default) follows the page-wide default set with
// UfControllerGlyph.setDefault({ family, swap }) — call it when P1's controller
// changes (core's identity gives glyphFamily + swapAB). Every auto glyph on the
// page re-renders.
//
// Replaces: hand-typed <b>A</b> / ✕ in hints, the game's .btn-diamond and
// spinner-submit icons, "LB/RB" text in the ride hint (#428 finding 13).

import { UfElement, prop, esc } from '../uf-element.js';

const FAMILIES = /** @type {const} */ (['auto', 'playstation', 'xbox', 'nintendo', 'steam', 'generic', 'keyboard']);
const BUTTONS = /** @type {const} */ ([
  'confirm', 'back', 'alt', 'extra', 'south', 'east', 'west', 'north',
  'menu', 'view', 'home', 'lb', 'rb', 'lt', 'rt', 'ls', 'rs',
  'dpad', 'dpad-h', 'dpad-v', 'up', 'down', 'left', 'right',
]);

/** @typedef {typeof FAMILIES[number]} GlyphFamily */
/** @typedef {Exclude<GlyphFamily, 'auto'>} ConcreteFamily */
/** @typedef {typeof BUTTONS[number]} GlyphButton */

// Printed label per family at each position, and a colour tone per face label.
/** @type {Record<ConcreteFamily, Record<string, [string, string]>>} label, tone */
const FACE = {
  playstation: { south: ['✕', 'ps-cross'], east: ['◯', 'ps-circle'], west: ['□', 'ps-square'], north: ['△', 'ps-triangle'] },
  xbox:        { south: ['A', 'xb-a'], east: ['B', 'xb-b'], west: ['X', 'xb-x'], north: ['Y', 'xb-y'] },
  nintendo:    { south: ['B', 'mono'], east: ['A', 'mono'], west: ['Y', 'mono'], north: ['X', 'mono'] },
  steam:       { south: ['A', 'mono'], east: ['B', 'mono'], west: ['X', 'mono'], north: ['Y', 'mono'] },
  generic:     { south: ['', 'diamond'], east: ['', 'diamond'], west: ['', 'diamond'], north: ['', 'diamond'] },
  keyboard:    { south: ['Enter', 'key'], east: ['Esc', 'key'], west: ['⌫', 'key'], north: ['Tab', 'key'] },
};
/** @type {Record<ConcreteFamily, Record<string, string>>} */
const OTHER = {
  playstation: { menu: 'Options', view: 'Create', home: 'PS', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', ls: 'L3', rs: 'R3' },
  xbox:        { menu: '☰', view: '⧉', home: 'Xbox', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'LS', rs: 'RS' },
  nintendo:    { menu: '+', view: '−', home: 'Home', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', ls: 'LS', rs: 'RS' },
  steam:       { menu: '☰', view: '⧉', home: 'Steam', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'L3', rs: 'R3' },
  generic:     { menu: 'Start', view: 'Select', home: 'Home', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', ls: 'LS', rs: 'RS' },
  keyboard:    { menu: 'Esc', view: 'Tab', home: 'Home', lb: 'Q', rb: 'E', lt: 'Z', rt: 'C', ls: 'Shift', rs: 'Ctrl' },
};
const DPAD = { dpad: '✚', 'dpad-h': '◀ ▶', 'dpad-v': '▲ ▼', up: '▲', down: '▼', left: '◀', right: '▶' };
const KEY_ARROWS = { dpad: '↑↓←→', 'dpad-h': '← →', 'dpad-v': '↑ ↓', up: '↑', down: '↓', left: '←', right: '→' };
const ROLE = { confirm: 'south', back: 'east', alt: 'west', extra: 'north' };
const SPOKEN = { south: 'bottom', east: 'right', west: 'left', north: 'top' };

/** @type {{ family: ConcreteFamily, swap: boolean }} */
const pageDefault = { family: 'generic', swap: false };
/** @type {Set<UfControllerGlyph>} */
const live = new Set();

/**
 * Resolve what to draw. Exported for tests and for hosts that need the text
 * (e.g. an aria-label or a canvas HUD).
 * @param {GlyphButton} button @param {ConcreteFamily} family @param {boolean} [swap]
 * @returns {{ text: string, tone: string, shape: 'round' | 'pill' | 'key' | 'diamond' | 'dpad', position: string | null, label: string }}
 */
export function resolveGlyph(button, family, swap = false) {
  let pos = /** @type {string|null} */ (null);
  if (button in ROLE) {
    pos = ROLE[/** @type {keyof typeof ROLE} */ (button)];
    if (swap && (pos === 'south' || pos === 'east')) pos = pos === 'south' ? 'east' : 'south';
  } else if (button in SPOKEN) pos = button;

  if (pos) {
    const [text, tone] = FACE[family][pos];
    const shape = family === 'keyboard' ? 'key' : family === 'generic' ? 'diamond' : 'round';
    const label = family === 'generic' ? `${SPOKEN[/** @type {keyof typeof SPOKEN} */ (pos)]} face button` : `${text} button`;
    return { text, tone, shape, position: pos, label };
  }
  if (button in DPAD) {
    const k = /** @type {keyof typeof DPAD} */ (button);
    return family === 'keyboard'
      ? { text: KEY_ARROWS[k], tone: 'key', shape: 'key', position: null, label: `arrow keys` }
      : { text: DPAD[k], tone: 'mono', shape: 'dpad', position: null, label: button === 'dpad' ? 'd-pad' : `d-pad ${button.replace('dpad-', '')}` };
  }
  const text = OTHER[family][button] || button.toUpperCase();
  return { text, tone: family === 'keyboard' ? 'key' : 'mono', shape: family === 'keyboard' ? 'key' : 'pill', position: null, label: `${text} button` };
}

export class UfControllerGlyph extends UfElement {
  /** @override */ static tag = 'uf-controller-glyph';

  /** @override */ static props = {
    button: prop.enum(BUTTONS, 'confirm'),
    family: prop.enum(FAMILIES, 'auto'),
    swap: prop.boolean(false),
    size: prop.enum(/** @type {const} */ (['sm', 'md', 'lg']), 'md'),
  };

  /** @override */ static styles = `
    uf-controller-glyph { display: inline-flex; vertical-align: middle; line-height: 1; }
    uf-controller-glyph .ufg { --_s: calc(var(--uf-size-md) * 1.35);
      box-sizing: border-box; display: inline-grid; place-items: center; min-width: var(--_s); height: var(--_s); padding: 0 .3em;
      border-radius: 999px; border: 2px solid currentColor; font: 800 calc(var(--_s) * .52)/1 var(--uf-font-ui); color: var(--uf-color-fg); }
    uf-controller-glyph[size="sm"] .ufg { --_s: calc(var(--uf-size-sm) * 1.35); border-width: 1.5px; }
    uf-controller-glyph[size="lg"] .ufg { --_s: calc(var(--uf-size-lg) * 1.4); }
    uf-controller-glyph .ufg--pill { border-radius: calc(var(--_s) / 3); font-size: calc(var(--_s) * .42); padding: 0 .45em; }
    uf-controller-glyph .ufg--key  { border-radius: 6px; border-width: 1.5px; border-bottom-width: 3px; font: 700 calc(var(--_s) * .42)/1 var(--uf-font-mono); padding: 0 .5em; }
    uf-controller-glyph .ufg--dpad { border: none; font-size: calc(var(--_s) * .62); padding: 0; }
    uf-controller-glyph .ufg--ps-cross    { color: #7ea6ff; }
    uf-controller-glyph .ufg--ps-circle   { color: #ff6d7f; }
    uf-controller-glyph .ufg--ps-square   { color: #f39ad8; }
    uf-controller-glyph .ufg--ps-triangle { color: #4fd6b8; }
    uf-controller-glyph .ufg--xb-a { color: #6fd14f; } uf-controller-glyph .ufg--xb-b { color: #ff5a5a; }
    uf-controller-glyph .ufg--xb-x { color: #4ea7ff; } uf-controller-glyph .ufg--xb-y { color: #ffd23f; }
    /* generic: a 4-dot diamond with the pressed position lit */
    uf-controller-glyph .ufg--diamond { border: none; padding: 0; position: relative; width: var(--_s); }
    uf-controller-glyph .ufg--diamond i { position: absolute; width: 32%; height: 32%; border-radius: 50%; background: var(--uf-color-line-soft); }
    uf-controller-glyph .ufg--diamond i.on { background: var(--uf-color-fg); }
    uf-controller-glyph .ufg--diamond i.n { left: 34%; top: 0; } uf-controller-glyph .ufg--diamond i.s { left: 34%; bottom: 0; }
    uf-controller-glyph .ufg--diamond i.w { left: 0; top: 34%; } uf-controller-glyph .ufg--diamond i.e { right: 0; top: 34%; }
  `;

  /**
   * Set the page-wide family for every family="auto" glyph (P1's controller).
   * @param {{ family?: string, swap?: boolean }} next
   */
  static setDefault({ family, swap } = {}) {
    if (family && FAMILIES.includes(/** @type {any} */ (family)) && family !== 'auto') pageDefault.family = /** @type {ConcreteFamily} */ (family);
    if (typeof swap === 'boolean') pageDefault.swap = swap;
    for (const g of live) if (g.family === 'auto') g.requestUpdate();
  }
  /** @returns {{ family: ConcreteFamily, swap: boolean }} */
  static getDefault() { return { ...pageDefault }; }

  /** @returns {GlyphButton} */ get button() { return this.get('button'); }
  /** @param {GlyphButton} v */ set button(v) { this.set('button', v); }

  /** @returns {GlyphFamily} */ get family() { return this.get('family'); }
  /** @param {GlyphFamily} v */ set family(v) { this.set('family', v); }

  /** @returns {boolean} */ get swap() { return this.get('swap'); }
  /** @param {boolean} v */ set swap(v) { this.set('swap', v); }

  /** @returns {'sm' | 'md' | 'lg'} */ get size() { return this.get('size'); }
  /** @param {'sm' | 'md' | 'lg'} v */ set size(v) { this.set('size', v); }

  /** The family actually drawn (auto resolved). @returns {ConcreteFamily} */
  get resolvedFamily() { return this.family === 'auto' ? pageDefault.family : this.family; }

  /** @override */ onConnect() { live.add(this); }
  /** @override */ onDisconnect() { live.delete(this); }

  /** @override */
  render() {
    const swap = this.family === 'auto' ? (this.swap || pageDefault.swap) : this.swap;
    const g = resolveGlyph(this.button, this.resolvedFamily, swap);
    this.setAttribute('role', 'img');
    this.setAttribute('aria-label', g.label);
    if (g.shape === 'diamond') {
      const on = (/** @type {string} */ p) => (g.position === p ? ' on' : '');
      return `<span class="ufg ufg--diamond" aria-hidden="true"><i class="n${on('north')}"></i><i class="w${on('west')}"></i><i class="e${on('east')}"></i><i class="s${on('south')}"></i></span>`;
    }
    const shape = g.shape === 'round' ? '' : ` ufg--${g.shape}`;
    const tone = g.tone && g.tone !== 'mono' && g.tone !== 'key' ? ` ufg--${g.tone}` : '';
    return `<span class="ufg${shape}${tone}" aria-hidden="true">${esc(g.text)}</span>`;
  }
}

UfControllerGlyph.define();
