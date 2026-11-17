// @ts-check
// A small base for the identity elements. They are plain custom elements in the light DOM,
// styled with @usersfirst/ui's design tokens (--uf-*), and they import nothing from the UI
// kit: a host that vendors this package gets them whether or not it vendors the kit's
// element classes. Where the kit helps (a QR, a button look) they use its tags and classes
// by name, and still read without it.

// Without a DOM (unit tests, a server render) the class still loads: render() is a pure
// function of the element's data.
const Base = /** @type {typeof HTMLElement} */ (typeof HTMLElement === 'undefined' ? /** @type {any} */ (class {
  addEventListener() {}
  getAttribute() { return null; }
  hasAttribute() { return false; }
  dispatchEvent() { return true; }
}) : HTMLElement);

/** Escape text for an html string. */
export const esc = (/** @type {unknown} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }))[c]);

const styled = new Set();

export class IdentityElement extends Base {
  /** Registered name. */ static tag = '';
  /** CSS, injected once per tag. */ static styles = '';

  static define() {
    if (typeof customElements === 'undefined' || !this.tag || customElements.get(this.tag)) return;
    customElements.define(this.tag, this);
  }

  connectedCallback() {
    const C = /** @type {typeof IdentityElement} */ (this.constructor);
    if (C.styles && !styled.has(C.tag) && typeof document !== 'undefined') {
      styled.add(C.tag);
      const el = document.createElement('style');
      el.dataset.uf = C.tag;
      el.textContent = C.styles;
      document.head.appendChild(el);
    }
    this.requestUpdate();
  }

  /** Re-render on the next microtask (several property sets, one render). */
  requestUpdate() {
    if (this._queued) return;
    this._queued = true;
    queueMicrotask(() => {
      this._queued = false;
      if (!this.isConnected) return;
      this.innerHTML = this.render();
      this.afterRender();
    });
  }

  /** @returns {string} */ render() { return ''; }
  afterRender() {}

  /** @param {string} type @param {any} [detail] */
  emit(type, detail) { return this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })); }
}

/** Shared looks: text, the two-button row, an account card. Tokens fall back to sane values. */
export const SHARED_STYLES = `
  .uf-id-text { margin: 0; font: 500 var(--uf-size-sm, 14px)/1.45 var(--uf-font-ui, system-ui, sans-serif); color: var(--uf-color-fg, #f4efe6); }
  .uf-id-actions { display: flex; flex-wrap: wrap; gap: var(--uf-space-2, 8px); margin-top: var(--uf-space-2, 8px); }
  .uf-id-btn { font: 700 var(--uf-size-sm, 14px)/1 var(--uf-font-ui, system-ui, sans-serif); letter-spacing: .04em; text-transform: uppercase;
    padding: 10px 14px; border-radius: var(--uf-radius-md, 10px); border: 1px solid var(--uf-color-line, #5b5068);
    background: var(--uf-color-surface-2, #2a2335); color: var(--uf-color-fg, #f4efe6); cursor: pointer; }
  .uf-id-btn[data-tone="accent"] { background: var(--uf-color-accent, #ffd36b); border-color: var(--uf-color-accent, #ffd36b); color: var(--uf-color-fg-on-accent, #17131f); }
  .uf-id-btn[data-tone="danger"] { border-color: var(--uf-color-danger, #ff9b8a); }
  .uf-id-btn:focus-visible, .uf-id-btn.uf-focus { outline: 3px solid var(--uf-color-focus, #ffd36b); outline-offset: 2px; }
  .uf-id-btn[disabled] { opacity: .5; cursor: default; }
`;
