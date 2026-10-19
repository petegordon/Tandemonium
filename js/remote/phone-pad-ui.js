// @ts-check
// ============================================================
// phone-pad-ui — "Phone as controller" panel on the game screen (#421)
// ============================================================
//
// A button on the mode screen opens a panel with a QR for Player 1's phone
// remote and its live status. If a connected phone drops, the panel comes back
// as "Phone disconnected" (the game pauses, see game.js) and closes itself
// when the phone returns. The phone-first flow (D4) is Phase 3.
// ============================================================

import { PhonePadHost } from './phone-pad-host.js';

const STATUS_TEXT = {
  idle: '',
  connecting: 'Opening a connection…',
  waiting: 'Scan the code with your phone’s camera.',
  connected: 'Phone connected. Tilt to steer, tap LEFT / RIGHT to pedal.',
  error: 'Can’t reach the phone relay. Retrying…',
};

const CSS = `
#phone-pad-panel { position: fixed; inset: 0; z-index: 9000; display: none;
  align-items: center; justify-content: center; background: var(--uf-color-scrim, rgba(0,0,0,.6)); }
#phone-pad-panel.open { display: flex; }
#phone-pad-panel .ppp-card { background: var(--uf-color-surface, #1a1a2e); color: var(--uf-color-fg, #fff);
  border: 1px solid var(--uf-color-line-soft, rgba(255,255,255,.16)); border-radius: 16px;
  padding: 22px 26px; width: min(92vw, 380px); text-align: center; display: flex; flex-direction: column; gap: 12px; }
#phone-pad-panel h2 { font-size: 20px; letter-spacing: 1px; }
#phone-pad-panel .ppp-qr { background: #fff; border-radius: 10px; padding: 10px; align-self: center; line-height: 0; }
#phone-pad-panel .ppp-qr svg { width: 220px; height: 220px; }
#phone-pad-panel .ppp-link { font-size: 11px; color: var(--uf-color-fg-muted, #8a93a6); word-break: break-all; user-select: all; }
#phone-pad-panel .ppp-status { font-size: 15px; min-height: 2.6em; color: var(--uf-color-fg-muted, #8a93a6); }
#phone-pad-panel .ppp-status.ok { color: var(--uf-color-accent, #44ff66); }
#phone-pad-panel .ppp-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
#btn-mode-phone.phone-on { color: var(--uf-color-accent, #44ff66); }
`;

/**
 * Wire the mode-screen button to a phone remote for `input` (Player 1).
 * @param {import('../input-manager.js').InputManager} input
 * @param {{onDrop?: () => void, onReturn?: () => void, onPause?: () => void}} [hooks]
 * @returns {PhonePadHost}
 */
export function installPhonePadUI(input, hooks = {}) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'phone-pad-panel';
  panel.innerHTML = `
    <div class="ppp-card" role="dialog" aria-label="Phone as controller">
      <h2 id="ppp-title">&#128241; PHONE AS CONTROLLER</h2>
      <div class="ppp-qr" id="ppp-qr"></div>
      <div class="ppp-link" id="ppp-link"></div>
      <div class="ppp-status" id="ppp-status"></div>
      <div class="ppp-row">
        <uf-button variant="accent" id="btn-ppp-done">DONE</uf-button>
        <uf-button variant="ghost" size="sm" id="btn-ppp-stop">Stop using phone</uf-button>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const btn = document.getElementById('btn-mode-phone');
  const statusEl = /** @type {HTMLElement} */ (panel.querySelector('#ppp-status'));

  const titleEl = /** @type {HTMLElement} */ (panel.querySelector('#ppp-title'));
  let dropped = false;
  const host = new PhonePadHost({
    input,
    seat: 1,
    onPause: hooks.onPause,
    onDrop: () => {
      dropped = true;
      titleEl.textContent = '📱 PHONE DISCONNECTED';
      open();
      statusEl.textContent = 'Open the controller page on your phone again (it reconnects by itself), or scan the code.';
      hooks.onDrop?.();
    },
    onReturn: () => {
      dropped = false;
      titleEl.textContent = '📱 PHONE AS CONTROLLER';
      hooks.onReturn?.();
    },
    onStatus: (s) => {
      if (dropped && s !== 'connected') return;   // keep the disconnected message
      statusEl.textContent = STATUS_TEXT[s] || '';
      statusEl.classList.toggle('ok', s === 'connected');
      if (btn) {
        btn.classList.toggle('phone-on', s === 'connected');
        btn.textContent = s === 'connected' ? '\u{1F4F1} Phone connected' : '\u{1F4F1} Phone as controller';
      }
      // Close the panel a moment after the phone connects: the player is
      // looking at the phone by then, and the menu needs the screen.
      if (s === 'connected') setTimeout(() => close(), 1500);
    },
  });

  const open = async () => {
    panel.classList.add('open');
    const link = await host.open();
    if (!link) return;   // stopped while opening
    const qrEl = /** @type {HTMLElement} */ (panel.querySelector('#ppp-qr'));
    const linkEl = /** @type {HTMLElement} */ (panel.querySelector('#ppp-link'));
    if (qrEl.dataset.link !== link) {
      let qrOk = false;
      try {
        const qr = /** @type {any} */ (window).qrcode(0, 'M');
        qr.addData(link);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
        qrOk = true;
      } catch { /* the QR script didn't load (offline, blocked) */ }
      qrEl.style.display = qrOk ? '' : 'none';
      qrEl.dataset.link = link;
      // Without a QR the full link (with its secret) is the only way in.
      linkEl.textContent = qrOk ? link.split('#')[0] : link;
    }
    if (!dropped) statusEl.textContent = STATUS_TEXT[host.status] || '';
    watchPadClose();
  };
  const close = () => panel.classList.remove('open');

  // A gamepad (or a TV remote) has no Escape key: B or Start closes the panel.
  let padPoll = 0;
  const watchPadClose = () => {
    if (padPoll) return;
    let held = true;   // ignore whatever was held as the panel opened
    padPoll = window.setInterval(() => {
      if (!panel.classList.contains('open')) { clearInterval(padPoll); padPoll = 0; return; }
      let down = false;
      for (const gp of navigator.getGamepads?.() || []) {
        if (gp && (gp.buttons[1]?.pressed || gp.buttons[9]?.pressed)) down = true;
      }
      if (down && !held) close();
      held = down;
    }, 100);
  };

  btn?.addEventListener('click', open);
  panel.querySelector('#btn-ppp-done')?.addEventListener('click', close);
  panel.querySelector('#btn-ppp-stop')?.addEventListener('click', () => {
    host.close();
    dropped = false;
    titleEl.textContent = '📱 PHONE AS CONTROLLER';
    const qrEl = /** @type {HTMLElement} */ (panel.querySelector('#ppp-qr'));
    qrEl.dataset.link = '';
    close();
  });
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) close();
  });

  /** @type {any} */ (window).__phonePad = host;   // smoke-test hook
  return host;
}
