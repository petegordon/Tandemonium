// @ts-check
// ============================================================
// <uf-controller-roster> — every connected controller and where it sits.
// ============================================================
//
//   <uf-controller-roster variant="strip" capacity="2"></uf-controller-roster>
//   roster.rows = manager.controllerRoster(pads, { seatOf, keyboard: true });
//
// Data in, markup out: set `rows` (core's controllerRoster() rows, or anything
// with the same fields) every frame if you like — it only re-renders when a
// row's identity or state changes and patches the live "in use" dots in place.
//
// variant="strip" (seat screens): one chip per controller. Seated chips carry
//   their seat badge in the team / role colour (Captain, Stoker, P1–P4); spare
//   ones say "press ✕ to join" with the glyph for THAT controller, or "seats
//   full" once `capacity` seats are taken. Always visible, wraps to more rows —
//   the #428 review's answer to "with 8 controllers I need to see them all".
// variant="list" (Controls sheet, lab Controllers panel): one row per
//   controller with its connection (USB, Bluetooth, Puck, WebHID, Gamepad),
//   an optional `detail` line, and state chips CONNECTED / JOINED / SEATED /
//   READY. With `selectable`, rows are focusable and emit
//   `uf-controller-roster:select` ({ key, row }).
//
// Replaces: the game's "Controllers ▴" list, the lab lobby's .lounge chips and
// its Controllers panel rows (docs/UI-KIT-TV-COMPONENTS.md §7).

import { UfElement, prop, esc } from '../uf-element.js';

/**
 * @typedef {object} RosterRow  (the fields this element reads; core's RosterEntry has them all)
 * @property {string} key
 * @property {string} [shortName]
 * @property {string} [name]
 * @property {'connected' | 'joined' | 'seated' | 'ready'} state
 * @property {number|null} [player]
 * @property {{ team?: string|null, role?: string|null, label?: string, tone?: string }|null} [seat]  the app's words; label + tone are shown
 * @property {string} [glyphFamily]
 * @property {boolean} [swapAB]
 * @property {string} [connection]
 * @property {boolean} [active]
 * @property {string} [detail]   list variant: a second line (ids, vid:pid, serial…)
 */

const CONNECTION = { usb: 'USB', bluetooth: 'Bluetooth', puck: 'Puck', webhid: 'WebHID', gamepad: 'Gamepad', keyboard: 'Keys' };
const STATE_WORD = { connected: 'CONNECTED', joined: 'JOINED', seated: 'SEATED', ready: 'READY' };
const STATE_TONE = { connected: 'info', joined: 'warn', seated: 'neutral', ready: 'accent' };

// Seat words are the app's: the badge prints seat.label (else "P<n>", else
// "Seated") and is coloured by seat.tone — one of the kit's seat colours. The
// roster never reads team or role names (a game passes its own vocabulary).
const TONES = ['captain', 'stoker', 'team-a', 'team-b', 'accent', 'info'];
/** @param {RosterRow} r */
const seatTone = (r) => (r.seat && r.seat.tone && TONES.includes(r.seat.tone) ? r.seat.tone : 'accent');
/** @param {RosterRow} r */
const seatBadge = (r) => (r.seat && r.seat.label) || (r.player != null ? `P${r.player}` : 'Seated');
/** @param {RosterRow} r */
const isSeated = (r) => r.state === 'seated' || r.state === 'ready';

export class UfControllerRoster extends UfElement {
  /** @override */ static tag = 'uf-controller-roster';

  /** @override */ static props = {
    variant: prop.enum(/** @type {const} */ (['strip', 'list']), 'strip'),
    heading: prop.string('Connected controllers'),
    capacity: prop.number(0),
    selectable: prop.boolean(false),
  };

  /** @override */ static styles = `
    uf-controller-roster { display: grid; gap: var(--uf-space-2); font-family: var(--uf-font-ui); color: var(--uf-color-fg); min-width: 0; }
    uf-controller-roster .ucr-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--uf-space-3); font-size: var(--uf-size-sm); }
    uf-controller-roster .ucr-head b { font-weight: 700; }
    uf-controller-roster .ucr-head span { color: var(--uf-color-fg-muted); }
    uf-controller-roster .ucr-chips { display: flex; flex-wrap: wrap; gap: var(--uf-space-2); }
    uf-controller-roster .ucr-chip { display: inline-flex; align-items: center; gap: var(--uf-space-2); padding: .35em .8em; border-radius: 999px; font-size: var(--uf-size-sm);
      background: var(--uf-color-surface-3); border: 1px solid var(--uf-color-line-soft); white-space: nowrap; }
    uf-controller-roster .ucr-chip em { font-style: normal; font-size: .82em; color: var(--uf-color-fg-muted); display: inline-flex; align-items: center; gap: .3em; }
    uf-controller-roster .ucr-dot { width: .5em; height: .5em; border-radius: 50%; background: var(--uf-color-info); flex: none; }
    uf-controller-roster .ucr-dot.on { background: var(--uf-color-accent); box-shadow: 0 0 8px var(--uf-color-accent); }
    uf-controller-roster .ucr-badge { font: 800 .72em/1 var(--uf-font-mono); padding: .3em .5em; border-radius: 6px; color: var(--uf-color-bg); background: var(--_tone); }
    uf-controller-roster .ucr-chip[data-tone] { border-color: color-mix(in srgb, var(--_tone) 60%, transparent); }
    uf-controller-roster [data-tone="captain"] { --_tone: var(--uf-color-captain); }
    uf-controller-roster [data-tone="stoker"]  { --_tone: var(--uf-color-stoker); }
    uf-controller-roster [data-tone="team-a"]  { --_tone: var(--uf-color-team-a); }
    uf-controller-roster [data-tone="team-b"]  { --_tone: var(--uf-color-team-b); }
    uf-controller-roster [data-tone="accent"]  { --_tone: var(--uf-color-accent); }
    uf-controller-roster [data-tone="info"]    { --_tone: var(--uf-color-info); }
    uf-controller-roster .ucr-rows { display: grid; gap: var(--uf-space-1); }
    uf-controller-roster .ucr-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: var(--uf-space-3);
      padding: var(--uf-space-2) var(--uf-space-3); border-radius: var(--uf-radius-sm); background: var(--uf-color-surface-3); border: 2px solid transparent; }
    uf-controller-roster .ucr-row b { font-size: var(--uf-size-md); font-weight: 700; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    uf-controller-roster .ucr-row small { display: block; font: var(--uf-size-xs)/1.35 var(--uf-font-mono); color: var(--uf-color-fg-muted); overflow-wrap: anywhere; }
    uf-controller-roster .ucr-conn { font: 500 var(--uf-size-xs) var(--uf-font-mono); color: var(--uf-color-fg-muted); }
    uf-controller-roster .ucr-tags { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
    uf-controller-roster .ucr-row[data-focusable] { cursor: pointer; }
    uf-controller-roster .ucr-row.gamepad-focus, uf-controller-roster .ucr-row:focus-visible { outline: none; border-color: var(--uf-color-accent); box-shadow: var(--uf-glow-accent); }
    uf-controller-roster .ucr-empty { color: var(--uf-color-fg-muted); font-size: var(--uf-size-sm); }
  `;

  /** @type {RosterRow[]} */ #rows = [];
  #sig = '';
  #wired = false;

  /** @returns {'strip' | 'list'} */ get variant() { return this.get('variant'); }
  /** @param {'strip' | 'list'} v */ set variant(v) { this.set('variant', v); }

  /** @returns {string} */ get heading() { return this.get('heading'); }
  /** @param {string} v */ set heading(v) { this.set('heading', v); }

  /** Seats on the screen (0 = don't show the seat count). @returns {number} */
  get capacity() { return this.get('capacity'); }
  /** @param {number} v */ set capacity(v) { this.set('capacity', v); }

  /** @returns {boolean} */ get selectable() { return this.get('selectable'); }
  /** @param {boolean} v */ set selectable(v) { this.set('selectable', v); }

  /** @returns {RosterRow[]} */ get rows() { return this.#rows; }
  /** @param {RosterRow[]} v */
  set rows(v) {
    this.#rows = Array.isArray(v) ? v : [];
    const sig = this.#rows.map((r) => [r.key, r.shortName || r.name, r.state, r.player, r.seat && r.seat.team, r.seat && r.seat.role, r.glyphFamily, r.swapAB, r.connection, r.detail].join('|')).join('~');
    if (sig !== this.#sig) { this.#sig = sig; this.requestUpdate(); }
    else this.#patchDots();
  }

  /** Seats taken (seated or ready rows). */
  get taken() { return this.#rows.filter(isSeated).length; }
  /** True once every seat is taken. */
  get full() { return this.capacity > 0 && this.taken >= this.capacity; }

  /** Focusable rows (list + selectable), for a FocusController scope. @returns {HTMLElement[]} */
  focusables() { return /** @type {HTMLElement[]} */ (Array.from(this.querySelectorAll('[data-focusable]'))); }

  /** @override */
  onConnect() {
    if (this.#wired) return;
    this.#wired = true;
    const pick = (/** @type {Event} */ e) => {
      const el = /** @type {HTMLElement|null} */ ((/** @type {HTMLElement} */ (e.target)).closest('.ucr-row[data-focusable]'));
      if (!el) return;
      const row = this.#rows.find((r) => r.key === el.dataset.key);
      if (row) this.emit('uf-controller-roster:select', { key: row.key, row });
    };
    this.addEventListener('click', pick);
    this.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
  }

  #patchDots() {
    for (const r of this.#rows) {
      const d = this.querySelector(`.ucr-dot[data-key="${CSS.escape(r.key)}"]`);
      if (d) d.classList.toggle('on', !!r.active);
    }
  }

  /** @override */
  render() {
    const rows = this.#rows;
    const head = `<div class="ucr-head"><b>${esc(this.heading)} · ${rows.length}</b>` +
      (this.capacity > 0 ? `<span>${this.taken} of ${this.capacity} seats taken</span>` : '') + `</div>`;
    if (!rows.length) return head + `<div class="ucr-empty">No controllers yet: press a button on one, or pair it.</div>`;
    return head + (this.variant === 'list' ? this.#list(rows) : this.#strip(rows));
  }

  /** @param {RosterRow[]} rows */
  #strip(rows) {
    const full = this.full;
    const ordered = [...rows].sort((a, b) => (isSeated(a) ? 0 : 1) - (isSeated(b) ? 0 : 1) || (a.player ?? 99) - (b.player ?? 99));
    const chips = ordered.map((r) => {
      const name = esc(r.shortName || r.name || 'Controller');
      if (isSeated(r)) {
        return `<span class="ucr-chip" data-tone="${seatTone(r)}"><span class="ucr-badge">${esc(seatBadge(r))}</span>${name}` +
          (r.state === 'ready' ? `<em>ready</em>` : '') + `</span>`;
      }
      const glyph = `<uf-controller-glyph size="sm" button="confirm" family="${esc(r.glyphFamily || 'generic')}"${r.swapAB ? ' swap' : ''}></uf-controller-glyph>`;
      const hint = full ? 'seats full' : (r.state === 'joined' ? `joined · ${glyph} take a seat` : `press ${glyph} to join`);
      return `<span class="ucr-chip"><i class="ucr-dot${r.active ? ' on' : ''}" data-key="${esc(r.key)}"></i>${name}<em>${hint}</em></span>`;
    }).join('');
    return `<div class="ucr-chips">${chips}</div>`;
  }

  /** @param {RosterRow[]} rows */
  #list(rows) {
    const focus = this.selectable ? ' data-focusable tabindex="0" role="button"' : '';
    const items = rows.map((r) => {
      const tags = [`<uf-chip tone="${r.state === 'connected' ? 'info' : 'warn'}">${r.state === 'connected' ? 'CONNECTED' : 'JOINED'}</uf-chip>`];
      if (isSeated(r)) tags.push(`<uf-chip tone="${STATE_TONE[r.state]}">${STATE_WORD[r.state]}</uf-chip>`);
      const seat = isSeated(r) ? `${seatBadge(r)} · ` : (r.state === 'joined' && r.player != null ? `P${r.player} · ` : '');
      return `<div class="ucr-row" data-key="${esc(r.key)}"${focus}>` +
        `<i class="ucr-dot${r.active ? ' on' : ''}" data-key="${esc(r.key)}"></i>` +
        `<div><b>${esc(r.name || r.shortName || 'Controller')}</b>${r.detail ? `<small>${esc(seat)}${esc(r.detail)}</small>` : (seat ? `<small>${esc(seat.replace(/ · $/, ''))}</small>` : '')}</div>` +
        `<span class="ucr-conn">${esc(CONNECTION[/** @type {keyof typeof CONNECTION} */ (r.connection)] || r.connection || '')}</span>` +
        `<span class="ucr-tags">${tags.join('')}</span></div>`;
    }).join('');
    return `<div class="ucr-rows">${items}</div>`;
  }
}

UfControllerRoster.define();
