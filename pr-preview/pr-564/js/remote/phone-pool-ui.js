// @ts-check
// ============================================================
// phone-pool-ui — "Join with phone" on the co-op and versus screens (#562)
// ============================================================
//
// The button opens a panel with a QR for the next phone. Each phone that
// scans joins as a controller ("Phone 2", "Phone 3" …) and the QR moves on to
// the next one, so a couch can pass the screen round. A joined phone then
// takes a seat on the screen behind (OK on the phone), like any pad.
// A SEATED phone that drops mid-ride brings the panel back with that phone's
// code (it reconnects by itself when its page is reopened); the ride's own
// disconnect pause holds everything meanwhile.
// ============================================================

import { PhonePadHost } from './phone-pad-host.js';
import { PhonePool } from './phone-entry.js';
import qrcode from '../../shared/ui/third_party/qrcode-generator.js';

/**
 * #562 · the entry point's words, in one place (Pete is still choosing between
 * this and one QR where the phone asks "play here / control the TV").
 * The controller QR says where the game appears, and is never on screen with
 * the online room's QR (which makes a phone the game screen): the host step
 * hides that QR while this panel is open, and the button is hidden once an
 * online partner holds the seat.
 */
export const PHONE_JOIN_COPY = {
  button: '\u{1F4F1} Use your phone as a controller',
  title: '\u{1F4F1} USE YOUR PHONE AS A CONTROLLER',
  caption: 'Steer from your phone — the game stays on this screen',
};

/**
 * #562 · the whole entry point: label the screens' buttons and open the panel
 * from them. Not while an online partner holds the co-op seat.
 * @param {string[]} buttonIds @param {() => void} open
 */
export function wireJoinEntry(buttonIds, open) {
  for (const id of buttonIds) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.textContent = PHONE_JOIN_COPY.button;
    b.setAttribute('title', PHONE_JOIN_COPY.caption);
    b.addEventListener('click', () => {
      if (b.closest('#lobby-host') && document.querySelector('#lobby-host.host-online-on')) return;
      open();
    });
  }
}

const CSS = `
/* The online room QR (a phone becomes the game screen) never shows beside this one. */
body.phone-controller-qr #room-qr-tv, body.phone-controller-qr #room-qr { visibility: hidden; }
#phone-pool-panel .ppp-caption { font-size: var(--uf-size-md, 15px); color: var(--uf-color-fg, #fff); }
#phone-pool-panel { position: fixed; inset: 0; z-index: 9000; display: none;
  align-items: center; justify-content: center; background: var(--uf-color-scrim, rgba(0,0,0,.6)); }
#phone-pool-panel.open { display: flex; }
#phone-pool-panel .ppp-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
#phone-pool-panel .ppp-card { background: var(--uf-color-surface, #1a1a2e); color: var(--uf-color-fg, #fff);
  border: 1px solid var(--uf-color-line-soft, rgba(255,255,255,.16)); border-radius: 16px;
  padding: 22px 26px; width: min(92vw, 420px); text-align: center; display: flex; flex-direction: column; gap: 12px; }
#phone-pool-panel h2 { font-size: var(--uf-size-lg, 20px); letter-spacing: 1px; }
#phone-pool-panel .ppp-qr { background: #fff; border-radius: 10px; padding: 10px; align-self: center; line-height: 0; }
#phone-pool-panel .ppp-qr svg { width: 220px; height: 220px; }
#phone-pool-panel .ppp-link { font-size: 11px; color: var(--uf-color-fg-muted, #8a93a6); word-break: break-all; user-select: all; }
#phone-pool-panel .ppp-status { font-size: var(--uf-size-md, 15px); min-height: 2.6em; color: var(--uf-color-fg-muted, #8a93a6); }
#phone-pool-panel .ppp-phones { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; min-height: 1.6em; }
#phone-pool-panel .ppp-phone { padding: 2px 10px; border-radius: 999px; font-size: var(--uf-size-sm, 13px);
  border: 1px solid var(--uf-color-line-soft, rgba(255,255,255,.16)); color: var(--uf-color-fg-muted, #8a93a6); }
#phone-pool-panel .ppp-phone.here { color: var(--uf-color-accent, #44ff66); border-color: currentColor; }
`;

/**
 * Make the phone pool and its panel, and wire the screens' "Join with phone"
 * buttons to it.
 * @param {object} deps
 * @param {() => any} deps.makeInput  a remoteOnly InputManager
 * @param {any} deps.p1Input  Player 1's InputManager (its B / Start close the panel)
 * @param {(entry: import('./phone-entry.js').PhoneEntry) => void} [deps.onPause]
 * @param {(pool: PhonePool) => void} [deps.onChange]
 * @param {string[]} [buttonIds]
 * @returns {{ pool: PhonePool, open: (entry?: any) => void, close: () => void, readonly panelOpen: boolean }}
 */
export function installPhonePoolUI({ makeInput, p1Input, onPause, onChange }, buttonIds = ['btn-host-join-phone', 'btn-versus-join-phone']) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'phone-pool-panel';
  panel.className = 'phone-qr-panel';
  panel.innerHTML = `
    <div class="ppp-card" role="dialog" aria-label="Join with phone">
      <h2 id="ppool-title"></h2>
      <div class="ppp-caption" id="ppool-caption"></div>
      <div class="ppp-qr" id="ppool-qr"></div>
      <div class="ppp-link" id="ppool-link"></div>
      <div class="ppp-phones" id="ppool-phones"></div>
      <div class="ppp-status" id="ppool-status"></div>
      <div class="ppp-row"><uf-button variant="accent" id="btn-ppool-done">DONE</uf-button></div>
    </div>`;
  document.body.appendChild(panel);
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (panel.querySelector('#' + id));

  /** The dropped phone the panel is showing, else null (showing the next phone's QR). */
  let dropped = /** @type {import('./phone-entry.js').PhoneEntry|null} */ (null);

  const pool = new PhonePool({
    makeInput,
    makeHost: (opts) => new PhonePadHost(opts),
    onChange: (p) => { render(); onChange?.(p); },
    onDrop: (e) => { dropped = e; open(); },
    onReturn: (e) => { if (dropped === e) { dropped = null; close(); } },
    onPause: (e) => onPause?.(e),
  });

  const drawLink = (/** @type {string|null} */ link) => {
    const qrEl = $('ppool-qr'), linkEl = $('ppool-link');
    if (qrEl.dataset.link === (link || '')) return;
    qrEl.dataset.link = link || '';
    if (!link) { qrEl.innerHTML = ''; qrEl.style.display = 'none'; linkEl.textContent = ''; return; }
    let ok = false;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
      ok = true;
    } catch { /* fall back to the link */ }
    qrEl.style.display = ok ? '' : 'none';
    linkEl.textContent = ok ? link.split('#')[0] : link;
  };

  const render = () => {
    if (!panel.classList.contains('open')) return;
    const show = dropped || pool.pending;
    $('ppool-title').textContent = dropped ? `\u{1F4F1} ${dropped.identity.name.toUpperCase()} DISCONNECTED` : PHONE_JOIN_COPY.title;
    $('ppool-caption').textContent = PHONE_JOIN_COPY.caption;
    drawLink(show ? show.link : null);
    $('ppool-phones').innerHTML = pool.joinedEntries()
      .map((e) => `<span class="ppp-phone${e.present ? ' here' : ''}">${e.identity.name}${e.present ? ' ✓' : ''}</span>`).join('');
    let status;
    if (dropped) status = 'Open the controller page on that phone again (it reconnects by itself), or scan the code.';
    else if (!pool.pending) status = pool.joinedEntries().length ? 'Every phone seat is taken.' : '';
    else if (pool.pending.status === 'error') status = 'Can’t reach the phone relay. Retrying…';
    else if (pool.pending.status === 'connecting' || !pool.pending.link) status = 'Opening a connection…';
    else status = `Scan with the next phone’s camera to join as ${pool.pending.identity.name}. Then press OK on the phone to take a seat.`;
    $('ppool-status').textContent = status;
  };

  let padPoll = 0;
  const watchPadClose = () => {
    if (padPoll) return;
    let held = true;   // ignore whatever was held as the panel opened
    padPoll = window.setInterval(() => {
      if (!panel.classList.contains('open')) { clearInterval(padPoll); padPoll = 0; return; }
      // Status changes (connecting → waiting) don't all reach onChange.
      render();
      const gp = p1Input && p1Input.gamepadConnected ? p1Input.getGamepadState() : null;
      const bIdx = p1Input && p1Input._gpSwapAB ? 0 : 1;
      const down = !!gp && !!(gp.buttons[bIdx]?.pressed || gp.buttons[9]?.pressed);
      if (down && !held) close();
      held = down;
    }, 100);
  };

  const open = () => {
    panel.classList.add('open');
    document.body.classList.add('phone-controller-qr');
    if (!dropped) pool.setOffering(true);
    render();
    watchPadClose();
  };
  const close = () => {
    panel.classList.remove('open');
    document.body.classList.remove('phone-controller-qr');
    dropped = null;
    pool.setOffering(false);
  };

  wireJoinEntry(buttonIds, () => { dropped = null; open(); });
  $('btn-ppool-done').addEventListener('click', close);
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) close(); });

  const ui = {
    pool, open, close,
    get panelOpen() { return panel.classList.contains('open'); },
  };
  /** @type {any} */ (window).__phonePool = ui;   // smoke-test hook
  return ui;
}
