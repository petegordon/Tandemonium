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

    this._setup();
  }

  show() {
    this.lobbyEl.style.display = 'flex';
    this._showStep(this.modeStep);
  }

  _showStep(step) {
    [this.modeStep, this.roleStep, this.hostStep, this.joinStep]
      .forEach(s => s.style.display = 'none');
    step.style.display = 'flex';
  }

  _setup() {
    // SOLO
    document.getElementById('btn-solo').addEventListener('click', () => {
      this._requestMotion();
      this.lobbyEl.style.display = 'none';
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

    // Auto-join from URL (e.g. ?room=TNDM-ABCD)
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      history.replaceState(null, '', window.location.pathname);
      const code = roomParam.toUpperCase();
      const short = code.startsWith('TNDM-') ? code.slice(5) : code;
      setTimeout(() => {
        this._requestMotion();
        this._showStep(this.joinStep);
        document.getElementById('room-code-input').value = short;
        document.getElementById('btn-join').click();
      }, 300);
    }
  }

  _requestMotion() {
    if (this.input && this.input.needsMotionPermission) {
      this.input.requestMotionPermission();
    }
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
        this.lobbyEl.style.display = 'none';
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
        this.lobbyEl.style.display = 'none';
        this.onMultiplayerReady(this.net, 'stoker');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Could not connect';
      statusEl.className = 'conn-status error';
    };
  }
}
