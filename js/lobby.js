// ============================================================
// LOBBY — UI controller for mode/role selection + connection
// ============================================================

import { NetworkManager } from './network-manager.js';
import { RELAY_URL } from './config.js';
import { LEVELS } from './race-config.js';
import { AuthManager } from './auth.js';

export class Lobby {
  constructor({ onSolo, onMultiplayerReady, input }) {
    this.onSolo = onSolo;
    this.onMultiplayerReady = onMultiplayerReady;
    this.input = input; // InputManager — needed for iOS motion permission
    this.net = null;
    this.selectedLevel = LEVELS[0]; // default level
    this._pendingMode = null; // 'solo' or 'multiplayer', set during level selection

    this.lobbyEl = document.getElementById('lobby');
    this.modeStep = document.getElementById('lobby-mode');
    this.levelStep = document.getElementById('lobby-level');
    this.roleStep = document.getElementById('lobby-role');
    this.hostStep = document.getElementById('lobby-host');
    this.joinStep = document.getElementById('lobby-join');

    // Permission toggle buttons
    this.toggleAll = document.getElementById('toggle-all');
    this.toggleCamera = document.getElementById('toggle-camera');
    this.toggleMotion = document.getElementById('toggle-motion');
    this.toggleAudio = document.getElementById('toggle-audio');
    this.toggleMusic = document.getElementById('toggle-music');
    this.toggleHelp = document.getElementById('toggle-help');
    this.helpModal = document.getElementById('help-modal');
    this.toggleProfile = document.getElementById('toggle-profile');
    this.toggleLeaderboard = document.getElementById('toggle-leaderboard');
    this.cameraActive = false;
    this.motionActive = false;
    this.audioActive = false;
    this._cameraPermitted = false;
    this._motionPermitted = false;
    this._audioPermitted = false;
    this._permissionsChecked = false;

    // Music toggle (not a permission — just on/off, persisted in localStorage)
    this.musicActive = localStorage.getItem('tandemonium_music') !== 'off';
    if (this.musicActive) this.toggleMusic.classList.add('active');
    this.onMusicChanged = null; // callback set by Game

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
      [this.toggleHelp, this.toggleLeaderboard, this.toggleProfile],
      [document.getElementById('btn-together'), document.getElementById('btn-solo')],
      [this.toggleAll, this.toggleCamera, this.toggleAudio],
      [this.toggleMotion, this.toggleMusic],
    ];
    this._modeCol = 1;
    this._modeColIndex = [0, 0, 0, 0];

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

    // Auth
    this.auth = new AuthManager();
    this._setupAuth();

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
    [this.modeStep, this.levelStep, this.roleStep, this.hostStep, this.joinStep]
      .forEach(s => s.style.display = 'none');
    step.style.display = 'flex';
    this._clearFocusHighlight();
    this._currentStep = step;
    if (step === this.modeStep) {
      this._modeCol = 1;
      this._modeColIndex = [0, 0, 0, 0];
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
    // SOLO → start directly with Level 1
    document.getElementById('btn-solo').addEventListener('click', () => {
      this._requestMotion();
      this.selectedLevel = LEVELS[0];
      this._hideLobby();
      this.onSolo();
    });

    // RIDE TOGETHER → role selection with Level 1
    document.getElementById('btn-together').addEventListener('click', () => {
      this._requestMotion();
      this.selectedLevel = LEVELS[0];
      this._showStep(this.roleStep);
    });

    // Level selection: build cards and handle clicks
    this._buildLevelCards();
    document.getElementById('btn-back-level').addEventListener('click', () => {
      this._showStep(this.modeStep);
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
    this.toggleAll.addEventListener('click', () => this._toggleAll());
    this.toggleCamera.addEventListener('click', () => this._toggleCamera());
    this.toggleMotion.addEventListener('click', () => this._toggleMotion());
    this.toggleAudio.addEventListener('click', () => this._toggleAudio());
    this.toggleMusic.addEventListener('click', () => this._toggleMusic());
    this.toggleHelp.addEventListener('click', () => this._openHelp());
    this.toggleProfile.addEventListener('click', () => this._toggleProfile());
    this.toggleLeaderboard.addEventListener('click', () => this._openLeaderboard());
    document.getElementById('btn-leaderboard').addEventListener('click', () => this._openLeaderboard());
  }

  _buildLevelCards() {
    const container = document.getElementById('level-cards');
    const buttons = [];
    LEVELS.forEach(level => {
      const card = document.createElement('button');
      card.className = 'level-card';
      card.innerHTML =
        '<div class="level-card-top">' +
          '<span class="level-card-icon">' + level.icon + '</span>' +
          '<span class="level-card-name">' + level.name + '</span>' +
        '</div>' +
        '<div class="level-card-desc">' + level.description + '</div>' +
        '<div class="level-card-distance">' + (level.distance >= 1000 ? (level.distance / 1000) + ' km' : level.distance + ' m') + '</div>';
      card.addEventListener('click', () => {
        this.selectedLevel = level;
        if (this._pendingMode === 'solo') {
          this._hideLobby();
          this.onSolo();
        } else {
          this._showStep(this.roleStep);
        }
      });
      container.appendChild(card);
      buttons.push(card);
    });

    // Register for gamepad navigation
    buttons.push(document.getElementById('btn-back-level'));
    this._stepItems.set(this.levelStep, buttons);
    this._stepBack.set(this.levelStep, document.getElementById('btn-back-level'));
  }

  _setupAuth() {
    this.profilePopup = document.getElementById('profile-popup');
    const popupAvatar = document.getElementById('profile-popup-avatar');
    const popupName = document.getElementById('profile-popup-name');
    const popupEmail = document.getElementById('profile-popup-email');
    const logoutBtn = document.getElementById('profile-popup-logout');

    // Initialize GSI
    this.auth.initGSI();

    // Save original SVG to restore on logout
    const profileSvg = this.toggleProfile.innerHTML;

    const updateUI = (user) => {
      if (user) {
        this.toggleProfile.classList.add('active');
        popupAvatar.src = user.avatar || '';
        popupName.textContent = user.name || '';
        popupEmail.textContent = user.email || '';
        if (user.avatar) {
          this.toggleProfile.innerHTML = '<img src="' + user.avatar + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">';
        }
      } else {
        this.toggleProfile.classList.remove('active');
        this.toggleProfile.innerHTML = profileSvg;
        this.profilePopup.classList.remove('visible');
      }
    };

    this.auth.onLogin((user) => {
      updateUI(user);
      this.profilePopup.classList.remove('visible');
    });

    // Logout
    logoutBtn.addEventListener('click', () => {
      this.auth.logout();
      updateUI(null);
    });

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.profilePopup.classList.contains('visible')) return;
      if (this.profilePopup.contains(e.target)) return;
      if (this.toggleProfile.contains(e.target)) return;
      this.profilePopup.classList.remove('visible');
    });

    // Leaderboard close
    document.getElementById('leaderboard-close').addEventListener('click', () => {
      document.getElementById('leaderboard-modal').style.display = 'none';
    });

    // Restore UI if already logged in from localStorage
    if (this.auth.isLoggedIn()) {
      updateUI(this.auth.getUser());
    }
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

  _toggleAll() {
    // If ALL is active, turn everything off
    const motionOk = !this._motionAvailable() || this.motionActive;
    if (this.cameraActive && this.audioActive && motionOk && this.musicActive) {
      if (this.cameraActive) this._toggleCamera();
      if (this.audioActive)  this._toggleAudio();
      if (this._motionAvailable() && this.motionActive) this._toggleMotion();
      if (this.musicActive) this._toggleMusic();
      return;
    }

    // Batch camera + mic into one getUserMedia prompt when both are needed
    const needCam = !this.cameraActive && !this._cameraPermitted;
    const needMic = !this.audioActive  && !this._audioPermitted;

    if (needCam || needMic) {
      const constraints = {};
      if (needCam) constraints.video = true;
      if (needMic) constraints.audio = true;
      navigator.mediaDevices.getUserMedia(constraints).then(stream => {
        stream.getTracks().forEach(t => t.stop());
        if (needCam) {
          this._cameraPermitted = true;
          this.cameraActive = true;
          this._setToggleActive('camera', true);
        }
        if (needMic) {
          this._audioPermitted = true;
          this.audioActive = true;
          this._setToggleActive('audio', true);
        }
        // Already-permitted but inactive toggles
        if (!needCam && !this.cameraActive) this._toggleCamera();
        if (!needMic && !this.audioActive)  this._toggleAudio();
        if (this._motionAvailable() && !this.motionActive) this._toggleMotion();
        if (!this.musicActive) this._toggleMusic();
      }).catch(() => {
        // Even if cam+mic fails, still try the ones that are already permitted
        if (!this.cameraActive && this._cameraPermitted) this._toggleCamera();
        if (!this.audioActive  && this._audioPermitted)  this._toggleAudio();
        if (this._motionAvailable() && !this.motionActive) this._toggleMotion();
        if (!this.musicActive) this._toggleMusic();
      });
    } else {
      // Both cam+mic already permitted — just activate any that are off
      if (!this.cameraActive) this._toggleCamera();
      if (!this.audioActive)  this._toggleAudio();
      if (this._motionAvailable() && !this.motionActive) this._toggleMotion();
      if (!this.musicActive) this._toggleMusic();
    }
  }

  _motionAvailable() {
    return this.toggleMotion.style.display !== 'none';
  }

  _showMotionToggle() {
    this.toggleMotion.style.display = '';
  }

  _checkGamepadGyro() {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (gp && /playstation|dualsense|dualshock|054c/i.test(gp.id)) {
      this._showMotionToggle();
    }
  }

  _updateAllToggle() {
    const motionOk = !this._motionAvailable() || this.motionActive;
    if (this.cameraActive && this.audioActive && motionOk && this.musicActive) {
      this.toggleAll.classList.add('active');
    } else {
      this.toggleAll.classList.remove('active');
    }
  }

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
             : name === 'music'  ? this.toggleMusic
             : this.toggleAudio;
    if (active) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
    this._updateAllToggle();
  }

  _toggleMusic() {
    this.musicActive = !this.musicActive;
    this._setToggleActive('music', this.musicActive);
    if (this.musicActive) {
      localStorage.removeItem('tandemonium_music');
    } else {
      localStorage.setItem('tandemonium_music', 'off');
    }
    if (this.onMusicChanged) this.onMusicChanged(this.musicActive);
  }

  _openHelp() {
    this.helpModal.classList.add('visible');
  }

  _toggleProfile() {
    if (this.auth.isLoggedIn()) {
      // Show logged-in content, hide sign-in button
      document.querySelector('.profile-popup-content').style.display = '';
      document.getElementById('profile-popup-signin').style.display = 'none';
      this.profilePopup.classList.toggle('visible');
    } else {
      // Show sign-in button, hide logged-in content
      document.querySelector('.profile-popup-content').style.display = 'none';
      document.getElementById('profile-popup-signin').style.display = '';
      this.profilePopup.classList.toggle('visible');
      // Also try One Tap prompt as a bonus
      this.auth.login();
    }
  }

  async _openLeaderboard() {
    const modal = document.getElementById('leaderboard-modal');
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = '<div style="text-align:center;padding:16px;color:rgba(255,255,255,0.5);">Loading...</div>';
    modal.style.display = '';

    try {
      const levelId = this.selectedLevel ? this.selectedLevel.id : 'grandma';
      const data = await this.auth.getLeaderboard(levelId);
      const entries = data.entries || [];

      if (entries.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:16px;color:rgba(255,255,255,0.5);">No scores yet</div>';
        return;
      }

      list.innerHTML = entries.map((e, i) =>
        '<div class="lb-entry">' +
          '<span class="lb-rank">' + (i + 1) + '</span>' +
          '<span class="lb-name">' + this._escapeHtml(e.display_name || 'Player') + '</span>' +
          '<span class="lb-time">' + this._formatTime(e.time_ms) + '</span>' +
        '</div>'
      ).join('');
    } catch (e) {
      list.innerHTML = '<div style="text-align:center;padding:16px;color:rgba(255,255,255,0.5);">Could not load leaderboard</div>';
    }
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  _formatTime(ms) {
    if (!ms) return '--:--';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const frac = Math.floor((ms % 1000) / 100);
    return min + ':' + String(sec).padStart(2, '0') + '.' + frac;
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

    // Motion — only show the toggle when a real sensor source exists.
    // Hidden by default (display:none in HTML).
    if (this.input && (this.input.motionEnabled || this.input.gyroConnected)) {
      this._showMotionToggle();
      this._motionPermitted = true;
      this.motionActive = true;
      this._setToggleActive('motion', true);
    } else if (this.input && this.input.needsMotionPermission) {
      // iOS: permission needed — show button, leave tappable but inactive
      this._showMotionToggle();
    } else if (this.input && this.input.gamepadConnected && navigator.hid) {
      this._checkGamepadGyro();
    } else if (typeof DeviceMotionEvent !== 'undefined') {
      // Desktop/Android: API exists but no data yet.
      // Listen for first real motion event to reveal + auto-enable.
      const onFirstMotion = () => {
        if (this.input && this.input.motionEnabled) {
          this._showMotionToggle();
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
        }
        window.removeEventListener('devicemotion', onFirstMotion);
      };
      window.addEventListener('devicemotion', onFirstMotion);
    }
    // else: no DeviceMotionEvent API at all — toggle stays hidden

    // Show motion toggle if a gyro-capable gamepad connects later
    window.addEventListener('gamepadconnected', () => {
      if (this.toggleMotion.style.display !== 'none') return;
      if (this.input && this.input.gamepadConnected && navigator.hid) {
        this._checkGamepadGyro();
      }
    });
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
    // Restore row index for destination column (clamped); filter hidden buttons
    const colItems = this._modeColumns[newCol].filter(el => el.style.display !== 'none');
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
