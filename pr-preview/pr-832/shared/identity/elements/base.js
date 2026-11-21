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
  querySelector() { return null; }
  querySelectorAll() { return []; }
}) : HTMLElement);

/** Escape text for an html string. */
export const esc = (/** @type {unknown} */ s) => String(s ?? '').replace(/[&<>"']/g, (c) => (/** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }))[c]);

const styled = new Set();

// ── Updating in place (lab #152) ─────────────────────────────
// A render used to replace everything inside the element, so a button that had the
// controller's (or the keyboard's) focus was gone after any property set, and so was a class
// the host had put on it. morph() changes the nodes that are there instead: a node that is
// still wanted is never replaced or moved, only its attributes and text are brought up to
// date. Nodes are matched by `data-part` when they have one, else by the class the render
// gave them, else by position and tag. Another custom element inside (a <uf-qr>) gets its
// attributes brought up to date and is otherwise left to itself: its content is its own.
//
// What the render wrote on each node is remembered, so an attribute or class the HOST added
// (a focus class, a picture swapped for a cached copy) is left alone until the render itself
// changes that attribute.

/** @type {WeakMap<Element, Record<string, string>>} */
const rendered = new WeakMap();

/** @param {Element} el */
function attrsOf(el) {
  /** @type {Record<string, string>} */ const out = {};
  for (const a of Array.from(el.attributes)) out[a.name] = a.value;
  return out;
}

/** What tells one sibling from another: its part name, else the class the render wrote. @param {Node} n */
function keyOf(n) {
  if (n.nodeType !== 1) return '';
  const el = /** @type {Element} */ (n);
  const part = el.getAttribute('data-part');
  if (part) return '#' + part;
  const was = rendered.get(el);
  const cls = was ? was.class : el.getAttribute('class');
  return cls ? '.' + cls : '';
}

/** @param {Node} a @param {Node} b */
function sameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
}

/** @param {Element} old @param {Element} next */
function syncAttrs(old, next) {
  const was = rendered.get(old) || attrsOf(old);
  const now = attrsOf(next);
  for (const name of Object.keys(was)) if (!(name in now)) old.removeAttribute(name);
  for (const name of Object.keys(now)) {
    if (was[name] === now[name]) continue;                    // the render did not change it: the host's value stays
    if (name === 'class') {
      // keep the classes the host added (those not in the last render)
      const mine = new Set((was.class || '').split(/\s+/).filter(Boolean));
      const extra = Array.from(old.classList).filter((c) => !mine.has(c));
      old.setAttribute('class', [now.class, ...extra].filter(Boolean).join(' '));
    } else old.setAttribute(name, now[name]);
  }
  rendered.set(old, now);
}

/** @param {Node} oldParent @param {Node} newParent */
function syncChildren(oldParent, newParent) {
  const news = Array.from(newParent.childNodes);
  for (let i = 0; i < news.length; i++) {
    const n = news[i];
    let o = oldParent.childNodes[i];
    if (o && !sameNode(o, n)) {
      // A kept node is never moved (moving a focused node blurs it). If the old node here is
      // wanted later, the new one goes in before it; if the new one exists further on, the old
      // nodes in between go; otherwise the old one is not wanted at all.
      const oldWantedLater = keyOf(o) && news.slice(i + 1).some((x) => sameNode(o, x));
      if (!oldWantedLater) {
        const olds = Array.from(oldParent.childNodes);
        const at = keyOf(n) ? olds.findIndex((x, j) => j > i && sameNode(x, n)) : -1;
        if (at > i) { for (let j = i; j < at; j++) oldParent.removeChild(olds[j]); o = oldParent.childNodes[i]; }
        else { oldParent.replaceChild(n, o); continue; }
      } else { oldParent.insertBefore(n, o); continue; }
    }
    if (!o) { oldParent.appendChild(n); continue; }
    if (o.nodeType === 1) {
      syncAttrs(/** @type {Element} */ (o), /** @type {Element} */ (n));
      if (!o.nodeName.includes('-')) syncChildren(o, n);
    } else if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
  }
  while (oldParent.childNodes.length > news.length) oldParent.removeChild(/** @type {Node} */ (oldParent.lastChild));
}

/**
 * Bring `host`'s content up to date with `html`, keeping the nodes that are still wanted.
 * @param {Element} host @param {string} html
 */
export function morph(host, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  syncChildren(host, tpl.content);
  // remember what the render wrote on the nodes that are new
  for (const el of Array.from(host.querySelectorAll('*'))) if (!rendered.has(el)) rendered.set(el, attrsOf(el));
}

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
    queueMicrotask(() => { if (this._queued) this.renderNow(); });
  }

  /**
   * Render at once (a pending update included). For a host that needs the buttons right after
   * it set a property, without waiting a microtask. Nodes that are still wanted are kept, so
   * focus and the host's own classes survive (see morph()).
   */
  renderNow() {
    this._queued = false;
    if (!this.isConnected) return;
    morph(this, this.render());
    this.afterRender();
  }

  /** @returns {string} */ render() { return ''; }
  afterRender() {}

  /**
   * The element's buttons and links, top to bottom, for a host's own focus list (a TV's
   * controller focus). Disabled ones are included; `hidden` ones are not.
   * @returns {HTMLElement[]}
   */
  buttons() {
    return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('button, a[href]'))).filter((b) => !b.hidden);
  }

  /**
   * One named part (`data-part`), or null when it is not showing. The names are a contract:
   * each element lists its own.
   * @param {string} name @returns {HTMLElement|null}
   */
  named(name) {
    return /** @type {HTMLElement|null} */ (this.querySelector(`[data-part="${String(name).replace(/["\\]/g, '')}"]`));
  }

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
