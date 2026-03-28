// ============================================================
// LOBBY — UI controller for mode/role selection + connection
// ============================================================
//
// ═══════════════════════════════════════════════════════════════
// LOBBY COMPONENT CATALOG
// ═══════════════════════════════════════════════════════════════
//
// SCREENS (lobby steps, shown/hidden by _showStep):
//   #lobby-mode         — Mode selection (Solo / Ride Together)       back: none (root)
//   #lobby-level        — Level + difficulty selection (solo path)    back: #lobby-mode
//   #lobby-role         — Role selection (Captain / Stoker)           back: #lobby-mode
//   #lobby-host         — Captain waiting room (room code + QR)      back: #lobby-role
//   #lobby-join         — Stoker join room (code input / spinner)     back: #lobby-role
//   #lobby-room         — Multiplayer social room (video + PLAY)     back: leave room
//   (multiplayer reuses #lobby-level with START RIDE / wait text)
//
// SHARED COMPONENTS:
//   Level Card           — .level-card button, built by _buildLevelCards() / _buildRoomLevelCards()
//   Difficulty Selector  — #difficulty-selector, wired by _setupDifficultySelector()
//   Tutorial Level Card   — .level-card-tutorial, built in the LEVELS loop (dashed border)
//   Back Button          — .lobby-back per step, plus #lobby-fixed-back (non-gamepad)
//   Toggle Columns       — .lobby-left-col (help/leaderboard/profile)
//                          .lobby-right-col (camera/audio/joystick/motion/music)
//   Waiting Text         — .conn-status elements ("Waiting for captain...")
//
// GAMEPAD NAVIGATION:
//   _stepItems           — Map<step, focusableElements[]> — active nav items per step
//   _stepCenterItems     — Map<step, elements[]> — immutable center column items
//   _stepBack            — Map<step, backButton> — back button per step
//   _modeColumns         — 4-column layout [leftToggles, center, rightToggles, farRight]
//   _moveFocus(dir)      — vertical nav (up/down), skips difficulty siblings
//   _moveColumn(dir)     — horizontal nav (left/right), difficulty sibling cycling
//   _pollGamepadNav()    — RAF loop polling gamepad, dispatches to above
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { NetworkManager } from './network-manager.js';
import { isMobile, RELAY_URL, SITE_URL, BIKE_MODEL_PATH, TUNE, applySteeringFeel, snapshotTuningBase } from './config.js';
import { LEVELS } from './race-config.js';
import { AuthManager } from './auth.js';
import { LicenseManager } from './license.js';
import { AchievementManager, updateBadgeDisplay } from './achievements.js';
import * as analytics from './analytics.js';
import { ControllerRegistry } from './controllers/controller-registry.js';

// Timeout wrapper for permission promises that may hang on iOS stale tabs
const PERMISSION_TIMEOUT_MS = 8000;
function withTimeout(promise, ms = PERMISSION_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('permission_timeout')), ms))
  ]);
}

const DEFAULT_AVATAR_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Ccircle cx='40' cy='30' r='14' fill='%23666'/%3E%3Cellipse cx='40' cy='72' rx='24' ry='18' fill='%23666'/%3E%3C/svg%3E";

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
    this.selectedDifficulty = 'chill'; // 'chill' | 'adventurous' | 'daredevil'
    this._pendingMode = null; // 'solo' or 'multiplayer', set during level selection

    this.lobbyEl = document.getElementById('lobby');
    this.modeStep = document.getElementById('lobby-mode');
    this.levelStep = document.getElementById('lobby-level');
    this.roleStep = document.getElementById('lobby-role');
    this.hostStep = document.getElementById('lobby-host');
    this.joinStep = document.getElementById('lobby-join');
    this.roomStep = document.getElementById('lobby-room');
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
    this._hasCamera = true; // assume true, check async below

    // Hide camera toggle if no camera hardware exists
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        this._hasCamera = devices.some(d => d.kind === 'videoinput');
        if (!this._hasCamera) {
          this.toggleCamera.style.display = 'none';
          this.cameraActive = false;
          this._setToggleActive('camera', false);
        }
      }).catch(() => {});
    }
    this._motionPermitted = false;
    this._audioPermitted = false;
    this._permissionsChecked = false;

    // Music toggle (not a permission — just on/off, persisted in localStorage)
    this.musicActive = localStorage.getItem('tandemonium_music') !== 'off';
    // Sync: if volume was set to Mute, treat music as inactive
    const initSavedVol = localStorage.getItem('tandemonium_music_volume');
    if (initSavedVol !== null && parseFloat(initSavedVol) === 0) {
      this.musicActive = false;
    }
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

    // Steam: bypass LicenseManager when Steam ownership is confirmed
    // Initialize with a default license so code that reads this.license.isLicensed
    // before _initSteamLicense completes doesn't crash.
    this._isSteam = false;
    this.license = new LicenseManager(this.auth);
    this._steamReady = this._initSteamLicense().then(() => this._setupAuth());
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

    // "Tap/Press to Start" overlay — unlocks audio autoplay + activates gamepad.
    // On desktop: shows "Press any button to start" and polls for controller input.
    // On mobile: shows "Tap to Start" for audio unlock.
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

    const isDesktop = window.steam || navigator.userAgent.includes('Electron') || navigator.userAgent.includes('electron');

    if (isDesktop) {
      // Desktop: the button press that dismissed the overlay also activated the gamepad.
      // Poll briefly to let Chromium register it, then show toggles + auto-connect gyro.
      console.log('Desktop: overlay dismissed, activating gamepad...');
      let attempts = 0;
      const detectGamepad = () => {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < gamepads.length; i++) {
          if (!gamepads[i]) continue;
          // Register with input manager
          if (this.input && !this.input.gamepadConnected) {
            this.input.gamepadIndex = i;
            this.input.gamepadConnected = true;
            this.input._gpName = gamepads[i].id;
            // GameSir Cyclone reports as "Gamepad" with Switch Pro IDs but has
            // swapped A/B buttons (Nintendo layout). Detect and store swap flag.
            this.input._gpSwapAB = /^Gamepad/i.test(gamepads[i].id) && /057e/i.test(gamepads[i].id);
            console.log('Desktop: gamepad activated:', gamepads[i].id, this.input._gpSwapAB ? '(A/B swapped)' : '');
          }
          // Show joystick toggle
          this.toggleJoystick.style.display = '';
          this._setToggleActive('joystick', this.joystickActive);
          // Check for gyro-capable controller and auto-connect
          if (navigator.hid) {
            this._checkGamepadGyro();
          }
          // Start music
          if (this.onMusicChanged) this.onMusicChanged(true);
          return;
        }
        // Retry for up to 2 seconds
        attempts++;
        if (attempts < 20) setTimeout(detectGamepad, 100);
      };
      setTimeout(detectGamepad, 200);
    } else {
      // Mobile/browser: request all permissions (audio, camera, motion)
      this._toggleAll();
      if (this.musicActive && this.onMusicChanged) {
        this.onMusicChanged(true);
      }
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
    // Refresh achievements and bike unlock state earned during the ride
    if (this._achievements) this._achievements.reload();
    this._renderAchievements();
    this._applyPresetToPreview();
    // Rebuild level cards to reflect newly unlocked levels
    this._rebuildLevelCards();
    this._showStep(this.modeStep);
    this._startGamepadNav();
    this._checkPermissionStates();
    if (this._previewModel) this._startPreviewLoop();
  }

  /**
   * Transition to a lobby step. Handles: hiding all other steps, toggle column
   * visibility (hidden on join), bike carousel visibility (hidden on level steps),
   * difficulty selector visibility, fixed back button text, column nav reset,
   * card header update, and initial gamepad focus.
   * @param {HTMLElement} step — the step div to show (e.g. this.levelStep)
   */
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
    [this.modeStep, this.levelStep, this.roleStep, this.hostStep, this.joinStep, this.roomStep]
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
    const hideCarousel = (step === this.levelStep);
    if (carousel) carousel.style.display = hideCarousel ? 'none' : '';
    if (lobbyCard) lobbyCard.classList.toggle('carousel-hidden', hideCarousel);
    const lobbyEl = document.getElementById('lobby');
    if (lobbyEl) lobbyEl.classList.toggle('lobby-wide', hideCarousel);

    // Show shared difficulty selector on level step; reset hidden state
    const diffSel = document.getElementById('difficulty-selector');
    const showDiff = (step === this.levelStep);
    if (diffSel) {
      diffSel.style.display = showDiff ? '' : 'none';
      // Reset context-aware visibility (show by default, based on selected level)
      if (showDiff) {
        const selId = this.selectedLevel ? this.selectedLevel.id : null;
        this._updateDifficultyVisibility(selId);
      }
    }

    // Show/hide #level-extras wrapper (START RIDE + wait text)
    // Wrapper scopes these to the level step; child visibility is set by
    // _buildLevelCards (solo) or _showRoomLevelsStep (multiplayer role).
    const levelExtras = document.getElementById('level-extras');
    if (levelExtras) levelExtras.style.display = showDiff ? '' : 'none';

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
    if (step === this.levelStep) {
      requestAnimationFrame(() => this._adjustLevelCompact());
    }

    // ── PiP class management ──
    // Show PiP circles on room (hero size) and multiplayer level (scaled down).
    // Hidden on all other steps (base CSS display:none).
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    if (selfieWrap && partnerWrap) {
      const isRoom = (step === this.roomStep);
      const isMultiplayerLevel = (step === this.levelStep && this._pendingMode === 'multiplayer');
      selfieWrap.classList.toggle('pip-lobby-mode', isRoom);
      selfieWrap.classList.toggle('pip-level-mode', isMultiplayerLevel);
      partnerWrap.classList.toggle('pip-lobby-mode', isRoom);
      partnerWrap.classList.toggle('pip-level-mode', isMultiplayerLevel);
    }
  }

  _hideLobby() {
    this.lobbyEl.style.display = 'none';
    this._stopGamepadNav();
    this._stopPreviewLoop();
  }

  _setup() {
    // SOLO → always show level selection
    document.getElementById('btn-solo').addEventListener('click', async () => {
      analytics.trackFirstInput('solo');
      await this._requestMotion();
      this._syncMotionState();
      this._pendingMode = 'solo';
      this._detectAndSetInputMethod();
      this._showStep(this.levelStep);
    });

    // RIDE TOGETHER → check for rejoin, then role selection
    document.getElementById('btn-together').addEventListener('click', async () => {
      analytics.trackFirstInput('together');
      // Check for saved room to rejoin
      const rejoined = await this._handleRejoinCheck();
      if (rejoined) return;

      await this._requestMotion();
      this._syncMotionState();
      this._pendingMode = 'multiplayer';
      this._detectAndSetInputMethod();
      this._updateRoleButtons();
      this._showStep(this.roleStep);
    });

    // Level selection: build cards and handle clicks
    this._buildLevelCards();
    this._setupDifficultySelector();

    document.getElementById('btn-back-level').addEventListener('click', () => {
      if (this._pendingMode === 'multiplayer') {
        // Reset multiplayer elements when leaving level step
        const startBtn = document.getElementById('btn-start-ride');
        const waitText = document.getElementById('level-wait-text');
        const prompt = document.getElementById('level-prompt');
        if (startBtn) startBtn.style.display = 'none';
        if (waitText) waitText.style.display = 'none';
        if (prompt) prompt.style.display = 'none';
        // Reset difficulty selector interactivity
        const diffSel = document.getElementById('difficulty-selector');
        if (diffSel) { diffSel.style.opacity = ''; diffSel.style.pointerEvents = ''; }
        this._showStep(this.roomStep);
      } else {
        this._showStep(this.modeStep);
      }
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

    // CAPTAIN (START A RIDE) — open to all players
    document.getElementById('btn-captain').addEventListener('click', async () => {
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

    // Levels step: START RIDE button — works for both solo and multiplayer
    document.getElementById('btn-start-ride').addEventListener('click', () => {
      if (this._pendingMode === 'multiplayer') {
        if (this._roomRole !== 'captain') return;
        // Send start ride to partner — block if not connected
        if (!this.net || !this.net.connected) {
          const statusEl = document.getElementById('status');
          if (statusEl) statusEl.textContent = 'Reconnecting to partner...';
          return;
        }
        this.net.sendProfile({ type: 'startRide' });
        this._transitionToGame();
      } else {
        // Solo: start game directly
        this._hideLobby();
        this.onSolo();
      }
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
    this.toggleCamera.addEventListener('click', () => {
      this._toggleCamera();
      analytics.trackEvent('video_toggle', { enabled: this.cameraActive });
    });
    this.toggleMotion.addEventListener('click', () => this._toggleMotion());
    this.toggleJoystick.addEventListener('click', () => this._toggleJoystick());
    this.toggleAudio.addEventListener('click', () => {
      this._toggleAudio();
      analytics.trackEvent('audio_toggle', { enabled: this.audioActive });
    });
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
      if (!this._musicLongPressed) {
        this._toggleMusic();
        this._musicHandledByPointer = true; // prevent click from double-firing
      }
    });
    this.toggleMusic.addEventListener('pointerleave', () => {
      clearTimeout(this._longPressTimer);
    });
    this.toggleMusic.addEventListener('pointercancel', () => {
      clearTimeout(this._longPressTimer);
    });
    // Gamepad A-button fires .click() not pointerdown/pointerup — handle it
    this.toggleMusic.addEventListener('click', () => {
      if (this._musicHandledByPointer) {
        this._musicHandledByPointer = false;
        return; // already handled by pointerup
      }
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

  /**
   * Shared level card builder used by both solo and multiplayer paths.
   * Creates a button per non-tutorial level, handles unlock logic, click behavior,
   * optional tutorial button, and gamepad nav registration.
   * @param {Object} opts
   * @param {HTMLElement} opts.container       — DOM element to append cards to
   * @param {boolean}     opts.isClickable     — true for solo/captain, false for stoker
   * @param {'solo'|'multiplayer'} opts.mode   — determines click behavior
   * @param {boolean}     opts.showTutorial    — whether to include Learn to Ride button
   * @param {HTMLElement|null} opts.startBtn   — START RIDE button (multiplayer only)
   * @param {HTMLElement} opts.backBtn         — back button for this step
   * @param {HTMLElement} opts.step            — step element for _stepItems registration
   */
  _buildLevelCardsShared({ container, isClickable, mode, showTutorial, startBtn, backBtn, step }) {
    container.innerHTML = '';
    const buttons = [];

    // Level unlock requirements: Castle requires finishing Grandma's House
    const LEVEL_UNLOCK = { castle: 'home_sweet' };

    // Check if gyro is active but uncalibrated (show recommendation, don't lock)
    const needsTuning = this._needsMotionTuning();

    const levels = showTutorial ? LEVELS : LEVELS.filter(l => !l.isTutorial);

    levels.forEach(level => {
      const isTutorial = level.isTutorial;
      const requiredAch = LEVEL_UNLOCK[level.id];
      const locked = !isTutorial && requiredAch && !this._achievements.getEarnedIds().includes(requiredAch);

      const card = document.createElement('button');
      card.className = 'level-card' + (locked ? ' level-locked' : '') + (isTutorial ? ' level-card-tutorial' : '');
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
        // Tutorial description adapts to calibration state
        const desc = isTutorial && needsTuning
          ? '\u2B50 Recommended for calibration'
          : level.description;
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">' + level.icon + '</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' + desc + '</div>';

        if (isClickable) {
          card.addEventListener('click', () => {
            this.selectedLevel = level;
            this._forceWizard = isTutorial;
            this._updateDifficultyVisibility(level.id);
            container.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            if (startBtn) startBtn.disabled = false;
            analytics.trackEvent('level_select', { level: level.id, difficulty: this.selectedDifficulty });
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

    // Default selection: restore previous or pick first unlocked non-tutorial level
    if (isClickable) {
      let defaultCard = null;
      if (this.selectedLevel) {
        // Restore previous selection
        defaultCard = container.querySelector('.level-card[data-level-id="' + this.selectedLevel.id + '"]:not(.level-locked)');
      }
      if (!defaultCard) {
        // Pick first unlocked non-tutorial level (Grandma's)
        defaultCard = container.querySelector('.level-card:not(.level-locked):not(.level-card-tutorial)');
      }
      if (defaultCard) {
        defaultCard.classList.add('selected');
        this.selectedLevel = LEVELS.find(l => l.id === defaultCard.dataset.levelId);
        this._forceWizard = !!(this.selectedLevel && this.selectedLevel.isTutorial);
        if (startBtn) startBtn.disabled = false;
        this._updateDifficultyVisibility(defaultCard.dataset.levelId);
        // Sync to partner on multiplayer re-entry
        if (this.net && this.net.connected) {
          this.net.sendProfile({ type: 'levelSync', levelId: this.selectedLevel.id });
        }
      }
    }

    // Add individual difficulty buttons to gamepad navigation
    if (isClickable) {
      const diffBtns = document.querySelectorAll('#difficulty-selector .difficulty-btn');
      diffBtns.forEach(b => buttons.push(b));
    }

    // Multiplayer: add START RIDE button to nav after difficulty (natural flow)
    if (startBtn && isClickable) buttons.push(startBtn);

    // Register for gamepad navigation
    const navItems = isClickable ? [...buttons, backBtn] : [backBtn];
    this._stepItems.set(step, navItems);
    this._stepCenterItems.set(step, navItems);
    this._stepBack.set(step, backBtn);
  }

  /**
   * Build solo-path level cards. Thin wrapper around _buildLevelCardsShared().
   * Also hides multiplayer-only elements in the shared #lobby-level step.
   */
  _buildLevelCards() {
    // Hide multiplayer elements in the shared level step
    const startBtn = document.getElementById('btn-start-ride');
    const waitText = document.getElementById('level-wait-text');
    const prompt = document.getElementById('level-prompt');
    // Reset START RIDE button state (visibility handled by _showStep)
    if (startBtn) { startBtn.disabled = true; }
    if (waitText) waitText.style.display = 'none';
    if (prompt) prompt.style.display = 'none';
    // Reset difficulty selector interactivity
    const diffSel = document.getElementById('difficulty-selector');
    if (diffSel) { diffSel.style.opacity = ''; diffSel.style.pointerEvents = ''; }

    this._buildLevelCardsShared({
      container: document.getElementById('level-cards'),
      isClickable: true,
      mode: 'solo',
      showTutorial: true,
      startBtn: startBtn,
      backBtn: document.getElementById('btn-back-level'),
      step: this.levelStep
    });
  }

  _rebuildLevelCards() {
    const container = document.getElementById('level-cards');
    container.innerHTML = '';
    this._buildLevelCards();
    // Sync _modeColumns[1] only if we're currently on the level step
    if (this._currentStep === this.levelStep) {
      const centerItems = this._stepCenterItems.get(this.levelStep) || [];
      this._modeColumns[1] = centerItems;
      if (this._modeCol === 1) {
        this._stepItems.set(this.levelStep, centerItems);
      }
    }
  }

  /**
   * Update difficulty selector based on selected level. Tutorial forces Chill
   * and disables harder options; real levels re-enable all options.
   * @param {string|null} levelId — level ID being selected, or null to enable all
   */
  _updateDifficultyVisibility(levelId) {
    const isTutorial = levelId === 'tutorial';
    const diffBtns = document.querySelectorAll('#difficulty-selector .difficulty-btn');
    diffBtns.forEach(btn => {
      const diff = btn.dataset.difficulty;
      if (isTutorial && diff !== 'chill') {
        btn.disabled = true;
        btn.classList.add('diff-disabled');
      } else {
        btn.disabled = false;
        btn.classList.remove('diff-disabled');
      }
    });
    // Auto-select Chill when tutorial is chosen
    if (isTutorial) {
      diffBtns.forEach(b => b.classList.remove('selected'));
      const chillBtn = document.querySelector('#difficulty-selector .difficulty-btn[data-difficulty="chill"]');
      if (chillBtn) chillBtn.classList.add('selected');
      this.selectedDifficulty = 'chill';
    }
  }

  /**
   * Wire click handlers on all .difficulty-btn elements. Keeps both selectors
   * (solo and room) in sync — clicking one updates all matching buttons.
   * Syncs selected difficulty to partner via net.sendProfile if connected.
   * Stores selection in this.selectedDifficulty.
   */
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

  async _initSteamLicense() {
    if (!window.steam) {
      this.license = new LicenseManager(this.auth);
      return;
    }
    try {
      const available = await window.steam.isAvailable();
      if (!available) {
        this.license = new LicenseManager(this.auth);
        return;
      }
      const subscribed = await window.steam.isSubscribed();
      if (subscribed) {
        this._isSteam = true;
        // Shim: Steam ownership = fully licensed, no network checks needed
        this.license = {
          isLicensed: true,
          isFreePlay: false,
          accessLevel: 'licensed',
          _license: { licensed: true },
          check: async () => {},
          refresh: async () => {},
          clear: () => {},
        };
        // Hide all Google sign-in UI on Steam — Steam users auth via Steam identity
        const gsiBtn = document.getElementById('gsi-button-container');
        if (gsiBtn) gsiBtn.style.display = 'none';
        const signInBtn = document.getElementById('btn-sign-in');
        if (signInBtn) signInBtn.style.display = 'none';
        // Hide logout button — Steam auth is tied to Steam identity
        const logoutBtn = document.getElementById('profile-popup-logout');
        if (logoutBtn) logoutBtn.style.display = 'none';
      } else {
        this.license = new LicenseManager(this.auth);
      }
    } catch (e) {
      console.warn('Steam license check failed, falling back to LicenseManager', e);
      this.license = new LicenseManager(this.auth);
    }
  }

  _setupAuth() {
    this.profilePopup = document.getElementById('profile-popup');
    const popupAvatar = document.getElementById('profile-popup-avatar');
    const popupName = document.getElementById('profile-popup-name');
    const popupEmail = document.getElementById('profile-popup-email');
    const logoutBtn = document.getElementById('profile-popup-logout');

    // Initialize auth: Steam auto-login or Google Sign-In
    const isElectron = navigator.userAgent.includes('Electron');
    if (this._isSteam) {
      // Steam users auto-authenticate — no Google sign-in needed
      this.auth.loginWithSteam();
    } else if (isElectron) {
      // Electron without Steam (shouldn't happen) — don't init Google OAuth
      // Google OAuth won't work from custom protocol origin
      console.warn('AUTH: Electron without Steam — skipping Google sign-in');
    } else {
      this.auth.initGSI();
    }

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
      analytics.trackEvent('auth_complete', {});
      // Check license and update mode buttons + level cards
      await this.license.check();
      this._updateModeButtons();

      // Migrate anonymous tuning to logged-in user if they don't have their own
      this._migrateAnonymousTuning(user);

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
      // Sync all earned achievements to Steam profile (catches web/mobile unlocks)
      if (this._isSteam) {
        this._achievements.syncToSteam();
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

      // Proactively refresh expired JWT before anything needs it
      const tokenReady = this.auth.isTokenExpired()
        ? this.auth.ensureValidToken().catch(() => false)
        : Promise.resolve(true);

      tokenReady.then(() => {
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
      });
    }
    this._updateModeButtons();
  }

  async _requestMotion() {
    if (this.input && this.input.needsMotionPermission) {
      await this.input.requestMotionPermission();
    }
  }

  /** Sync lobby motion flags after permission is granted.
   *  Only auto-enables on first grant — if the user previously had motion
   *  and manually toggled it off, respect their choice.
   */
  _syncMotionState() {
    if (this.input && (this.input.motionEnabled || this.input.gyroConnected)) {
      if (!this.motionActive && !this._motionPermitted) {
        this._showMotionToggle();
        this._motionPermitted = true;
        this.motionActive = true;
        this._setToggleActive('motion', true);
        this._updateTutorialButton();
      }
    }
  }

  _detectAndSetInputMethod() {
    let method = 'keyboard';
    if (this.input) {
      if (this.input.gyroConnected) method = 'gamepad_gyro';
      else if (this.input.gamepadConnected) method = 'gamepad_stick';
      else if (this.input.motionEnabled) method = 'gyro';
      else if (this.motionActive) method = 'gyro';
      // On mobile, motion permission may be granted but events haven't fired yet
      else if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) method = 'gyro';
    }
    analytics.setInputMethod(method);
    analytics.trackEvent('input_select', { method });
  }

  /**
   * Update mode buttons based on auth + license state.
   *   Playtest: all players get full access (SOLO RIDE + RIDE TOGETHER)
   */
  _updateModeButtons() {
    const btnSolo = document.getElementById('btn-solo');
    const btnTogether = document.getElementById('btn-together');
    const access = this.license.accessLevel;

    // All players get full access during playtest
    btnSolo.textContent = 'SOLO RIDE';
    btnTogether.classList.remove('role-locked');
    btnTogether.innerHTML = 'RIDE TOGETHER';

    // License status icon next to version: 🔒 not licensed, ✅ licensed, 🆓 free play
    const licIcon = document.getElementById('lobby-license-icon');
    if (licIcon) {
      const freePlay = this.license.isFreePlay;
      const paidLicense = !!(this.license._license && this.license._license.licensed);
      if (paidLicense) {
        licIcon.textContent = '\u2705'; // ✅
      } else if (freePlay) {
        licIcon.textContent = '\uD83C\uDD93'; // 🆓
      } else {
        licIcon.textContent = '\uD83D\uDD12'; // 🔒
      }
    }
  }

  /**
   * Update role buttons: lock START A RIDE for unlicensed users.
   */
  _updateRoleButtons() {
    const btnCaptain = document.getElementById('btn-captain');
    btnCaptain.classList.remove('role-locked');
    btnCaptain.classList.add('lobby-btn-accent');
    btnCaptain.innerHTML = 'START A RIDE<br><span class="lobby-role-desc">Captain &middot; Front seat</span>';
  }

  // ── Permission toggles ──────────────────────────────────────
  // Track whether the browser permission has been obtained (separate from
  // the user's on/off toggle choice). Once a browser permission is granted
  // we remember it so re-enabling doesn't re-prompt.

  _toggleAll() {
    // If ALL is active, turn everything off
    const motionOk = !this._motionAvailable() || this.motionActive;
    const cameraOk = !this._hasCamera || this.cameraActive;
    if (cameraOk && this.audioActive && motionOk && this.musicActive) {
      if (this.cameraActive) this._toggleCamera();
      if (this.audioActive)  this._toggleAudio();
      if (this._motionAvailable() && this.motionActive) this._toggleMotion();
      if (this.musicActive) this._toggleMusic();
      return;
    }

    // Batch camera + mic into one getUserMedia prompt when both are needed
    const needCam = !this.cameraActive && !this._cameraPermitted && this._hasCamera;
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

    this._updateTutorialButton();
  }

  /** Copy anonymous tuning to a logged-in user's key if they don't have one yet. */
  _migrateAnonymousTuning(user) {
    if (!user || !user.id) return;
    const userKey = 'tandemonium_motion_tuning_' + user.id;
    const anonKey = 'tandemonium_motion_tuning';
    try {
      // Only migrate if user has no saved tuning
      if (localStorage.getItem(userKey)) return;
      const anonData = localStorage.getItem(anonKey);
      if (!anonData) return;
      localStorage.setItem(userKey, anonData);
    } catch {}
  }

  /** Returns the per-user localStorage key for motion tuning. */
  _tuningKey() {
    const userId = this.auth && this.auth.isLoggedIn() && this.auth.getUser() ? this.auth.getUser().id : null;
    return userId ? 'tandemonium_motion_tuning_' + userId : 'tandemonium_motion_tuning';
  }

  _needsMotionTuning() {
    // Only gate levels for motion/gyro players — keyboard/joystick-only don't need calibration
    const hasMotion = this.motionActive && (
      (this.input && this.input.motionEnabled) ||
      (this.input && this.input.gyroConnected)
    );
    if (!hasMotion) return false;
    try {
      const saved = localStorage.getItem(this._tuningKey());
      if (!saved) return true;
      const data = JSON.parse(saved);
      if (data.version !== 1) return true;
      // Re-require if input type changed
      const curType = (this.input && this.input.gyroConnected) ? 'gyro' : 'phone';
      return data.inputType !== curType;
    } catch { return true; }
  }

  _updateTutorialButton() {
    // Rebuild level cards + tutorial button + gamepad nav in one pass.
    // This ensures the gamepad navigation list stays in sync when the
    // tutorial button appears/disappears due to motion toggle changes.
    const container = document.getElementById('level-cards');
    if (container && container.children.length > 0) {
      this._rebuildLevelCards();
    }
  }

  _checkGamepadGyro() {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    const controllerInfo = gp ? ControllerRegistry.identifyFromGamepadId(gp.id) : null;
    if (!controllerInfo || !controllerInfo.hasGyro) return;

    this._showMotionToggle();

    // Auto-connect gyro in Electron/Steam (no user gesture needed for WebHID)
    const isDesktop = window.steam || navigator.userAgent.includes('Electron');
    if (isDesktop && !this.motionActive) {
      setTimeout(() => this._autoConnectGyro(), 1000);
    }
  }

  /** Auto-connect gyro in Electron/Steam — no user gesture needed since
   *  WebHID permissions are granted via session handlers in main.js. */
  _autoConnectGyro() {
    if (this.motionActive || this._motionPermitted) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    const controllerInfo = gp ? ControllerRegistry.identifyFromGamepadId(gp.id) : null;
    if (!controllerInfo || !controllerInfo.hasGyro) return;

    console.log('Auto-connecting gyro for', controllerInfo.driverName, 'in desktop mode...');
    this.input.connectControllerGyro().then(() => {
      if (this.input.gyroConnected) {
        this._motionPermitted = true;
        this.motionActive = true;
        this._setToggleActive('motion', true);
        this._showMotionToggle();
        this._updateTutorialButton();
        console.log('Gyro auto-connected successfully');
      }
    }).catch((err) => {
      console.warn('Gyro auto-connect failed:', err.message);
    });
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
    if (!this._hasCamera) return; // no camera hardware
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
        // Turning off — check if joystick is also off
        if (!this.joystickActive) {
          this._showKeyboardConfirm('motion');
          return;
        }
        // Turn off — disable gyro steering but keep device connected
        this.motionActive = false;
        this.input.motionEnabled = false;
        this.input.motionLean = 0;
        this._setToggleActive('motion', false);
        this._updateTutorialButton();
        return;
      }
      if (this._motionPermitted) {
        // Re-enable previously connected gyro
        this.motionActive = true;
        this.input.motionEnabled = true;
        this.input.startTiltCalibration();
        this._setToggleActive('motion', true);
        this._updateTutorialButton();
        return;
      }
      // First time — request WebHID access
      this.input.connectControllerGyro().then(() => {
        if (this.input.gyroConnected) {
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
          this._updateTutorialButton();
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
          this._updateTutorialButton();
        }
      }, 500);
    }
  }

  _toggleJoystick() {
    if (this.joystickActive) {
      // Turning off — check if motion is also off
      if (!this.motionActive) {
        this._showKeyboardConfirm('joystick');
        return;
      }
      this.joystickActive = false;
      this._setToggleActive('joystick', false);
      if (this.input) this.input.suppressGamepadLean = true;
      try { localStorage.setItem('tandemonium_joystick', 'off'); } catch {}
    } else {
      this.joystickActive = true;
      this._setToggleActive('joystick', true);
      if (this.input) this.input.suppressGamepadLean = false;
      try { localStorage.setItem('tandemonium_joystick', 'on'); } catch {}
    }
  }

  _showKeyboardConfirm(source) {
    // Turn off the toggle immediately
    if (source === 'joystick') {
      this.joystickActive = false;
      this._setToggleActive('joystick', false);
      if (this.input) this.input.suppressGamepadLean = true;
      try { localStorage.setItem('tandemonium_joystick', 'off'); } catch {}
    } else {
      this.motionActive = false;
      if (this.input) { this.input.motionEnabled = false; this.input.motionLean = 0; }
      this._setToggleActive('motion', false);
      this._updateTutorialButton();
    }

    // Show brief "Keyboard only!" notice — tapping the toggle again will re-enable
    const popup = document.getElementById('keyboard-confirm-popup');
    popup.classList.add('visible');
    // Auto-dismiss after 2s or on any click
    const dismiss = () => {
      popup.classList.remove('visible');
      document.removeEventListener('click', autoDismiss, true);
      clearTimeout(timer);
    };
    const autoDismiss = () => dismiss();
    const timer = setTimeout(dismiss, 2000);
    setTimeout(() => document.addEventListener('click', autoDismiss, true), 0);
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
      const oldFeel = TUNE.steeringFeel;
      applySteeringFeel(feel);
      analytics.trackEvent('steering_feel_change', { value: feel, from_value: oldFeel });
      // Save immediately
      try {
        const tuningKey = this._tuningKey();
        const saved = localStorage.getItem(tuningKey);
        if (saved) {
          const data = JSON.parse(saved);
          data.steeringFeel = feel;
          localStorage.setItem(tuningKey, JSON.stringify(data));
        }
      } catch {}
    };

    const dismiss = () => {
      popup.classList.remove('visible');
      document.removeEventListener('click', outsideClick, true);
    };

    document.getElementById('btn-recalibrate').onclick = () => {
      try { localStorage.removeItem(this._tuningKey()); } catch {}
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
    // When toggling on from muted volume, bump to Low so audio is audible
    if (this.musicActive && this.musicVolume === 0) {
      this.musicVolume = 0.10;
      localStorage.setItem('tandemonium_music_volume', 0.10);
      if (this.onVolumeChanged) this.onVolumeChanged(0.10);
      this._updateVolumeUI();
    }
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

    this._lbVideo = { video, renderer, videoTexture, mat, scene, animId };
  }

  _stopLeaderboardVideo() {
    if (!this._lbVideo) return;
    const v = this._lbVideo;
    cancelAnimationFrame(v.animId);
    v.video.pause();
    v.video.src = '';
    v.videoTexture.dispose();
    if (v.scene) {
      v.scene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
      });
    }
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
          this._updateTutorialButton();
        }
        window.removeEventListener('devicemotion', onFirstMotion);
      };
      window.addEventListener('devicemotion', onFirstMotion);
    }
    // else: no DeviceMotionEvent API at all — toggle stays hidden

    // When motion sensor data starts flowing, ensure toggle shows green
    // and re-detect input method so analytics is accurate
    if (this.input) {
      this.input.onMotionEnabled = () => {
        if (!this.motionActive) {
          this._showMotionToggle();
          this._motionPermitted = true;
          this.motionActive = true;
          this._setToggleActive('motion', true);
          this._updateTutorialButton();
        }
        this._detectAndSetInputMethod();
      };
    }

    // Show motion toggle if a gyro-capable gamepad connects later
    window.addEventListener('gamepadconnected', () => {
      // Cancel pending disconnect handler (rapid reconnect debounce)
      clearTimeout(this._gamepadDisconnectTimer);
      // Hide fixed back button when gamepad takes over
      this._fixedBackBtn.style.visibility = 'hidden';
      // Re-prime edge-detect flags so a held button from connection
      // doesn't immediately fire a click in _pollGamepadNav.
      if (this.input && this.input.gamepadConnected) {
        const gamepads = navigator.getGamepads();
        const gp = gamepads[this.input.gamepadIndex];
        if (gp) {
          const btns = this._gpButtons(gp);
          this._gpPrevA = btns.a;
          this._gpPrevB = btns.b;
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
      if (this.input && this.input.gamepadConnected && navigator.hid) {
        this._checkGamepadGyro();
      }
    });

    // Desktop/Electron: actively poll for gamepad on startup instead of
    // waiting for user input (browser requires button press to detect).
    const isDesktop = window.steam || navigator.userAgent.includes('Electron');
    if (isDesktop) {
      this._desktopGamepadPoll = setInterval(() => {
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < gamepads.length; i++) {
          if (!gamepads[i]) continue;
          // Found a gamepad — set it up as if gamepadconnected fired
          if (this.input && !this.input.gamepadConnected) {
            this.input.gamepadIndex = i;
            this.input.gamepadConnected = true;
            this.input._gpName = gamepads[i].id;
            this.input._gpSwapAB = /^Gamepad/i.test(gamepads[i].id) && /057e/i.test(gamepads[i].id);
            console.log('Desktop: auto-detected gamepad:', gamepads[i].id);
          }
          // Show joystick toggle
          this.toggleJoystick.style.display = '';
          this._setToggleActive('joystick', this.joystickActive);
          // Check for gyro
          if (navigator.hid) {
            this._checkGamepadGyro();
          }
          clearInterval(this._desktopGamepadPoll);
          return;
        }
      }, 1000);
    }
    window.addEventListener('gamepaddisconnected', () => {
      // Debounce rapid disconnect/reconnect (e.g. brief USB glitch)
      clearTimeout(this._gamepadDisconnectTimer);
      this._gamepadDisconnectTimer = setTimeout(() => {
        // If a gamepad reconnected during the debounce window, bail out
        if (this.input && this.input.gamepadConnected) return;

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
        // Hide motion/gyro toggle too (unless phone tilt is active)
        if (!(this.input && this.input.motionEnabled)) {
          this.toggleMotion.style.display = 'none';
        }
      }, 300);
    });
  }

  async _checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (!roomParam) return;

    history.replaceState(null, '', window.location.pathname);
    const code = roomParam.toUpperCase();
    const fullCode = code.startsWith('TNDM-') ? code : 'TNDM-' + code;

    try { await this._requestMotion(); } catch (_) {}
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

    // Analytics: room creation
    analytics.trackRoomCreate(code);
    analytics.trackEvent('room_create', { code });

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
      // In Electron, use the production web URL for QR codes (localhost isn't reachable from mobile)
      const isDesktop = navigator.userAgent.includes('Electron');
      const baseUrl = isDesktop
        ? SITE_URL
        : window.location.origin + window.location.pathname;
      const url = baseUrl + '?room=' + code;
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
      analytics.trackEvent('room_connect', { type: this.net.connectionType || 'p2p' });
      analytics.trackRoomUpdate(code, {
        webrtc_connected: 1,
        connection_type: this.net.connectionType || 'p2p',
        video_enabled: this.cameraActive ? 1 : 0,
        audio_enabled: this.audioActive ? 1 : 0,
      });
      setTimeout(() => {
        this._showRoomStep('captain');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      statusEl.textContent = reason || 'Disconnected';
      statusEl.className = 'conn-status error';
    };

    // Auth error: token was rejected by relay — try silent refresh first
    this.net.onAuthError = async () => {
      console.warn('LOBBY: Relay auth failed for captain — refreshing token');
      statusEl.textContent = 'Session expired, refreshing...';
      statusEl.className = 'conn-status';
      const refreshed = await this.auth.ensureValidToken();
      if (refreshed) {
        // Token refreshed — retry room creation
        const freshToken = await this.auth.getRelayToken(code, 'captain');
        if (freshToken) this.net._relayToken = freshToken;
        this.net.enterRoom(code, 'captain');
      } else {
        statusEl.textContent = 'Sign-in required...';
        this._pendingCreateRoom = true;
      }
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

    // Analytics: room join
    const joinedViaUrl = new URLSearchParams(window.location.search).has('room');
    analytics.trackEvent('room_join', { code, joined_via_url: joinedViaUrl });
    analytics.trackRoomUpdate(code, {
      stoker_session_id: analytics.getSessionId(),
      stoker_joined_at: new Date().toISOString(),
      stoker_joined_via_url: joinedViaUrl ? 1 : 0,
    });
    analytics.trackConversion('stoker_joined', 'room_join');
    if (joinedViaUrl) analytics.trackConversion('stoker_joined_via_url', 'room_join');

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
      analytics.trackEvent('room_connect', { type: this.net.connectionType || 'p2p' });
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

    // Auth error: token was rejected by relay — try silent refresh first
    this.net.onAuthError = async () => {
      console.warn('LOBBY: Relay auth failed for stoker — refreshing token');
      statusEl.textContent = 'Session expired, refreshing...';
      statusEl.className = 'conn-status';

      const refreshed = await this.auth.ensureValidToken();
      if (refreshed) {
        const freshToken = await this.auth.getRelayToken(code, 'stoker');
        if (freshToken) {
          statusEl.textContent = 'Reconnecting...';
          this.net.retryWithToken(freshToken);
        } else {
          statusEl.textContent = 'Sign-in required...';
          this._pendingAutoJoinCode = code;
        }
      } else {
        statusEl.textContent = 'Sign-in required...';
        this._pendingAutoJoinCode = code;
      }
    };

    this.net.enterRoom(code, 'stoker');
  }

  // ── Room Persistence (localStorage) ──────────────────────────

  _saveRoom(roomCode, role, partnerName) {
    try {
      const rooms = this._getRecentRooms();
      const entry = { roomCode, role, timestamp: Date.now(), partnerName: partnerName || null };
      const existing = rooms.findIndex(r => r.roomCode === roomCode);
      if (existing >= 0) {
        // Preserve partner name if not provided
        if (!entry.partnerName && rooms[existing].partnerName) entry.partnerName = rooms[existing].partnerName;
        rooms[existing] = entry;
      } else {
        rooms.push(entry);
      }
      localStorage.setItem('tandemonium-rooms', JSON.stringify(rooms));
    } catch (e) {}
  }

  _clearRoom(roomCode) {
    try {
      if (roomCode) {
        const rooms = this._getRecentRooms().filter(r => r.roomCode !== roomCode);
        localStorage.setItem('tandemonium-rooms', JSON.stringify(rooms));
      } else {
        localStorage.removeItem('tandemonium-rooms');
      }
    } catch (e) {}
  }

  _getRecentRooms() {
    try {
      // Migrate old single-room format
      const oldRaw = localStorage.getItem('tandemonium-room');
      if (oldRaw) {
        localStorage.removeItem('tandemonium-room');
        const old = JSON.parse(oldRaw);
        if (old.roomCode) {
          const existing = localStorage.getItem('tandemonium-rooms');
          const rooms = existing ? JSON.parse(existing) : [];
          if (!rooms.some(r => r.roomCode === old.roomCode)) rooms.push(old);
          localStorage.setItem('tandemonium-rooms', JSON.stringify(rooms));
        }
      }
      const raw = localStorage.getItem('tandemonium-rooms');
      if (!raw) return [];
      const rooms = JSON.parse(raw);
      const fiveMinAgo = Date.now() - 5 * 60 * 1000;
      const recent = rooms.filter(r => r.timestamp > fiveMinAgo);
      if (recent.length !== rooms.length) {
        localStorage.setItem('tandemonium-rooms', JSON.stringify(recent));
      }
      return recent;
    } catch (e) { return []; }
  }

  _showRecentRoomsPrompt(rooms) {
    const overlay = document.createElement('div');
    overlay.id = 'rejoin-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';

    const now = Date.now();
    const cardsHtml = rooms.map((r, i) => {
      const roleName = r.role === 'captain' ? 'Captain' : 'Stoker';
      const agoSec = Math.floor((now - r.timestamp) / 1000);
      const agoText = agoSec < 60 ? 'just now' : Math.floor(agoSec / 60) + 'm ago';
      const partnerText = r.partnerName ? 'with ' + this._escapeHtml(r.partnerName) + ' · ' : '';
      const dimStyle = agoSec > 180 ? 'opacity:0.6;' : '';
      return '<button class="rejoin-room-card" data-idx="' + i + '" style="' +
        'display:block;width:100%;padding:12px 16px;border-radius:10px;border:1.5px solid rgba(255,255,255,0.15);' +
        'background:rgba(255,255,255,0.06);color:#fff;cursor:pointer;text-align:left;font-family:inherit;' +
        'transition:border-color 0.2s,background 0.2s;' + dimStyle + '">' +
        '<div style="font-size:1em;font-weight:700;margin-bottom:2px;">' +
          this._escapeHtml(r.roomCode) + '  ·  ' + roleName +
        '</div>' +
        '<div style="font-size:0.8em;color:rgba(255,255,255,0.5);">' + partnerText + agoText + '</div>' +
      '</button>';
    }).join('');

    overlay.innerHTML =
      '<div style="background:#1a1a2e;border-radius:16px;padding:24px 28px;max-width:340px;width:90%;text-align:center;color:#fff;font-family:inherit;">' +
        '<div style="font-size:1.1em;font-weight:700;margin-bottom:14px;">Recent Rooms</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' + cardsHtml + '</div>' +
        '<button id="btn-rejoin-new" style="padding:10px 20px;border-radius:8px;border:none;background:#444;color:#fff;font-size:1em;cursor:pointer;width:100%;">New Room</button>' +
      '</div>';
    document.body.appendChild(overlay);

    // Default gamepad focus on first card
    this._rejoinFocus = 0;
    const cards = overlay.querySelectorAll('.rejoin-room-card');
    if (cards.length > 0) cards[0].classList.add('gamepad-focus');

    return new Promise((resolve) => {
      cards.forEach((card) => {
        card.addEventListener('click', () => {
          const idx = parseInt(card.dataset.idx, 10);
          overlay.remove();
          resolve(rooms[idx]);
        });
      });
      document.getElementById('btn-rejoin-new').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
    });
  }

  async _handleRejoinCheck() {
    const rooms = this._getRecentRooms();
    if (rooms.length === 0) return false;

    const selected = await this._showRecentRoomsPrompt(rooms);
    if (!selected) return false; // User chose "New Room"

    // Rejoin: skip role selection, go straight to connection
    await this._requestMotion();
    this._pendingMode = 'multiplayer';
    const saved = selected;

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

      // Acquire local media early so it's ready when P2P connects
      await this.net.acquireLocalMedia(this._cameraPermitted, this._audioPermitted);

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
        // Buffer profile messages during the 1s delay so none are lost
        this._rejoinMessageQueue = [];
        this.net.onProfileReceived = (profile) => this._rejoinMessageQueue.push(profile);
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

      // Acquire local media early so it's ready when P2P connects
      await this.net.acquireLocalMedia(this._cameraPermitted, this._audioPermitted);

      this.net.onRoomJoined = () => {
        statusEl.textContent = 'Waiting for captain...';
        this._saveRoom(saved.roomCode, 'stoker');
        this._startStaleRoomTimer(statusEl);
      };

      this.net.onConnected = () => {
        this._clearStaleRoomTimer();
        statusEl.textContent = 'Connected!';
        statusEl.className = 'conn-status connected';
        // Buffer profile messages during the 1s delay so none are lost
        this._rejoinMessageQueue = [];
        this.net.onProfileReceived = (profile) => this._rejoinMessageQueue.push(profile);
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
            if (this.net && this.net.roomCode) this._clearRoom(this.net.roomCode);
            else this._clearRoom();
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

    // Replay any messages buffered during the rejoin delay
    if (this._rejoinMessageQueue && this._rejoinMessageQueue.length > 0) {
      for (const msg of this._rejoinMessageQueue) this._handleRoomMessage(msg);
    }
    this._rejoinMessageQueue = null;

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
      const waitText = document.getElementById('level-wait-text');
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

  /**
   * Transition to the multiplayer level selection step. Configures the shared
   * #lobby-level step for multiplayer mode: START RIDE button (captain) vs
   * waiting text (stoker), builds level cards, sets difficulty interactivity.
   */
  _showRoomLevelsStep() {
    const role = this._roomRole;

    // Show multiplayer-specific elements, hide solo-only elements
    const startBtn = document.getElementById('btn-start-ride');
    const waitText = document.getElementById('level-wait-text');
    const prompt = document.getElementById('level-prompt');
    if (prompt) prompt.style.display = 'none';
    if (role === 'captain') {
      startBtn.style.display = '';
      startBtn.disabled = true;
      if (waitText) waitText.style.display = 'none';
    } else {
      startBtn.style.display = 'none';
      if (waitText) waitText.style.display = '';
    }

    // Build level cards into the shared container BEFORE _showStep
    this._buildRoomLevelCards(role === 'captain');

    // Stoker can see difficulty but not interact
    const diffSel = document.getElementById('difficulty-selector');
    if (diffSel) {
      diffSel.style.opacity = (role === 'captain') ? '' : '0.7';
      diffSel.style.pointerEvents = (role === 'captain') ? '' : 'none';
    }

    this._showStep(this.levelStep);

    // Reset gamepad edge flags so held A/B from room step don't immediately
    // fire on the level step (A = confirm, B = back to room)
    this._gpPrevA = true;
    this._gpPrevB = true;
  }

  /**
   * Build multiplayer-path level cards. Thin wrapper around _buildLevelCardsShared().
   * @param {boolean} isClickable — true for captain, false for stoker
   */
  _buildRoomLevelCards(isClickable) {
    this._buildLevelCardsShared({
      container: document.getElementById('level-cards'),
      isClickable,
      mode: 'multiplayer',
      showTutorial: true, // Both captain and stoker see tutorial card
      startBtn: document.getElementById('btn-start-ride'),
      backBtn: document.getElementById('btn-back-level'),
      step: this.levelStep
    });
  }

  _updatePartnerPip() {
    const partnerVideo = document.getElementById('partner-pip');
    const partnerAvatar = document.getElementById('partner-pip-avatar');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    if (!partnerWrap) return;

    const stream = partnerVideo && partnerVideo.srcObject;
    const hasVideo = stream && stream.getVideoTracks().length > 0;

    if (this._partnerCameraOn && hasVideo) {
      partnerVideo.style.display = 'block';
      partnerVideo.play().catch(() => {});
      if (partnerAvatar) partnerAvatar.style.display = 'none';
    } else {
      if (partnerVideo) partnerVideo.style.display = 'none';
      if (partnerAvatar) {
        partnerAvatar.src = this._partnerAvatarUrl
          ? (this._avatarCache.get(this._partnerAvatarUrl) || this._partnerAvatarUrl)
          : DEFAULT_AVATAR_SVG;
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
      if (!partnerVideo || !remoteStream) return;

      // Authoritative: always set srcObject, show video, call play.
      // Don't delegate initial display to _updatePartnerPip — just show it.
      partnerVideo.srcObject = remoteStream;
      partnerVideo.style.display = 'block';
      partnerVideo.play().catch(() => {});
      const partnerAvatar = document.getElementById('partner-pip-avatar');
      if (partnerAvatar) partnerAvatar.style.display = 'none';

      // If partner camera is known to be off, switch to avatar
      if (!this._partnerCameraOn) {
        this._updatePartnerPip();
      }

      // Fall back to avatar if track ends
      const vt = remoteStream.getVideoTracks()[0];
      if (vt) {
        vt.addEventListener('ended', () => this._updatePartnerPip(), { once: true });
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

    // PiP class is managed by _showStep() — just get the element reference
    const selfieWrap = document.getElementById('selfie-pip-wrap');

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
        // Show avatar fallback when camera is off (or default icon if not logged in)
        if (selfieAvatar) {
          const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
          selfieAvatar.src = (user && user.avatar)
            ? (this._avatarCache.get(user.avatar) || user.avatar)
            : DEFAULT_AVATAR_SVG;
          selfieAvatar.style.display = 'block';
        }
      }
      if (selfieWrap) selfieWrap.style.display = 'block';
    } else {
      // No stream at all — fallback to avatar or default icon
      if (selfieAvatar && selfieWrap) {
        const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
        selfieAvatar.src = (user && user.avatar)
          ? (this._avatarCache.get(user.avatar) || user.avatar)
          : DEFAULT_AVATAR_SVG;
        selfieAvatar.style.display = 'block';
        if (selfieVideo) selfieVideo.style.display = 'none';
        selfieWrap.style.display = 'block';
      }
    }

    // Show partner PiP in lobby mode (no appendChild — CSS handles positioning)
    // PiP class is managed by _showStep() — no manual toggle needed here

    // Captain initiates media call first; stoker follows after a delay as fallback.
    // Staggered to avoid cross-call interference that causes flickering.
    // PeerJS media calls require P2P, so we wait for the upgrade first.
    this._mediaCallRetries = 0;
    this._mediaCallTimer = null;
    const initialDelay = this._roomRole === 'captain' ? 0 : 4000;

    const tryInitiateCall = () => {
      if (!this.net || !this.net.peer || !this.net.conn) return;
      // Skip if we already have a live partner stream
      const pv = document.getElementById('partner-pip');
      const hasLive = pv && pv.srcObject &&
        pv.srcObject.getVideoTracks().some(t => t.readyState === 'live');
      if (hasLive) return;
      this.net.initiateCall();
      this._mediaCallRetries++;
      if (this._mediaCallRetries < 3) {
        this._mediaCallTimer = setTimeout(() => {
          tryInitiateCall();
        }, 5000);
      }
    };

    const onP2PReady = () => {
      this._mediaCallTimer = setTimeout(() => tryInitiateCall(), initialDelay);
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
      if (partnerNameEl && profile && profile.name) {
        partnerNameEl.textContent = profile.name;
        // Save partner name for recent rooms display
        if (this.net && this.net.roomCode && this._roomRole) {
          this._saveRoom(this.net.roomCode, this._roomRole, profile.name);
        }
      }
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
      // Track if captain selected tutorial — stoker needs _forceWizard too
      this._forceWizard = (profile.levelId === 'tutorial');
      const container = document.getElementById('level-cards');
      container.querySelectorAll('.level-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.levelId === profile.levelId);
      });
      // Update difficulty selector (disable harder options for tutorial)
      this._updateDifficultyVisibility(profile.levelId);
    } else if (profile.type === 'cameraToggle') {
      // Partner toggled their camera — update state and refresh PiP
      this._partnerCameraOn = !!profile.enabled;
      if (!profile.enabled) {
        const avatarUrl = profile.avatar || this._partnerAvatarUrl;
        if (avatarUrl) this._partnerAvatarUrl = avatarUrl;
      }
      // When partner enables camera, the new media stream may not have arrived yet.
      // Re-evaluate PiP after a delay to catch the stream/track becoming live.
      if (profile.enabled) {
        setTimeout(() => this._updatePartnerPip(), 1500);
        setTimeout(() => this._updatePartnerPip(), 4000);
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
    // Detect input method before hiding lobby
    this._detectAndSetInputMethod();
    // Hide lobby
    this._hideLobby();
    // Fire multiplayer ready
    this.onMultiplayerReady(this.net, this._roomRole);
  }

  _removePipLobbyMode() {
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    // Remove lobby/level classes and set inline display:block to prevent
    // base CSS display:none from flashing the PiPs invisible before
    // game-recorder shows them.
    if (selfieWrap) {
      selfieWrap.classList.remove('pip-lobby-mode', 'pip-level-mode');
      selfieWrap.style.display = 'block';
    }
    if (partnerWrap) {
      partnerWrap.classList.remove('pip-lobby-mode', 'pip-level-mode');
      partnerWrap.style.display = 'block';
    }
  }

  showRoom(net, role) {
    // Called by game.js _returnToRoom() to re-show the lobby at roomStep
    this.net = net;
    this._roomRole = role;
    this._pendingMode = 'multiplayer';

    const roomCodeLabel = document.getElementById('room-code-label');
    if (roomCodeLabel && this.net && this.net.roomCode) {
      roomCodeLabel.textContent = this.net.roomCode;
    }

    this.lobbyEl.style.display = '';
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

    // Delay gamepad init to let held buttons from game controls release
    setTimeout(() => this._startGamepadNav(), 500);

    // Refresh achievements and bike unlock state earned during the ride
    if (this._achievements) this._achievements.reload();
    this._renderAchievements();
    this._applyPresetToPreview();

    // Ensure game overlays don't block room UI on mobile
    const victoryEl = document.getElementById('victory-overlay');
    if (victoryEl) victoryEl.classList.remove('visible');
    const gameoverEl = document.getElementById('game-over-overlay');
    if (gameoverEl) gameoverEl.style.display = 'none';
    // Re-sync toggle button states after returning from ride
    this._checkPermissionStates();

    // Return-to-room: the connection and media streams are still alive from the
    // game session. Do NOT call _startRoomMedia() — that re-acquires media,
    // Return to room: add lobby-mode class for CSS positioning.
    // Return to room: video streams are already playing from room → game.
    // Don't touch srcObject, don't initiate new calls, don't call play().
    // Just switch the CSS class for lobby positioning.
    // PiP class is managed by _showStep(roomStep) above — no manual toggle needed

    // Re-register handlers (game.js replaced these during gameplay)
    this.net.onRemoteStream = (remoteStream) => {
      const pv = document.getElementById('partner-pip');
      if (!pv || !remoteStream) return;
      pv.srcObject = remoteStream;
      pv.style.display = 'block';
      pv.play().catch(() => {});
      const pa = document.getElementById('partner-pip-avatar');
      if (pa) pa.style.display = 'none';
    };
    this.net.onProfileReceived = (profile) => this._handleRoomMessage(profile);

    // Replay any messages buffered during the rejoin delay
    if (this._rejoinMessageQueue && this._rejoinMessageQueue.length > 0) {
      for (const msg of this._rejoinMessageQueue) this._handleRoomMessage(msg);
    }
    this._rejoinMessageQueue = null;

    // Send current bike preset and profile to partner on re-entry
    if (this.net.connected) {
      this.net.sendProfile({ type: 'bikeSync', presetKey: this.selectedPresetKey });
      this._sendRoomProfile();
      const camMsg = { type: 'cameraToggle', enabled: this.cameraActive };
      const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
      if (user && user.avatar) camMsg.avatar = user.avatar;
      this.net.sendProfile(camMsg);
    }

    // Re-register disconnect handler for room
    this.net.onDisconnected = (reason) => {
      const waitTextRoom = document.getElementById('room-wait-text-room');
      const waitText = document.getElementById('level-wait-text');
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
        const gpId = this.input._gpName || '';
        const info = ControllerRegistry.identifyFromGamepadId(gpId);
        const isPS = info && info.driverName === 'DualSense';
        const isXbox = info && info.driverName === 'Xbox';
        if (isPS) {
          submitIcon.innerHTML = '\u2715';
          submitIcon.style.color = '#4a9df8';
          submitIcon.style.borderColor = '#4a9df8';
          submitIcon.style.borderRadius = '50%';
          backIcon.innerHTML = '\u25EF';
          backIcon.style.color = '#ff6b81';
          backIcon.style.borderColor = '#ff6b81';
          backIcon.style.borderRadius = '50%';
        } else if (isXbox) {
          submitIcon.innerHTML = 'A';
          backIcon.innerHTML = 'B';
        } else {
          // Diamond indicator: always bottom=confirm, right=back
          // The button swap already remaps indices so bottom press = confirm on all controllers
          submitIcon.innerHTML = this._makeDiamondHTML('bottom');
          submitIcon.style.border = 'none';
          backIcon.innerHTML = this._makeDiamondHTML('right');
          backIcon.style.border = 'none';
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
        const btns = this._gpButtons(gp);
        this._gpPrevA = btns.a;
        this._gpPrevB = btns.b;
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
      const gpId = this.input._gpName || '';
      const info = ControllerRegistry.identifyFromGamepadId(gpId);
      const isPS = info && info.driverName === 'DualSense';
      const isXbox = info && info.driverName === 'Xbox';
      if (isPS) {
        icon.innerHTML = '\u25EF';
        icon.style.color = '#ff6b81';
      } else if (isXbox) {
        icon.innerHTML = 'B';
        icon.style.color = '#ff4444';
      } else {
        // Universal 4-dot diamond for Switch Pro, GameSir, and generic controllers
        // Always right=back — the button swap remaps indices so this is correct for all
        icon.innerHTML = this._makeDiamondHTML('right');
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
    if ((step === this.hostStep || step === this.roomStep || (step === this.levelStep && this._pendingMode === 'multiplayer')) && code && code !== '----') {
      header.textContent = code;
    } else {
      header.textContent = '';
    }
  }

  /**
   * Generate HTML for a 4-dot diamond face button indicator.
   * @param {'top'|'bottom'|'left'|'right'} active — which dot is filled
   */
  _makeDiamondHTML(active) {
    const dot = (pos) => `<span class="dot dot-${pos}${pos === active ? ' active' : ''}"></span>`;
    return `<span class="btn-diamond">${dot('top')}${dot('right')}${dot('bottom')}${dot('left')}</span>`;
  }

  /**
   * Detect if the connected gamepad has swapped A/B buttons.
   * The GameSir Cyclone reports as "Gamepad" with Switch Pro vendor/product
   * (057e:2009) but uses Nintendo-style button layout where the right face
   * button is confirm and bottom is cancel — opposite of the standard mapping.
   * @returns {boolean} true if buttons[0] and buttons[1] should be swapped
   */
  /** Get the confirm (A) and cancel (B) button indices, accounting for swap */
  _gpButtons(gp) {
    const swap = this.input._gpSwapAB;
    const aIdx = swap ? 1 : 0;
    const bIdx = swap ? 0 : 1;
    return {
      a: gp.buttons[aIdx] && gp.buttons[aIdx].pressed,
      b: gp.buttons[bIdx] && gp.buttons[bIdx].pressed,
    };
  }

  /**
   * Progressively hide secondary text on the level step when vertical space is tight.
   * Measures the lobby card's available height vs its scroll height and applies
   * compact classes: 1 = hide diff descriptions, 2 = also hide locked card desc,
   * 3 = hide all descriptions.
   */
  /**
   * Progressively hide secondary text on the level step based on viewport height.
   * Compact 1: hide difficulty descriptions only.
   * Compact 2: also hide locked level card descriptions.
   * Compact 3: hide all level card descriptions.
   */
  _adjustLevelCompact() {
    const card = document.querySelector('.lobby-card');
    if (!card) return;
    card.classList.remove('lobby-compact-1', 'lobby-compact-2', 'lobby-compact-3');

    // Use viewport height ratio to decide compactness
    // --ls ranges from 1.8px (1080px) to 4px (2400px+), card height is 150*ls
    // At 1080px: card = 270px, at 2400px: card = 600px
    // Content with descriptions needs roughly 180*ls, without ~120*ls
    const vh = window.innerHeight;
    if (vh >= 800) return;          // desktop/TV/laptop — show everything
    if (vh >= 700) {                // compact — hide difficulty descs
      card.classList.add('lobby-compact-1');
    } else if (vh >= 600) {         // smaller — also hide locked card desc
      card.classList.add('lobby-compact-2');
    } else {                        // tight (small mobile) — hide all descriptions
      card.classList.add('lobby-compact-3');
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

  /**
   * RAF-based gamepad polling loop. Reads navigator.getGamepads() every frame.
   * Dispatches: D-pad/left-stick up/down → _moveFocus(), left/right → _moveColumn(),
   * A button → _confirmFocus(), B button → _goBack(), LB/RB → bike color cycle.
   * Special modes: spinner input on join step, modal navigation for profile/
   * leaderboard/help overlays.
   */
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
    // A/B buttons (swapped for GameSir Cyclone)
    const btns = this._gpButtons(gp);
    const a = btns.a;
    const b = btns.b;

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

    // Recent rooms popup: navigate room cards + New Room button
    const rejoinOverlay = document.getElementById('rejoin-overlay');
    if (rejoinOverlay) {
      const items = [...rejoinOverlay.querySelectorAll('.rejoin-room-card'), document.getElementById('btn-rejoin-new')].filter(Boolean);
      if (items.length === 0) { this._rejoinFocus = undefined; return; }
      if (this._rejoinFocus === undefined) this._rejoinFocus = 0;
      if (up && !this._gpPrevUp) {
        items[this._rejoinFocus].classList.remove('gamepad-focus');
        this._rejoinFocus = Math.max(0, this._rejoinFocus - 1);
        items[this._rejoinFocus].classList.add('gamepad-focus');
      }
      if (down && !this._gpPrevDown) {
        items[this._rejoinFocus].classList.remove('gamepad-focus');
        this._rejoinFocus = Math.min(items.length - 1, this._rejoinFocus + 1);
        items[this._rejoinFocus].classList.add('gamepad-focus');
      }
      if (a && !this._gpPrevA) items[this._rejoinFocus].click();
      if (b && !this._gpPrevB) {
        const newBtn = document.getElementById('btn-rejoin-new');
        if (newBtn) newBtn.click();
      }
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

  /**
   * Move gamepad focus vertically (up/down) through the current step's items.
   * Special handling: difficulty buttons are horizontal siblings — up/down skips
   * over them as a group. Down from a level card jumps to the selected difficulty
   * button. Skips hidden items.
   * @param {number} dir — +1 for down, -1 for up
   */
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

  /**
   * Move gamepad focus horizontally (left/right). On difficulty buttons, cycles
   * between sibling difficulty options. On mode step, switches between the 4
   * columns (left toggles, center, right toggles, far-right toggles). Saves
   * and restores focus position per column.
   * @param {number} dir — +1 for right, -1 for left
   */
  _moveColumn(dir) {
    const items = this._stepItems.get(this._currentStep);
    const focusedEl = items && items[this._focusIndex];
    // If focused on a difficulty button, move to sibling difficulty button instead of changing columns
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

    // Level cards are vertical — left/right always switches to toggle columns
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
    if (!locked) analytics.trackEvent('bike_color_change', { preset_key: key });

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
      nameEl.textContent = '🏆 ' + (BIKE_NAMES[key] || key);
      if (hintEl) hintEl.style.display = 'none';
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
    if ((this._currentStep === this.roomStep || (this._currentStep === this.levelStep && this._pendingMode === 'multiplayer')) && this.net && this.net.connected) {
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

  /** Dispose preview renderer and scene to free GPU/CPU memory. */
  _disposePreview() {
    this._stopPreviewLoop();
    if (this._previewScene) {
      this._previewScene.traverse(child => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
      this._previewScene = null;
    }
    if (this._previewRenderer) {
      this._previewRenderer.dispose();
      this._previewRenderer = null;
    }
    this._previewCamera = null;
    this._previewOriginalMats = null;
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
