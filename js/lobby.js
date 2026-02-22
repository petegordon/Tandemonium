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

    // Permission toggle buttons
    this.toggleCamera = document.getElementById('toggle-camera');
    this.toggleMotion = document.getElementById('toggle-motion');
    this.toggleAudio = document.getElementById('toggle-audio');
    this.cameraActive = false;
    this.motionActive = false;
    this.audioActive = false;
    this._cameraPermitted = false;
    this._motionPermitted = false;
    this._audioPermitted = false;
    this._permissionsChecked = false;

    // Gamepad navigation state
    this._focusIndex = 0;
    this._currentStep = null;
    this._pollRafId = null;
    this._gpPrevUp = false;
    this._gpPrevDown = false;
    this._gpPrevA = false;
    this._gpPrevB = false;
    this._gpPrevLeft = false;
    this._gpPrevRight = false;

    // Column-based navigation for mode step
    this._modeColumns = [
      [this.toggleCamera, this.toggleMotion, this.toggleAudio],
      [document.getElementById('btn-solo'), document.getElementById('btn-together')],
    ];
    this._modeCol = 1;
    this._modeColIndex = [0, 0];

    // Per-step focusable items and back buttons
    this._stepItems = new Map();
    this._stepBack = new Map();
    this._stepItems.set(this.modeStep, this._modeColumns[1]);
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
    this._checkPermissionStates();
  }

  show() {
    this.lobbyEl.style.display = 'flex';
    this._showStep(this.modeStep);
    this._startGamepadNav();
    this._checkPermissionStates();
  }

  _showStep(step) {
    [this.modeStep, this.roleStep, this.hostStep, this.joinStep]
      .forEach(s => s.style.display = 'none');
    step.style.display = 'flex';
    this._clearFocusHighlight();
    this._currentStep = step;
    if (step === this.modeStep) {
      this._modeCol = 1;
      this._modeColIndex = [0, 0];
      this._stepItems.set(this.modeStep, this._modeColumns[1]);
    }
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

    // Permission toggles
    this.toggleCamera.addEventListener('click', () => this._toggleCamera());
    this.toggleMotion.addEventListener('click', () => this._toggleMotion());
    this.toggleAudio.addEventListener('click', () => this._toggleAudio());
  }

  _requestMotion() {
    if (this.input && this.input.needsMotionPermission) {
      this.input.requestMotionPermission();
    }
  }

  // ── Permission toggles ──────────────────────────────────────
  // Track whether the browser permission has been obtained (separate from
  // the user's on/off toggle choice). Once a browser permission is granted
  // we remember it so re-enabling doesn't re-prompt.

  _toggleCamera() {
    if (this.cameraActive) {
      this.cameraActive = false;
      this._setToggleActive('camera', false);
      return;
    }
    if (this._cameraPermitted) {
      this.cameraActive = true;
      this._setToggleActive('camera', true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      this._cameraPermitted = true;
      this.cameraActive = true;
      this._setToggleActive('camera', true);
    }).catch(() => {});
  }

  _toggleMotion() {
    // Gamepad + WebHID: true on/off toggle for controller gyro
    if (this.input && this.input.gamepadConnected && navigator.hid) {
      if (this.motionActive) {
        // Turn off — disable gyro steering but keep device connected
        this.motionActive = false;
        this.input.motionEnabled = false;
        this.input.motionLean = 0;
        this._setToggleActive('motion', false);
        return;
      }
      if (this._motionPermitted) {
        // Re-enable previously connected gyro
        this.motionActive = true;
        this.input.motionEnabled = true;
        this._setToggleActive('motion', true);
        return;
      }
      // First time — request WebHID access
      this.input.connectControllerGyro().then(() => {
        if (this.input.gyroConnected) {
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
        }
      }).catch((err) => {
        console.warn('Gyro connect failed:', err);
      });
      return;
    }

    // Mobile: permission-grant only (tilt is the primary steering input,
    // disabling it would leave the player unable to steer)
    if (this._motionPermitted) return;
    if (this.input) {
      this.input.requestMotionPermission();
      // Check after a short delay (iOS permission dialog is async)
      setTimeout(() => {
        if (this.input.motionEnabled) {
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
        }
      }, 500);
    }
  }

  _toggleAudio() {
    if (this.audioActive) {
      this.audioActive = false;
      this._setToggleActive('audio', false);
      return;
    }
    if (this._audioPermitted) {
      this.audioActive = true;
      this._setToggleActive('audio', true);
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      this._audioPermitted = true;
      this.audioActive = true;
      this._setToggleActive('audio', true);
    }).catch(() => {});
  }

  _setToggleActive(name, active) {
    const el = name === 'camera' ? this.toggleCamera
             : name === 'motion' ? this.toggleMotion
             : this.toggleAudio;
    if (active) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  }

  _checkPermissionStates() {
    // Only auto-enable on first load; don't override user's toggle choice on re-entry
    if (this._permissionsChecked) return;
    this._permissionsChecked = true;

    // Camera
    if (navigator.permissions) {
      navigator.permissions.query({ name: 'camera' }).then(r => {
        if (r.state === 'granted') {
          this._cameraPermitted = true;
          this.cameraActive = true;
          this._setToggleActive('camera', true);
        }
      }).catch(() => {});

      // Microphone
      navigator.permissions.query({ name: 'microphone' }).then(r => {
        if (r.state === 'granted') {
          this._audioPermitted = true;
          this.audioActive = true;
          this._setToggleActive('audio', true);
        }
      }).catch(() => {});
    }

    // Motion — auto-green if sensor data or gyro already connected.
    if (this.input && (this.input.motionEnabled || this.input.gyroConnected)) {
      this._motionPermitted = true;
      this.motionActive = true;
      this._setToggleActive('motion', true);
    } else if (this.input && this.input.needsMotionPermission) {
      // iOS: permission needed — leave button tappable but inactive
    } else if (this.input && this.input.gamepadConnected && navigator.hid) {
      // Desktop with PlayStation controller: leave toggle enabled for gyro
      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.input.gamepadIndex];
      if (gp && /playstation|dualsense|dualshock|054c/i.test(gp.id)) {
        // Toggle stays enabled — tapping requests WebHID gyro
      } else {
        this.toggleMotion.disabled = true;
      }
    } else if (typeof DeviceMotionEvent === 'undefined') {
      // No API at all — disable the button
      this.toggleMotion.disabled = true;
    } else {
      // Desktop/Android: API exists but no data yet.
      // Listen for first real motion event to auto-enable.
      const onFirstMotion = () => {
        if (this.input && this.input.motionEnabled) {
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
        }
        window.removeEventListener('devicemotion', onFirstMotion);
      };
      window.addEventListener('devicemotion', onFirstMotion);
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
    this.net.cameraEnabled = this.cameraActive;
    this.net.audioEnabled = this.audioActive;
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
    this.net.cameraEnabled = this.cameraActive;
    this.net.audioEnabled = this.audioActive;
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
    this._gpPrevLeft = false;
    this._gpPrevRight = false;
    if (this.input && this.input.gamepadConnected) {
      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.input.gamepadIndex];
      if (gp) {
        this._gpPrevUp = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
        this._gpPrevDown = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
        this._gpPrevA = gp.buttons[0] && gp.buttons[0].pressed;
        this._gpPrevB = gp.buttons[1] && gp.buttons[1].pressed;
        this._gpPrevLeft = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
        this._gpPrevRight = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
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

    // D-pad left/right (buttons 14/15 or left stick axis 0)
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;

    // Edge detection: fire on press, not hold
    if (up && !this._gpPrevUp) this._moveFocus(-1);
    if (down && !this._gpPrevDown) this._moveFocus(1);
    if (left && !this._gpPrevLeft) this._moveColumn(-1);
    if (right && !this._gpPrevRight) this._moveColumn(1);
    if (a && !this._gpPrevA) this._confirmFocus();
    if (b && !this._gpPrevB) this._goBack();

    this._gpPrevUp = up;
    this._gpPrevDown = down;
    this._gpPrevLeft = left;
    this._gpPrevRight = right;
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

  _moveColumn(dir) {
    if (this._currentStep !== this.modeStep) return;
    const newCol = Math.max(0, Math.min(this._modeColumns.length - 1, this._modeCol + dir));
    if (newCol === this._modeCol) return;

    this._clearFocusHighlight();
    // Save current row index for the column we're leaving
    this._modeColIndex[this._modeCol] = this._focusIndex;
    this._modeCol = newCol;
    // Restore row index for destination column (clamped)
    const colItems = this._modeColumns[newCol];
    this._focusIndex = Math.min(this._modeColIndex[newCol], colItems.length - 1);
    // Update _stepItems to point at the active column's items
    this._stepItems.set(this.modeStep, colItems);
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
