// ============================================================
// LOBBY — UI controller for mode/role selection + connection
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { NetworkManager } from './network-manager.js';
import { RELAY_URL, BIKE_MODEL_PATH, TUNE, applySteeringFeel, snapshotTuningBase } from './config.js';
import { LEVELS } from './race-config.js';
import { AuthManager } from './auth.js';
import { LicenseManager } from './license.js';
import { AchievementManager, updateBadgeDisplay } from './achievements.js';

// Timeout wrapper for permission promises that may hang on iOS stale tabs
const PERMISSION_TIMEOUT_MS = 8000;
function withTimeout(promise, ms = PERMISSION_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('permission_timeout')), ms))
  ]);
}

const BIKE_NAMES = {
  default: "Grandma's Classic",
  bike_orange: 'Marmalade Express',
  bike_magenta: 'Berry Blaster',
  bike_red: 'Cherry Bomb',
  bike_blue: 'Ocean Breeze',
  bike_green: 'Jungle Cruiser',
  bike_yellow: 'Banana Delivery',
  bike_christmas: 'Christmas Cruiser',
  bike_newyears: 'New Year Rider',
  bike_birthday: 'Birthday Express',
};

const BIKE_COLORS = {
  default: 'rgba(68, 255, 102, 0.7)',
  bike_orange: '#fd892b',
  bike_magenta: '#ff61f2',
  bike_red: '#ff4444',
  bike_blue: '#66aaff',
  bike_green: '#00ff00',
  bike_yellow: '#ffff00',
  bike_christmas: '#2eff46',
  bike_newyears: '#fbff00',
  bike_birthday: '#66ff00',
};

// Map bike preset keys to their per-bike Grandma's House achievement IDs
const BIKE_ACHIEVEMENT_MAP = {
  default: 'grandma_default',
  bike_red: 'grandma_red',
  bike_blue: 'grandma_blue',
  bike_green: 'grandma_green',
  bike_yellow: 'grandma_yellow',
  bike_orange: 'grandma_orange',
  bike_magenta: 'grandma_magenta',
};

const HOLIDAY_BIKES = {
  bike_christmas: {
    requires: ['bike_green', 'bike_red'],
    hint: 'Win with Jungle Cruiser & Cherry Bomb',
  },
  bike_newyears: {
    requires: ['bike_yellow', 'default'],
    hint: 'Win with Banana Delivery & Grandma\'s Classic',
  },
  bike_birthday: {
    requires: ['bike_red', 'bike_blue', 'bike_yellow', 'bike_green', 'default'],
    hint: 'Win with Cherry Bomb, Ocean Breeze, Banana Delivery, Jungle Cruiser & Grandma\'s Classic',
  },
};

export class Lobby {
  constructor({ onSolo, onMultiplayerReady, input }) {
    this.onSolo = onSolo;
    this.onMultiplayerReady = onMultiplayerReady;
    this.input = input; // InputManager — needed for iOS motion permission
    this.net = null;
    this.selectedLevel = LEVELS.find(l => !l.isTutorial) || LEVELS[0]; // default to first non-tutorial level
    this._forceWizard = false;
    this.selectedPresetKey = 'default';
    this.selectedDifficulty = 'normal'; // 'chill' | 'normal' | 'daredevil'
    this._pendingMode = null; // 'solo' or 'multiplayer', set during level selection

    this.lobbyEl = document.getElementById('lobby');
    this.modeStep = document.getElementById('lobby-mode');
    this.levelStep = document.getElementById('lobby-level');
    this.roleStep = document.getElementById('lobby-role');
    this.hostStep = document.getElementById('lobby-host');
    this.joinStep = document.getElementById('lobby-join');
    this.roomStep = document.getElementById('lobby-room');
    this.roomLevelsStep = document.getElementById('lobby-room-levels');
    this._roomRole = null; // 'captain' | 'stoker'

    // Permission toggle buttons
    this.toggleAll = document.getElementById('toggle-all');
    this.toggleCamera = document.getElementById('toggle-camera');
    this.toggleMotion = document.getElementById('toggle-motion');
    this.toggleJoystick = document.getElementById('toggle-joystick');
    this.toggleAudio = document.getElementById('toggle-audio');
    this.toggleMusic = document.getElementById('toggle-music');
    this.toggleHelp = document.getElementById('toggle-help');
    this.helpModal = document.getElementById('help-modal');
    this.toggleProfile = document.getElementById('toggle-profile');
    this.toggleLeaderboard = document.getElementById('toggle-leaderboard');
    this.cameraActive = false;
    this.motionActive = false;
    this.joystickActive = true; // joystick steering on by default when gamepad connected
    this.audioActive = false;
    this._cameraPermitted = false;
    this._motionPermitted = false;
    this._audioPermitted = false;
    this._permissionsChecked = false;

    // Music toggle (not a permission — just on/off, persisted in localStorage)
    this.musicActive = localStorage.getItem('tandemonium_music') !== 'off';
    if (this.musicActive) this.toggleMusic.classList.add('active');
    this.onMusicChanged = null; // callback set by Game

    // Volume control (discrete levels, persisted in localStorage, default 0.18)
    const volPresets = [0, 0.10, 0.18, 0.40];
    const savedVol = localStorage.getItem('tandemonium_music_volume');
    let rawVol = savedVol !== null ? parseFloat(savedVol) : 0.18;
    // Snap to nearest preset
    this.musicVolume = volPresets.reduce((a, b) => Math.abs(b - rawVol) < Math.abs(a - rawVol) ? b : a);
    this.onVolumeChanged = null; // callback set by Game
    this._volumePicker = document.getElementById('volume-picker');
    this._volBtns = this._volumePicker.querySelectorAll('.vol-btn');
    this._longPressTimer = null;
    this._updateVolumeUI();

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

    // Gamepad code spinner state
    this._spinnerChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    this._spinnerValues = [0, 0, 0, 0]; // indices into _spinnerChars
    this._spinnerSlot = 0; // which of the 4 slots is active
    this._spinnerActive = false; // true when spinners are visible
    this._spinnerRepeatTimer = null;
    this._spinnerRepeatInterval = null;

    // Column-based navigation for mode step
    this._modeColumns = [
      [this.toggleHelp, this.toggleLeaderboard, this.toggleProfile],
      [document.getElementById('btn-together'), document.getElementById('btn-solo')],
      [this.toggleAll, this.toggleCamera, this.toggleAudio],
      [this.toggleJoystick, this.toggleMotion, this.toggleMusic],
    ];
    this._modeCol = 1;
    this._modeColIndex = [0, 0, 0, 0];

    // Per-step focusable items and back buttons
    this._stepItems = new Map();
    this._stepCenterItems = new Map(); // immutable center-column items per step
    this._stepBack = new Map();
    this._stepItems.set(this.modeStep, this._modeColumns[1]);
    this._stepCenterItems.set(this.modeStep, this._modeColumns[1]);
    const roleItems = [
      document.getElementById('btn-captain'),
      document.getElementById('btn-stoker'),
      document.getElementById('btn-back-mode'),
    ];
    this._stepItems.set(this.roleStep, roleItems);
    this._stepCenterItems.set(this.roleStep, roleItems);
    const hostItems = [
      document.getElementById('btn-back-role-host'),
    ];
    this._stepItems.set(this.hostStep, hostItems);
    this._stepCenterItems.set(this.hostStep, hostItems);
    const joinItems = [
      document.getElementById('room-code-input'),
      document.getElementById('btn-join'),
      document.getElementById('btn-back-role-join'),
    ];
    this._stepItems.set(this.joinStep, joinItems);
    this._stepCenterItems.set(this.joinStep, joinItems);
    this._stepBack.set(this.modeStep, null);
    this._stepBack.set(this.roleStep, document.getElementById('btn-back-mode'));
    this._stepBack.set(this.hostStep, document.getElementById('btn-back-role-host'));
    this._stepBack.set(this.joinStep, document.getElementById('btn-back-role-join'));

    // Fixed back button (non-gamepad, stays at bottom of steps column)
    this._fixedBackBtn = document.getElementById('lobby-fixed-back');

    // Default focus index per step (0 if not specified)
    this._stepDefaultFocus = new Map();
    this._stepDefaultFocus.set(this.modeStep, 0); // RIDE TOGETHER

    // Bike carousel state
    this.selectedPreset = null; // null = default, or preset data object
    this._presetKeys = ['default'];
    this._presetData = {};
    this._presetIndex = 0;
    this._previewRafId = null;
    this._previewModel = null;
    this._previewPivot = null;
    this._previewOriginalMats = null;

    // Leaderboard state
    this._lbVideo = null;
    this._lbMainTab = 'you';    // 'solo' | 'together' | 'you'
    this._lbSubLevel = LEVELS[0].id;
    this._achievements = new AchievementManager();
    this._avatarCache = new Map(); // originalUrl → blobUrl (fetched once per session)

    // Auth (after _avatarCache — _setupAuth triggers updateUI which reads the cache)
    this.auth = new AuthManager();
    this.license = new LicenseManager(this.auth);
    this._setupAuth();
    this._lbFocusRow = 0;   // 0 = main tabs, 1 = sub tabs, 2 = close button
    this._lbFocusCol = 0;   // index within the current row

    this._setup();
    this._buildLeaderboardTabs();
    this._initBikeCarousel();

    // Lobby is visible by default on page load (show() is only called on
    // re-entry from gameplay), so start gamepad nav now and set initial step.
    this._currentStep = this.modeStep;
    this._startGamepadNav();

    // Auto-join must run AFTER _currentStep is set so _showStep can override it
    this._checkAutoJoin();
    this._checkPermissionStates();

    // "Tap to Start" overlay — unlocks audio autoplay + requests permissions.
    // Only shown once ever; after first dismissal, localStorage flag prevents it.
    this._tapOverlay = document.getElementById('tap-to-start');
    if (this._tapOverlay) {
      if (localStorage.getItem('tandemonium_started')) {
        this._tapOverlay.remove();
        this._tapOverlay = null;
      } else {
        this._tapOverlay.addEventListener('click', () => this._dismissTapOverlay(), { once: true });
      }
    }

    // iOS stale-tab recovery: detect when tab resumes and check if
    // permissions/media tracks have been revoked by the OS.
    this._tabHiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this._tabHiddenAt = Date.now();
      } else if (document.visibilityState === 'visible') {
        this._onTabResume();
      }
    });
  }

  _dismissTapOverlay() {
    if (!this._tapOverlay) return;
    const overlay = this._tapOverlay;
    this._tapOverlay = null;
    localStorage.setItem('tandemonium_started', '1');
    // Request all permissions (reuse _toggleAll flow)
    this._toggleAll();
    // Ensure music actually starts playing — _toggleAll skips _toggleMusic
    // when musicActive is already true, so fire the callback explicitly.
    if (this.musicActive && this.onMusicChanged) {
      this.onMusicChanged(true);
    }
    // Fade out and remove
    overlay.classList.add('fade-out');
    setTimeout(() => overlay.remove(), 400);
  }

  // ── iOS stale-tab recovery ──────────────────────────────────

  _onTabResume() {
    // Only check if the tab was hidden for more than 5 seconds
    if (this._tabHiddenAt && Date.now() - this._tabHiddenAt < 5000) return;

    let stale = false;

    // Check if media tracks have been ended by the OS
    if (this.net && this.net._localMediaStream) {
      const tracks = this.net._localMediaStream.getTracks();
      for (const track of tracks) {
        if (track.readyState === 'ended') {
          stale = true;
          break;
        }
      }
    }

    // Check if permission grants have been revoked
    if (!stale && navigator.permissions) {
      const checks = [];
      if (this._cameraPermitted) {
        checks.push(
          navigator.permissions.query({ name: 'camera' }).then(r => {
            if (r.state !== 'granted') return true;
          }).catch(() => false)
        );
      }
      if (this._audioPermitted) {
        checks.push(
          navigator.permissions.query({ name: 'microphone' }).then(r => {
            if (r.state !== 'granted') return true;
          }).catch(() => false)
        );
      }
      if (checks.length > 0) {
        Promise.all(checks).then(results => {
          if (results.some(r => r)) this._showStaleOverlay();
        });
        return;
      }
    }

    // Check if motion data stopped flowing (iOS may suspend sensors)
    if (this.motionActive && this.input && this.input.motionEnabled) {
      const hadMotion = this.input.motionEnabled;
      // Wait briefly to see if motion events resume
      setTimeout(() => {
        // If rawGamma hasn't changed, sensors may be suspended
        const before = this.input.rawGamma;
        setTimeout(() => {
          if (hadMotion && this.input.rawGamma === before && this.motionActive) {
            // Sensors might be stale — don't show overlay for motion alone,
            // but reset the motion permission so re-tapping will re-request
            this._motionPermitted = false;
            this.motionActive = false;
            this.input.motionEnabled = false;
            this._setToggleActive('motion', false);
          }
        }, 500);
      }, 200);
    }

    if (stale) this._showStaleOverlay();
  }

  _showStaleOverlay() {
    // Prevent duplicate overlays
    if (document.getElementById('tap-to-start')) return;

    // Reset permission state — grants are no longer valid
    this._cameraPermitted = false;
    this._audioPermitted = false;
    this.cameraActive = false;
    this.audioActive = false;
    this._setToggleActive('camera', false);
    this._setToggleActive('audio', false);

    // Stop dead tracks
    if (this.net && this.net._localMediaStream) {
      this.net._localMediaStream.getTracks().forEach(t => t.stop());
    }

    // Create the overlay (reuses tap-to-start styling)
    const overlay = document.createElement('div');
    overlay.id = 'tap-to-start';
    overlay.innerHTML = `<div class="tap-to-start-content">
      <p>Permissions expired</p>
      <p style="font-size:16px;opacity:0.6;margin-top:8px;">Tap to retry</p>
    </div>`;
    document.body.appendChild(overlay);
    this._tapOverlay = overlay;

    const dismiss = () => {
      if (!this._tapOverlay) return;
      this._tapOverlay = null;
      // Re-request all permissions (user gesture required on iOS)
      this._permissionsChecked = false;
      this._toggleAll();
      // Fade out
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 400);
    };

    overlay.addEventListener('click', dismiss, { once: true });
  }

  show() {
    this.lobbyEl.style.display = '';
    // Rebuild level cards to reflect newly unlocked levels
    this._rebuildLevelCards();
    this._showStep(this.modeStep);
    this._startGamepadNav();
    this._checkPermissionStates();
    if (this._previewModel) this._startPreviewLoop();
  }

  _showStep(step) {
    // Restore toggle columns and clean up spinners if leaving join step
    if (this._currentStep === this.joinStep && step !== this.joinStep) {
      this._lastFailedCode = null;
      this._spinnerStopRepeat();
      if (this._spinnerActive) this._showSpinners(false);
      const leftCol = document.querySelector('.lobby-left-col');
      const rightCol = document.querySelector('.lobby-right-col');
      if (leftCol) leftCol.style.display = '';
      if (rightCol) rightCol.style.display = '';
      const backHint = document.getElementById('gamepad-back-hint');
      if (backHint) { backHint.style.display = ''; backHint.style.visibility = ''; }
    }
    [this.modeStep, this.levelStep, this.roleStep, this.hostStep, this.joinStep, this.roomStep, this.roomLevelsStep]
      .forEach(s => s.style.display = 'none');
    step.style.display = 'flex';
    this._clearFocusHighlight();
    this._currentStep = step;

    // Hide toggle columns and gamepad back hint on join step
    if (step === this.joinStep) {
      const leftCol = document.querySelector('.lobby-left-col');
      const rightCol = document.querySelector('.lobby-right-col');
      if (leftCol) leftCol.style.display = 'none';
      if (rightCol) rightCol.style.display = 'none';
      const backHint = document.getElementById('gamepad-back-hint');
      if (backHint) { backHint.style.display = 'none'; backHint.style.visibility = 'hidden'; }
    }

    // Hide bike carousel on level step (use that space for level cards + difficulty)
    const carousel = document.getElementById('bike-carousel');
    const lobbyCard = document.querySelector('.lobby-card');
    const hideCarousel = (step === this.levelStep) || (step === this.roomLevelsStep);
    if (carousel) carousel.style.display = hideCarousel ? 'none' : '';
    if (lobbyCard) lobbyCard.classList.toggle('carousel-hidden', hideCarousel);
    const lobbyEl = document.getElementById('lobby');
    if (lobbyEl) lobbyEl.classList.toggle('lobby-wide', hideCarousel);

    // Show shared difficulty selector on level and room steps (captain only for room)
    const diffSel = document.getElementById('difficulty-selector');
    const showDiff = (step === this.levelStep) || (step === this.roomLevelsStep);
    if (diffSel) diffSel.style.display = showDiff ? '' : 'none';

    // Show/hide fixed back button at bottom (use visibility to always reserve space)
    const hasBack = this._stepBack.get(step);
    if (hasBack && !(this.input && this.input.gamepadConnected)) {
      this._fixedBackBtn.textContent = (step === this.roomStep) ? '\u2190 Leave Room' : '\u2190 Back';
      this._fixedBackBtn.style.visibility = 'visible';
    } else {
      this._fixedBackBtn.style.visibility = 'hidden';
    }

    // Always reset to center column and update its items
    this._modeCol = 1;
    this._modeColIndex = [0, 0, 0, 0];
    const centerItems = this._stepCenterItems.get(step) || [];
    this._modeColumns[1] = centerItems;
    this._stepItems.set(step, centerItems);

    this._focusIndex = this._stepDefaultFocus.get(step) || 0;
    this._applyFocusHighlight();
    this._updateBackHint(step);
    this._updateCardHeader(step);
  }

  _hideLobby() {
    this.lobbyEl.style.display = 'none';
    this._stopGamepadNav();
    this._stopPreviewLoop();
  }

  _setup() {
    // SOLO → level/difficulty selection (demo users see levels but can only play Grandma's House)
    document.getElementById('btn-solo').addEventListener('click', () => {
      this._requestMotion();
      this._pendingMode = 'solo';
      this._showStep(this.levelStep);
    });

    // RIDE TOGETHER → check for rejoin, then role selection
    document.getElementById('btn-together').addEventListener('click', async () => {
      if (!this.auth.isLoggedIn()) {
        this.auth.login();
        return;
      }
      // Check for saved room to rejoin
      const rejoined = await this._handleRejoinCheck();
      if (rejoined) return;

      this._requestMotion();
      this._pendingMode = 'multiplayer';
      this._updateRoleButtons();
      this._showStep(this.roleStep);
    });

    // Level selection: build cards and handle clicks
    this._buildLevelCards();
    this._setupDifficultySelector();

    // "Learn to Ride" tutorial button
    document.getElementById('btn-tutorial').addEventListener('click', () => {
      this._forceWizard = true;
      this._hideLobby();
      this.onSolo();
    });

    document.getElementById('btn-back-level').addEventListener('click', () => {
      this._showStep(this.modeStep);
    });

    // Back buttons
    document.getElementById('btn-back-mode').addEventListener('click', () => {
      this._showStep(this.modeStep);
    });
    document.getElementById('btn-back-role-host').addEventListener('click', () => {
      this._clearRoom();
      if (this.net) { this.net.destroy(); this.net = null; }
      document.getElementById('room-code-display').textContent = '----';
      document.getElementById('room-qr').innerHTML = '';
      this._showStep(this.roleStep);
    });
    document.getElementById('btn-back-role-join').addEventListener('click', () => {
      this._clearRoom();
      if (this.net) { this.net.destroy(); this.net = null; }
      this._showSpinners(false);
      this._spinnerStopRepeat();
      this._showStep(this.roleStep);
    });

    // Fixed back button delegates to the per-step back button
    this._fixedBackBtn.addEventListener('click', () => {
      const stepBackBtn = this._stepBack.get(this._currentStep);
      if (stepBackBtn) stepBackBtn.click();
    });

    // CAPTAIN (START A RIDE) — locked for unlicensed, acts as purchase CTA
    document.getElementById('btn-captain').addEventListener('click', async () => {
      if (!this.license.isLicensed) {
        try {
          const url = await this.license.startCheckout('tandemonium-web-early');
          window.location.href = url;
        } catch (e) {
          console.error('Checkout error', e);
        }
        return;
      }
      this._showStep(this.hostStep);
      this._createRoom();
    });

    // STOKER (JOIN A RIDE)
    document.getElementById('btn-stoker').addEventListener('click', () => {
      this._showStep(this.joinStep);
      if (this.input && this.input.gamepadConnected) {
        this._showSpinners(true);
      } else {
        this._showSpinners(false);
        document.getElementById('room-code-input').focus();
      }
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

    // Room step: PLAY GAME button (captain only)
    document.getElementById('btn-play-game').addEventListener('click', () => {
      if (this._roomRole !== 'captain') return;
      if (this.net && this.net.connected) {
        this.net.sendProfile({ type: 'playGame' });
        this.net.sendProfile({ type: 'difficultySync', difficulty: this.selectedDifficulty });
      }
      this._showRoomLevelsStep();
    });

    // Levels step: START RIDE button (captain only)
    document.getElementById('btn-start-ride').addEventListener('click', () => {
      if (this._roomRole !== 'captain') return;
      // Send start ride to partner
      if (this.net && this.net.connected) {
        this.net.sendProfile({ type: 'startRide' });
      }
      this._transitionToGame();
    });

    // Levels step: Back button → return to Room
    document.getElementById('btn-back-room-levels').addEventListener('click', () => {
      this._showStep(this.roomStep);
    });

    document.getElementById('btn-back-room').addEventListener('click', () => {
      // Leave room — destroy connection, return to role step
      if (this.net) { this.net.destroy(); this.net = null; }
      this._removePipLobbyMode();
      // Stop selfie video
      const selfieVideo = document.getElementById('selfie-pip');
      if (selfieVideo) selfieVideo.srcObject = null;
      const selfieWrap = document.getElementById('selfie-pip-wrap');
      if (selfieWrap) selfieWrap.style.display = 'none';
      const partnerVideo = document.getElementById('partner-pip');
      if (partnerVideo) partnerVideo.srcObject = null;
      const partnerWrap = document.getElementById('partner-pip-wrap');
      if (partnerWrap) partnerWrap.style.display = 'none';
      this._showStep(this.roleStep);
    });

    // Permission toggles
    this.toggleAll.addEventListener('click', () => this._toggleAll());
    this.toggleCamera.addEventListener('click', () => this._toggleCamera());
    this.toggleMotion.addEventListener('click', () => this._toggleMotion());
    this.toggleJoystick.addEventListener('click', () => this._toggleJoystick());
    this.toggleAudio.addEventListener('click', () => this._toggleAudio());
    // Music toggle: tap = mute/unmute, long press (500ms) = show volume slider
    this._musicLongPressed = false;
    this.toggleMusic.addEventListener('pointerdown', (e) => {
      this._musicLongPressed = false;
      this._longPressTimer = setTimeout(() => {
        this._musicLongPressed = true;
        this._showVolumePicker();
      }, 500);
    });
    this.toggleMusic.addEventListener('pointerup', () => {
      clearTimeout(this._longPressTimer);
      if (!this._musicLongPressed) this._toggleMusic();
    });
    this.toggleMusic.addEventListener('pointerleave', () => {
      clearTimeout(this._longPressTimer);
    });
    this.toggleMusic.addEventListener('pointercancel', () => {
      clearTimeout(this._longPressTimer);
    });
    // Gamepad A-button fires .click() not pointerdown/pointerup — handle it
    this.toggleMusic.addEventListener('click', () => {
      if (!this._musicLongPressed) this._toggleMusic();
    });
    // Volume picker buttons
    for (const btn of this._volBtns) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const vol = parseFloat(btn.dataset.vol);
        this.musicVolume = vol;
        localStorage.setItem('tandemonium_music_volume', vol);
        // Apply volume BEFORE toggling so playback starts at correct level
        if (this.onVolumeChanged) this.onVolumeChanged(vol);
        // Sync mute state with volume
        if (vol === 0 && this.musicActive) {
          this._toggleMusic();
        } else if (vol > 0 && !this.musicActive) {
          this._toggleMusic();
        }
        this._updateVolumeUI();
        this._hideVolumePicker();
      });
    }
    // Dismiss picker when clicking outside
    document.addEventListener('pointerdown', (e) => {
      if (this._volumePicker.classList.contains('visible') &&
          !this._volumePicker.contains(e.target) &&
          e.target !== this.toggleMusic &&
          !this.toggleMusic.contains(e.target)) {
        this._hideVolumePicker();
      }
    });
    this.toggleHelp.addEventListener('click', () => this._openHelp());
    this.toggleProfile.addEventListener('click', () => this._toggleProfile());
    this.toggleLeaderboard.addEventListener('click', () => this._openLeaderboard());
  }

  _buildLevelCards() {
    const container = document.getElementById('level-cards');
    const buttons = [];
    const isDemo = !this.license.isLicensed;

    // Level unlock requirements: achievement ID needed to unlock each level
    const LEVEL_UNLOCK = { castle: 'home_sweet' }; // Castle requires finishing Grandma's House

    LEVELS.filter(l => !l.isTutorial).forEach(level => {
      const requiredAch = LEVEL_UNLOCK[level.id];
      const achievementLocked = requiredAch && !this._achievements.getEarnedIds().includes(requiredAch);
      const locked = achievementLocked || (isDemo && level.id !== 'grandma');

      const card = document.createElement('button');
      card.className = 'level-card' + (locked ? ' level-locked' : '');
      card.dataset.levelId = level.id;

      if (locked) {
        const lockReason = isDemo && !achievementLocked
          ? 'Get the full game to unlock'
          : 'Complete Grandma\'s House to unlock';
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">&#x1F512;</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' + lockReason + '</div>';
        card.disabled = true;
      } else {
        const demoTag = isDemo ? ' <span class="demo-tag">DEMO</span>' : '';
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">' + level.icon + '</span>' +
            '<span class="level-card-name">' + level.name + demoTag + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' + level.description + '</div>';
        card.addEventListener('click', () => {
          this.selectedLevel = level;
          if (this._pendingMode === 'solo') {
            this._hideLobby();
            this.onSolo();
          } else {
            this._showStep(this.roleStep);
          }
        });
      }

      container.appendChild(card);
      if (!locked) buttons.push(card);
    });

    // Tutorial button sits between level cards and difficulty
    const tutBtn = document.getElementById('btn-tutorial');
    if (tutBtn) buttons.push(tutBtn);

    // Add individual difficulty buttons to gamepad navigation
    const diffBtns = document.querySelectorAll('#difficulty-selector .difficulty-btn');
    diffBtns.forEach(b => buttons.push(b));

    // Register for gamepad navigation
    buttons.push(document.getElementById('btn-back-level'));
    this._stepItems.set(this.levelStep, buttons);
    this._stepCenterItems.set(this.levelStep, buttons);
    this._stepBack.set(this.levelStep, document.getElementById('btn-back-level'));
  }

  _rebuildLevelCards() {
    const container = document.getElementById('level-cards');
    container.innerHTML = '';
    this._buildLevelCards();
  }

  _setupDifficultySelector() {
    // Wire up both difficulty selectors (solo level step + room step)
    document.querySelectorAll('.difficulty-selector').forEach(selector => {
      const btns = selector.querySelectorAll('.difficulty-btn');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          // Sync both selectors
          document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
          document.querySelectorAll('.difficulty-btn[data-difficulty="' + btn.dataset.difficulty + '"]')
            .forEach(b => b.classList.add('selected'));
          this.selectedDifficulty = btn.dataset.difficulty;
          // Sync difficulty to partner in multiplayer
          if (this.net && this.net.connected) {
            this.net.sendProfile({ type: 'difficultySync', difficulty: btn.dataset.difficulty });
          }
        });
      });
    });
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
        this.toggleLeaderboard.classList.add('active');
        popupAvatar.src = user.avatar || '';
        popupName.textContent = user.name || '';
        popupEmail.textContent = user.email || '';
        if (user.avatar) {
          const cachedAvatar = this._avatarCache.get(user.avatar) || user.avatar;
          this.toggleProfile.innerHTML = '<img src="' + cachedAvatar + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">';
          // Fire-and-forget: fetch and upgrade to blob URL
          if (!this._avatarCache.has(user.avatar)) {
            this._cacheAvatarUrl(user.avatar).then(() => {
              const blobUrl = this._avatarCache.get(user.avatar);
              if (blobUrl && blobUrl !== user.avatar) {
                const img = this.toggleProfile.querySelector('img');
                if (img) img.src = blobUrl;
              }
            });
          }
        }
      } else {
        this.toggleProfile.classList.remove('active');
        this.toggleLeaderboard.classList.remove('active');
        this.toggleProfile.innerHTML = profileSvg;
        this.profilePopup.classList.remove('visible');
      }
    };

    this.auth.onLogin(async (user) => {
      updateUI(user);
      this.profilePopup.classList.remove('visible');
      // Check license and update mode buttons + level cards
      await this.license.check();
      this._updateModeButtons();
      this._rebuildLevelCards();
      // Fetch server-side achievements (D1 is source of truth for logged-in users)
      try {
        const me = await this.auth.getMe();
        if (me && me.achievements) {
          this._achievements.mergeFromServer(
            me.achievements.map(a => ({ id: a.achievement_id, earnedAt: a.earned_at }))
          );
        }
      } catch (e) {
        console.warn('Failed to fetch server achievements on login', e);
      }

      // Resume auto-join if user arrived via shared URL before logging in
      if (this._pendingAutoJoinCode) {
        const code = this._pendingAutoJoinCode;
        this._pendingAutoJoinCode = null;
        this._showStep(this.joinStep);
        const suffix = code.slice(-4);
        document.getElementById('room-code-input').value = suffix;
        this._lastFailedCode = code;
        this._joinRoom(code);
      }

      // Resume room creation after login / auth refresh
      if (this._pendingCreateRoom) {
        this._pendingCreateRoom = false;
        if (this.auth.token) {
          this._showStep(this.hostStep);
          this._createRoom();
        } else {
          // Login succeeded but server token exchange failed — show on host step
          this._showStep(this.hostStep);
          const statusEl = document.getElementById('host-status');
          statusEl.textContent = (this.auth.lastAuthError || 'Server auth failed') + ' — please reload';
          statusEl.className = 'conn-status error';
        }
      }
    });

    // Logout: sync achievements to server, then clear local state
    logoutBtn.addEventListener('click', async () => {
      // Push local achievements to server before clearing
      const ids = this._achievements.getEarnedIds();
      if (ids.length > 0) {
        try { await this.auth.syncAchievements(ids); } catch (e) {}
      }
      this._achievements.clear();
      this.license.clear();
      this.auth.logout();
      updateUI(null);
      this._updateModeButtons();
      this._rebuildLevelCards();
    });

    // Back buttons close the popup
    document.getElementById('profile-popup-back').addEventListener('click', () => {
      this.profilePopup.classList.remove('visible');
    });
    document.getElementById('profile-popup-signin-back').addEventListener('click', () => {
      this.profilePopup.classList.remove('visible');
    });

    // Profile popup gamepad focus index (0 = logout/sign-in, 1 = back)
    this._profileFocusIndex = 0;

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.profilePopup.classList.contains('visible')) return;
      if (this.profilePopup.contains(e.target)) return;
      if (this.toggleProfile.contains(e.target)) return;
      this.profilePopup.classList.remove('visible');
    });

    // Leaderboard close
    document.getElementById('leaderboard-close').addEventListener('click', () => this._closeLeaderboard());
    document.getElementById('leaderboard-x').addEventListener('click', () => this._closeLeaderboard());
    document.getElementById('leaderboard-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this._closeLeaderboard();
    });

    // Restore UI if already logged in from localStorage
    if (this.auth.isLoggedIn()) {
      updateUI(this.auth.getUser());
      // Check license and update mode buttons + level cards
      this.license.check().then(() => {
        this._updateModeButtons();
        this._rebuildLevelCards();
      }).catch(() => {});
      // Sync achievements from D1 for returning users
      this.auth.getMe().then(me => {
        if (me && me.achievements) {
          this._achievements.mergeFromServer(
            me.achievements.map(a => ({ id: a.achievement_id, earnedAt: a.earned_at }))
          );
        }
      }).catch(() => {});
    }
    this._updateModeButtons();
  }

  _requestMotion() {
    if (this.input && this.input.needsMotionPermission) {
      this.input.requestMotionPermission();
    }
  }

  /**
   * Update mode buttons based on auth + license state.
   *   anonymous  → SOLO DEMO only
   *   free       → RIDE TOGETHER (join only) + SOLO DEMO
   *   licensed   → RIDE TOGETHER + SOLO RIDE
   */
  _updateModeButtons() {
    const btnSolo = document.getElementById('btn-solo');
    const btnTogether = document.getElementById('btn-together');
    const access = this.license.accessLevel;

    if (access === 'licensed') {
      btnSolo.textContent = 'SOLO RIDE';
      btnTogether.classList.remove('role-locked');
      btnTogether.innerHTML = 'RIDE TOGETHER';
    } else if (access === 'free') {
      btnSolo.textContent = 'SOLO DEMO';
      btnTogether.classList.remove('role-locked');
      btnTogether.innerHTML = 'RIDE TOGETHER';
    } else {
      // anonymous — show but locked
      btnSolo.textContent = 'SOLO DEMO';
      btnTogether.classList.add('role-locked');
      btnTogether.innerHTML = '&#x1F512; RIDE TOGETHER<br><span class="lobby-role-desc">Sign in to ride together</span>';
    }
  }

  /**
   * Update role buttons: lock START A RIDE for unlicensed users.
   */
  _updateRoleButtons() {
    const btnCaptain = document.getElementById('btn-captain');
    if (!this.license.isLicensed) {
      btnCaptain.classList.add('role-locked');
      btnCaptain.classList.remove('lobby-btn-accent');
      btnCaptain.innerHTML = '&#x1F512; START A RIDE<br><span class="lobby-role-desc">Get the full game to be Captain &middot; $5.99</span>';
    } else {
      btnCaptain.classList.remove('role-locked');
      btnCaptain.classList.add('lobby-btn-accent');
      btnCaptain.innerHTML = 'START A RIDE<br><span class="lobby-role-desc">Captain &middot; Front seat</span>';
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
      withTimeout(navigator.mediaDevices.getUserMedia(constraints)).then(stream => {
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
      }).catch((err) => {
        if (err && err.message === 'permission_timeout') {
          this._showStaleOverlay();
          return;
        }
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

    // Update motion toggle icon: gamepad gyro vs phone tilt
    const svg = document.getElementById('motion-icon-svg');
    if (svg) {
      const isGamepad = this.input && this.input.gamepadConnected;
      if (isGamepad) {
        // Gamepad with tilt waves — represents controller gyro
        svg.innerHTML =
          '<rect x="3" y="6" width="14" height="9" rx="2"/>' +
          '<circle cx="7" cy="10.5" r="1.5" fill="currentColor" stroke="none"/>' +
          '<line x1="11" y1="9" x2="13" y2="9"/>' +
          '<line x1="12" y1="8" x2="12" y2="10"/>' +
          '<path d="M4 4c-1 0.5-1 1.5 0 2" opacity="0.6"/>' +
          '<path d="M16 4c1 0.5 1 1.5 0 2" opacity="0.6"/>';
      } else {
        // Phone with tilt waves — represents mobile tilt
        svg.innerHTML =
          '<rect x="6" y="2" width="8" height="16" rx="2"/>' +
          '<circle cx="10" cy="14" r="1" fill="currentColor" stroke="none"/>' +
          '<path d="M3 6c-1 1.5-1 3.5 0 5" opacity="0.6"/>' +
          '<path d="M17 6c1 1.5 1 3.5 0 5" opacity="0.6"/>';
      }
    }

    // Show joystick toggle when gamepad is connected
    if (this.input && this.input.gamepadConnected) {
      this.toggleJoystick.style.display = '';
      // Load persisted joystick preference
      try {
        const saved = localStorage.getItem('tandemonium_joystick');
        if (saved === 'off') {
          this.joystickActive = false;
          if (this.input) this.input.suppressGamepadLean = true;
        }
      } catch {}
      this._setToggleActive('joystick', this.joystickActive);
    }

    // Show "Learn to Ride" tutorial button on level select with input-appropriate icon
    const tutBtn = document.getElementById('btn-tutorial');
    if (tutBtn) {
      tutBtn.style.display = '';
      const isGyro = this.input && this.input.gyroConnected;
      const icon = (this.input && this.input.gamepadConnected) ? '\uD83C\uDFAE' : '\uD83D\uDCF1'; // 🎮 or 📱
      tutBtn.textContent = icon + (isGyro ? ' Learn to Ride with Gyro' : ' Learn to Ride');
    }
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
      this._applyVideoTrackState(false);
      // Notify partner to show avatar
      if (this.net && this.net.connected) {
        const msg = { type: 'cameraToggle', enabled: false };
        const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
        if (user && user.avatar) msg.avatar = user.avatar;
        this.net.sendProfile(msg);
      }
      return;
    }
    if (this._cameraPermitted) {
      this.cameraActive = true;
      this._setToggleActive('camera', true);
      // If we're in the room but have no video track yet, acquire it now
      if (this.net && !this.net._localMediaStream?.getVideoTracks().length) {
        this._acquireAndShowCamera();
      } else {
        this._applyVideoTrackState(true);
      }
      // Notify partner to show video
      if (this.net && this.net.connected) {
        this.net.sendProfile({ type: 'cameraToggle', enabled: true });
      }
      return;
    }
    withTimeout(navigator.mediaDevices.getUserMedia({ video: true })).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      this._cameraPermitted = true;
      this.cameraActive = true;
      this._setToggleActive('camera', true);
      // If in the room, acquire the real track and show it
      if (this.net && !this.net._localMediaStream?.getVideoTracks().length) {
        this._acquireAndShowCamera();
      } else {
        this._applyVideoTrackState(true);
      }
      // Notify partner to show video
      if (this.net && this.net.connected) {
        this.net.sendProfile({ type: 'cameraToggle', enabled: true });
      }
    }).catch((err) => {
      if (err && err.message === 'permission_timeout') this._showStaleOverlay();
    });
  }

  async _acquireAndShowCamera() {
    if (!this.net) return;
    await this.net.acquireLocalMedia(true, this._audioPermitted);
    if (!this.net._localMediaStream) return;
    const videoTrack = this.net._localMediaStream.getVideoTracks()[0];
    if (videoTrack) videoTrack.enabled = true;
    // Wire up the selfie PiP
    const selfieVideo = document.getElementById('selfie-pip');
    const selfieAvatar = document.getElementById('selfie-pip-avatar');
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    if (selfieVideo) {
      selfieVideo.srcObject = this.net._localMediaStream;
      selfieVideo.style.display = 'block';
      selfieVideo.play().catch(() => {});
    }
    if (selfieAvatar) selfieAvatar.style.display = 'none';
    if (selfieWrap) selfieWrap.style.display = 'block';
    // Re-initiate media call so partner gets the video
    if (this.net.transport === 'p2p') {
      this.net.initiateCall();
    } else {
      // P2P not up yet — initiate when upgrade completes
      const prevOnP2P = this.net.onP2PUpgrade;
      this.net.onP2PUpgrade = () => {
        this.net.initiateCall();
        if (prevOnP2P) prevOnP2P();
      };
    }
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
        this.input.startTiltCalibration();
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

    // Mobile: if already permitted, show recalibrate popup
    if (this._motionPermitted) {
      this._showRecalPopup();
      return;
    }
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

  _toggleJoystick() {
    this.joystickActive = !this.joystickActive;
    this._setToggleActive('joystick', this.joystickActive);
    if (this.input) {
      this.input.suppressGamepadLean = !this.joystickActive;
    }
    // Persist choice
    try {
      localStorage.setItem('tandemonium_joystick', this.joystickActive ? 'on' : 'off');
    } catch {}
  }

  _showRecalPopup() {
    const popup = document.getElementById('motion-recal-popup');
    popup.classList.add('visible');

    // Load current feel value into slider
    const slider = document.getElementById('lobby-feel-slider');
    const currentFeel = TUNE.steeringFeel != null ? TUNE.steeringFeel : 0.5;
    slider.value = Math.round(currentFeel * 100);
    slider.oninput = () => {
      const feel = slider.value / 100;
      applySteeringFeel(feel);
      // Save immediately
      try {
        const saved = localStorage.getItem('tandemonium_motion_tuning');
        if (saved) {
          const data = JSON.parse(saved);
          data.steeringFeel = feel;
          localStorage.setItem('tandemonium_motion_tuning', JSON.stringify(data));
        }
      } catch {}
    };

    const dismiss = () => {
      popup.classList.remove('visible');
      document.removeEventListener('click', outsideClick, true);
    };

    document.getElementById('btn-recalibrate').onclick = () => {
      try { localStorage.removeItem('tandemonium_motion_tuning'); } catch {}
      this._forceWizard = true;
      dismiss();
    };
    document.getElementById('btn-recal-cancel').onclick = dismiss;

    // Click outside to dismiss
    const outsideClick = (e) => {
      if (!popup.contains(e.target) && e.target.id !== 'toggle-motion') {
        dismiss();
      }
    };
    // Defer to avoid immediate trigger
    setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
  }

  _toggleAudio() {
    if (this.audioActive) {
      this.audioActive = false;
      this._setToggleActive('audio', false);
      this._applyAudioTrackState(false);
      return;
    }
    if (this._audioPermitted) {
      this.audioActive = true;
      this._setToggleActive('audio', true);
      this._applyAudioTrackState(true);
      return;
    }
    withTimeout(navigator.mediaDevices.getUserMedia({ audio: true })).then(stream => {
      stream.getTracks().forEach(t => t.stop());
      this._audioPermitted = true;
      this.audioActive = true;
      this._setToggleActive('audio', true);
      this._applyAudioTrackState(true);
    }).catch((err) => {
      if (err && err.message === 'permission_timeout') this._showStaleOverlay();
    });
  }

  _setToggleActive(name, active) {
    const el = name === 'camera' ? this.toggleCamera
             : name === 'motion' ? this.toggleMotion
             : name === 'joystick' ? this.toggleJoystick
             : name === 'music'  ? this.toggleMusic
             : this.toggleAudio;
    if (active) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
    this._updateAllToggle();
  }

  _applyVideoTrackState(enabled) {
    if (!this.net || !this.net._localMediaStream) return;
    const track = this.net._localMediaStream.getVideoTracks()[0];
    if (track) track.enabled = enabled;
    const selfieVideo = document.getElementById('selfie-pip');
    const selfieAvatar = document.getElementById('selfie-pip-avatar');
    if (enabled && track) {
      if (selfieVideo) {
        selfieVideo.style.display = 'block';
        selfieVideo.play().catch(() => {});
      }
      if (selfieAvatar) selfieAvatar.style.display = 'none';
    } else {
      if (selfieVideo) selfieVideo.style.display = 'none';
      if (selfieAvatar && this.auth && this.auth.isLoggedIn()) {
        const user = this.auth.getUser();
        if (user && user.avatar) {
          selfieAvatar.src = this._avatarCache.get(user.avatar) || user.avatar;
          selfieAvatar.style.display = 'block';
        }
      }
    }
  }

  _applyAudioTrackState(enabled) {
    if (!this.net || !this.net._localMediaStream) return;
    const track = this.net._localMediaStream.getAudioTracks()[0];
    if (track) track.enabled = enabled;
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

  _showVolumePicker() {
    this._updateVolumeUI();
    this._volumePicker.classList.add('visible');
  }

  _hideVolumePicker() {
    this._volumePicker.classList.remove('visible');
  }

  _updateVolumeUI() {
    for (const btn of this._volBtns) {
      const vol = parseFloat(btn.dataset.vol);
      btn.classList.toggle('active', vol === this.musicVolume);
    }
  }

  _openHelp() {
    this.helpModal.classList.add('visible');
  }

  _closeHelp() {
    this.helpModal.classList.remove('visible');
  }

  _closeLeaderboard() {
    this._stopLeaderboardVideo();
    this._lbClearFocus();
    document.getElementById('leaderboard-modal').style.display = 'none';
  }

  _lbGetRowItems(row) {
    if (row === 0) return [...document.getElementById('lb-main-tabs').querySelectorAll('.lb-tab')];
    if (row === 1) return [...document.getElementById('lb-sub-tabs').querySelectorAll('.lb-tab')];
    if (row === 2) return [document.getElementById('leaderboard-close')];
    return [];
  }

  _lbClearFocus() {
    document.querySelectorAll('#leaderboard-modal .gamepad-focus').forEach(el => el.classList.remove('gamepad-focus'));
  }

  _lbApplyFocus() {
    this._lbClearFocus();
    const items = this._lbGetRowItems(this._lbFocusRow);
    const idx = Math.min(this._lbFocusCol, items.length - 1);
    if (items[idx]) items[idx].classList.add('gamepad-focus');
  }

  _lbResetFocus() {
    // Default: focus the active main tab
    this._lbFocusRow = 0;
    const mainTabs = document.getElementById('lb-main-tabs').querySelectorAll('.lb-tab');
    this._lbFocusCol = [...mainTabs].findIndex(t => t.classList.contains('active'));
    if (this._lbFocusCol < 0) this._lbFocusCol = 0;
    this._lbApplyFocus();
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
    // Reset gamepad focus for profile popup
    if (this.profilePopup.classList.contains('visible')) {
      this._profileFocusIndex = 0;
      // Apply initial highlight
      const items = this.auth.isLoggedIn()
        ? [document.getElementById('profile-popup-logout'), document.getElementById('profile-popup-back')]
        : [document.getElementById('profile-popup-signin-back')];
      items.forEach(el => el.classList.remove('gamepad-focus'));
      items[0].classList.add('gamepad-focus');
    } else {
      // Clear highlights on close
      this.profilePopup.querySelectorAll('.gamepad-focus').forEach(el => el.classList.remove('gamepad-focus'));
    }
  }

  _buildLeaderboardTabs() {
    const mainContainer = document.getElementById('lb-main-tabs');
    const tabs = [
      { id: 'solo', label: 'Solo' },
      { id: 'together', label: 'Together' },
      { id: 'you', label: 'You' },
      { id: 'partners', label: 'Partners' }
    ];
    tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className = 'lb-tab' + (tab.id === this._lbMainTab ? ' active' : '');
      btn.textContent = tab.label;
      btn.dataset.tabId = tab.id;
      btn.addEventListener('click', () => {
        mainContainer.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        this._lbMainTab = tab.id;
        this._buildSubTabs();
        this._renderLeaderboardContent();
      });
      mainContainer.appendChild(btn);
    });
  }

  _buildSubTabs() {
    const container = document.getElementById('lb-sub-tabs');
    container.innerHTML = '';
    if (this._lbMainTab === 'partners') {
      this._stopLeaderboardVideo();
      document.getElementById('leaderboard-video').style.display = 'none';
      return;
    }
    document.getElementById('leaderboard-video').style.display = '';
    LEVELS.forEach(level => {
      const btn = document.createElement('button');
      btn.className = 'lb-tab' + (level.id === this._lbSubLevel ? ' active' : '');
      btn.textContent = level.icon + ' ' + level.name;
      btn.dataset.levelId = level.id;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        this._lbSubLevel = level.id;
        this._startLeaderboardVideo(level.id);
        this._renderLeaderboardContent();
      });
      container.appendChild(btn);
    });
  }

  async _openLeaderboard() {
    const modal = document.getElementById('leaderboard-modal');
    this._lbSubLevel = this.selectedLevel ? this.selectedLevel.id : 'grandma';

    // Reset main tabs active state
    const mainTabs = document.getElementById('lb-main-tabs');
    mainTabs.querySelectorAll('.lb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tabId === this._lbMainTab);
    });

    this._buildSubTabs();

    const level = LEVELS.find(l => l.id === this._lbSubLevel) || LEVELS[0];
    document.getElementById('leaderboard-title').textContent = 'Leaderboard';

    modal.style.display = '';
    if (this._lbMainTab !== 'partners') {
      this._startLeaderboardVideo(this._lbSubLevel);
    }
    this._renderLeaderboardContent();
    this._lbResetFocus();
  }

  async _renderLeaderboardContent() {
    const list = document.getElementById('leaderboard-list');
    const achDiv = document.getElementById('lb-achievements');
    const levelId = this._lbSubLevel;
    const level = LEVELS.find(l => l.id === levelId) || LEVELS[0];

    if (this._lbMainTab === 'you') {
      // Show achievements + personal rides
      document.getElementById('leaderboard-title').textContent = 'Your Rides';
      this._renderAchievements();
      list.innerHTML = '<div class="lb-no-data">Loading...</div>';

      try {
        const myId = this.auth.user ? this.auth.user.serverId : null;
        if (!myId) {
          list.innerHTML = '<div class="lb-no-data">Sign in to see your rides</div>';
          return;
        }

        const data = await this.auth.getLeaderboard(levelId, null, null, { userId: 'me' });
        const entries = data.entries || [];

        if (entries.length === 0) {
          list.innerHTML = '<div class="lb-no-data">No rides yet</div>';
          return;
        }

        await this._cacheAvatarUrls(entries.map(e => e.avatar_url));
        list.innerHTML = this._renderEntries(entries, level, myId);
      } catch (e) {
        list.innerHTML = '<div class="lb-no-data">Could not load rides</div>';
      }
    } else if (this._lbMainTab === 'partners') {
      document.getElementById('leaderboard-title').textContent = 'Partners';
      achDiv.innerHTML = '';
      list.innerHTML = '<div class="lb-no-data">Loading...</div>';

      try {
        if (!this.auth.user) {
          list.innerHTML = '<div class="lb-no-data">Sign in to see partners</div>';
          return;
        }
        const data = await this.auth.getPartners();
        const partners = data.partners || [];

        if (partners.length === 0) {
          list.innerHTML = '<div class="lb-no-data">Play together to find partners!</div>';
          return;
        }

        await this._cacheAvatarUrls(partners.map(p => p.avatar_url));
        list.innerHTML = this._renderPartners(partners);
      } catch (e) {
        list.innerHTML = '<div class="lb-no-data">Could not load partners</div>';
      }
    } else {
      // SOLO or TOGETHER — hide achievements, show filtered leaderboard
      document.getElementById('leaderboard-title').textContent = 'Leaderboard';
      achDiv.innerHTML = '';
      list.innerHTML = '<div class="lb-no-data">Loading...</div>';

      try {
        const mode = this._lbMainTab === 'solo' ? 'solo' : 'together';
        const data = await this.auth.getLeaderboard(levelId, null, null, { mode });
        const entries = data.entries || [];
        const myId = this.auth.user ? this.auth.user.serverId : null;

        if (entries.length === 0) {
          list.innerHTML = '<div class="lb-no-data">No scores yet</div>';
          return;
        }

        await this._cacheAvatarUrls(entries.map(e => e.avatar_url));
        list.innerHTML = this._renderEntries(entries, level, myId);
      } catch (e) {
        list.innerHTML = '<div class="lb-no-data">Could not load leaderboard</div>';
      }
    }
  }

  _renderEntries(entries, level, myId) {
    const collectibleEmoji = level.collectibles === 'gems' ? '\uD83D\uDC8E' : '\uD83C\uDF81';

    return entries.map((e, i) => {
      const isYou = myId && e.user_id === myId;
      const youClass = isYou ? ' lb-you' : '';
      const youTag = isYou ? '<span class="lb-you-tag">You</span>' : '';

      const avatarSrc = e.avatar_url ? (this._avatarCache.get(e.avatar_url) || e.avatar_url) : '';
      const avatar = avatarSrc
        ? '<img class="lb-avatar" src="' + this._escapeHtml(avatarSrc) + '" alt="" referrerpolicy="no-referrer">'
        : '';

      let modeHtml = '';
      if (e.mode) {
        const modeClass = e.mode === 'captain' ? 'lb-mode-captain'
                        : e.mode === 'stoker'  ? 'lb-mode-stoker'
                        : 'lb-mode-solo';
        const modeLabel = e.mode === 'captain' ? 'Capt'
                        : e.mode === 'stoker'  ? 'Stoke'
                        : 'Solo';
        modeHtml = '<span class="lb-mode ' + modeClass + '">' + modeLabel + '</span>';
      }

      let collectHtml = '';
      if (e.collectibles_found != null) {
        collectHtml = '<span class="lb-collectibles">' + collectibleEmoji + e.collectibles_found + '</span>';
      }

      const dateHtml = e.created_at
        ? '<span class="lb-date">' + this._relativeDate(e.created_at) + '</span>'
        : '';

      return '<div class="lb-entry' + youClass + '">' +
        '<span class="lb-rank">' + (i + 1) + '</span>' +
        avatar +
        '<span class="lb-name">' + this._escapeHtml((e.display_name || 'Player').split(' ')[0]) + youTag + '</span>' +
        modeHtml +
        collectHtml +
        '<span class="lb-time">' + this._formatTime(e.time_ms) + '</span>' +
        dateHtml +
      '</div>';
    }).join('');
  }

  _renderPartners(partners) {
    return partners.map(p => {
      const avatarSrc = p.avatar_url ? (this._avatarCache.get(p.avatar_url) || p.avatar_url) : '';
      const avatar = avatarSrc
        ? '<img class="lb-avatar" src="' + this._escapeHtml(avatarSrc) + '" alt="" referrerpolicy="no-referrer">'
        : '';
      const name = (p.display_name || 'Player').split(' ')[0];
      const rideLabel = p.rides_together === 1 ? '1 ride' : p.rides_together + ' rides';
      const dateHtml = p.last_ride
        ? '<span class="lb-date">' + this._relativeDate(p.last_ride) + '</span>'
        : '';
      return '<div class="lb-entry">' +
        avatar +
        '<span class="lb-name">' + this._escapeHtml(name) + '</span>' +
        '<span class="lb-rides">' + rideLabel + '</span>' +
        dateHtml +
      '</div>';
    }).join('');
  }

  _renderAchievements() {
    const container = document.getElementById('lb-achievements');
    const defs = this._achievements.getAllDefinitions();
    const earnedCount = defs.filter(d => d.earned).length;

    let html = '<div class="lb-ach-count"><span>' + earnedCount + '</span> / ' + defs.length + ' Unlocked</div>';
    html += '<div class="lb-achievement-grid">';
    defs.forEach(d => {
      const cls = d.earned ? 'earned' : 'locked';
      html += '<div class="lb-ach-item ' + cls + '">' +
        '<span class="lb-ach-icon">' + d.icon + '</span>' +
        '<span class="lb-ach-name">' + this._escapeHtml(d.name) + '</span>' +
      '</div>';
    });
    html += '</div>';
    container.innerHTML = html;
  }

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Fetch an avatar URL once, convert to blob URL, and cache it. */
  async _cacheAvatarUrl(url) {
    if (!url || this._avatarCache.has(url)) return;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const blob = await res.blob();
      this._avatarCache.set(url, URL.createObjectURL(blob));
    } catch (_) {
      // Cache the original URL so we don't retry on failure
      this._avatarCache.set(url, url);
    }
  }

  /** Batch-cache an array of avatar URLs in parallel. */
  async _cacheAvatarUrls(urls) {
    const unique = [...new Set(urls.filter(u => u && !this._avatarCache.has(u)))];
    if (unique.length === 0) return;
    await Promise.all(unique.map(u => this._cacheAvatarUrl(u)));
  }

  _formatTime(ms) {
    if (!ms) return '--:--';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const frac = Math.floor((ms % 1000) / 100);
    return min + ':' + String(sec).padStart(2, '0') + '.' + frac;
  }

  _relativeDate(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    const days = Math.floor(hr / 24);
    if (days < 7) return days + 'd ago';
    const d = new Date(isoStr);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }

  _startLeaderboardVideo(levelId) {
    this._stopLeaderboardVideo();

    const videoConfigs = {
      grandma: {
        src: 'assets/grandma_house_chromakey.mp4',
        maskSrc: 'assets/grandma_house_chromakey_mask.png',
        trimStart: 0.00, trimEnd: 5.50,
        threshold: -0.02, smoothness: 0.110
      }
    };
    const cfg = videoConfigs[levelId];
    const canvas = document.getElementById('leaderboard-video');
    if (!cfg) {
      canvas.style.display = 'none';
      return;
    }

    canvas.style.display = '';

    const video = document.createElement('video');
    video.src = cfg.src;
    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    video.addEventListener('timeupdate', () => {
      if (video.currentTime > cfg.trimEnd) {
        video.currentTime = cfg.trimStart;
        video.play().catch(() => {});
      }
    });

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setSize(canvas.width, canvas.height);
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.z = 2;

    const videoTexture = new THREE.VideoTexture(video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;

    const fallbackMask = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
    fallbackMask.needsUpdate = true;
    const maskUniform = { value: fallbackMask };
    if (cfg.maskSrc) {
      new THREE.TextureLoader().load(
        cfg.maskSrc,
        (tex) => { maskUniform.value = tex; },
        undefined,
        () => {}
      );
    }

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: videoTexture },
        maskTex: maskUniform,
        threshold: { value: cfg.threshold },
        smoothness: { value: cfg.smoothness }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map;
        uniform sampler2D maskTex;
        uniform float threshold;
        uniform float smoothness;
        varying vec2 vUv;
        void main() {
          float mask = texture2D(maskTex, vUv).r;
          if (mask > 0.5) discard;
          vec4 texColor = texture2D(map, vUv);
          float greenDom = texColor.g - max(texColor.r, texColor.b);
          float alpha = 1.0 - smoothstep(threshold, threshold + smoothness, greenDom);
          if (alpha < 0.01) discard;
          vec3 col = texColor.rgb;
          float spillMax = 0.5 * (col.r + col.b) + 0.05;
          col.g = min(col.g, spillMax);
          gl_FragColor = vec4(col, alpha);
        }`,
      transparent: true,
      depthWrite: false
    });

    const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    scene.add(plane);

    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    this._lbVideo = { video, renderer, videoTexture, mat, animId };
  }

  _stopLeaderboardVideo() {
    if (!this._lbVideo) return;
    const v = this._lbVideo;
    cancelAnimationFrame(v.animId);
    v.video.pause();
    v.video.src = '';
    v.videoTexture.dispose();
    v.mat.dispose();
    v.renderer.dispose();
    this._lbVideo = null;
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

    // When motion sensor data starts flowing, ensure toggle shows green
    if (this.input) {
      this.input.onMotionEnabled = () => {
        if (!this.motionActive) {
          this._showMotionToggle();
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
        }
      };
    }

    // Show motion toggle if a gyro-capable gamepad connects later
    window.addEventListener('gamepadconnected', () => {
      // Hide fixed back button when gamepad takes over
      this._fixedBackBtn.style.visibility = 'hidden';
      // Re-prime edge-detect flags so a held button from connection
      // doesn't immediately fire a click in _pollGamepadNav.
      if (this.input && this.input.gamepadConnected) {
        const gamepads = navigator.getGamepads();
        const gp = gamepads[this.input.gamepadIndex];
        if (gp) {
          this._gpPrevA = gp.buttons[0] && gp.buttons[0].pressed;
          this._gpPrevB = gp.buttons[1] && gp.buttons[1].pressed;
          this._gpPrevUp = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
          this._gpPrevDown = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
          this._gpPrevLeft = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
          this._gpPrevRight = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
          this._gpPrevLB = gp.buttons[4] && gp.buttons[4].pressed;
          this._gpPrevRB = gp.buttons[5] && gp.buttons[5].pressed;
        }
      }
      this._updateBackHint(this._currentStep);
      // Switch to spinners if currently on join step
      if (this._currentStep === this.joinStep) {
        if (this._lastFailedCode) {
          this._setSpinnerValuesFromCode(this._lastFailedCode);
          this._spinnerReshow = true;
        }
        this._showSpinners(true);
      }
      // Show joystick toggle for any gamepad
      if (this.input && this.input.gamepadConnected) {
        this.toggleJoystick.style.display = '';
        try {
          const saved = localStorage.getItem('tandemonium_joystick');
          if (saved === 'off') {
            this.joystickActive = false;
            this.input.suppressGamepadLean = true;
          }
        } catch {}
        this._setToggleActive('joystick', this.joystickActive);
      }
      if (this.toggleMotion.style.display !== 'none') return;
      if (this.input && this.input.gamepadConnected && navigator.hid) {
        this._checkGamepadGyro();
      }
    });
    window.addEventListener('gamepaddisconnected', () => {
      this._updateBackHint(this._currentStep);
      // Show fixed back button when gamepad disconnects
      const hasBack = this._stepBack.get(this._currentStep);
      if (hasBack) {
        this._fixedBackBtn.textContent = (this._currentStep === this.roomStep) ? '\u2190 Leave Room' : '\u2190 Back';
        this._fixedBackBtn.style.visibility = 'visible';
      }
      // Switch back to text input if on join step
      if (this._currentStep === this.joinStep) {
        this._showSpinners(false);
        this._spinnerStopRepeat();
      }
      // Hide joystick toggle when gamepad disconnects
      this.toggleJoystick.style.display = 'none';
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
    // Dismiss tap-to-start overlay — user already acted by navigating via URL
    if (this._tapOverlay) this._dismissTapOverlay();

    // If not logged in, prompt sign-in first and join after auth completes
    if (!this.auth.isLoggedIn()) {
      this._pendingAutoJoinCode = fullCode;
      this.auth.login();
      return;
    }

    this._showStep(this.joinStep);
    // Put the last 4 chars in the text input and pre-set for spinners
    const suffix = fullCode.slice(-4);
    document.getElementById('room-code-input').value = suffix;
    this._lastFailedCode = fullCode;
    this._joinRoom(fullCode);
  }

  async _createRoom() {
    this.net = new NetworkManager();
    this.net._fallbackUrl = RELAY_URL;
    this.net.cameraEnabled = this.cameraActive;
    this.net.audioEnabled = this.audioActive;
    const statusEl = document.getElementById('host-status');
    const codeEl = document.getElementById('room-code-display');

    statusEl.textContent = 'Creating room...';
    statusEl.className = 'conn-status';
    codeEl.textContent = '----';

    const code = this.net.generateRoomCode();

    // Fetch relay auth token if logged in (optional — relay allows unauthenticated)
    const relayToken = await this.auth.getRelayToken(code, 'captain');
    if (relayToken) this.net._relayToken = relayToken;

    this.net.onRoomJoined = () => {
      codeEl.textContent = code;
      this._updateCardHeader(this._currentStep);
      statusEl.textContent = 'Waiting for partner...';

      // Save room to localStorage for rejoin after refresh
      this._saveRoom(code, 'captain');

      // Generate QR code with join URL
      const qrEl = document.getElementById('room-qr');
      const urlEl = document.getElementById('room-url');
      const url = window.location.origin + window.location.pathname + '?room=' + code;
      try {
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag({ cellSize: 2, margin: 2 });
      } catch (_) {
        qrEl.style.display = 'none';
      }

      // Show full URL
      if (urlEl) urlEl.textContent = url;

      // Long-press to copy on both QR and URL
      const copyUrl = () => {
        navigator.clipboard.writeText(url).then(() => {
          if (urlEl) {
            const orig = urlEl.textContent;
            urlEl.textContent = 'Copied!';
            urlEl.classList.add('room-url-copied');
            setTimeout(() => { urlEl.textContent = orig; urlEl.classList.remove('room-url-copied'); }, 1500);
          }
        }).catch(() => {});
      };
      [qrEl, urlEl].forEach(el => {
        if (!el) return;
        let timer = null;
        const start = (e) => { e.preventDefault(); timer = setTimeout(copyUrl, 500); };
        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        el.addEventListener('touchstart', start, { passive: false });
        el.addEventListener('touchend', cancel);
        el.addEventListener('touchcancel', cancel);
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); copyUrl(); });
      });
    };

    this.net.onConnected = () => {
      statusEl.textContent = 'Partner connected!';
      statusEl.className = 'conn-status connected';
      setTimeout(() => {
        this._showRoomStep('captain');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Disconnected';
      statusEl.className = 'conn-status error';
    };

    // Auth error: token was rejected by relay — clear and re-login
    this.net.onAuthError = () => {
      console.warn('LOBBY: Relay auth failed for captain — refreshing login');
      statusEl.textContent = 'Session expired, signing in...';
      statusEl.className = 'conn-status';
      this.auth.refreshLogin();
      this._pendingCreateRoom = true;
    };

    this.net.enterRoom(code, 'captain');
  }

  async _joinRoom(code) {
    this.net = new NetworkManager();
    this.net._fallbackUrl = RELAY_URL;
    this.net.cameraEnabled = this.cameraActive;
    this.net.audioEnabled = this.audioActive;
    const statusEl = document.getElementById('join-status');

    statusEl.textContent = 'Connecting...';
    statusEl.className = 'conn-status';

    // Fetch relay auth token if logged in (optional — relay allows unauthenticated)
    const relayToken = await this.auth.getRelayToken(code, 'stoker');
    if (relayToken) this.net._relayToken = relayToken;

    this.net.onRoomJoined = () => {
      statusEl.textContent = 'Waiting for captain...';
      // Save room to localStorage for rejoin after refresh
      this._saveRoom(code, 'stoker');
    };

    this.net.onConnected = () => {
      this._lastFailedCode = null;
      statusEl.textContent = 'Connected!';
      statusEl.className = 'conn-status connected';
      setTimeout(() => {
        this._showRoomStep('stoker');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Could not connect';
      statusEl.className = 'conn-status error';
      // Sync error into spinner status area
      const spinnerStatus = document.getElementById('spinner-status');
      if (spinnerStatus) {
        spinnerStatus.textContent = statusEl.textContent;
        spinnerStatus.className = statusEl.className;
        spinnerStatus.style.display = '';
      }
      if (this._currentStep === this.joinStep) {
        this._lastFailedCode = code;
      }
    };

    // Auth error: token was rejected by relay — clear and re-login
    this.net.onAuthError = async () => {
      console.warn('LOBBY: Relay auth failed for stoker — attempting token refresh');
      statusEl.textContent = 'Session expired, retrying...';
      statusEl.className = 'conn-status';

      // Try getting a fresh token first (in case server JWT is still valid)
      const freshToken = await this.auth.getRelayToken(code, 'stoker');
      if (freshToken) {
        statusEl.textContent = 'Reconnecting...';
        this.net.retryWithToken(freshToken);
      } else {
        // Server JWT is also bad — need full re-login
        statusEl.textContent = 'Sign-in required...';
        this.auth.refreshLogin();
        this._pendingAutoJoinCode = code;
      }
    };

    this.net.enterRoom(code, 'stoker');
  }

  // ── Room Persistence (localStorage) ──────────────────────────

  _saveRoom(roomCode, role) {
    try {
      localStorage.setItem('tandemonium-room', JSON.stringify({
        roomCode, role, timestamp: Date.now()
      }));
    } catch (e) {}
  }

  _clearRoom() {
    try { localStorage.removeItem('tandemonium-room'); } catch (e) {}
  }

  _getSavedRoom() {
    try {
      const raw = localStorage.getItem('tandemonium-room');
      if (!raw) return null;
      const data = JSON.parse(raw);
      // Expire after 1 hour
      if (Date.now() - data.timestamp > 3600000) {
        localStorage.removeItem('tandemonium-room');
        return null;
      }
      return data;
    } catch (e) { return null; }
  }

  _showRejoinPrompt(saved) {
    const roleName = saved.role === 'captain' ? 'Captain' : 'Stoker';
    // Create a simple modal overlay for rejoin prompt
    const overlay = document.createElement('div');
    overlay.id = 'rejoin-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML =
      '<div style="background:#1a1a2e;border-radius:16px;padding:24px 28px;max-width:320px;text-align:center;color:#fff;font-family:inherit;">' +
        '<div style="font-size:1.1em;margin-bottom:12px;">Rejoin room <b>' + saved.roomCode + '</b> as ' + roleName + '?</div>' +
        '<div style="display:flex;gap:12px;justify-content:center;">' +
          '<button id="btn-rejoin-yes" style="padding:10px 20px;border-radius:8px;border:none;background:#44ff66;color:#000;font-weight:bold;font-size:1em;cursor:pointer;">Rejoin</button>' +
          '<button id="btn-rejoin-no" style="padding:10px 20px;border-radius:8px;border:none;background:#444;color:#fff;font-size:1em;cursor:pointer;">New Room</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Default-focus "Rejoin" for gamepad navigation
    this._rejoinFocus = 0;
    document.getElementById('btn-rejoin-yes').classList.add('gamepad-focus');

    return new Promise((resolve) => {
      document.getElementById('btn-rejoin-yes').addEventListener('click', () => {
        overlay.remove();
        resolve('rejoin');
      });
      document.getElementById('btn-rejoin-no').addEventListener('click', () => {
        overlay.remove();
        this._clearRoom();
        resolve('new');
      });
    });
  }

  async _handleRejoinCheck() {
    const saved = this._getSavedRoom();
    if (!saved) return false;

    const choice = await this._showRejoinPrompt(saved);
    if (choice !== 'rejoin') return false;

    // Rejoin: skip role selection, go straight to connection
    this._requestMotion();
    this._pendingMode = 'multiplayer';

    if (saved.role === 'captain') {
      this._showStep(this.hostStep);
      // Re-use _createRoom logic but with saved code
      this.net = new NetworkManager();
      this.net._fallbackUrl = RELAY_URL;
      this.net.cameraEnabled = this.cameraActive;
      this.net.audioEnabled = this.audioActive;
      const statusEl = document.getElementById('host-status');
      const codeEl = document.getElementById('room-code-display');
      statusEl.textContent = 'Rejoining room...';
      statusEl.className = 'conn-status';

      const relayToken = await this.auth.getRelayToken(saved.roomCode, 'captain');
      if (relayToken) this.net._relayToken = relayToken;

      this.net.onRoomJoined = () => {
        codeEl.textContent = saved.roomCode;
        this._updateCardHeader(this._currentStep);
        statusEl.textContent = 'Waiting for partner...';
        this._saveRoom(saved.roomCode, 'captain');
        // Start stale room timer
        this._startStaleRoomTimer(statusEl);
      };

      this.net.onConnected = () => {
        this._clearStaleRoomTimer();
        statusEl.textContent = 'Partner connected!';
        statusEl.className = 'conn-status connected';
        setTimeout(() => this._showRoomStep('captain'), 1000);
      };

      this.net.onDisconnected = (reason) => {
        statusEl.textContent = reason || 'Disconnected';
        statusEl.className = 'conn-status error';
      };

      this.net.enterRoom(saved.roomCode, 'captain');
    } else {
      this._showStep(this.joinStep);
      // Re-use _joinRoom logic with saved code
      this.net = new NetworkManager();
      this.net._fallbackUrl = RELAY_URL;
      this.net.cameraEnabled = this.cameraActive;
      this.net.audioEnabled = this.audioActive;
      const statusEl = document.getElementById('join-status');
      statusEl.textContent = 'Rejoining room...';
      statusEl.className = 'conn-status';

      const relayToken = await this.auth.getRelayToken(saved.roomCode, 'stoker');
      if (relayToken) this.net._relayToken = relayToken;

      this.net.onRoomJoined = () => {
        statusEl.textContent = 'Waiting for captain...';
        this._saveRoom(saved.roomCode, 'stoker');
        this._startStaleRoomTimer(statusEl);
      };

      this.net.onConnected = () => {
        this._clearStaleRoomTimer();
        statusEl.textContent = 'Connected!';
        statusEl.className = 'conn-status connected';
        setTimeout(() => this._showRoomStep('stoker'), 1000);
      };

      this.net.onDisconnected = (reason) => {
        statusEl.textContent = reason || 'Could not connect';
        statusEl.className = 'conn-status error';
      };

      this.net.enterRoom(saved.roomCode, 'stoker');
    }

    return true;
  }

  _startStaleRoomTimer(statusEl) {
    this._clearStaleRoomTimer();
    this._staleRoomTimeout = setTimeout(() => {
      if (this.net && !this.net.connected) {
        statusEl.innerHTML = 'Partner hasn\'t reconnected yet. ' +
          '<button id="btn-stale-new-room" style="background:#444;color:#fff;border:none;border-radius:6px;padding:6px 14px;margin-left:8px;cursor:pointer;">New Room</button>';
        const newBtn = document.getElementById('btn-stale-new-room');
        if (newBtn) {
          newBtn.addEventListener('click', () => {
            this._clearRoom();
            if (this.net) { this.net.destroy(); this.net = null; }
            this._showStep(this.roleStep);
          });
        }
      }
    }, 30000);
  }

  _clearStaleRoomTimer() {
    if (this._staleRoomTimeout) {
      clearTimeout(this._staleRoomTimeout);
      this._staleRoomTimeout = null;
    }
  }

  // ── Room Step (shared multiplayer lobby) ─────────────────────

  _showRoomStep(role) {
    this._roomRole = role;
    this._partnerCameraOn = true; // assume on until cameraToggle received

    const roomCodeLabel = document.getElementById('room-code-label');
    if (roomCodeLabel && this.net && this.net.roomCode) {
      roomCodeLabel.textContent = this.net.roomCode;
    }

    // Show/hide play game button vs waiting text based on role
    const playBtn = document.getElementById('btn-play-game');
    const waitTextRoom = document.getElementById('room-wait-text-room');
    if (role === 'captain') {
      playBtn.style.display = '';
      waitTextRoom.style.display = 'none';
    } else {
      playBtn.style.display = 'none';
      waitTextRoom.style.display = '';
    }

    // Set role labels on PiP circles
    const selfieLabel = document.getElementById('selfie-pip-label');
    const partnerLabel = document.getElementById('partner-pip-label');
    if (selfieLabel) selfieLabel.textContent = role === 'captain' ? 'CAPTAIN' : 'STOKER';
    if (partnerLabel) partnerLabel.textContent = role === 'captain' ? 'STOKER' : 'CAPTAIN';

    // Register gamepad nav for room step
    const roomItems = (role === 'captain')
      ? [document.getElementById('btn-play-game'), document.getElementById('btn-back-room')]
      : [document.getElementById('btn-back-room')];
    this._stepItems.set(this.roomStep, roomItems);
    this._stepCenterItems.set(this.roomStep, roomItems);
    this._stepBack.set(this.roomStep, document.getElementById('btn-back-room'));

    this._showStep(this.roomStep);

    // Start media
    this._startRoomMedia();

    // Register room message handler
    this.net.onProfileReceived = (profile) => this._handleRoomMessage(profile);

    // Send current bike preset to partner
    this.net.sendProfile({ type: 'bikeSync', presetKey: this.selectedPresetKey });

    // Send profile with avatar + achievements so partner sees them in room
    this._sendRoomProfile();

    // Notify partner of current camera state so they show video or avatar
    const camMsg = { type: 'cameraToggle', enabled: this.cameraActive };
    const camUser = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
    if (camUser && camUser.avatar) camMsg.avatar = camUser.avatar;
    this.net.sendProfile(camMsg);

    // Handle partner disconnect while in room or levels
    this.net.onDisconnected = (reason) => {
      const waitTextRoom = document.getElementById('room-wait-text-room');
      const waitText = document.getElementById('room-wait-text');
      if (waitTextRoom) { waitTextRoom.textContent = 'Partner disconnected'; waitTextRoom.style.display = ''; }
      if (waitText) { waitText.textContent = 'Partner disconnected'; waitText.style.display = ''; }
      document.getElementById('btn-play-game').style.display = 'none';
      document.getElementById('btn-start-ride').style.display = 'none';
      setTimeout(() => {
        if (this.net) { this.net.destroy(); this.net = null; }
        this._removePipLobbyMode();
        this._showStep(this.roleStep);
      }, 2000);
    };
  }

  _showRoomLevelsStep() {
    const role = this._roomRole;

    // Show/hide start button vs waiting text based on role
    const startBtn = document.getElementById('btn-start-ride');
    const waitText = document.getElementById('room-wait-text');
    if (role === 'captain') {
      startBtn.style.display = '';
      startBtn.disabled = true;
      waitText.style.display = 'none';
    } else {
      startBtn.style.display = 'none';
      waitText.style.display = '';
    }

    // Build level cards BEFORE _showStep so _stepItems is populated
    this._buildRoomLevelCards(role === 'captain');

    // Stoker can see difficulty but not interact
    const diffSel = document.getElementById('difficulty-selector');
    if (diffSel) {
      diffSel.style.opacity = (role === 'captain') ? '' : '0.7';
      diffSel.style.pointerEvents = (role === 'captain') ? '' : 'none';
    }

    this._showStep(this.roomLevelsStep);
  }

  _buildRoomLevelCards(isClickable) {
    const container = document.getElementById('room-level-cards');
    container.innerHTML = '';
    const buttons = [];
    const LEVEL_UNLOCK = { castle: 'home_sweet' };

    LEVELS.filter(l => !l.isTutorial).forEach(level => {
      const requiredAch = LEVEL_UNLOCK[level.id];
      const locked = requiredAch && !this._achievements.getEarnedIds().includes(requiredAch);

      const card = document.createElement('button');
      card.className = 'level-card' + (locked ? ' level-locked' : '');
      card.dataset.levelId = level.id;

      if (locked) {
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">&#x1F512;</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">Complete Grandma\'s House to unlock</div>';
        card.disabled = true;
      } else {
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">' + level.icon + '</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' + level.description + '</div>';
        if (isClickable) {
          card.addEventListener('click', () => {
            this.selectedLevel = level;
            container.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            document.getElementById('btn-start-ride').disabled = false;
            if (this.net && this.net.connected) {
              this.net.sendProfile({ type: 'levelSync', levelId: level.id });
            }
          });
        } else {
          card.style.opacity = '0.7';
          card.style.pointerEvents = 'none';
        }
      }

      container.appendChild(card);
      if (!locked) buttons.push(card);
    });

    // Restore previously selected level
    if (this.selectedLevel) {
      container.querySelectorAll('.level-card').forEach(c => {
        if (c.dataset.levelId === this.selectedLevel.id) c.classList.add('selected');
      });
      if (isClickable) document.getElementById('btn-start-ride').disabled = false;
      // Re-sync level to partner (captain only)
      if (isClickable && this.net && this.net.connected) {
        this.net.sendProfile({ type: 'levelSync', levelId: this.selectedLevel.id });
      }
    }

    // Add shared difficulty buttons to gamepad nav (captain only)
    if (isClickable) {
      const diffBtns = document.querySelectorAll('#difficulty-selector .difficulty-btn');
      diffBtns.forEach(b => buttons.push(b));
    }

    // Register for gamepad nav on levels step
    const levelsItems = isClickable
      ? [...buttons, document.getElementById('btn-start-ride'), document.getElementById('btn-back-room-levels')]
      : [document.getElementById('btn-back-room-levels')];
    this._stepItems.set(this.roomLevelsStep, levelsItems);
    this._stepCenterItems.set(this.roomLevelsStep, levelsItems);
    this._stepBack.set(this.roomLevelsStep, document.getElementById('btn-back-room-levels'));
  }

  _updatePartnerPip() {
    const partnerVideo = document.getElementById('partner-pip');
    const partnerAvatar = document.getElementById('partner-pip-avatar');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    if (!partnerWrap) return;

    if (this._partnerCameraOn && partnerVideo && partnerVideo.srcObject) {
      partnerVideo.style.display = 'block';
      partnerVideo.play().catch(() => {});
      if (partnerAvatar) partnerAvatar.style.display = 'none';
    } else {
      if (partnerVideo) partnerVideo.style.display = 'none';
      if (partnerAvatar && this._partnerAvatarUrl) {
        partnerAvatar.src = this._avatarCache.get(this._partnerAvatarUrl) || this._partnerAvatarUrl;
        partnerAvatar.style.display = 'block';
      }
    }
    partnerWrap.style.display = 'block';
  }

  async _startRoomMedia() {
    if (!this.net) return;

    // Register remote stream handler BEFORE acquiring local media so that
    // an incoming call that arrives while getUserMedia is pending still
    // gets its stream rendered in the partner PiP.
    this.net.onRemoteStream = (remoteStream) => {
      const partnerVideo = document.getElementById('partner-pip');
      if (partnerVideo && remoteStream) {
        partnerVideo.srcObject = remoteStream;
        this._updatePartnerPip();

        // Track may start muted; re-evaluate when it unmutes
        const remoteVideoTrack = remoteStream.getVideoTracks()[0];
        if (remoteVideoTrack && remoteVideoTrack.muted) {
          remoteVideoTrack.addEventListener('unmute', () => this._updatePartnerPip(), { once: true });
        }
      }
    };

    // Acquire all permitted tracks so they can be toggled on/off in the room
    await this.net.acquireLocalMedia(this._cameraPermitted, this._audioPermitted);

    // Apply current toggle states to live tracks
    if (this.net._localMediaStream) {
      const videoTrack = this.net._localMediaStream.getVideoTracks()[0];
      if (videoTrack) videoTrack.enabled = this.cameraActive;
      const audioTrack = this.net._localMediaStream.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = this.audioActive;
    }

    // Show selfie PiP in lobby mode
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    if (selfieWrap) {
      selfieWrap.classList.add('pip-lobby-mode');
      const videoArea = document.getElementById('room-video-area');
      videoArea.appendChild(selfieWrap);
    }

    // Start selfie video from the acquired stream
    const selfieVideo = document.getElementById('selfie-pip');
    const selfieAvatar = document.getElementById('selfie-pip-avatar');
    if (selfieVideo && this.net._localMediaStream) {
      const videoTrack = this.net._localMediaStream.getVideoTracks()[0];
      // Always bind the stream so toggling on later works immediately
      if (videoTrack) selfieVideo.srcObject = this.net._localMediaStream;
      if (videoTrack && this.cameraActive) {
        selfieVideo.style.display = 'block';
        selfieVideo.play().catch(() => {});
        if (selfieAvatar) selfieAvatar.style.display = 'none';
      } else {
        selfieVideo.style.display = 'none';
        // Show avatar fallback when camera is off
        if (selfieAvatar && this.auth && this.auth.isLoggedIn()) {
          const user = this.auth.getUser();
          if (user && user.avatar) {
            selfieAvatar.src = this._avatarCache.get(user.avatar) || user.avatar;
            selfieAvatar.style.display = 'block';
          }
        }
      }
      if (selfieWrap) selfieWrap.style.display = 'block';
    } else if (this.auth && this.auth.isLoggedIn()) {
      // No stream at all — fallback to avatar
      const user = this.auth.getUser();
      if (user && user.avatar && selfieAvatar && selfieWrap) {
        selfieAvatar.src = this._avatarCache.get(user.avatar) || user.avatar;
        selfieAvatar.style.display = 'block';
        if (selfieVideo) selfieVideo.style.display = 'none';
        selfieWrap.style.display = 'block';
      }
    }

    // Show partner PiP area
    const partnerWrap = document.getElementById('partner-pip-wrap');
    if (partnerWrap) {
      partnerWrap.classList.add('pip-lobby-mode');
      const videoArea = document.getElementById('room-video-area');
      videoArea.appendChild(partnerWrap);
    }

    // Initiate media call — both sides try, with retries until stream arrives.
    // PeerJS media calls require P2P, so we wait for the upgrade first.
    this._mediaCallRetries = 0;
    this._mediaCallTimer = null;

    const tryInitiateCall = () => {
      if (!this.net || !this.net.peer || !this.net.conn) return;
      this.net.initiateCall();
      // Retry every 3s until partner video arrives (up to 10 attempts)
      this._mediaCallRetries++;
      if (this._mediaCallRetries < 10) {
        this._mediaCallTimer = setTimeout(() => {
          const partnerVideo = document.getElementById('partner-pip');
          const hasStream = partnerVideo && partnerVideo.srcObject &&
            partnerVideo.srcObject.getVideoTracks().length > 0;
          if (!hasStream) {
            tryInitiateCall();
          }
        }, 3000);
      }
    };

    const onP2PReady = () => {
      // Both sides initiate — first successful call wins
      tryInitiateCall();
    };

    if (this.net.transport === 'p2p') {
      onP2PReady();
    } else {
      const prevOnP2P = this.net.onP2PUpgrade;
      this.net.onP2PUpgrade = () => {
        onP2PReady();
        if (prevOnP2P) prevOnP2P();
      };
    }
  }

  _handleRoomMessage(profile) {
    if (!profile || !profile.type) {
      // Profile message (avatar, name, achievements)
      const partnerNameEl = document.getElementById('room-partner-name');
      if (partnerNameEl && profile && profile.name) partnerNameEl.textContent = profile.name;
      // Cache partner avatar URL for camera toggle
      if (profile && profile.avatar) {
        this._partnerAvatarUrl = this._avatarCache.get(profile.avatar) || profile.avatar;
      }
      // Refresh partner PiP (avatar may have just arrived)
      this._updatePartnerPip();
      // Render partner achievement badges
      if (profile && profile.achievements) {
        updateBadgeDisplay('partner-badges', profile.achievements);
      }
      return;
    }

    if (profile.type === 'bikeSync') {
      // Partner changed bike — no label update needed (keep role-only labels)
    } else if (profile.type === 'levelSync') {
      // Stoker: highlight captain's level selection
      this.selectedLevel = LEVELS.find(l => l.id === profile.levelId) || this.selectedLevel;
      const container = document.getElementById('room-level-cards');
      container.querySelectorAll('.level-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.levelId === profile.levelId);
      });
    } else if (profile.type === 'cameraToggle') {
      // Partner toggled their camera — update state and refresh PiP
      this._partnerCameraOn = !!profile.enabled;
      if (!profile.enabled) {
        const avatarUrl = profile.avatar || this._partnerAvatarUrl;
        if (avatarUrl) this._partnerAvatarUrl = avatarUrl;
      }
      this._updatePartnerPip();
    } else if (profile.type === 'difficultySync') {
      // Stoker: update difficulty selection to match captain's choice
      this.selectedDifficulty = profile.difficulty;
      document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
      document.querySelectorAll('.difficulty-btn[data-difficulty="' + profile.difficulty + '"]')
        .forEach(b => b.classList.add('selected'));
    } else if (profile.type === 'playGame') {
      // Stoker: captain clicked PLAY GAME → go to levels step
      this._showRoomLevelsStep();
    } else if (profile.type === 'startRide') {
      // Stoker: captain started the ride
      this._transitionToGame();
    }
  }

  _sendRoomProfile() {
    if (!this.net || !this.net.connected) return;
    const profile = { achievements: this._achievements.getEarned() };
    if (this.auth && this.auth.isLoggedIn()) {
      const user = this.auth.getUser();
      if (user) {
        if (user.avatar) profile.avatar = user.avatar;
        if (user.name) profile.name = user.name;
      }
    }
    this.net.sendProfile(profile);
  }

  _transitionToGame() {
    // Stop media call retry timer
    if (this._mediaCallTimer) { clearTimeout(this._mediaCallTimer); this._mediaCallTimer = null; }
    // Remove lobby mode from PiP elements
    this._removePipLobbyMode();
    // Hide lobby
    this._hideLobby();
    // Fire multiplayer ready
    this.onMultiplayerReady(this.net, this._roomRole);
  }

  _removePipLobbyMode() {
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    if (selfieWrap) {
      selfieWrap.classList.remove('pip-lobby-mode');
      // Move back to body so fixed positioning works in-game
      document.body.appendChild(selfieWrap);
    }
    if (partnerWrap) {
      partnerWrap.classList.remove('pip-lobby-mode');
      document.body.appendChild(partnerWrap);
    }
  }

  showRoom(net, role) {
    // Called by game.js _returnToRoom() to re-show the lobby at roomStep
    this.net = net;
    this._roomRole = role;

    const roomCodeLabel = document.getElementById('room-code-label');
    if (roomCodeLabel && this.net && this.net.roomCode) {
      roomCodeLabel.textContent = this.net.roomCode;
    }

    this.lobbyEl.style.display = '';
    this._startGamepadNav();
    if (this._previewModel) this._startPreviewLoop();

    // Show/hide play game button vs waiting text
    const playBtn = document.getElementById('btn-play-game');
    const waitTextRoom = document.getElementById('room-wait-text-room');
    if (role === 'captain') {
      playBtn.style.display = '';
      waitTextRoom.style.display = 'none';
    } else {
      playBtn.style.display = 'none';
      waitTextRoom.style.display = '';
    }

    // Set role labels on PiP circles
    const selfieLabel = document.getElementById('selfie-pip-label');
    const partnerLabel = document.getElementById('partner-pip-label');
    if (selfieLabel) selfieLabel.textContent = role === 'captain' ? 'CAPTAIN' : 'STOKER';
    if (partnerLabel) partnerLabel.textContent = role === 'captain' ? 'STOKER' : 'CAPTAIN';

    // Register gamepad nav for room step
    const roomItems = (role === 'captain')
      ? [document.getElementById('btn-play-game'), document.getElementById('btn-back-room')]
      : [document.getElementById('btn-back-room')];
    this._stepItems.set(this.roomStep, roomItems);
    this._stepCenterItems.set(this.roomStep, roomItems);
    this._stepBack.set(this.roomStep, document.getElementById('btn-back-room'));

    // Show room step directly (not levels)
    this._showStep(this.roomStep);

    // Re-add PiP lobby mode
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    const videoArea = document.getElementById('room-video-area');
    if (selfieWrap) {
      selfieWrap.classList.add('pip-lobby-mode');
      videoArea.appendChild(selfieWrap);
    }
    if (partnerWrap) {
      partnerWrap.classList.add('pip-lobby-mode');
      videoArea.appendChild(partnerWrap);
    }

    // Refresh selfie video from existing stream
    const selfieVideo = document.getElementById('selfie-pip');
    const selfieAvatar = document.getElementById('selfie-pip-avatar');
    if (selfieVideo && this.net && this.net._localMediaStream) {
      const videoTrack = this.net._localMediaStream.getVideoTracks()[0];
      if (videoTrack) selfieVideo.srcObject = this.net._localMediaStream;
      if (videoTrack && this.cameraActive) {
        selfieVideo.style.display = 'block';
        selfieVideo.play().catch(() => {});
        if (selfieAvatar) selfieAvatar.style.display = 'none';
      } else {
        selfieVideo.style.display = 'none';
        if (selfieAvatar && this.auth && this.auth.isLoggedIn()) {
          const user = this.auth.getUser();
          if (user && user.avatar) {
            selfieAvatar.src = this._avatarCache.get(user.avatar) || user.avatar;
            selfieAvatar.style.display = 'block';
          }
        }
      }
      if (selfieWrap) selfieWrap.style.display = 'block';
    }

    // Re-register remote stream handler so partner video shows in room
    // (game.js replaces this with its own handler during gameplay)
    this.net.onRemoteStream = (remoteStream) => {
      const pVideo = document.getElementById('partner-pip');
      if (pVideo && remoteStream) {
        pVideo.srcObject = remoteStream;
        this._updatePartnerPip();

        const remoteVideoTrack = remoteStream.getVideoTracks()[0];
        if (remoteVideoTrack && remoteVideoTrack.muted) {
          remoteVideoTrack.addEventListener('unmute', () => this._updatePartnerPip(), { once: true });
        }
      }
    };

    // Re-register room message handler
    this.net.onProfileReceived = (profile) => this._handleRoomMessage(profile);

    // Send current bike preset and profile to partner on re-entry
    if (this.net.connected) {
      this.net.sendProfile({ type: 'bikeSync', presetKey: this.selectedPresetKey });
      this._sendRoomProfile();
      // Notify partner of current camera state
      const camMsg = { type: 'cameraToggle', enabled: this.cameraActive };
      const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
      if (user && user.avatar) camMsg.avatar = user.avatar;
      this.net.sendProfile(camMsg);
    }

    // Re-initiate media call to refresh video stream after returning from game
    this._mediaCallRetries = 0;
    if (this._mediaCallTimer) { clearTimeout(this._mediaCallTimer); this._mediaCallTimer = null; }

    const retryCall = () => {
      if (!this.net || !this.net.peer || !this.net.conn) return;
      this.net.initiateCall();
      this._mediaCallRetries++;
      if (this._mediaCallRetries < 10) {
        this._mediaCallTimer = setTimeout(() => {
          const partnerVideo = document.getElementById('partner-pip');
          const hasStream = partnerVideo && partnerVideo.srcObject &&
            partnerVideo.srcObject.getVideoTracks().length > 0;
          if (!hasStream) retryCall();
        }, 3000);
      }
    };

    if (this.net.transport === 'p2p') {
      retryCall();
    } else {
      const prevOnP2P = this.net.onP2PUpgrade;
      this.net.onP2PUpgrade = () => {
        retryCall();
        if (prevOnP2P) prevOnP2P();
      };
    }

    // Re-register disconnect handler for room
    this.net.onDisconnected = (reason) => {
      const waitTextRoom = document.getElementById('room-wait-text-room');
      const waitText = document.getElementById('room-wait-text');
      if (waitTextRoom) { waitTextRoom.textContent = 'Partner disconnected'; waitTextRoom.style.display = ''; }
      if (waitText) { waitText.textContent = 'Partner disconnected'; waitText.style.display = ''; }
      document.getElementById('btn-play-game').style.display = 'none';
      document.getElementById('btn-start-ride').style.display = 'none';
      setTimeout(() => {
        if (this.net) { this.net.destroy(); this.net = null; }
        this._removePipLobbyMode();
        this._showStep(this.roleStep);
      }, 2000);
    };

    // Refresh carousel visual on re-entry
    this._applyPresetToPreview();
  }

  // ── Gamepad code spinners ─────────────────────────────────────

  _showSpinners(show) {
    const spinnerWrap = document.getElementById('gamepad-code-spinners');
    const inputWrap = document.querySelector('.room-code-join-wrap');
    if (!spinnerWrap || !inputWrap) return;
    this._spinnerActive = show;
    spinnerWrap.style.display = show ? '' : 'none';
    inputWrap.style.display = show ? 'none' : '';
    // Hide JOIN button, status, back button when spinners are active
    const joinBtn = document.getElementById('btn-join');
    if (joinBtn) joinBtn.style.display = show ? 'none' : '';
    const joinStatus = document.getElementById('join-status');
    if (joinStatus) joinStatus.style.display = show ? 'none' : '';
    const backBtn = document.getElementById('btn-back-role-join');
    if (backBtn) backBtn.style.display = show ? 'none' : '';
    const backHint = document.getElementById('gamepad-back-hint');
    if (backHint) backHint.style.visibility = show ? 'hidden' : '';
    // Set controller-appropriate button icons (PS: ✕/◯, Xbox: A/B)
    if (show) {
      const submitIcon = document.getElementById('spinner-submit-icon');
      const backIcon = document.getElementById('spinner-back-icon');
      if (submitIcon && backIcon && this.input) {
        const gpId = (this.input._gpName || '').toLowerCase();
        const isPS = /playstation|dualsense|dualshock|054c/.test(gpId);
        submitIcon.textContent = isPS ? '\u2715' : 'A';
        backIcon.textContent = isPS ? '\u25EF' : 'B';
        if (isPS) {
          submitIcon.style.color = '#4a9df8';
          submitIcon.style.borderColor = '#4a9df8';
          submitIcon.style.borderRadius = '50%';
          backIcon.style.color = '#ff6b81';
          backIcon.style.borderColor = '#ff6b81';
          backIcon.style.borderRadius = '50%';
        }
      }
      // Copy status from main join-status into spinner status area
      const mainStatus = document.getElementById('join-status');
      const spinnerStatus = document.getElementById('spinner-status');
      if (mainStatus && spinnerStatus) {
        spinnerStatus.textContent = mainStatus.textContent;
        spinnerStatus.className = mainStatus.className;
        spinnerStatus.style.display = mainStatus.textContent ? '' : 'none';
      }
    }
    if (show) {
      if (!this._spinnerReshow) {
        this._spinnerSlot = 0;
        this._spinnerValues = [0, 0, 0, 0];
      }
      this._spinnerReshow = false;
      this._updateSpinnerDisplay();
      this._applySpinnerFocus();
    }
  }

  _updateSpinnerDisplay() {
    const slots = document.querySelectorAll('#gamepad-code-spinners .code-spinner');
    slots.forEach((slot, i) => {
      const charEl = slot.querySelector('.spinner-char');
      charEl.textContent = this._spinnerChars[this._spinnerValues[i]];
      slot.classList.toggle('active', this._spinnerActive && i === this._spinnerSlot);
    });
    // Always highlight JOIN when spinners are active (A submits from anywhere)
    const joinBtn = document.getElementById('btn-join');
    joinBtn.classList.toggle('gamepad-focus', this._spinnerActive);
  }

  _applySpinnerFocus() {
    this._clearFocusHighlight();
    this._updateSpinnerDisplay();
  }

  _spinnerCycleChar(dir) {
    const len = this._spinnerChars.length;
    this._spinnerValues[this._spinnerSlot] = (this._spinnerValues[this._spinnerSlot] + dir + len) % len;
    this._updateSpinnerDisplay();
  }

  _spinnerStartRepeat(dir) {
    this._spinnerStopRepeat();
    this._spinnerCycleChar(dir);
    this._spinnerRepeatTimer = setTimeout(() => {
      this._spinnerRepeatInterval = setInterval(() => this._spinnerCycleChar(dir), 120);
    }, 250);
  }

  _spinnerStopRepeat() {
    if (this._spinnerRepeatTimer) { clearTimeout(this._spinnerRepeatTimer); this._spinnerRepeatTimer = null; }
    if (this._spinnerRepeatInterval) { clearInterval(this._spinnerRepeatInterval); this._spinnerRepeatInterval = null; }
  }

  _spinnerSubmit() {
    const code = 'TNDM-' + this._spinnerValues.map(i => this._spinnerChars[i]).join('');
    // Show connecting status in spinner area
    const spinnerStatus = document.getElementById('spinner-status');
    if (spinnerStatus) {
      spinnerStatus.textContent = 'Connecting...';
      spinnerStatus.className = 'conn-status';
      spinnerStatus.style.display = '';
    }
    this._joinRoom(code);
  }

  _setSpinnerValuesFromCode(code) {
    // Parse last 4 chars into spinner indices
    const suffix = code.slice(-4);
    for (let i = 0; i < 4; i++) {
      const ch = suffix[i] ? suffix[i].toUpperCase() : 'A';
      const idx = this._spinnerChars.indexOf(ch);
      this._spinnerValues[i] = idx >= 0 ? idx : 0;
    }
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
    this._gpPrevLB = false;
    this._gpPrevRB = false;
    if (this.input && this.input.gamepadConnected) {
      const gamepads = navigator.getGamepads();
      const gp = gamepads[this.input.gamepadIndex];
      if (gp) {
        this._gpPrevUp = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
        this._gpPrevDown = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
        this._gpPrevLB = gp.buttons[4] && gp.buttons[4].pressed;
        this._gpPrevRB = gp.buttons[5] && gp.buttons[5].pressed;
        this._gpPrevA = gp.buttons[0] && gp.buttons[0].pressed;
        this._gpPrevB = gp.buttons[1] && gp.buttons[1].pressed;
        this._gpPrevLeft = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
        this._gpPrevRight = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
      }
    }
    this._pollGamepadNav();
  }

  _updateBackHint(step) {
    const hint = document.getElementById('gamepad-back-hint');
    if (!hint) return;
    const hasBack = this._stepBack.get(step);
    const hasGamepad = this.input && this.input.gamepadConnected;
    if (hasBack && hasGamepad) {
      const icon = document.getElementById('gamepad-back-icon');
      const gpId = (this.input._gpName || '').toLowerCase();
      const isPS = /playstation|dualsense|dualshock|054c/.test(gpId);
      const isXbox = /xbox|microsoft|045e/.test(gpId);
      if (isPS) {
        icon.textContent = '\u25EF';
        icon.style.color = '#ff6b81';
        icon.style.borderColor = '#ff6b81';
      } else if (isXbox) {
        icon.textContent = 'B';
        icon.style.color = '#ff4444';
        icon.style.borderColor = '#ff4444';
      } else {
        // Steam / generic
        icon.textContent = 'B';
        icon.style.color = 'rgba(255,255,255,0.5)';
        icon.style.borderColor = 'rgba(255,255,255,0.3)';
      }
      hint.style.visibility = 'visible';
    } else {
      hint.style.visibility = 'hidden';
    }
  }

  _updateCardHeader(step) {
    const header = document.getElementById('lobby-card-header');
    if (!header) return;
    const codeEl = document.getElementById('room-code-display');
    const code = codeEl ? codeEl.textContent : '';
    if ((step === this.hostStep || step === this.roomStep || step === this.roomLevelsStep) && code && code !== '----') {
      header.textContent = code;
    } else {
      header.textContent = '';
    }
  }

  _flashBumper(el) {
    if (!el) return;
    el.style.boxShadow = '0 0 12px 4px rgba(68,255,102,0.8)';
    el.style.borderColor = 'rgba(68,255,102,0.9)';
    setTimeout(() => {
      el.style.boxShadow = '';
      el.style.borderColor = '';
    }, 200);
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

    // Auto-switch to spinners on join step when gamepad is active and join failed
    if (this._currentStep === this.joinStep && !this._spinnerActive && this._lastFailedCode) {
      this._setSpinnerValuesFromCode(this._lastFailedCode);
      this._spinnerReshow = true;
      this._showSpinners(true);
    }

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

    // LB/RB bumpers (buttons 4/5) — cycle bike color
    const lb = gp.buttons[4] && gp.buttons[4].pressed;
    const rb = gp.buttons[5] && gp.buttons[5].pressed;
    if (lb && !this._gpPrevLB && this._bikePrev) {
      this._bikePrev();
      this._flashBumper(document.getElementById('bike-prev'));
    }
    if (rb && !this._gpPrevRB && this._bikeNext) {
      this._bikeNext();
      this._flashBumper(document.getElementById('bike-next'));
    }
    this._gpPrevLB = lb;
    this._gpPrevRB = rb;

    // If profile popup is open, navigate between logout and back
    if (this.profilePopup.classList.contains('visible')) {
      const isLoggedIn = this.auth.isLoggedIn();
      const items = isLoggedIn
        ? [document.getElementById('profile-popup-logout'), document.getElementById('profile-popup-back')]
        : [document.getElementById('profile-popup-signin-back')];
      if (up && !this._gpPrevUp) this._profileFocusIndex = Math.max(0, this._profileFocusIndex - 1);
      if (down && !this._gpPrevDown) this._profileFocusIndex = Math.min(items.length - 1, this._profileFocusIndex + 1);
      // Apply focus highlight
      items.forEach(el => el.classList.remove('gamepad-focus'));
      if (items[this._profileFocusIndex]) items[this._profileFocusIndex].classList.add('gamepad-focus');
      if (a && !this._gpPrevA) {
        if (items[this._profileFocusIndex]) items[this._profileFocusIndex].click();
      }
      if (b && !this._gpPrevB) {
        items.forEach(el => el.classList.remove('gamepad-focus'));
        this.profilePopup.classList.remove('visible');
      }
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }
    // Leaderboard modal gamepad navigation
    if (document.getElementById('leaderboard-modal').style.display !== 'none') {
      // Right stick (axis 3) scrolls the leaderboard list
      const lbStickY = gp.axes[3] || 0;
      if (Math.abs(lbStickY) > 0.15) {
        const lbBox = document.querySelector('.leaderboard-box');
        if (lbBox) lbBox.scrollTop += lbStickY * 12;
      }
      if (left && !this._gpPrevLeft) {
        this._lbFocusCol = Math.max(0, this._lbFocusCol - 1);
        this._lbApplyFocus();
      }
      if (right && !this._gpPrevRight) {
        const rowLen = this._lbGetRowItems(this._lbFocusRow).length;
        this._lbFocusCol = Math.min(rowLen - 1, this._lbFocusCol + 1);
        this._lbApplyFocus();
      }
      if (up && !this._gpPrevUp) {
        let r = this._lbFocusRow - 1;
        while (r >= 0 && this._lbGetRowItems(r).length === 0) r--;
        if (r >= 0) {
          this._lbFocusRow = r;
          const rowLen = this._lbGetRowItems(r).length;
          this._lbFocusCol = Math.min(this._lbFocusCol, rowLen - 1);
          this._lbApplyFocus();
        }
      }
      if (down && !this._gpPrevDown) {
        let r = this._lbFocusRow + 1;
        while (r <= 2 && this._lbGetRowItems(r).length === 0) r++;
        if (r <= 2) {
          this._lbFocusRow = r;
          const rowLen = this._lbGetRowItems(r).length;
          this._lbFocusCol = Math.min(this._lbFocusCol, rowLen - 1);
          this._lbApplyFocus();
        }
      }
      if (a && !this._gpPrevA) {
        const items = this._lbGetRowItems(this._lbFocusRow);
        const idx = Math.min(this._lbFocusCol, items.length - 1);
        if (items[idx]) items[idx].click();
      }
      if (b && !this._gpPrevB) {
        this._closeLeaderboard();
      }
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }
    if (this.helpModal.classList.contains('visible')) {
      // Right stick Y scrolls the help content
      const helpStickY = gp.axes[3] || 0;
      if (Math.abs(helpStickY) > 0.15) {
        const helpInner = document.getElementById('help-modal-inner');
        if (helpInner) helpInner.scrollTop += helpStickY * 12;
      }
      if (b && !this._gpPrevB) {
        this._closeHelp();
      }
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }

    // Rejoin prompt: navigate between Rejoin / New Room buttons
    const rejoinOverlay = document.getElementById('rejoin-overlay');
    if (rejoinOverlay) {
      const btns = [document.getElementById('btn-rejoin-yes'), document.getElementById('btn-rejoin-no')];
      if (this._rejoinFocus === undefined) this._rejoinFocus = 0;
      if ((left && !this._gpPrevLeft) || (up && !this._gpPrevUp)) {
        btns[this._rejoinFocus].classList.remove('gamepad-focus');
        this._rejoinFocus = Math.max(0, this._rejoinFocus - 1);
        btns[this._rejoinFocus].classList.add('gamepad-focus');
      }
      if ((right && !this._gpPrevRight) || (down && !this._gpPrevDown)) {
        btns[this._rejoinFocus].classList.remove('gamepad-focus');
        this._rejoinFocus = Math.min(btns.length - 1, this._rejoinFocus + 1);
        btns[this._rejoinFocus].classList.add('gamepad-focus');
      }
      if (a && !this._gpPrevA) btns[this._rejoinFocus].click();
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }
    this._rejoinFocus = undefined;

    // If "Tap to Start" overlay is showing, any button dismisses it
    if (this._tapOverlay) {
      if ((a && !this._gpPrevA) || (b && !this._gpPrevB)) {
        this._dismissTapOverlay();
      }
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }

    // Gamepad code spinner navigation
    if (this._spinnerActive) {
      // Up/down cycles characters (with hold-to-repeat)
      if (up && !this._gpPrevUp) this._spinnerStartRepeat(-1);
      if (down && !this._gpPrevDown) this._spinnerStartRepeat(1);
      if (!up && this._gpPrevUp) this._spinnerStopRepeat();
      if (!down && this._gpPrevDown) this._spinnerStopRepeat();
      // Left/right moves between slots
      if (left && !this._gpPrevLeft) {
        this._spinnerSlot = Math.max(0, this._spinnerSlot - 1);
        this._applySpinnerFocus();
      }
      if (right && !this._gpPrevRight) {
        this._spinnerSlot = Math.min(3, this._spinnerSlot + 1);
        this._applySpinnerFocus();
      }
      // A button submits directly
      if (a && !this._gpPrevA) this._spinnerSubmit();
      if (b && !this._gpPrevB) this._goBack();
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }

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

    // Difficulty buttons are horizontal — up/down should skip over siblings
    const focusedEl = items[this._focusIndex];
    if (focusedEl && focusedEl.classList.contains('difficulty-btn')) {
      if (dir === -1) {
        // Up from any difficulty button: jump to tutorial button if visible, else last level card
        const preDiffItem = [...items].reverse().find(el =>
          !el.classList.contains('difficulty-btn') &&
          el.offsetParent !== null && el.style.display !== 'none' &&
          items.indexOf(el) < items.indexOf(focusedEl)
        );
        if (preDiffItem) {
          this._clearFocusHighlight();
          this._focusIndex = items.indexOf(preDiffItem);
          this._applyFocusHighlight();
          return;
        }
      } else {
        // Down from any difficulty button: jump past all difficulty buttons
        const firstNonDiff = items.findIndex((el, i) =>
          i > this._focusIndex && !el.classList.contains('difficulty-btn') &&
          el.offsetParent !== null && el.style.display !== 'none'
        );
        if (firstNonDiff >= 0) {
          this._clearFocusHighlight();
          this._focusIndex = firstNonDiff;
          this._applyFocusHighlight();
          return;
        }
      }
    }

    // Down from a level card: jump to first difficulty button if next visible item is one
    if (dir === 1 && focusedEl && focusedEl.classList.contains('level-card')) {
      // Find the next visible item
      let nextIdx = this._focusIndex + 1;
      while (nextIdx < items.length && items[nextIdx] && (items[nextIdx].offsetParent === null || items[nextIdx].style.display === 'none')) nextIdx++;
      const next = items[nextIdx];
      if (next && next.classList.contains('difficulty-btn')) {
        // Jump to the middle difficulty button (default selection)
        const diffBtns = items.filter(el => el.classList.contains('difficulty-btn'));
        const selected = diffBtns.find(el => el.classList.contains('selected')) || diffBtns[0];
        if (selected) {
          this._clearFocusHighlight();
          this._focusIndex = items.indexOf(selected);
          this._applyFocusHighlight();
          return;
        }
      }
    }

    this._clearFocusHighlight();
    // Skip hidden items
    let next = this._focusIndex + dir;
    while (next >= 0 && next < items.length) {
      const el = items[next];
      if (el && el.offsetParent !== null && el.style.display !== 'none') break;
      next += dir;
    }
    this._focusIndex = Math.max(0, Math.min(items.length - 1, next));
    // If we landed on a hidden item, stay put
    const landed = items[this._focusIndex];
    if (landed && (landed.offsetParent === null || landed.style.display === 'none')) {
      this._focusIndex -= dir; // revert
    }
    this._applyFocusHighlight();
  }

  _moveColumn(dir) {
    // If focused on a difficulty button, move to sibling difficulty button instead of changing columns
    const items = this._stepItems.get(this._currentStep);
    const focusedEl = items && items[this._focusIndex];
    if (focusedEl && focusedEl.classList.contains('difficulty-btn')) {
      const siblings = [...focusedEl.parentElement.querySelectorAll('.difficulty-btn')];
      const curIdx = siblings.indexOf(focusedEl);
      const nextIdx = curIdx + dir;
      if (nextIdx >= 0 && nextIdx < siblings.length) {
        // Find the target button in the items list and move focus there
        const target = siblings[nextIdx];
        const targetFocusIdx = items.indexOf(target);
        if (targetFocusIdx >= 0) {
          this._clearFocusHighlight();
          this._focusIndex = targetFocusIdx;
          this._applyFocusHighlight();
        }
      }
      return;
    }

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
    this._stepItems.set(this._currentStep, colItems);
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
    if (!this.input || !this.input.gamepadConnected) return;
    const items = this._stepItems.get(this._currentStep);
    if (!items || items.length === 0) return;

    const el = items[this._focusIndex];
    if (el) el.classList.add('gamepad-focus');
  }

  _clearFocusHighlight() {
    const prev = this.lobbyEl.querySelector('.gamepad-focus');
    if (prev) prev.classList.remove('gamepad-focus');
  }

  // ============================================================
  // BIKE CAROUSEL
  // ============================================================

  async _initBikeCarousel() {
    // Load presets
    try {
      const resp = await fetch('tandem-3d/bike-presets.json');
      this._presetData = await resp.json();
    } catch (e) {
      console.warn('Failed to load bike presets:', e);
    }
    try {
      const holidayResp = await fetch('tandem-3d/bike-presets-holidays.json');
      if (holidayResp.ok) {
        const holidayData = await holidayResp.json();
        Object.assign(this._presetData, holidayData);
      }
    } catch (e) {
      console.warn('Failed to load holiday bike presets:', e);
    }
    this._presetKeys = ['default', ...Object.keys(this._presetData)];

    // Setup mini 3D preview
    const canvas = document.getElementById('bike-preview-canvas');
    const w = canvas.clientWidth || 220;
    const h = canvas.clientHeight || 132;

    this._previewRenderer = new THREE.WebGLRenderer({
      canvas, antialias: true
    });
    this._previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._previewRenderer.setSize(w, h);
    this._previewRenderer.setClearColor(0x8b7355, 1);
    this._previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._previewRenderer.toneMappingExposure = 1.2;
    this._previewRenderer.shadowMap.enabled = true;
    this._previewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this._previewScene = new THREE.Scene();
    this._previewScene.fog = new THREE.Fog(0x8b7355, 6, 14);
    this._previewCamera = new THREE.PerspectiveCamera(28, w / h, 0.1, 100);
    this._previewCamera.position.set(0, 1.4, 4.2);
    this._previewCamera.lookAt(0, 0.5, 0);

    // Lights
    this._previewScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(5, 8, 5);
    dir.castShadow = true;
    dir.shadow.mapSize.set(512, 512);
    dir.shadow.camera.near = 0.5;
    dir.shadow.camera.far = 20;
    dir.shadow.camera.left = -3;
    dir.shadow.camera.right = 3;
    dir.shadow.camera.top = 3;
    dir.shadow.camera.bottom = -3;
    dir.shadow.bias = -0.002;
    this._previewScene.add(dir);
    const rim = new THREE.DirectionalLight(0x8899cc, 0.5);
    rim.position.set(-3, 4, -4);
    this._previewScene.add(rim);

    // Ground plane
    const groundGeo = new THREE.CircleGeometry(3, 32);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x7a6548, roughness: 0.9, metalness: 0.0
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    this._previewScene.add(ground);

    // Load bike model
    const loader = new GLTFLoader();
    loader.load(BIKE_MODEL_PATH, (gltf) => {
      this._previewModel = gltf.scene;

      // Scale to fit preview
      const box = new THREE.Box3().setFromObject(this._previewModel);
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 3.0 / maxDim;
      this._previewModel.scale.setScalar(scale);

      // Center horizontally/depth, sit on ground
      this._previewModel.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(this._previewModel);
      const center = b2.getCenter(new THREE.Vector3());
      this._previewModel.position.x -= center.x;
      this._previewModel.position.z -= center.z;
      this._previewModel.position.y -= b2.min.y;

      // Clone all materials and store originals
      this._previewOriginalMats = new Map();
      this._previewModel.traverse(child => {
        if (child.isMesh) {
          child.material = child.material.clone();
          child.castShadow = true;
          this._previewOriginalMats.set(child.name, child.material.clone());
        }
      });

      // Add to rotating pivot
      this._previewPivot = new THREE.Group();
      this._previewPivot.add(this._previewModel);
      this._previewScene.add(this._previewPivot);

      this._startPreviewLoop();
      this._applyPresetToPreview();
    });

    // Arrow navigation
    const prevBtn = document.getElementById('bike-prev');
    const nextBtn = document.getElementById('bike-next');
    this._bikePrev = () => {
      this._presetIndex = (this._presetIndex - 1 + this._presetKeys.length) % this._presetKeys.length;
      this._applyPresetToPreview();
      this._sendBikeSyncIfInRoom();
    };
    this._bikeNext = () => {
      this._presetIndex = (this._presetIndex + 1) % this._presetKeys.length;
      this._applyPresetToPreview();
      this._sendBikeSyncIfInRoom();
    };
    prevBtn.addEventListener('click', this._bikePrev);
    nextBtn.addEventListener('click', this._bikeNext);
    prevBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._bikePrev(); });
    nextBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._bikeNext(); });

    // Touch swipe on canvas
    let touchStartX = 0;
    const previewWrap = document.getElementById('bike-preview-wrap');
    previewWrap.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    previewWrap.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 30) {
        if (dx < 0) this._bikeNext();
        else this._bikePrev();
      }
    }, { passive: true });
  }

  _applyPresetToPreview() {
    const key = this._presetKeys[this._presetIndex];
    const nameEl = document.getElementById('bike-name');
    const locked = HOLIDAY_BIKES[key] && !this._isHolidayUnlocked(key);
    nameEl.style.color = locked ? 'rgba(255,255,255,0.3)' : (BIKE_COLORS[key] || 'rgba(68, 255, 102, 0.7)');

    // Reset all materials to originals
    if (this._previewModel && this._previewOriginalMats) {
      this._previewModel.traverse(child => {
        if (!child.isMesh) return;
        const orig = this._previewOriginalMats.get(child.name);
        if (!orig) return;
        child.material.copy(orig);
        child.material.needsUpdate = true;
      });
    }

    this.selectedPresetKey = locked ? 'default' : key;

    if (locked) {
      nameEl.textContent = '\uD83D\uDD12 ' + (BIKE_NAMES[key] || key);
      // Show hint below name
      let hintEl = document.getElementById('bike-hint');
      if (!hintEl) {
        hintEl = document.createElement('div');
        hintEl.id = 'bike-hint';
        hintEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);margin-top:2px;text-align:center;';
        nameEl.parentNode.insertBefore(hintEl, nameEl.nextSibling);
      }
      // Show per-bike progress: ✓ won / ✗ not yet
      let earnedIds = [];
      try {
        const raw = localStorage.getItem('tandemonium_achievements');
        if (raw) earnedIds = JSON.parse(raw).map(a => a.id);
      } catch { /* empty */ }
      const lines = HOLIDAY_BIKES[key].requires.map(k => {
        const achId = BIKE_ACHIEVEMENT_MAP[k];
        const done = achId && earnedIds.includes(achId);
        const name = BIKE_NAMES[k] || k;
        return done ? `✓ ${name}` : `✗ ${name}`;
      });
      hintEl.innerHTML = lines.map(l =>
        l.startsWith('✓')
          ? `<span style="color:rgba(100,255,100,0.7)">${l}</span>`
          : `<span style="color:rgba(255,255,255,0.4)">${l}</span>`
      ).join('<br>');
      hintEl.style.display = '';

      // Grey out the preview model
      this.selectedPreset = null;
      if (this._previewModel) {
        this._previewModel.traverse(child => {
          if (!child.isMesh) return;
          child.material.color.set(0x444444);
          child.material.emissive && child.material.emissive.set(0x000000);
          child.material.needsUpdate = true;
        });
      }
      return;
    }

    const hintEl = document.getElementById('bike-hint');
    if (HOLIDAY_BIKES[key]) {
      // Unlocked holiday bike — show how it was earned
      nameEl.textContent = '🏆 ' + (BIKE_NAMES[key] || key);
      if (hintEl) {
        const wonWith = HOLIDAY_BIKES[key].requires.map(k => BIKE_NAMES[k] || k).join(', ');
        hintEl.innerHTML = `<span style="color:rgba(100,255,100,0.7)">Won with ${wonWith}</span>`;
        hintEl.style.display = '';
      }
    } else {
      if (hintEl) hintEl.style.display = 'none';
      nameEl.textContent = BIKE_NAMES[key] || key;
    }

    if (key === 'default') {
      this.selectedPreset = null;
      return;
    }
    this.selectedPreset = this._presetData[key];

    // Apply preset materials
    if (!this._previewModel) return;
    const preset = this._presetData[key];
    this._previewModel.traverse(child => {
      if (!child.isMesh) return;
      const entry = preset[child.name];
      if (!entry) return;
      const mat = child.material;
      if (entry.color && mat.color) mat.color.set(entry.color);
      if (entry.emissive && mat.emissive) mat.emissive.set(entry.emissive);
      if (entry.metalness !== undefined) mat.metalness = entry.metalness;
      if (entry.roughness !== undefined) mat.roughness = entry.roughness;
      if (entry.opacity !== undefined) {
        mat.opacity = entry.opacity;
        mat.transparent = entry.opacity < 1;
      }
      if (entry.wireframe !== undefined) mat.wireframe = entry.wireframe;
      if (entry.side !== undefined) mat.side = entry.side;
      if (entry.disabledTextures) {
        for (const tk of entry.disabledTextures) mat[tk] = null;
        mat.needsUpdate = true;
      }
    });

  }

  _sendBikeSyncIfInRoom() {
    if ((this._currentStep === this.roomStep || this._currentStep === this.roomLevelsStep) && this.net && this.net.connected) {
      this.net.sendProfile({ type: 'bikeSync', presetKey: this.selectedPresetKey });
    }
  }

  _startPreviewLoop() {
    if (this._previewRafId) return;
    const animate = () => {
      this._previewRafId = requestAnimationFrame(animate);
      if (this._previewPivot) {
        this._previewPivot.rotation.y += 0.008;
      }
      this._previewRenderer.render(this._previewScene, this._previewCamera);
    };
    animate();
  }

  _stopPreviewLoop() {
    if (this._previewRafId) {
      cancelAnimationFrame(this._previewRafId);
      this._previewRafId = null;
    }
  }

  _isHolidayUnlocked(bikeKey) {
    const def = HOLIDAY_BIKES[bikeKey];
    if (!def) return true;
    // Read earned achievement IDs from localStorage (same store as AchievementManager)
    let earnedIds = [];
    try {
      const raw = localStorage.getItem('tandemonium_achievements');
      if (raw) earnedIds = JSON.parse(raw).map(a => a.id);
    } catch { /* empty */ }
    return def.requires.every(k => {
      const achId = BIKE_ACHIEVEMENT_MAP[k];
      return achId && earnedIds.includes(achId);
    });
  }
}
