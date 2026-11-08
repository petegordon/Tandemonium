// @ts-check
// ============================================================
// UfElement — the typed custom-element base for @usersfirst/ui
// ============================================================
//
// One small base class so every control in the kit shares the same contract:
//
//   static tag     'uf-button'                       — registered name
//   static props   { label: prop.string(''), … }     — the typed attribute/property surface
//   static styles  '…css…'                           — injected once per tag
//   static shadow  false                             — light DOM by default (see below)
//   render()       → html string                     — full re-render
//   update(changed) (optional)                       — targeted patch instead of render()
//   emit(type, detail)                               — bubbling CustomEvent
//
// Typing without a build step: this file and every element are plain ESM
// with JSDoc, checked by `tsc --checkJs` (npm run typecheck). The scaffolder
// (tools/ui-kit/new-element.mjs) generates explicit getters/setters per prop
// so the *instance* type is exact, and appends the tag → class mapping to
// src/elements.d.ts so `document.createElement('uf-button')` and
// `querySelector('uf-button')` are typed too.
//
// Light DOM by default, on purpose: the game's FocusController, the existing
// page CSS and the capture tools all reach into elements with ordinary
// selectors. Shadow DOM is opt-in per element (`static shadow = true`) for
// leaf widgets whose internals must not leak.

const Base = /** @type {typeof HTMLElement} */ (typeof HTMLElement === 'undefined' ? /** @type {any} */ (class {}) : HTMLElement);

/**
 * @typedef {'string'|'number'|'boolean'} PropKind
 * @typedef {Object} PropSpec
 * @property {PropKind} type
 * @property {any} default
 * @property {readonly string[]} [enum]       allowed values (string props)
 * @property {string|false} [attribute]       attribute name; false = property-only
 * @property {boolean} [reflect]              write property changes back to the attribute (default true)
 */

export const prop = {
  /** @param {string} def @param {{attribute?: string|false, reflect?: boolean}} [o] @returns {PropSpec} */
  string: (def = '', o = {}) => ({ type: 'string', default: def, ...o }),
  /** @param {number} def @param {{attribute?: string|false, reflect?: boolean}} [o] @returns {PropSpec} */
  number: (def = 0, o = {}) => ({ type: 'number', default: def, ...o }),
  /** @param {boolean} def @param {{attribute?: string|false, reflect?: boolean}} [o] @returns {PropSpec} */
  boolean: (def = false, o = {}) => ({ type: 'boolean', default: def, ...o }),
  /**
   * @template {readonly string[]} T
   * @param {T} values @param {T[number]} def @param {{attribute?: string|false, reflect?: boolean}} [o]
   * @returns {PropSpec}
   */
  enum: (values, def, o = {}) => ({ type: 'string', default: def, enum: values, ...o }),
};

/** camelCase → kebab-case. */
export const kebab = (/** @type {string} */ s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/**
 * Coerce a raw value (attribute string, JS value, null) to the prop's type.
 * Invalid enum values fall back to the default (and warn) rather than throw —
 * a typo in markup should degrade, not take the screen down.
 * @param {PropSpec} spec @param {any} v @param {string} [name]
 */
export function coerce(spec, v, name = '') {
  if (spec.type === 'boolean') {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v !== 'false';   // presence = true, "false" = false
    return !!v;
  }
  if (v === null || v === undefined) return spec.default;
  if (spec.type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : spec.default; }
  const s = String(v);
  if (spec.enum && !spec.enum.includes(s)) {
    if (typeof console !== 'undefined') console.warn(`[uf] ${name}: "${s}" is not one of ${spec.enum.join('|')}; using "${spec.default}"`);
    return spec.default;
  }
  return s;
}

/** Escape text for interpolation into an html string. */
export const esc = (/** @type {unknown} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

const injected = new Set();

export class UfElement extends Base {
  /** @type {string} */ static tag = 'uf-element';
  /** @type {Record<string, PropSpec>} */ static props = {};
  /** @type {string} */ static styles = '';
  /** @type {boolean} */ static shadow = false;

  static get observedAttributes() {
    return Object.entries(this.props).filter(([, s]) => s.attribute !== false).map(([n, s]) => s.attribute || kebab(n));
  }

  /** Register once; safe to call from several modules. */
  static define() {
    if (typeof customElements === 'undefined') return;
    if (!customElements.get(this.tag)) customElements.define(this.tag, /** @type {any} */ (this));
  }

  /** @type {Record<string, any>} */ #state = {};
  #updateQueued = false;
  #rendered = false;
  /** @type {Set<string>} */ #changed = new Set();
  #reflecting = false;

  constructor() {
    super();
    const ctor = /** @type {typeof UfElement} */ (this.constructor);
    for (const [n, s] of Object.entries(ctor.props)) this.#state[n] = s.default;
    if (ctor.shadow && !this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  /** @param {string} name */
  get(name) { return this.#state[name]; }

  /** @param {string} name @param {any} value */
  set(name, value) {
    const ctor = /** @type {typeof UfElement} */ (this.constructor);
    const spec = ctor.props[name];
    if (!spec) throw new Error(`[uf] ${ctor.tag}: unknown prop "${name}"`);
    const next = coerce(spec, value, `${ctor.tag}.${name}`);
    if (Object.is(next, this.#state[name])) return;
    this.#state[name] = next;
    this.#changed.add(name);
    if (spec.attribute !== false && spec.reflect !== false && !this.#reflecting) {
      const attr = spec.attribute || kebab(name);
      if (spec.type === 'boolean') { if (next) this.setAttribute(attr, ''); else this.removeAttribute(attr); }
      else this.setAttribute(attr, String(next));
    }
    this.requestUpdate();
  }

  /** @param {string} attr @param {string|null} _old @param {string|null} val */
  attributeChangedCallback(attr, _old, val) {
    const ctor = /** @type {typeof UfElement} */ (this.constructor);
    const entry = Object.entries(ctor.props).find(([n, s]) => (s.attribute || kebab(n)) === attr);
    if (!entry) return;
    this.#reflecting = true;
    try { this.set(entry[0], val); } finally { this.#reflecting = false; }
  }

  connectedCallback() {
    const ctor = /** @type {typeof UfElement} */ (this.constructor);
    if (ctor.styles) {
      const host = ctor.shadow ? this.shadowRoot : null;
      if (host) { if (!host.querySelector('style[data-uf]')) { const st = document.createElement('style'); st.dataset.uf = ctor.tag; st.textContent = ctor.styles; host.prepend(st); } }
      else if (!injected.has(ctor.tag)) { injected.add(ctor.tag); const st = document.createElement('style'); st.dataset.uf = ctor.tag; st.textContent = ctor.styles; document.head.appendChild(st); }
    }
    this.#rendered = false;
    this.requestUpdate();
    this.onConnect();
  }

  disconnectedCallback() { this.onDisconnect(); }

  /** Override points. */
  onConnect() {}
  onDisconnect() {}

  /** Batch property changes into one DOM pass per microtask. */
  requestUpdate() {
    if (this.#updateQueued || !this.isConnected) return;
    this.#updateQueued = true;
    queueMicrotask(() => {
      this.#updateQueued = false;
      const changed = this.#changed; this.#changed = new Set();
      if (this.#rendered && this.update(changed)) return;   // element patched itself
      const html = this.render();
      if (html != null) {
        // Elements that own their DOM return markup. Elements that wrap authored
        // children (uf-step, uf-flow, a uf-button with icon children) return
        // null and leave the children alone — so ids, listeners and references
        // the host page captured before the upgrade all survive.
        const root = this.shadowRoot || this;
        const style = root.querySelector(':scope > style[data-uf]');
        root.innerHTML = html;
        if (style) root.prepend(style);
      }
      this.#rendered = true;
      this.afterRender(changed);
    });
  }

  /**
   * Return the element's markup, or null to keep the authored children untouched
   * (the default: most kit elements decorate what the page wrote rather than
   * replace it).
   * @returns {string|null}
   */
  render() { return this.shadowRoot ? '<slot></slot>' : null; }

  /**
   * Optional targeted patch. Return true to skip the full re-render.
   * @param {Set<string>} _changed
   */
  update(_changed) { return false; }

  /** Runs after every DOM pass (full render or update). @param {Set<string>} _changed */
  afterRender(_changed) {}

  /** @param {string} type @param {any} [detail] */
  emit(type, detail) { return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }

  /** First element matching `sel` inside this element (light or shadow). @param {string} sel */
  $(sel) { return /** @type {HTMLElement|null} */ ((this.shadowRoot || this).querySelector(sel)); }
}
