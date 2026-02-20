// ============================================================
// LOBBY — UI controller for mode/role selection + connection
// ============================================================

import { NetworkManager } from './network-manager.js';
import { RELAY_URL } from './config.js';

export class Lobby {
  constructor({ onSolo, onMultiplayerReady, input }) {
    this.onSolo = onSolo;
    this.onMultiplayerReady = onMultiplayerReady;
    this.input = input; // InputManager — needed for iOS motion permission
    this.net = null;

    this.lobbyEl = document.getElementById('lobby');
    this.modeStep = document.getElementById('lobby-mode');
    this.roleStep = document.getElementById('lobby-role');
    this.hostStep = document.getElementById('lobby-host');
    this.joinStep = document.getElementById('lobby-join');

    // Gamepad navigation state
    this._focusIndex = 0;
    this._currentStep = null;
    this._pollRafId = null;
    this._gpPrevUp = false;
    this._gpPrevDown = false;
    this._gpPrevA = false;
    this._gpPrevB = false;

    // Per-step focusable items and back buttons
    this._stepItems = new Map();
    this._stepBack = new Map();
    this._stepItems.set(this.modeStep, [
      document.getElementById('btn-solo'),
      document.getElementById('btn-together'),
    ]);
    this._stepItems.set(this.roleStep, [
      document.getElementById('btn-captain'),
      document.getElementById('btn-stoker'),
      document.getElementById('btn-back-mode'),
    ]);
    this._stepItems.set(this.hostStep, [
      document.getElementById('btn-back-role-host'),
    ]);
    this._stepItems.set(this.joinStep, [
      document.getElementById('room-code-input'),
      document.getElementById('btn-join'),
      document.getElementById('btn-back-role-join'),
    ]);
    this._stepBack.set(this.modeStep, null);
    this._stepBack.set(this.roleStep, document.getElementById('btn-back-mode'));
    this._stepBack.set(this.hostStep, document.getElementById('btn-back-role-host'));
    this._stepBack.set(this.joinStep, document.getElementById('btn-back-role-join'));

    // Default focus index per step (0 if not specified)
    this._stepDefaultFocus = new Map();
    this._stepDefaultFocus.set(this.modeStep, 1); // RIDE TOGETHER

    this._setup();
    this._checkAutoJoin();

    // Lobby is visible by default on page load (show() is only called on
    // re-entry from gameplay), so start gamepad nav now and set initial step.
    this._currentStep = this.modeStep;
    this._startGamepadNav();
  }

  show() {
    this.lobbyEl.style.display = 'flex';
    this._showStep(this.modeStep);
    this._startGamepadNav();
  }

  _showStep(step) {
    [this.modeStep, this.roleStep, this.hostStep, this.joinStep]
      .forEach(s => s.style.display = 'none');
    step.style.display = 'flex';
    this._clearFocusHighlight();
    this._currentStep = step;
    this._focusIndex = this._stepDefaultFocus.get(step) || 0;
    this._applyFocusHighlight();
  }

  _hideLobby() {
    this.lobbyEl.style.display = 'none';
    this._stopGamepadNav();
  }

  _setup() {
    // SOLO
    document.getElementById('btn-solo').addEventListener('click', () => {
      this._requestMotion();
      this._hideLobby();
      this.onSolo();
    });

    // RIDE TOGETHER
    document.getElementById('btn-together').addEventListener('click', () => {
      this._requestMotion();
      this._showStep(this.roleStep);
    });

    // Back buttons
    document.getElementById('btn-back-mode').addEventListener('click', () => {
      this._showStep(this.modeStep);
    });
    document.getElementById('btn-back-role-host').addEventListener('click', () => {
      if (this.net) { this.net.destroy(); this.net = null; }
      document.getElementById('room-qr').innerHTML = '';
      this._showStep(this.roleStep);
    });
    document.getElementById('btn-back-role-join').addEventListener('click', () => {
      if (this.net) { this.net.destroy(); this.net = null; }
      this._showStep(this.roleStep);
    });

    // CAPTAIN (START A RIDE)
    document.getElementById('btn-captain').addEventListener('click', () => {
      this._showStep(this.hostStep);
      this._createRoom();
    });

    // STOKER (JOIN A RIDE)
    document.getElementById('btn-stoker').addEventListener('click', () => {
      this._showStep(this.joinStep);
      document.getElementById('room-code-input').focus();
    });

    // JOIN button
    document.getElementById('btn-join').addEventListener('click', () => {
      const raw = document.getElementById('room-code-input').value.trim().toUpperCase();
      if (raw.length >= 4) {
        const code = raw.startsWith('TNDM-') ? raw : 'TNDM-' + raw;
        this._joinRoom(code);
      }
    });

    // Enter key on room code input
    document.getElementById('room-code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('btn-join').click();
      }
    });

  }

  _requestMotion() {
    if (this.input && this.input.needsMotionPermission) {
      this.input.requestMotionPermission();
    }
  }

  _checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (!roomParam) return;

    history.replaceState(null, '', window.location.pathname);
    const code = roomParam.toUpperCase();
    const fullCode = code.startsWith('TNDM-') ? code : 'TNDM-' + code;

    try { this._requestMotion(); } catch (_) {}
    this._showStep(this.joinStep);
    this._joinRoom(fullCode);
  }

  _createRoom() {
    this.net = new NetworkManager();
    this.net._fallbackUrl = RELAY_URL;
    const statusEl = document.getElementById('host-status');
    const codeEl = document.getElementById('room-code-display');

    statusEl.textContent = 'Creating room...';
    statusEl.className = 'conn-status';

    this.net.createRoom((code) => {
      codeEl.textContent = code;
      statusEl.textContent = 'Waiting for partner...';

      // Generate QR code with join URL
      const qrEl = document.getElementById('room-qr');
      const url = window.location.origin + window.location.pathname + '?room=' + code;
      try {
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 2 });
      } catch (_) {
        qrEl.style.display = 'none';
      }
    });

    this.net.onConnected = () => {
      statusEl.textContent = 'Partner connected!';
      statusEl.className = 'conn-status connected';
      setTimeout(() => {
        this._hideLobby();
        this.onMultiplayerReady(this.net, 'captain');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Disconnected';
      statusEl.className = 'conn-status error';
    };
  }

  _joinRoom(code) {
    this.net = new NetworkManager();
    this.net._fallbackUrl = RELAY_URL;
    const statusEl = document.getElementById('join-status');

    statusEl.textContent = 'Connecting...';
    statusEl.className = 'conn-status';

    this.net.joinRoom(code, () => {
      statusEl.textContent = 'Connecting to room...';
    });

    this.net.onConnected = () => {
      statusEl.textContent = 'Connected!';
      statusEl.className = 'conn-status connected';
      setTimeout(() => {
        this._hideLobby();
        this.onMultiplayerReady(this.net, 'stoker');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Could not connect';
      statusEl.className = 'conn-status error';
    };
  }

  // ── Gamepad navigation ──────────────────────────────────────

  _startGamepadNav() {
    // Prime edge-detect flags from current gamepad state so held buttons
    // from a previous screen don't fire, but fresh presses work immediately.
    this._gpPrevUp = false;
    this._gpPrevDown = false;
    this._gpPrevA = false;
    this._gpPrevB = false;
    if (this.input && this.input.gamepadConnected) {
      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.input.gamepadIndex];
      if (gp) {
        this._gpPrevUp = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
        this._gpPrevDown = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
        this._gpPrevA = gp.buttons[0] && gp.buttons[0].pressed;
        this._gpPrevB = gp.buttons[1] && gp.buttons[1].pressed;
      }
    }
    this._pollGamepadNav();
  }

  _stopGamepadNav() {
    if (this._pollRafId) {
      cancelAnimationFrame(this._pollRafId);
      this._pollRafId = null;
    }
    this._clearFocusHighlight();
  }

  _pollGamepadNav() {
    this._pollRafId = requestAnimationFrame(() => this._pollGamepadNav());

    if (!this.input || !this.input.gamepadConnected) return;

    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (!gp) return;

    // D-pad up (button 12) or left stick up (axis 1 < -0.5)
    const up = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
    // D-pad down (button 13) or left stick down (axis 1 > 0.5)
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
    // A button (button 0)
    const a = gp.buttons[0] && gp.buttons[0].pressed;
    // B button (button 1)
    const b = gp.buttons[1] && gp.buttons[1].pressed;

    // Edge detection: fire on press, not hold
    if (up && !this._gpPrevUp) this._moveFocus(-1);
    if (down && !this._gpPrevDown) this._moveFocus(1);
    if (a && !this._gpPrevA) this._confirmFocus();
    if (b && !this._gpPrevB) this._goBack();

    this._gpPrevUp = up;
    this._gpPrevDown = down;
    this._gpPrevA = a;
    this._gpPrevB = b;
  }

  _moveFocus(dir) {
    const items = this._stepItems.get(this._currentStep);
    if (!items || items.length === 0) return;

    this._clearFocusHighlight();
    this._focusIndex = Math.max(0, Math.min(items.length - 1, this._focusIndex + dir));
    this._applyFocusHighlight();
  }

  _confirmFocus() {
    const items = this._stepItems.get(this._currentStep);
    if (!items || items.length === 0) return;

    const el = items[this._focusIndex];
    if (!el) return;

    if (el.tagName === 'INPUT') {
      el.focus();
    } else {
      el.click();
    }
  }

  _goBack() {
    const backBtn = this._stepBack.get(this._currentStep);
    if (backBtn) backBtn.click();
  }

  _applyFocusHighlight() {
    const items = this._stepItems.get(this._currentStep);
    if (!items || items.length === 0) return;

    const el = items[this._focusIndex];
    if (el) el.classList.add('gamepad-focus');
  }

  _clearFocusHighlight() {
    const prev = this.lobbyEl.querySelector('.gamepad-focus');
    if (prev) prev.classList.remove('gamepad-focus');
  }
}
