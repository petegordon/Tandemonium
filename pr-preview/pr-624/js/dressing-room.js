// ============================================================
// DRESSING ROOM (#548) — every seated player dresses their goose at once, each from their own pad
// ============================================================
//
// Opened from a seat screen (co-op room or versus join) by any seated pad's △/Y or a WARDROBE
// button. One card per seated player, side by side (versus groups them by team): player label +
// pad name, a live 3D preview of their goose (dressing-room-preview.js; a text card on the Low
// perf tier), the look summary and a state badge. A "Buzz a controller" strip under the cards has one
// chip per seated pad (rumble + flash, findMe); only Player 1's pad can navigate into it, any mouse
// can click it, and picking a new controller light buzzes that pad by itself. The opener starts in Edit,
// everyone else Ready.
//
// Ownership: each card is driven ONLY by its own pad — a FocusController on that player's
// InputManager (a keyboard player gets a ManualInput fed by arrows / Enter / Esc). Mouse works on
// every card (one couch). A = Edit on your card: it expands into the rows (Gander/Goose, Outfit,
// Colours, Controller light); every pick saves at once and the preview follows. A on DONE or B
// while editing = Ready (picks kept). When nobody is editing, BACK TO SEATS shows: A on it from
// anyone, or B from anyone, closes the room; while someone is editing, B from the others only
// nudges that card. A player who disconnects or leaves their seat while editing counts as Ready,
// so the room can never stick. A phone-seated player drives their card from the phone's menu pad
// (D-pad, OK = A, Back = B) like any controller (#617); the phone has no wardrobe screen of its own.

import { ManualInput } from '../shared/ui/inputs.js';
import { RowFocusController as FocusController } from './row-focus.js';
import { playerLooks, BODIES, LED_COLOURS, lookColourway, withColourway, seatLook, ledRgb } from './player-look.js';
import { GOOSE_OUTFITS } from './goose-outfits.js';
import { colourwaysFor } from './goose-colourways.js';
import { applyPlayerLed, findMe } from './player-led.js';

const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/**
 * @typedef {{ n: number, input: any, type: 'gamepad'|'keyboard'|'phone', label: string, team: 'A'|'B'|null, seat: 'Captain'|'Stoker' }} RoomPlayer
 */

/** How long "Buzzing Player N's controller…" stays up (the pulses take ~0.8 s). */
const BUZZ_NOTE_MS = 2500;

/** A card at least this wide (content box, CSS px) edits with the goose beside the pickers. */
const WIDE_CARD_PX = 560;

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
    this._ro = null;            // marks each card data-wide when it has room for goose-beside-pickers
  }

  // ── open / close ──

  /** @param {number} openerN the player whose pad opened the room (starts in Edit) */
  show(openerN) {
    if (this.open) return;
    this.open = true;
    this._cardsEl = document.getElementById('dr-cards');
    this._backBtn = document.getElementById('dr-back');
    this._statusEl = document.getElementById('dr-status');
    this._buzzEl = document.getElementById('dr-buzz');
    this._buzzKey = null;
    // Rebound on every open: a new room instance each time, so a listener from the last one would close a dead room.
    if (this._backBtn) this._backBtn.onclick = () => { if (this.open && !this.anyEditing()) this.close('back'); };
    this._preview = this._makePreview ? this._makePreview() : null;
    // The editing layout follows the card's own width, not the player count: a wide card puts
    // the goose beside the pickers, a narrow one stacks them (css/lobby-tv.css). Card widths
    // come from flex shares, never from this attribute, so it cannot oscillate.
    this._ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => { for (const e of entries) e.target.toggleAttribute('data-wide', e.contentRect.width >= WIDE_CARD_PX); })
      : null;
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
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
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
    this._renderBuzz();
    this._refreshFoot();
  }

  _addCard(p, editing) {
    playerLooks.bindPad(p.n, this._padKeyFor(p));
    const el = document.createElement('div');
    el.className = 'dr-card';
    el.dataset.n = String(p.n);
    const type = p.input && p.input.remoteOnly ? 'phone' : p.type;
    const c = { n: p.n, player: p, type, el, state: editing ? 'editing' : 'ready', focus: null, manual: null, nudgeTimer: 0 };
    el.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('button[data-act], button[data-pick]') : null;
      if (!b) return;
      if (b.dataset.pick) this._pick(c, b.dataset.pick, b.dataset.val);
      else this._act(c, b.dataset.act);
    });
    if ((type === 'gamepad' || type === 'phone') && p.input) {
      c.focus = new FocusController({ input: p.input, onConfirm: (x) => x.click(), onBack: () => this._back(c) });
    } else if (type === 'keyboard') {
      c.manual = new ManualInput();
      this._keyInput = c.manual;
      c.focus = new FocusController({ input: c.manual, onConfirm: (x) => x.click(), onBack: () => this._back(c) });
    }
    this.cards.set(p.n, c);
    if (this._ro) this._ro.observe(el);
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
    clearTimeout(c.buzzTimer);
    clearTimeout(c.hintTimer);
    if (c.focus) c.focus.clear();
    if (c.manual === this._keyInput) this._keyInput = null;
    if (this._preview) this._preview.remove('p' + c.n);
    if (this._ro) this._ro.unobserve(c.el);
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
      <div class="dr-head"><span class="dr-who"></span><span class="dr-badge"></span></div>
      ${previewHtml}
      <p class="dr-stick-hint">Right stick: look around · R3: reset</p>
      <p class="dr-summary"></p>
      <div class="dr-rows-wrap"></div>
      <div class="dr-actions"></div>
      <p class="options-note dr-hint"></p>`;
    const preview = c.el.querySelector('.dr-preview');
    if (preview) {
      // The transition's last frame: one exact resize + redraw so the goose never stays stretched.
      preview.addEventListener('transitionend', () => { c.transitionUntil = 0; this._resizePreview(c); });
      // Mouse (the shared couch mouse, and the keyboard player's path): drag = orbit, wheel = zoom.
      let drag = null;
      preview.addEventListener('pointerdown', (e) => { drag = { x: e.clientX }; preview.setPointerCapture?.(e.pointerId); e.preventDefault(); });
      preview.addEventListener('pointermove', (e) => { if (!drag || !this._preview) return; const dx = e.clientX - drag.x; drag.x = e.clientX; this._preview.orbitBy('p' + c.n, dx * 0.012); });
      const end = () => { drag = null; };
      preview.addEventListener('pointerup', end);
      preview.addEventListener('pointercancel', end);
      preview.addEventListener('wheel', (e) => { if (!this._preview) return; e.preventDefault(); this._preview.zoomBy('p' + c.n, -e.deltaY * 0.0015); }, { passive: false });
      preview.addEventListener('dblclick', () => { if (this._preview) this._preview.resetView('p' + c.n); });
    }
  }

  _renderCard(c) {
    if (!c.el.querySelector('.dr-head')) this._buildCard(c);
    const look = playerLooks.get(c.n);
    const p = c.player;
    const badge = c.state === 'editing' ? 'EDITING' : '✓ READY';
    const tone = p.team === 'A' ? 'team-a' : p.team === 'B' ? 'team-b' : (p.seat === 'Stoker' ? 'stoker' : 'captain');
    if (c.el.dataset.state !== c.state) c.transitionUntil = performance.now() + 450;   // the CSS transition runs ~280 ms
    c.el.dataset.state = c.state;
    c.el.dataset.tone = tone;
    c.el.querySelector('.dr-badge').textContent = badge;
    // The camera hint only where a pad drives the card and there is a 3D preview to look around.
    const stickHint = c.el.querySelector('.dr-stick-hint');
    if (stickHint) stickHint.hidden = !(c.type === 'gamepad' && this._preview);
    // The same P# badge as the seat cards (uf-seat badge), then the player's name (#617).
    c.el.querySelector('.dr-who').innerHTML = `<span class="dr-pnum">P${c.n}</span>${esc(p.label)}`;
    c.el.querySelector('.dr-summary').textContent = this._summary(look);
    c.el.querySelector('.dr-rows-wrap').innerHTML = c.state === 'editing' ? this._rows(c, look) : '';
    c.el.querySelector('.dr-actions').innerHTML = c.state === 'editing'
        ? `<button class="opt-btn dr-done" data-act="done">DONE</button>`
        : `<button class="opt-btn dr-edit" data-act="edit">EDIT</button>`;
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
      + (this._hasLight(c) ? row('Controller light', 'led', leds) : '')
      + `</div>`;
  }

  /**
   * #623 · does this player's controller have a light the game can colour? Only then is there a
   * Controller light row. A Steam Controller's light can't be set from here (TV test), and a
   * phone or a keyboard has none.
   */
  _hasLight(c) {
    if (c.type !== 'gamepad') return false;
    const input = c.player.input;
    const driver = input && input._controllerDriver;
    if (driver && driver.constructor && driver.constructor.needsSiblingFanout) return false;   // the Steam Controller driver
    const name = String((input && input._gpName) || c.player.label || '');
    return !/steam (controller|deck)/i.test(name);
  }

  _colourButtons(look) {
    const cur = lookColourway(look);
    return colourwaysFor(look.outfit).map((w) => `<button class="opt-btn${w.key === cur ? ' active' : ''}" data-pick="colourway" data-val="${esc(w.key)}">${esc(w.label)}</button>`).join('');
  }

  /** The card's own focusables (+ BACK TO SEATS when it shows), focus on `initial`. */
  _items(c) {
    const shown = (b) => b.getBoundingClientRect().width > 0;
    const own = [...c.el.querySelectorAll('button')].filter(shown);
    // Only Player 1's pad navigates into the Buzz strip (down past the card's last row lands on
    // P1's chip, up returns to the card); every other pad's scope never includes it.
    if (c.n === 1 && this._buzzEl) own.push(...[...this._buzzEl.querySelectorAll('button[data-buzz]')].filter(shown));
    if (!this.anyEditing() && this._backBtn && shown(this._backBtn)) own.push(this._backBtn);
    return own;
  }

  /** The Buzz strip: one chip per seated non-phone player, in their light colour; rebuilt when the roster or a light changes. */
  _renderBuzz() {
    if (!this._buzzEl) return;
    const chips = [...this.cards.values()].filter((c) => c.type !== 'phone').map((c) => {
      const look = playerLooks.get(c.n);
      const rgb = ledRgb(look.led);
      return { n: c.n, label: c.player.label, rgb: `rgb(${rgb.r},${rgb.g},${rgb.b})`, led: look.led };
    });
    const key = chips.map((x) => `${x.n}:${x.led}:${x.label}`).join('|');
    if (key === this._buzzKey) return;
    this._buzzKey = key;
    const box = this._buzzEl.querySelector('#dr-buzz-chips');
    box.innerHTML = chips.map((x) => `<button class="opt-btn dr-chip" data-buzz="${x.n}" title="${esc(x.label)}" style="--chip: ${x.rgb}"><span class="led-swatch" style="background: ${x.rgb}"></span>P${x.n}</button>`).join('');
    this._buzzEl.style.display = chips.length ? '' : 'none';
    if (!box._wired) {
      box._wired = true;
      box.addEventListener('click', (e) => {
        const b = e.target instanceof Element ? e.target.closest('button[data-buzz]') : null;
        if (b) this.buzz(Number(b.dataset.buzz));
      });
    }
    const p1 = this.cards.get(1);
    if (p1 && p1.focus) p1.focus.refreshSpatial(this._items(p1));
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

  }

  _setState(c, state) {
    if (c.state === state) return;
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
    else if (kind === 'led') {
      look = playerLooks.update(c.n, { led: val });
      applyPlayerLed(this._mgr, c.n, look.led);
      // One buzz per settled pick: a direction held across several swatches fires once.
      clearTimeout(c.buzzTimer);
      c.buzzTimer = setTimeout(() => { if (this.open && this.cards.get(c.n) === c) this.buzz(c.n); }, 400);
      this._renderBuzz();
    }
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

  /** Buzz player n's pad (rumble + flash) and say so on their card. A chip press, or a settled light pick. */
  buzz(n) {
    const c = this.cards.get(n);
    if (!c || c.type === 'phone') return;
    const look = playerLooks.get(c.n);
    const r = findMe(this._mgr, c.n, look.led, c.type === 'gamepad' ? c.player.input : null);
    const hint = c.el.querySelector('.dr-hint');
    const text = r.rumbled || r.lit ? `Buzzing Player ${c.n}'s controller…` : 'This controller has no rumble or light we can reach.';
    if (hint) {
      hint.textContent = text;
      // #623 · the note goes once the buzz is over (it stayed on the card for good).
      clearTimeout(c.hintTimer);
      c.hintTimer = setTimeout(() => { if (hint.textContent === text) hint.textContent = ''; }, BUZZ_NOTE_MS);
    }
    c.lastFind = r;
    c.buzzCount = (c.buzzCount || 0) + 1;
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
    const dt = this._lastPoll ? Math.min(0.1, (now - this._lastPoll) / 1000) : 1 / 60;
    this._lastPoll = now;
    this._sync();
    for (const c of this.cards.values()) {
      if (c.type === 'gamepad' || c.type === 'phone') {
        const connected = !!(c.player.input && c.player.input.gamepadConnected);
        if (!connected) { if (c.state === 'editing') { console.log(`[dressing room] P${c.n} disconnected while editing → ready`); this._setState(c, 'ready'); } continue; }
      }
      if (c.focus) {
        c.focus.refreshSpatial(this._items(c));
        c.focus.poll();
        this._showFocusedGroup(c);
      }
      // Right stick on THIS player's pad orbits / zooms their own preview (Ready or Editing);
      // R3 resets. The d-pad / left stick stay with the pickers (FocusController above).
      if (c.type === 'gamepad' && this._preview) {
        const gp = c.player.input.getGamepadState ? c.player.input.getGamepadState() : null;
        if (gp && gp.axes) {
          const r3 = !!(gp.buttons && gp.buttons[11] && gp.buttons[11].pressed);
          const reset = r3 && !c.prevR3;
          c.prevR3 = r3;
          this._preview.control('p' + c.n, { x: gp.axes[2] || 0, y: gp.axes[3] || 0, reset, dt });
        }
      }
      // While the preview's height transitions, keep the bitmap the size of its box every frame.
      if (c.transitionUntil && this._preview) { this._resizePreview(c); if (now > c.transitionUntil) c.transitionUntil = 0; }
    }
    if (this._preview) this._preview.tick(now);
  }

  /**
   * #617 · the pickers scroll in their own box (css/lobby-tv.css). The focus controller scrolls
   * just the focused button into view; also bring its label (the line above it) along, and the
   * first row all the way back to the top.
   */
  _showFocusedGroup(c) {
    const f = c.focus.focused;
    if (f === c.lastFocused) return;
    c.lastFocused = f;
    const wrap = c.el.querySelector('.dr-rows-wrap');
    const g = f && wrap && wrap.contains(f) ? f.closest('.dr-group') : null;
    if (!g || wrap.scrollHeight <= wrap.clientHeight + 1) return;
    if (g === wrap.querySelector('.dr-group')) { wrap.scrollTop = 0; return; }
    const gr = g.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (gr.height && gr.top < wr.top) wrap.scrollTop -= wr.top - gr.top;
  }

  /** Tests: {n: state}. */
  states() { const o = {}; for (const [n, c] of this.cards) o[n] = c.state; return o; }
}
