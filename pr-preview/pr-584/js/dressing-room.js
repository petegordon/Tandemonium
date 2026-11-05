// ============================================================
// DRESSING ROOM (#548) — every seated player dresses their goose at once, each from their own pad
// ============================================================
//
// Opened from a seat screen (co-op room or versus join) by any seated pad's △/Y or a WARDROBE
// button. One card per seated player, side by side (versus groups them by team): player label +
// pad name, a live 3D preview of their goose (dressing-room-preview.js; a text card on the Low
// perf tier), the look summary, a state badge and FIND MY CONTROLLER. The opener starts in Edit,
// everyone else Ready.
//
// Ownership: each card is driven ONLY by its own pad — a FocusController on that player's
// InputManager (a keyboard player gets a ManualInput fed by arrows / Enter / Esc). Mouse works on
// every card (one couch). A = Edit on your card: it expands into the rows (Gander/Goose, Outfit,
// Colours, Controller light); every pick saves at once and the preview follows. A on DONE or B
// while editing = Ready (picks kept). When nobody is editing, BACK TO SEATS shows: A on it from
// anyone, or B from anyone, closes the room; while someone is editing, B from the others only
// nudges that card. A player who disconnects or leaves their seat while editing counts as Ready,
// so the room can never stick. Phone-seated players get a read-only card ("edit on your phone").

import { ManualInput } from '../shared/ui/inputs.js';
import { RowFocusController as FocusController } from './row-focus.js';
import { playerLooks, BODIES, LED_COLOURS, lookColourway, withColourway, seatLook } from './player-look.js';
import { GOOSE_OUTFITS } from './goose-outfits.js';
import { colourwaysFor } from './goose-colourways.js';
import { applyPlayerLed, findMe } from './player-led.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/**
 * @typedef {{ n: number, input: any, type: 'gamepad'|'keyboard'|'phone', label: string, team: 'A'|'B'|null, seat: 'Captain'|'Stoker' }} RoomPlayer
 */

export class DressingRoom {
  /**
   * @param {Object} o
   * @param {any} o.sheet the <uf-sheet id="dressing-room"> (dismissible="false")
   * @param {() => RoomPlayer[]} o.roster the seated players, read every frame (a player who leaves drops out)
   * @param {(p: RoomPlayer) => string|null} o.padKeyFor the look key of a player's controller
   * @param {any} o.controllerManager for the LEDs / Find me
   * @param {(n: number, kind: string, val: string) => void} [o.onLookChanged]
   * @param {() => void} [o.onClose]
   * @param {() => (import('./dressing-room-preview.js').DressingRoomPreview | null)} [o.makePreview] null = static cards (Low tier)
   * @param {() => Set<string>} [o.lockedOutfits] outfits the store has not unlocked (#574)
   */
  constructor({ sheet, roster, padKeyFor, controllerManager, onLookChanged = null, onClose = null, makePreview = null, lockedOutfits = null }) {
    this._sheet = sheet;
    this._roster = roster;
    this._padKeyFor = padKeyFor;
    this._mgr = controllerManager;
    this._onLookChanged = onLookChanged;
    this._onClose = onClose;
    this._makePreview = makePreview;
    this._lockedOutfits = lockedOutfits || (() => new Set());
    /** @type {Map<number, any>} */ this.cards = new Map();   // n → card
    this.open = false;
    this._preview = null;
    this._keyInput = null;      // the keyboard player's ManualInput
    this._onKey = null;
    this._cardsEl = null;
    this._backBtn = null;
    this._statusEl = null;
  }

  // ── open / close ──

  /** @param {number} openerN the player whose pad opened the room (starts in Edit) */
  show(openerN) {
    if (this.open) return;
    this.open = true;
    this._cardsEl = document.getElementById('dr-cards');
    this._backBtn = document.getElementById('dr-back');
    this._statusEl = document.getElementById('dr-status');
    // Rebound on every open: a new room instance each time, so a listener from the last one would close a dead room.
    if (this._backBtn) this._backBtn.onclick = () => { if (this.open && !this.anyEditing()) this.close('back'); };
    this._preview = this._makePreview ? this._makePreview() : null;
    this._onKey = (e) => this._keyboard(e);
    document.addEventListener('keydown', this._onKey, true);
    document.addEventListener('keyup', this._onKey, true);
    this._sheet.show();
    this._sync(openerN);
    console.log(`[dressing room] open by P${openerN}: ${[...this.cards.keys()].map((n) => 'P' + n).join(' ')}`);
  }

  close(reason = 'api') {
    if (!this.open) return;
    this.open = false;
    for (const c of this.cards.values()) this._dropCard(c);
    this.cards.clear();
    if (this._preview) { this._preview.dispose(); this._preview = null; }
    if (this._onKey) { document.removeEventListener('keydown', this._onKey, true); document.removeEventListener('keyup', this._onKey, true); this._onKey = null; }
    this._keyInput = null;
    if (this._cardsEl) this._cardsEl.innerHTML = '';
    if (this._sheet.open) this._sheet.close(reason);
    console.log(`[dressing room] closed (${reason})`);
    if (this._onClose) this._onClose();
  }

  anyEditing() { return [...this.cards.values()].some((c) => c.state === 'editing'); }
  editingCard() { return [...this.cards.values()].find((c) => c.state === 'editing') || null; }

  // ── roster → cards ──

  _sync(openerN = null) {
    const players = this._roster() || [];
    const seen = new Set();
    for (const p of players) {
      seen.add(p.n);
      let c = this.cards.get(p.n);
      if (!c) c = this._addCard(p, p.n === openerN);
      else { c.player = p; if (c.el.dataset.team !== (p.team || '')) this._place(c); }
    }
    for (const [n, c] of this.cards) if (!seen.has(n)) { this._dropCard(c); this.cards.delete(n); }
    this._refreshFoot();
  }

  _addCard(p, editing) {
    playerLooks.bindPad(p.n, this._padKeyFor(p));
    const el = document.createElement('div');
    el.className = 'dr-card';
    el.dataset.n = String(p.n);
    const type = p.input && p.input.remoteOnly ? 'phone' : p.type;
    const c = { n: p.n, player: p, type, el, state: type === 'phone' ? 'readonly' : (editing ? 'editing' : 'ready'), focus: null, manual: null, nudgeTimer: 0 };
    el.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button[data-act], button[data-pick]') : null;
      if (!b) return;
      if (b.dataset.pick) this._pick(c, b.dataset.pick, b.dataset.val);
      else this._act(c, b.dataset.act);
    });
    if (type === 'gamepad' && p.input) {
      c.focus = new FocusController({ input: p.input, onConfirm: (x) => x.click(), onBack: () => this._back(c) });
    } else if (type === 'keyboard') {
      c.manual = new ManualInput();
      this._keyInput = c.manual;
      c.focus = new FocusController({ input: c.manual, onConfirm: (x) => x.click(), onBack: () => this._back(c) });
    }
    this.cards.set(p.n, c);
    this._place(c);
    this._renderCard(c);
    return c;
  }

  /** Put the card in its team group (versus) or the flat row (co-op). */
  _place(c) {
    const team = c.player.team || '';
    c.el.dataset.team = team;
    let box = this._cardsEl;
    if (team) {
      box = this._cardsEl.querySelector(`.dr-team[data-team="${team}"]`);
      if (!box) {
        box = document.createElement('div');
        box.className = 'dr-team';
        box.dataset.team = team;
        box.innerHTML = `<div class="dr-team-title">${team === 'A' ? 'Team blue' : 'Team red'}</div>`;
        this._cardsEl.appendChild(box);
      }
    }
    // keep player order
    const after = [...box.querySelectorAll(':scope > .dr-card')].find((x) => Number(x.dataset.n) > c.n);
    if (after) box.insertBefore(c.el, after); else box.appendChild(c.el);
  }

  _dropCard(c) {
    if (c.focus) c.focus.clear();
    if (c.manual === this._keyInput) this._keyInput = null;
    if (this._preview) this._preview.remove('p' + c.n);
    c.el.remove();
    const team = c.player.team;
    if (team) {
      const box = this._cardsEl && this._cardsEl.querySelector(`.dr-team[data-team="${team}"]`);
      if (box && !box.querySelector('.dr-card')) box.remove();
    }
  }

  // ── rendering ──

  _summary(look) {
    const way = colourwaysFor(look.outfit).find((w) => w.key === lookColourway(look));
    const led = LED_COLOURS.find((x) => x.key === look.led);
    return `${BODIES[look.body].label} · ${GOOSE_OUTFITS[look.outfit].label} · ${way ? way.label : 'Original'} · ${led ? led.label : 'Blue'} light`;
  }

  /**
   * The card's skeleton, built once: the canvas stays put across state changes so the preview's
   * height can TRANSITION between the full-height Ready view and the smaller Editing view
   * (CSS .dr-preview); _renderCard only swaps the badge, summary, rows and actions.
   */
  _buildCard(c) {
    const look = playerLooks.get(c.n);
    const previewHtml = this._preview
      ? `<canvas class="dr-preview" width="220" height="240"></canvas>`
      : `<div class="dr-preview dr-preview--static"><div class="dr-static-body">${esc(BODIES[look.body].label)}</div><div class="dr-static-outfit">${esc(GOOSE_OUTFITS[look.outfit].label)}</div></div>`;
    c.el.innerHTML = `
      <div class="dr-head"><span class="dr-who">Player <b>${c.n}</b> · ${esc(c.player.label)}</span><span class="dr-badge"></span></div>
      ${previewHtml}
      <p class="dr-summary"></p>
      <div class="dr-rows-wrap"></div>
      <div class="dr-actions"></div>`;
    const preview = c.el.querySelector('.dr-preview');
    if (preview) {
      // The transition's last frame: one exact resize + redraw so the goose never stays stretched.
      preview.addEventListener('transitionend', () => { c.transitionUntil = 0; this._resizePreview(c); });
    }
  }

  _renderCard(c) {
    if (!c.el.querySelector('.dr-head')) this._buildCard(c);
    const look = playerLooks.get(c.n);
    const p = c.player;
    const badge = c.state === 'editing' ? 'EDITING' : c.state === 'readonly' ? 'ON PHONE' : '✓ READY';
    const tone = p.team === 'A' ? 'team-a' : p.team === 'B' ? 'team-b' : (p.seat === 'Stoker' ? 'stoker' : 'captain');
    if (c.el.dataset.state !== c.state) c.transitionUntil = performance.now() + 450;   // the CSS transition runs ~280 ms
    c.el.dataset.state = c.state;
    c.el.dataset.tone = tone;
    c.el.querySelector('.dr-badge').textContent = badge;
    c.el.querySelector('.dr-who').innerHTML = `Player <b>${c.n}</b> · ${esc(p.label)}`;
    c.el.querySelector('.dr-summary').textContent = this._summary(look);
    c.el.querySelector('.dr-rows-wrap').innerHTML = c.state === 'editing' ? this._rows(c, look) : '';
    c.el.querySelector('.dr-actions').innerHTML = c.state === 'readonly'
      ? `<p class="dr-note">Edit on your phone</p>`
      : c.state === 'editing'
        ? `<button class="opt-btn dr-done" data-act="done">DONE</button><button class="opt-btn" data-act="find">FIND MY CONTROLLER</button>`
        : `<button class="opt-btn dr-edit" data-act="edit">EDIT</button><button class="opt-btn" data-act="find">FIND MY CONTROLLER</button>`;
    const stat = c.el.querySelector('.dr-preview--static');
    if (stat) { stat.querySelector('.dr-static-body').textContent = BODIES[look.body].label; stat.querySelector('.dr-static-outfit').textContent = GOOSE_OUTFITS[look.outfit].label; }
    const canvas = c.el.querySelector('canvas.dr-preview');
    if (canvas && this._preview) this._preview.show('p' + c.n, /** @type {HTMLCanvasElement} */ (canvas), p.seat, seatLook(look));
    this._refocus(c, c.state === 'editing' ? c.el.querySelector('.dr-rows .opt-btn.active') : c.el.querySelector('.dr-edit'));
  }

  /** Size the card's canvas bitmap to its CSS box and redraw it now (mid-transition frames). */
  _resizePreview(c) {
    if (this._preview) this._preview.resizeNow('p' + c.n);
  }

  _rows(c, look) {
    const locked = this._lockedOutfits(c.n);
    const btn = (kind, val, html, active, extra = '') => `<button class="opt-btn${active ? ' active' : ''}" data-pick="${kind}" data-val="${esc(val)}"${extra}>${html}</button>`;
    const row = (label, kind, opts) => `<div class="dr-group" data-group="${kind}"><div class="dr-label">${label}</div><div class="dr-opts" data-pick="${kind}">${opts}</div></div>`;
    const bodies = Object.entries(BODIES).map(([k, b]) => btn('body', k, `${esc(b.label)} <span class="dr-sub">(${esc(b.hint)})</span>`, look.body === k)).join('');
    const outfits = Object.entries(GOOSE_OUTFITS).map(([k, o]) => btn('outfit', k, esc(o.label), look.outfit === k, locked.has(k) ? ' data-locked="1" title="Coming to the store"' : '')).join('');
    const leds = LED_COLOURS.map((x) => btn('led', x.key, `<span class="led-swatch" style="background: rgb(${x.rgb.r},${x.rgb.g},${x.rgb.b})"></span>${esc(x.label)}`, look.led === x.key)).join('');
    return `<div class="dr-rows">`
      + row('Gander or goose', 'body', bodies)
      + row('Outfit', 'outfit', outfits)
      + row('Colours', 'colourway', this._colourButtons(look))
      + row('Controller light', 'led', leds)
      + `<p class="options-note dr-hint"></p></div>`;
  }

  _colourButtons(look) {
    const cur = lookColourway(look);
    return colourwaysFor(look.outfit).map((w) => `<button class="opt-btn${w.key === cur ? ' active' : ''}" data-pick="colourway" data-val="${esc(w.key)}">${esc(w.label)}</button>`).join('');
  }

  /** The card's own focusables (+ BACK TO SEATS when it shows), focus on `initial`. */
  _items(c) {
    const own = [...c.el.querySelectorAll('button')].filter((b) => b.getBoundingClientRect().width > 0);
    if (!this.anyEditing() && this._backBtn && this._backBtn.getBoundingClientRect().width > 0) own.push(this._backBtn);
    return own;
  }

  _refocus(c, initial) {
    if (!c.focus) return;
    c.focus.setSpatial(this._items(c), initial || null);
  }

  _refreshFoot() {
    const editing = [...this.cards.values()].filter((c) => c.state === 'editing');
    const show = editing.length === 0 && this.cards.size > 0;
    if (this._backBtn) this._backBtn.style.display = show ? '' : 'none';
    if (this._statusEl) this._statusEl.textContent = show ? '' : `Waiting for ${editing.map((c) => 'P' + c.n).join(', ')}…`;
  }

  // ── actions ──

  _act(c, act) {
    if (act === 'edit' && c.state === 'ready') this._setState(c, 'editing');
    else if (act === 'done' && c.state === 'editing') this._setState(c, 'ready');
    else if (act === 'find') this._findMe(c);
  }

  _setState(c, state) {
    if (c.state === 'readonly' || c.state === state) return;
    c.state = state;
    this._renderCard(c);
    this._refreshFoot();
    // The others' focus sets change with the footer (BACK TO SEATS comes and goes).
    for (const o of this.cards.values()) if (o !== c && o.focus) o.focus.refreshSpatial(this._items(o));
  }

  /** B on a card: editing → Ready; ready → close when nobody edits, else nudge the editor. */
  _back(c) {
    if (c.state === 'editing') { this._setState(c, 'ready'); return; }
    const ed = this.editingCard();
    if (ed) this.nudge(ed); else this.close('back');
  }

  nudge(c) {
    c.el.classList.add('dr-nudge');
    clearTimeout(c.nudgeTimer);
    c.nudgeTimer = setTimeout(() => c.el.classList.remove('dr-nudge'), 600);
    c.nudges = (c.nudges || 0) + 1;
  }

  _pick(c, kind, val) {
    if (c.state !== 'editing') return;
    const hint = c.el.querySelector('.dr-hint');
    let look = playerLooks.get(c.n);
    if (kind === 'outfit') {
      if (this._lockedOutfits(c.n).has(val)) { if (hint) hint.textContent = 'That outfit is coming to the store.'; return; }
      look = playerLooks.update(c.n, { outfit: val });
      const colours = c.el.querySelector('.dr-opts[data-pick="colourway"]');
      if (colours) colours.innerHTML = this._colourButtons(look);
    } else if (kind === 'body') look = playerLooks.update(c.n, { body: val });
    else if (kind === 'colourway') look = playerLooks.set(c.n, undefined, withColourway(look, val));
    else if (kind === 'led') { look = playerLooks.update(c.n, { led: val }); applyPlayerLed(this._mgr, c.n, look.led); }
    else return;
    const group = c.el.querySelector(`.dr-opts[data-pick="${kind}"]`);
    if (group) for (const b of group.querySelectorAll('button[data-pick]')) b.classList.toggle('active', b.dataset.val === String(val));
    const sum = c.el.querySelector('.dr-summary');
    if (sum) sum.textContent = this._summary(look);
    if (hint) hint.textContent = '';
    const canvas = c.el.querySelector('canvas.dr-preview');
    if (canvas && this._preview) this._preview.show('p' + c.n, /** @type {HTMLCanvasElement} */ (canvas), c.player.seat, seatLook(look));
    const stat = c.el.querySelector('.dr-preview--static');
    if (stat) { stat.querySelector('.dr-static-body').textContent = BODIES[look.body].label; stat.querySelector('.dr-static-outfit').textContent = GOOSE_OUTFITS[look.outfit].label; }
    if (c.focus) c.focus.refreshSpatial(this._items(c));
    if (this._onLookChanged) this._onLookChanged(c.n, kind, val);
  }

  _findMe(c) {
    const look = playerLooks.get(c.n);
    const r = findMe(this._mgr, c.n, look.led, c.type === 'gamepad' ? c.player.input : null);
    const hint = c.el.querySelector('.dr-hint');
    if (hint) hint.textContent = r.rumbled || r.lit ? `Buzzing Player ${c.n}'s controller…` : 'This controller has no rumble or light we can reach.';
    c.lastFind = r;
  }

  // ── input ──

  /** The keyboard player's keys → their ManualInput (arrows, Enter = A, Esc = B). */
  _keyboard(e) {
    if (!this._keyInput) return;
    const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'a', Escape: 'b' };
    const k = map[e.key];
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown') this._keyInput.press(k); else this._keyInput.release(k);
  }

  /** Each frame: the roster, every card's own pad, disconnects, the previews. */
  poll(now = performance.now()) {
    if (!this.open) return;
    this._sync();
    for (const c of this.cards.values()) {
      if (c.type === 'gamepad') {
        const connected = !!(c.player.input && c.player.input.gamepadConnected);
        if (!connected) { if (c.state === 'editing') { console.log(`[dressing room] P${c.n} disconnected while editing → ready`); this._setState(c, 'ready'); } continue; }
      }
      if (c.focus) {
        c.focus.refreshSpatial(this._items(c));
        c.focus.poll();
      }
      // While the preview's height transitions, keep the bitmap the size of its box every frame.
      if (c.transitionUntil && this._preview) { this._resizePreview(c); if (now > c.transitionUntil) c.transitionUntil = 0; }
    }
    if (this._preview) this._preview.tick(now);
  }

  /** Tests: {n: state}. */
  states() { const o = {}; for (const [n, c] of this.cards) o[n] = c.state; return o; }
}
