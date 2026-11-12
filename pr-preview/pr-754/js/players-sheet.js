// @ts-check
// ============================================================
// PLAYERS (#646) — who is playing on this screen, their controllers, and each controller's settings
// ============================================================
//
// Replaces the Controls sheet (bar pill → <uf-sheet id="players-sheet">). One row per seat on
// THIS screen (P1–P4; an online partner stays on the room screen):
//   who        signed in (picture + name) or Guest · Sign in with Discord / Sign out
//              (Steam build P1: no Sign out, they launched from their own Steam library)
//   controller the bound pad's model, its light colour, Buzz (rumble + flash, js/player-led.js)
//   settings   that controller's Stick steering, Gyro steering (+ Steering feel, Recalibrate) and
//              Button prompts. They follow the controller (js/controller-settings.js), not the seat.
// Below: Available controllers (connected, not seated). Picking one seats it through the step's
// own join path (co-op stoker / versus), which claims a ControllerManager slot as any join does.
// Then "Use your phone instead".
//
// Only Player 1's pad drives the sheet (like every lobby menu); a mouse can click anything.
// The lobby owns the state; this module renders it and routes the presses back.

import { PROMPT_LABELS, nextPrompt } from './controller-settings.js';
import { playerLooks, ledRgb } from './player-look.js';
import { findMe } from './player-led.js';
import qrcode from '../shared/ui/third_party/qrcode-generator.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const TONES = ['captain', 'stoker', 'team-a', 'team-b'];

/**
 * Apply one controller's settings to a seat's InputManager (players 2–4; Player 1's go through
 * the lobby's toggles). stick/gyro null = automatic: gyro stays as the join armed it, and the
 * stick is on unless the gyro is live (#576).
 * @param {any} input the seat's InputManager
 * @param {{stick: boolean|null, gyro: boolean|null}} s
 * @param {object|null} tune feelTuning(s.feel) for this pad
 * @param {boolean} hasGyro the pad's motion sensors are bound
 */
export function applyPadSettings(input, s, tune, hasGyro) {
  if (!input) return;
  if (s.gyro === false && input.motionEnabled) { input.motionEnabled = false; input.motionLean = 0; }
  else if (s.gyro === true && !input.motionEnabled && hasGyro) {
    input.motionEnabled = true;
    if (typeof input.startTiltCalibration === 'function') input.startTiltCalibration();
  }
  const gyroLive = !!input.motionEnabled && hasGyro;
  input.suppressGamepadLean = s.stick === false ? true : s.stick === true ? false : gyroLive;
  input.controllerTune = tune || null;
}

export class PlayersSheet {
  /**
   * @param {any} lobby the Lobby (state + join paths)
   * @param {any} sheet the <uf-sheet id="players-sheet">
   */
  constructor(lobby, sheet) {
    this.lobby = lobby;
    this.sheet = sheet;
    this.rowsEl = /** @type {HTMLElement} */ (sheet.querySelector('#pl-rows'));
    this.availEl = /** @type {any} */ (sheet.querySelector('#pl-available'));
    this.availNote = /** @type {HTMLElement} */ (sheet.querySelector('#pl-avail-note'));
    this._sig = '';
    this._availSig = '';
    this._notes = new Map();   // n → { text, until }
    this._accounts = null;
    this._wire();
  }

  get open() { return !!this.sheet.open; }

  show() {
    if (!this._accounts) {
      this._accounts = this.lobby._wardrobeAccounts();
      this._accounts.onChange(() => { if (this.open) this.sync(); });
    }
    this._sig = '';
    this._availSig = '';
    this.sheet.show();
    this.sync();
  }

  close() { this.sheet.close(); }

  _wire() {
    const rows = this.rowsEl;
    rows.addEventListener('change', (e) => {
      const set = /** @type {any} */ (e.target).closest?.('uf-setting[data-set]');
      if (!set) return;
      const n = Number(set.closest('.pl-row').dataset.n);
      if (set.dataset.set === 'stick') this.lobby.setSeatSteering(n, { stick: !!set.checked });
      else if (set.dataset.set === 'gyro') this.lobby.setSeatSteering(n, { gyro: !!set.checked });
      this.sync();
    });
    rows.addEventListener('input', (e) => {
      const el = /** @type {any} */ (e.target);
      if (!el || el.type !== 'range') return;
      const n = Number(el.closest('.pl-row').dataset.n);
      this.lobby.setSeatSteering(n, { feel: Number(el.value) / 100 });
    });
    rows.addEventListener('uf-setting:open', (e) => {
      const set = /** @type {any} */ (e.target).closest?.('uf-setting[data-set="prompts"]');
      if (!set) return;
      const n = Number(set.closest('.pl-row').dataset.n);
      const cur = this.lobby.seatPadSettings(n);
      this.lobby.setSeatSteering(n, { prompts: nextPrompt(cur ? cur.prompts : 'auto') });
      this.sync();
    });
    rows.addEventListener('click', (e) => {
      const b = /** @type {any} */ (e.target).closest?.('[data-act]');
      if (!b || b.hasAttribute('disabled')) return;
      const n = Number(b.closest('.pl-row').dataset.n);
      this._act(n, b.dataset.act);
    });
    this.availEl?.addEventListener('uf-controller-roster:select', (e) => {
      const key = /** @type {CustomEvent} */ (e).detail.key;
      const c = (this._avail || []).find((x) => x.key === key);
      if (c && c.assign) { c.assign(); this._sig = ''; this._availSig = ''; setTimeout(() => this.open && this.sync(), 50); }
    });
  }

  _act(n, act) {
    const acc = this._accounts;
    const p = this._players().find((x) => x.n === n);
    if (act === 'signin' && acc) Promise.resolve(acc.signIn(n)).catch(() => {}).then(() => this.open && this.sync());
    else if (act === 'cancel' && acc) acc.cancel(n);
    else if (act === 'signout') this.lobby.signOutSeat(n);
    else if (act === 'buzz' && p) {
      const look = playerLooks.get(n);
      const r = findMe(this.lobby.controllerManager, n, look.led, p.type === 'gamepad' ? p.input : null);
      this._note(n, r.rumbled || r.lit ? `Buzzing Player ${n}'s controller…` : 'This controller has no rumble or light we can reach.');
    } else if (act === 'recal') {
      if (n === 1) { this.lobby._recalibrateSteering(); this.close(); return; }
      if (p && p.input && typeof p.input.startTiltCalibration === 'function') p.input.startTiltCalibration();
      this._note(n, 'Hold the controller level: steering re-centred.');
    }
    this.sync();
  }

  _note(n, text) {
    this._notes.set(n, { text, until: Date.now() + 4000 });
    setTimeout(() => { if (this.open) this.sync(); }, 4100);
  }

  /** This screen's seats: {n, input, type, label, slotId}. */
  _players() {
    try { return this.lobby.playersOnScreen(); } catch (e) { return []; }
  }

  /** Re-render when something changed; cheap otherwise. Called from the lobby's ~1 Hz bar sync and on every change. */
  sync() {
    if (!this.open) return;
    const lobby = this.lobby;
    const players = this._players();
    const views = players.map((p) => this._view(p));
    const sig = JSON.stringify(views);
    if (sig !== this._sig) {
      this._sig = sig;
      this._render(views);
    }
    this._syncAvailable(players);
    void lobby;
  }

  /** Everything a row shows, as plain data (also its dirty-check). */
  _view(p) {
    const lobby = this.lobby;
    const n = p.n;
    const id = lobby.seatIdentity(p);
    const acc = this._accounts ? this._accounts.view(n) : null;
    const person = lobby.seatPerson(n);
    const steamP1 = n === 1 && !!lobby._isSteam;
    const look = playerLooks.get(n);
    const rgb = ledRgb(look.led);
    const isPhone = !!(p.input && p.input.remoteOnly);
    const kind = p.type === 'keyboard' ? 'keyboard' : isPhone ? 'phone' : (id ? 'pad' : 'none');
    const s = kind === 'pad' ? lobby.seatPadSettings(n) : null;
    const st = kind === 'pad' ? lobby.seatSteering(n) : null;
    const note = this._notes.get(n);
    return {
      n, kind,
      tone: p.team === 'A' ? 'team-a' : p.team === 'B' ? 'team-b' : n === 1 ? 'captain' : 'stoker',
      seat: p.seat || '',
      person: person ? { name: person.name, pic: person.pic, source: person.source } : null,
      acc: acc ? { state: acc.state, code: acc.code || '', url: acc.url || '', status: acc.status || '', error: acc.error || '', blockedBy: acc.blockedBy || null } : null,
      canSignOut: !!person && !steamP1,
      steamP1,
      pad: id ? { name: id.name || id.shortName || 'Controller', family: (s && s.prompts !== 'auto') ? s.prompts : (id.glyphFamily || 'generic') } : null,
      led: `rgb(${rgb.r},${rgb.g},${rgb.b})`, ledLabel: look.led,
      stick: st ? st.stick : null, gyro: st ? st.gyro : null, gyroCapable: st ? st.gyroCapable : false, gyroHint: st ? st.gyroHint : '',
      feel: s ? Math.round(s.feel * 100) : null,
      prompts: s ? s.prompts : null,
      note: note && note.until > Date.now() ? note.text : '',
    };
  }

  _render(views) {
    const fc = this.lobby._stepFocus;
    const focused = fc && fc.focusedEl && this.rowsEl.contains(fc.focusedEl) ? fc.focusedEl.dataset.fid : null;
    this.rowsEl.innerHTML = views.map((v) => this._rowHtml(v)).join('');
    this.rowsEl.dataset.count = String(views.length);
    // Sliders: values as properties (an attribute would not move a dragged thumb back).
    for (const v of views) {
      const r = /** @type {HTMLInputElement|null} */ (this.rowsEl.querySelector(`.pl-row[data-n="${v.n}"] input[type=range]`));
      if (r && v.feel != null) r.value = String(v.feel);
    }
    // The kit elements render on a microtask: re-read the focusables once they have.
    setTimeout(() => this._refocus(focused), 0);
  }

  /** After a re-render, keep the pad's highlight on the same control (by data-fid). */
  _refocus(fid) {
    const fc = this.lobby._stepFocus;
    if (!fc || !this.open) return;
    const items = this.sheet.focusables();
    const byFid = (f) => items.find((x) => x.dataset && x.dataset.fid === f) || null;
    let el = fid ? byFid(fid) : null;
    if (fid && !el) {
      // The control went (Sign in became Hide, or was greyed): stay in the same row,
      // on its account button, else its first control; never jump up to Close.
      const pre = fid.split('-')[0];
      el = byFid(pre + '-cancel') || byFid(pre + '-signout') || byFid(pre + '-signin')
        || items.find((x) => x.dataset && typeof x.dataset.fid === 'string' && x.dataset.fid.startsWith(pre + '-'))
        || items.find((x) => !x.classList.contains('uf-sheet__close')) || null;
    }
    if (el) {
      if (fc.focusedEl && fc.focusedEl !== el) fc.focusedEl.classList.remove(fc.focusClass || 'gamepad-focus');
      fc.focusedEl = el;
      el.classList.add(fc.focusClass || 'gamepad-focus');
    }
    fc.refreshSpatial(items);
  }

  _rowHtml(v) {
    const n = v.n;
    const fid = (k) => `data-fid="p${n}-${k}"`;
    const who = v.person
      ? `<uf-person name="${esc(v.person.name)}" pic="${esc(v.person.pic)}" source="${esc(v.person.source)}"></uf-person>`
      : `<span class="pl-guest">Guest</span>`;
    let accBtns = '', accPanel = '';
    const a = v.acc;
    if (a && a.state === 'pending') {
      let qr = '';
      try { const q = qrcode(0, 'M'); q.addData(a.url); q.make(); qr = q.createSvgTag({ cellSize: 3, margin: 1 }); } catch (e) {}
      accPanel = `<div class="pl-acc-panel"><div class="pl-acc-qr">${qr}</div>
        <ol class="pl-acc-steps"><li>Scan with your phone</li><li>Sign in with Discord</li><li>Check the code <b class="pl-acc-code">${esc(a.code)}</b></li></ol>
        <p class="pl-acc-status">${a.status === 'confirming' ? 'Confirm the code on your phone…' : 'Waiting for Discord…'}</p></div>`;
      accBtns = `<uf-button size="sm" data-act="cancel" ${fid('cancel')}>Hide</uf-button>`;
    } else if (v.person) {
      accBtns = v.canSignOut ? `<uf-button size="sm" data-act="signout" ${fid('signout')}>Sign out</uf-button>`
        : (v.steamP1 ? `<span class="pl-acc-note">Steam account</span>` : '');
    } else if (a) {
      const wait = a.blockedBy ? ' disabled' : '';
      accBtns = `<uf-button size="sm" variant="accent" data-act="signin" ${fid('signin')}${wait}>Sign in with Discord</uf-button>`;
      const msg = a.blockedBy ? `Waiting for P${a.blockedBy} to sign in…` : a.error;
      if (msg) accPanel = `<p class="pl-acc-status">${esc(msg)}</p>`;
    }
    let pad;
    if (v.kind === 'pad' && v.pad) {
      pad = `<uf-controller-glyph button="confirm" family="${esc(v.pad.family)}" size="sm"></uf-controller-glyph>
        <b class="pl-pad-name">${esc(v.pad.name)}</b>
        <span class="led-swatch pl-led" title="Light: ${esc(v.ledLabel)}" style="background:${v.led}"></span>
        <uf-button size="sm" data-act="buzz" ${fid('buzz')}>Buzz · Find me</uf-button>`;
    } else if (v.kind === 'phone') pad = `<b class="pl-pad-name">Phone</b><span class="pl-muted">steers by tilting the phone</span>`;
    else if (v.kind === 'keyboard') pad = `<b class="pl-pad-name">Keyboard</b><span class="pl-muted">press a button on a controller to use it</span>`;
    else pad = `<span class="pl-muted">No controller yet: press a button on one</span>`;
    let settings = '';
    if (v.kind === 'pad') {
      const gyroDesc = v.gyroHint;
      settings = `<div class="pl-settings">
        <uf-setting data-set="stick" ${fid('stick')} label="Stick steering" description="Lean with the left stick"${v.stick ? ' checked' : ''}></uf-setting>
        <uf-setting data-set="gyro" ${fid('gyro')} label="Gyro steering" description="${esc(gyroDesc)}"${v.gyro ? ' checked' : ''}${v.gyroCapable ? '' : ' disabled'}>
          <div slot="detail" class="pl-feel"><span class="pl-feel-label">Steering feel</span><uf-button size="sm" data-act="recal" ${fid('recal')}>Recalibrate</uf-button><span class="set-feel-end">Stable</span><input type="range" class="pl-feel-slider" ${fid('feel')} min="0" max="100" value="${v.feel}" aria-label="Steering feel, Player ${n}"><span class="set-feel-end">Responsive</span></div>
        </uf-setting>
        <uf-setting data-set="prompts" ${fid('prompts')} kind="value" label="Button prompts" description="${v.prompts === 'auto' ? 'Picked from this controller' : 'Chosen for this controller'}" value="${esc(PROMPT_LABELS[v.prompts] || 'Automatic')}"></uf-setting>
      </div>`;
    }
    return `<section class="pl-row" data-n="${n}" data-tone="${TONES.includes(v.tone) ? v.tone : 'captain'}">
      <header class="pl-head"><span class="pl-num">P${n}</span><span class="pl-who">${who}</span>${v.seat ? `<span class="pl-seat">${esc(v.seat)}</span>` : ''}<span class="pl-acc">${accBtns}</span></header>
      ${accPanel}
      <div class="pl-pad">${pad}</div>
      ${v.note ? `<p class="pl-note">${esc(v.note)}</p>` : ''}
      ${settings}
    </section>`;
  }

  /** The Available controllers list: connected, not seated; picking one seats it where the step can. */
  _syncAvailable(players) {
    if (!this.availEl) return;
    const { list, note } = this.lobby.availableControllers(players);
    this._avail = list;
    const sig = JSON.stringify([list.map((c) => [c.key, c.name, c.detail, !!c.assign]), note]);
    if (sig === this._availSig) return;
    this._availSig = sig;
    this.availEl.selectable = list.some((c) => !!c.assign);
    this.availEl.rows = list.map((c) => ({ key: c.key, name: c.name, shortName: c.name, state: 'connected', connection: c.connection, detail: c.detail, glyphFamily: c.glyphFamily || 'generic' }));
    // Nothing spare: one quiet line instead of the roster's "No controllers yet" (they are all seated).
    this.availEl.style.display = list.length ? '' : 'none';
    const text = list.length ? (note || '') : 'Available controllers: none. Every connected controller has a seat.';
    if (this.availNote) { this.availNote.textContent = text; this.availNote.hidden = !text; }
    setTimeout(() => this._refocusAvailable(), 0);
  }

  _refocusAvailable() {
    const fc = this.lobby._stepFocus;
    if (fc && this.open) {
      // The roster re-rendered: hand the pad the new rows (keep its place if it was on one).
      const fk = fc.focusedEl && fc.focusedEl.closest && fc.focusedEl.closest('#pl-available') ? fc.focusedEl.dataset.key : null;
      const items = this.sheet.focusables();
      const el = fk ? items.find((x) => x.dataset && x.dataset.key === fk) : null;
      if (el) { fc.focusedEl = el; el.classList.add(fc.focusClass || 'gamepad-focus'); }
      fc.refreshSpatial(items);
    }
  }
}
