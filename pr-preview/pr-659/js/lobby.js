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
//   _modeColumns         — 4-column layout [leftToggles, center, rightToggles, farRight];
//                          flattened into the spatial FocusController's scope
//   _stepFocus           — nav-core FocusController (spatial mode) driving all
//                          step nav; directions move to the nearest on-screen
//                          focusable by geometry (#318) — replaced _moveFocus/
//                          _moveColumn/_modeColIndex column math
//   _pollGamepadNav()    — RAF loop: modal branches + LB/RB, else _stepFocus.poll()
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { GOOSE_OUTFITS } from './goose-outfits.js';
import { lockedOutfits, outfitLockHint, rewardProgress } from './rewards.js';
import { SPECIAL_BIKE_KEYS, SPECIAL_BIKES, isSpecialBike } from './special-bikes.js';
import { boneFilterFor, trackBone } from './goose-rider-clips.js';
import { PARTNER_LEFT_REASON } from './network-manager.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { InputManager, isSteamTwinPad } from './input-manager.js';
import { isMobile, isTV, RELAY_URL, BIKE_MODEL_PATH, CHOOSER_MODEL_PATH, TUNE, GUEST_NAME, applySteeringFeel, snapshotTuningBase, saveSteeringFeelPref, BALANCE_DEFAULTS } from './config.js';
import { getCurrentTier } from './quality.js';
import { LEVELS, getMedals } from './race-config.js';
import { makePlacementSalt, dailyKey, dailySeed } from './daily-seed.js';
import { planRoute, planExplore, skipLabel, isValidPoint } from './tourist-route.js';
import { getMapsApiKey, geocodeAddress, resolveOriginAt } from './tourist-config.js';
import {
  resolveDailyLevel, dailyStatus, dailyDescription, browserStore, DAILY_RULES_LINE,
  ridesStarted
} from './daily-ride.js';
import * as records from './records.js';
import { isTutorialDone, tutorialStore } from './tutorial-progress.js';
import { AuthManager, identityPictures } from './auth.js';
import qrcode from '../shared/ui/third_party/qrcode-generator.js';
import { SeatAccounts } from './seat-accounts.js';
import { SeatAchievements } from './seat-achievements.js';
import { API_BASE } from './config.js';

/** #612 · the Steam "Link Discord" prompt shows at most once a week. */
const LINK_PROMPT_SNOOZE_KEY = 'tandemonium_link_discord_prompt_until';
const LINK_PROMPT_SNOOZE_MS = 7 * 24 * 3600 * 1000;
import { LicenseManager } from './license.js';
import { AchievementManager, updateBadgeDisplay, showInfoToast } from './achievements.js';
import * as analytics from './analytics.js';
import { ControllerRegistry } from '../shared/drivers/controller-registry.js';
import { isPresentableEntry } from '../shared/manager.js';
import { identityOf, identifyGamepadId, identifyHidDevice, KEYBOARD_IDENTITY } from '../shared/device-identity.js';
import { prettyGamepadName, prettyHidName, hidDeviceIdentity, slotIdentityHidFirst, fixRosterRow, versusJoinSeat, lowestFreePlayerNumber } from './lobby/controller-labels.js';
import { mergedPollGp, withoutHeldTwins, isJoinPress } from './lobby/join-poll.js';
import { RowFocusController as FocusController, scrollWithStick, scrollPage } from './row-focus.js';   // #517: nearest-row up/down + scroll-into-view over the kit's controller
import { canQuitApp, requestAppQuit } from './app-quit.js';
import { previewFov } from './lobby/preview-fit.js';   // #521: keep the whole bike across a taller box
import { RoomStore } from './lobby/room-store.js';
import { RoomProtocol, ROOM_MSG } from './lobby/room-protocol.js';
import { NetSession } from './lobby/net-session.js';
import { renderRoomQR, joinUrl } from './lobby/room-qr.js';
import { isDemoEdition, getEditionRules, levelAllowed, carriedQuery, dailyRideGate, bikeAllowed } from './edition.js';
import { mergeRoomRules, roomProfileFields, partnerFromProfile, levelSyncVerdict } from './edition.js'; // PR #397 M1
import { isMediaEnabled } from './edition.js'; // room camera/mic (#400 D7)
import { versusBotAllowed } from './versus/versus-bot.js';
import { loadWallet, browserStore as walletStore } from './wallet.js';
import { playerLooks, padKeyFor, vidPidFromGamepadId } from './player-look.js';   // #548
import { DressingRoom } from './dressing-room.js';   // #548
import { DressingRoomPreview } from './dressing-room-preview.js';   // #548

/** #576 · the difficulty a leaderboard row was ridden on. */
const DIFF_LABEL = { chill: 'Chill', adventurous: 'Adventurous', daredevil: 'Daredevil' };

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
  solo_flight: 'Solo Flight',   // #611 · special bikes (their own models, js/special-bikes.js)
  time_warp: 'Time Warp',
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
  solo_flight: '#9fd8ff',
  time_warp: '#f0b860',
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
  constructor({ onSolo, onMultiplayerReady, onLocalReady, onVersusReady, onTouristReady, onSlingshotReady, onGarage, input, controllerManager }) {
    this.onSolo = onSolo;
    this.onSlingshotReady = onSlingshotReady || (() => {});
    this.onGarage = onGarage || (() => {});   // #400 D4 · the one garage
    this.onTouristReady = onTouristReady || (() => {});   // E-6
    this.onMultiplayerReady = onMultiplayerReady;
    this.onLocalReady = onLocalReady;
    this.onVersusReady = onVersusReady;
    this.input = input; // P1 InputManager (slot-bound via ControllerManager)
    this.controllerManager = controllerManager; // shared with Game
    // Room network session: owns the NetworkManager instance + the stale-
    // callback epoch guard. `this.net` is a getter/setter over it, so every
    // existing `this.net.*` read/write is unchanged. (#318 Step 3)
    this._netSession = new NetSession();
    // Recent-room persistence (rejoin UX) — pure localStorage layer. (#318 Step 3)
    this._roomStore = new RoomStore();
    this.selectedLevel = LEVELS.find(l => !l.isTutorial) || LEVELS[0]; // default to first non-tutorial level
    this._forceWizard = false;
    this.selectedPresetKey = 'default';
    this.selectedDifficulty = 'chill'; // 'chill' | 'adventurous' | 'daredevil'
    this._pendingMode = null; // 'solo' | 'multiplayer' | 'local' | 'versus', set during level selection

    // Local multiplayer (JOIN RIDE on host page): second InputManager is created
    // here when P2 presses JOIN RIDE, then handed off to the game via onLocalReady.
    this._localP2InputManager = null;
    this._localP2Type = null; // 'gamepad' | 'keyboard'
    this._localJoinMonitorRAF = null;

    // Versus (local split-screen team racing): 2-4 players, each entry
    // { n, type: 'gamepad'|'keyboard', gpIndex, slotId, name, team: 'A'|'B', input }.
    // P1 auto-joins on entering the versus step; others join by pressing A
    // on an unclaimed pad (or the keyboard button). Handed to the game via
    // onVersusReady({ teams }) on START RIDE.
    this._versusPlayers = [];
    this._versusMonitorRAF = null;
    this._versusPrevButtons = new Map(); // candidate key / member n -> { a, left, right }
    this._versusLastCardsKey = null;
    this._versusKeyHandler = null;
    this._versusCandidates = []; // detected-but-unjoined controllers (all sources)
    // Stable per-device ids for candidate keys — two identical pads (e.g.
    // a pair of DualSenses) share vendor/product/name and would otherwise
    // collide in the edge-detect map.
    this._versusDeviceIds = new WeakMap();
    this._versusNextDeviceId = 1;
    this._localLastUnclaimedGp = null;  // last detected unclaimed gamepad index
    this._localLastJoinState = null;    // cached state string for dirty-checking
    // WebHID device cache for P2 detection (async getDevices() can't run per-frame)
    this._cachedHIDDevices = null;
    this._hidCacheTime = 0;

    this.lobbyEl = document.getElementById('lobby');
    this.modeStep = document.getElementById('lobby-mode');
    this.levelStep = document.getElementById('lobby-level');
    this.roleStep = document.getElementById('lobby-role');
    this.hostStep = document.getElementById('lobby-host');
    this.joinStep = document.getElementById('lobby-join');
    this.versusStep = document.getElementById('lobby-versus');
    this.touristStep = document.getElementById('lobby-tourist');   // E-6
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
    this.toggleAchievements = document.getElementById('toggle-achievements');   // #540
    this.cameraActive = false;
    this.motionActive = false;
    this.joystickActive = true; // joystick steering on by default when gamepad connected
    this.audioActive = false;
    this._cameraPermitted = false;
    this._hasCamera = true; // assume true, check async below

    // Room camera/mic off (#400 D7, default): no camera/audio toggles, and
    // never touch getUserMedia/enumerateDevices. Multiplayer is unaffected.
    this._mediaEnabled = isMediaEnabled();
    if (!this._mediaEnabled) {
      this._hasCamera = false;
      this.toggleCamera.style.display = 'none';
      this.toggleAudio.style.display = 'none';
    }

    // Hide camera toggle if no camera hardware exists
    if (this._mediaEnabled && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
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
    this._setToggleActive('music', this.musicActive);
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
    this._currentStep = null;
    // <uf-flow id="lobby-flow"> owns which step is visible. _showStep() asks it
    // to navigate; the change event runs that step's side effects
    // (_onStepShown) — so a step shown by any route gets the same treatment.
    /** @type {import('../shared/ui/elements/uf-flow.js').UfFlow} */
    this._flow = /** @type {any} */ (document.getElementById('lobby-flow'));
    this._flow.addEventListener('uf-flow:change', (e) => {
      const d = /** @type {CustomEvent} */ (e).detail;
      this._onStepShown(document.getElementById(d.to), d.from ? document.getElementById(d.from) : null);
      this._syncSystemBar();
    });
    this._pollRafId = null;
    // Step navigation (mode/level/role/host/join/room) now uses the shared
    // nav-core FocusController in spatial mode (#318): directions move to the
    // nearest on-screen focusable, dissolving the old _modeColumns/_moveColumn/
    // _modeColIndex column math and the difficulty-sibling special-casing.
    // The "one confirm per physical A press" gate that kills the popup flash
    // (a held press bleeding a second confirm into the scope it just opened)
    // now lives inside FocusController itself — armed on scope entry + after
    // each confirm, cleared only on an observed A release — so every call site
    // inherits it; no shared lobby-level gate needed. (#318)
    this._stepFocus = new FocusController({
      input: this.input,
      onConfirm: (el) => { if (el.tagName === 'INPUT') el.focus(); else el.click(); },
      onBack: () => this._goBack(),
    });
    this._stepNavRanLastFrame = false; // for reprime() on modal→step transitions
    // Shared controller for the linear modal lists (profile popup, rejoin
    // overlay). Vertical nav; B runs a per-modal back action set on open.
    // (Leaderboard/help/spinner stay on their bespoke branches — 2D table,
    // scroll-only, and character-wheel input don't fit a flat list.)
    this._modalFocus = new FocusController({
      input: this.input,
      orientation: 'vertical',
      onBack: () => { if (this._modalBack) this._modalBack(); },
      // #517: d-pad past the leaderboard's last row scrolls its sheet.
      onEdge: (dir) => {
        if (this._activeModal === 'leaderboard' && this._leaderboardSheet) scrollPage(this._leaderboardSheet.body, dir);
        else if (this._activeModal === 'achievements' && this._achievementsSheet) scrollPage(this._achievementsSheet.body, dir);   // #540
      },
      // Steam playtest 2026-11-07: hold the d-pad / left stick to run down the 100 achievements.
      repeat: () => this._activeModal === 'achievements',
    });
    this._activeModal = null; // 'profile' | 'volume' | 'leaderboard' | null
    this._modalBack = null;
    // #548 · the Dressing Room (js/dressing-room.js) while it is open: every seated player's card,
    // each driven by its own pad. Null when closed.
    this._room = null;
    this._gpPrevY = false;
    this._gpPrevUp = false;
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
      [this.toggleHelp, this.toggleLeaderboard, this.toggleAchievements, this.toggleProfile],
      [document.getElementById('btn-together'), document.getElementById('btn-solo'), document.getElementById('btn-mode-connect-hid'), document.getElementById('btn-mode-phone')].filter(Boolean),
      [this.toggleAll, this.toggleCamera, this.toggleAudio],
      [this.toggleJoystick, this.toggleMotion, this.toggleMusic],
    ];
    this._modeCol = 1;

    // Per-step focusable items and back buttons
    this._stepItems = new Map();
    this._stepCenterItems = new Map(); // immutable center-column items per step
    this._stepBack = new Map();
    this._stepItems.set(this.modeStep, this._modeColumns[1]);
    this._stepCenterItems.set(this.modeStep, this._modeColumns[1]);
    const roleItems = [
      document.getElementById('btn-captain'),
      document.getElementById('btn-stoker'),
      document.getElementById('btn-versus'),
      document.getElementById('btn-back-mode'),
    ];
    this._stepItems.set(this.roleStep, roleItems);
    this._stepCenterItems.set(this.roleStep, roleItems);
    const versusItems = [
      document.getElementById('btn-versus-join-kb'),
      document.getElementById('btn-versus-controllers'),
      document.getElementById('btn-versus-connect-hid'),
      document.getElementById('btn-versus-join-phone'),   // #562
      document.getElementById('btn-versus-continue'),
      document.getElementById('btn-back-versus'),
    ];
    this._stepItems.set(this.versusStep, versusItems);
    this._stepCenterItems.set(this.versusStep, versusItems);
    const hostItems = [
      document.getElementById('btn-host-room-code'),   // #563
      document.getElementById('btn-back-role-host'),
    ].filter(Boolean);
    // Online / Local CHOOSE LEVEL: enabled once there are two players
    // (_refreshHostNext rebuilds this list when one becomes usable).
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
    this._stepBack.set(this.versusStep, document.getElementById('btn-back-versus'));
    // #400: Tourist's inline Back is hidden by .lobby-step .lobby-back like every
    // step's; registering it drives the fixed bottom Back (and gamepad B).
    this._stepBack.set(this.touristStep, document.getElementById('btn-back-tourist'));

    // Fixed back button (non-gamepad, stays at bottom of steps column)
    this._fixedBackBtn = document.getElementById('lobby-fixed-back');

    // Default focus index per step (0 if not specified)
    this._stepDefaultFocus = new Map();
    this._stepDefaultFocus.set(this.modeStep, 0); // RIDE TOGETHER

    // Desktop/TV system bar + Controls sheet (#428 layout A).
    this._initSystemBar();

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
    this._lbMainTab = 'you';    // 'solo' | 'together' | 'you'
    this._lbSubLevel = LEVELS[0].id;
    this._achievements = new AchievementManager();
    this._avatarCache = new Map(); // originalUrl → blobUrl (fetched once per session)

    // Auth (after _avatarCache — _setupAuth triggers updateUI which reads the cache)
    this.auth = new AuthManager();
    // Achievements push to the backend via the identity (token provider), so
    // auth no longer reaches into achievements. (#318 Step 4)
    this._achievements.setIdentity(this.auth);

    // Steam: bypass LicenseManager when Steam ownership is confirmed
    // Initialize with a default license so code that reads this.license.isLicensed
    // before _initSteamLicense completes doesn't crash.
    this._isSteam = false;
    this.license = new LicenseManager(this.auth);
    this._steamReady = this._initSteamLicense().then(() => this._setupAuth());

    this._setup();
    this._buildLeaderboardTabs();
    this._initBikeCarousel();
    this._setupGamepadHotSwap();



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
      if (isMobile) {
        // Mobile: the old "Tap to Start" tap-gate is obsolete. iOS motion
        // permission is now requested from a real gesture at ride start
        // (game.js doStart) and audio unlocks on the first lobby interaction,
        // so no boot gesture is needed. The overlay is now purely a "Loading…"
        // veil (label set by the boot script) that auto-dismisses once the page
        // finishes loading — no tap. _toggleAll is intentionally NOT called
        // here: a non-gesture requestPermission() is rejected by iOS anyway.
        const lift = () => {
          const o = this._tapOverlay;
          if (!o) return;
          this._tapOverlay = null;
          o.classList.add('fade-out');
          setTimeout(() => o.remove(), 400);
        };
        if (document.readyState === 'complete') requestAnimationFrame(lift);
        else window.addEventListener('load', () => requestAnimationFrame(lift), { once: true });
        setTimeout(lift, 4000); // safety: never let the veil dead-end (see #350)
      } else if (localStorage.getItem('tandemonium_started')) {
        this._tapOverlay.remove();
        this._tapOverlay = null;
        // Subsequent-launch case: the tap overlay was dismissed in a
        // previous session, so _dismissTapOverlay will never fire again.
        // Run the desktop gamepad detection flow directly so the HID
        // bootstrap still has a chance to claim a DualSense that's
        // stuck in 0x31 full-report mode from the previous session —
        // otherwise the user has to power-cycle the controller on
        // every app restart to force it back into Chromium-visible
        // compat mode.
        this._runDesktopGamepadDetection();
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

    // Any non-mobile platform (Electron, Chrome desktop, Edge desktop) uses
    // the gamepad-detection poll. The old isDesktop check excluded regular
    // browsers, which meant the web-deployed game never auto-claimed P1 —
    // menu-nav stayed keyboard-only and the gyro toggle never appeared.
    if (!isMobile) {
      console.log('Desktop: overlay dismissed, activating gamepad...');
      this._runDesktopGamepadDetection();
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

  /**
   * Desktop gamepad detection loop. Polls navigator.getGamepads() for up
   * to 2 seconds, nudging ControllerManager to claim P1 to the first live
   * pad as soon as one is visible. The ControllerManager's HID pool
   * (populated at boot via autoPoolApprovedHid) also handles the
   * "previously-paired DualSense stuck in 0x31 mode and invisible to
   * Chromium's Gamepad API" recovery case automatically — its entry is
   * already in the pool, so claim via synthetic-activity detection works
   * from the very first frame.
   */
  _runDesktopGamepadDetection() {
    // Poll every 100ms for up to 2s, nudging ControllerManager to claim
    // P1 to the first live pad as soon as one is present. Matches the
    // old detectGamepad behavior of "P1 auto-claims on pad plug-in".
    let attempts = 0;
    const pollForPad = () => {
      if (this.controllerManager.getSlot('P1').state === 'claimed') return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const claimed = this.controllerManager.claimFirstAvailable('P1', pads);
      if (claimed) return;
      if (++attempts < 20) setTimeout(pollForPad, 100);
    };
    setTimeout(pollForPad, 200);

    // ControllerManager owns claim detection + HID pool + gyro fusion —
    // we just watch P1's slot here for UI side-effects.
    //  - 'claimed' event: show the joystick toggle + flip music once
    //    (first claim only; further claims re-fire this event for
    //    re-attach scenarios but the UI is already in the right state)
    //  - 'hid-bound' event: HID attaches either synchronously with claim
    //    (pool had a matching entry) or later (user grants HID via
    //    requestDevice, hot-plug, Electron auto-attach); arm the motion
    //    toggle whenever it fires.
    const slotP1 = this.controllerManager.getSlot('P1');
    let joystickShown = false;
    slotP1.on((slot, reason) => {
      if (reason === 'claimed') {
        if (!joystickShown) {
          joystickShown = true;
          this.toggleJoystick.style.display = '';
          this._setToggleActive('joystick', this.joystickActive);
          // Only start music if the user actually has it toggled on.
          // Previously this fired unconditionally, which both forced music
          // to play when the toggle was off and made playback depend on
          // controller recognition. Music is now controlled by musicActive
          // + the standard gesture handlers in game.js.
          if (this.musicActive && this.onMusicChanged) this.onMusicChanged(true);
        }
        // Motion-toggle visibility: the claimed pad's id tells us whether
        // the controller has gyro, BEFORE HID is attached. Show the toggle
        // (in OFF state) so the user has a clickable affordance to grant
        // WebHID permission; _toggleMotion's first-click path calls
        // manager.connectHidForSlot('P1') which in Electron auto-approves
        // invisibly and in a browser shows the HID picker.
        const info = slot.controllerLabel
          ? ControllerRegistry.identifyFromGamepadId(slot.controllerLabel)
          : null;
        if (info?.hasGyro) {
          // Gyro on by default (#428): bind an already-granted device now, no
          // gesture needed (connectHidForSlot with prompt:false only pools what
          // getDevices returns). 'hid-bound' below then switches motion on.
          if (!slot._hidEntry && navigator.hid && this.controllerManager.connectHidForSlot) {
            this.controllerManager.connectHidForSlot('P1', { prompt: false }).catch(() => {});
          }
          this._showMotionToggle();
          // Reflect HID state in the active class: green when bound, off
          // (greyed) otherwise so the user knows it needs a click.
          this._setToggleActive('motion', !!slot._hidEntry);
        }
        // If HID was attached synchronously (pool hit), arm motion now.
        if (slot._hidEntry && !this._motionPermitted) {
          this._motionPermitted = true;
          this.motionActive = true;
          if (this.input) this.input.motionEnabled = true;
          this._setToggleActive('motion', true);
          this._joystickOffForGyro();
        }
      } else if (reason === 'hid-bound' && !this._motionPermitted) {
        this._motionPermitted = true;
        this.motionActive = true;
        if (this.input) this.input.motionEnabled = true;
        this._showMotionToggle();
        this._setToggleActive('motion', true);
        this._joystickOffForGyro();
      }
    });
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
    this._refreshWallet();   // #400 D4: what the last ride paid
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
  /**
   * Show a lobby step. The flow does the showing; _onStepShown (via the
   * flow's change event) does everything else. Re-showing the current step
   * re-runs its side effects, as it always did (cards rebuilt, then shown).
   */
  _showStep(step) {
    if (!step) return;
    if (this._flow.current === step.id) { this._onStepShown(step, step); return; }
    this._flow.go(step.id, { push: false });   // lobby back buttons own "back"; no flow history
  }

  _onStepShown(step, prevStep) {
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
    this._clearFocusHighlight();
    this._currentStep = step;

    // B-3: cards are built once at boot, but bests change every ride — refresh
    // the record lines whenever a level list comes back into view.
    if (step === this.levelStep || step === this.versusStep) {
      this._refreshRecordLines();
    }
    if (step === this.levelStep) this._refreshTouristCard();

    // Local-MP JOIN RIDE monitor: run only while the captain host page is visible.
    if (step === this.hostStep) {
      this._startLocalJoinMonitor();
    } else if (prevStep === this.hostStep) {
      this._stopLocalJoinMonitor();
    }
    // #563: the host step's "Scan to join" QR is up only while it shows.
    if (step === this.hostStep || prevStep === this.hostStep) this._syncHostJoinQr();

    // Versus join monitor: run only while the team-setup screen is visible.
    // (Level select keeps the joined players but stops the polling loop.)
    if (step === this.versusStep) {
      this._startVersusMonitor();
    } else if (prevStep === this.versusStep) {
      this._stopVersusMonitor();
    }

    // Hide toggle columns and gamepad back hint on join step
    if (step === this.joinStep) {
      if (prevStep !== this.joinStep) this._renderRejoinCards();   // #547
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
    // Tourist opens from the level list (#400): the bike was already chosen
    // there, and on a phone the carousel pushes the route form off-screen.
    const hideCarousel = (step === this.levelStep || step === this.touristStep);
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
      this._fixedBackBtn.textContent = '\u2190 Back';
      this._fixedBackBtn.style.visibility = 'visible';
    } else {
      this._fixedBackBtn.style.visibility = 'hidden';
    }
    this._updateBackHint(step);

    // Always reset to center column and update its items
    this._modeCol = 1;
    const centerItems = this._stepCenterItems.get(step) || [];
    this._modeColumns[1] = centerItems;
    this._stepItems.set(step, centerItems);

    this._applyStepSpatialFocus(step);
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
    // #428: no video PiPs unless media sharing is on (?media=1, #400 D7) — the
    // room shows player cards instead.
    if (selfieWrap && partnerWrap && !this._mediaEnabled) {
      for (const w of [selfieWrap, partnerWrap]) w.classList.remove('pip-lobby-mode', 'pip-level-mode');
    } else if (selfieWrap && partnerWrap) {
      const isRoom = false;   // the room step is gone (merged into the host step)
      const isMultiplayerLevel = (step === this.levelStep && this._pendingMode === 'multiplayer');
      selfieWrap.classList.toggle('pip-lobby-mode', isRoom);
      selfieWrap.classList.toggle('pip-level-mode', isMultiplayerLevel);
      partnerWrap.classList.toggle('pip-lobby-mode', isRoom);
      partnerWrap.classList.toggle('pip-level-mode', isMultiplayerLevel);
      // Position PiPs to align with room-video-area in the center column (desktop)
      if (isRoom) {
        requestAnimationFrame(() => this._positionPipToVideoArea());
        // Re-render badges with rect shape on desktop TV/Monitor
        const shape = window.matchMedia('(min-width: 1024px)').matches ? 'rect' : undefined;
        updateBadgeDisplay('selfie-badges', this._achievements.getEarned(), shape);
        if (this._partnerAchievements) {
          updateBadgeDisplay('partner-badges', this._partnerAchievements, shape);
        }
      }
      // Mobile: show room code between PiP circles using a body-level element
      // (can't use the original label — it's inside a display:none parent on mobile)
      if (isMobile) {
        let mobileCode = document.getElementById('mobile-room-code');
        if (isRoom && this.net && this.net.roomCode) {
          if (!mobileCode) {
            mobileCode = document.createElement('div');
            mobileCode.id = 'mobile-room-code';
            document.body.appendChild(mobileCode);
          }
          mobileCode.textContent = this.net.roomCode;
          mobileCode.style.display = 'block';
        } else if (mobileCode) {
          mobileCode.style.display = 'none';
        }
      }
    }
  }

  /** Position each PiP over its slot container in the room grid */
  /**
   * The room's two <uf-seat>s (#173): which seat is yours, who is in the
   * other one, and whether they are here. Seats are keyed by role; 'self' /
   * 'partner' resolve through this._roomRole.
   * @param {'self'|'partner'} which
   * @param {{ who?: string, dev?: string, state?: 'open'|'joined'|'ready' }} v
   */
  _setRoomSeat(which, v) {
    // The partner's name, shown in the captain's host-step stoker seat.
    if (which === 'partner' && v.who !== undefined) this._roomPartnerName = v.who;
    this._renderRoomPlayers();
    if (this._roomRole === 'captain') this._refreshHostNext();
    this._syncLevelRoomBar();
  }

  /**
   * The Level screen is part of the online room (2026-11-06): while a session is on, its room bar
   * shows both seats, who is in them and whether the partner is connected, under the room code.
   * Cheap to call every frame: it only writes when something changed.
   */
  _syncLevelRoomBar() {
    const team = /** @type {any} */ (document.getElementById('level-room-team'));
    if (!team) return;
    const role = this._roomRole;
    const on = !!(this.net && this._pendingMode === 'multiplayer' && role && this._currentStep === this.levelStep);
    const connected = on && !!this.net.connected;
    const partner = this._roomPartnerName && this._roomPartnerName !== 'LEFT' ? this._roomPartnerName : '';
    const user = this.auth && this.auth.isLoggedIn() ? this.auth.getUser() : null;
    const mePerson = user ? this.seatPerson(1) : null;
    const me = { who: (mePerson && mePerson.name) || (user && user.name) || 'You', pic: mePerson ? mePerson.pic : '', source: mePerson ? mePerson.source : '', dev: 'This screen', state: 'joined' };
    const left = this._roomPartnerName === 'LEFT';
    const them = left ? { who: 'Partner left', dev: 'Disconnected', state: 'open' }
      : connected ? { who: partner || 'Partner', dev: 'Online · connected', state: 'joined' }
        : partner ? { who: partner, dev: 'Reconnecting…', state: 'open' }
          : { who: 'Waiting for partner…', dev: '', state: 'open' };
    const code = on ? (this.net.roomCode || '') : '';
    const key = on ? [role, code, me.who, me.pic, me.source, them.who, them.dev, them.state].join('|') : 'off';
    if (key === this._levelRoomKey) return;
    this._levelRoomKey = key;
    team.hidden = !on;
    if (!on) return;
    team.heading = code ? 'Online room ' + code : 'Online room';
    const cap = /** @type {any} */ (document.getElementById('level-room-captain'));
    const sto = /** @type {any} */ (document.getElementById('level-room-stoker'));
    const [mine, theirs] = role === 'captain' ? [cap, sto] : [sto, cap];
    if (mine) Object.assign(mine, me);
    if (theirs) Object.assign(theirs, { pic: '', source: '' }, them);
  }

  /** Both room seats from current state: me in my seat, the partner's seat open until they arrive. */
  _syncRoomSeats(role) {
    this._roomRole = role;
    this._renderRoomPlayers();
  }

  /**
   * The room's two player cards (#428; video sharing is off since #400 D7):
   * my profile and recent achievements in my seat, the partner's once their
   * profile message arrives, "Waiting for partner…" until then.
   */
  _renderRoomPlayers() {
    const role = this._roomRole || 'captain';
    const mine = document.getElementById(`room-player-${role}`);
    const theirs = document.getElementById(`room-player-${role === 'captain' ? 'stoker' : 'captain'}`);
    if (!mine || !theirs) return;
    const user = this.auth && this.auth.isLoggedIn() ? this.auth.getUser() : null;
    const recent = (list) => (list || []).slice().sort((a, b) => (b.earnedAt || 0) - (a.earnedAt || 0)).slice(0, 3);
    const fill = (card, { name, avatar, achievements, here, badge }) => {
      Object.assign(card, { name, avatar: avatar || '', state: here ? 'here' : 'waiting', badge: badge || '' });
      card.stats = here && achievements ? [{ value: achievements.length, label: 'Achievements' }] : [];
      const box = card.extra;
      box.replaceChildren(...(here ? recent(achievements) : []).map((a) => {
        const el = document.createElement('uf-achievement');
        Object.assign(el, { icon: a.icon || '🏅', name: a.name || a.id, size: 'sm', state: 'earned' });
        return el;
      }));
    };
    const myAch = this._achievements ? this._achievements.getEarned() : [];
    fill(mine, { name: (user && user.name) || 'You', avatar: user && user.avatar, achievements: myAch, here: true, badge: 'You' });
    const connected = !!(this.net && this.net.connected);
    const partnerName = this._roomPartnerName || '';
    fill(theirs, connected
      ? { name: partnerName || 'Partner', avatar: this._partnerAvatarUrl, achievements: this._partnerAchievements || [], here: true }
      : { name: 'Waiting for partner…', here: false });
  }

  _positionPipToVideoArea() {
    const captainSlot = document.getElementById('room-player-captain');
    const stokerSlot = document.getElementById('room-player-stoker');
    if (!captainSlot || !stokerSlot) return;
    const cRect = captainSlot.getBoundingClientRect();
    const sRect = stokerSlot.getBoundingClientRect();
    const root = document.documentElement.style;
    root.setProperty('--pip-captain-left', (cRect.left + cRect.width / 2) + 'px');
    root.setProperty('--pip-captain-top', (cRect.top + cRect.height / 2) + 'px');
    root.setProperty('--pip-stoker-left', (sRect.left + sRect.width / 2) + 'px');
    root.setProperty('--pip-stoker-top', (sRect.top + sRect.height / 2) + 'px');

    // #167: on phones the partner circle sits at 50% + 20vw, which with its
    // badges runs into the right toggle column (ALL / music). Cap its left
    // edge so circle + badges end just short of that column, and keep the
    // room code centred in the gap between the two circles.
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    const rightCol = this.lobbyEl && this.lobbyEl.querySelector('.lobby-right-col');
    const colRect = rightCol && rightCol.getBoundingClientRect();
    const wRect = partnerWrap && partnerWrap.getBoundingClientRect();
    if (!selfieWrap || !wRect || wRect.width === 0 || !colRect || colRect.width === 0) {
      root.removeProperty('--pip-partner-max-left');
      root.removeProperty('--pip-room-code-left');
      root.removeProperty('--pip-room-code-lift');
      return;
    }
    let right = wRect.right;
    for (const b of partnerWrap.querySelectorAll('.pip-badge')) right = Math.max(right, b.getBoundingClientRect().right);
    const maxLeft = Math.max(0, colRect.left - (right - wRect.left) - 6);
    root.setProperty('--pip-partner-max-left', maxLeft + 'px');
    const partnerLeft = Math.min(window.innerWidth * 0.7, maxLeft); // 50% + 20vw
    const selfieRight = selfieWrap.getBoundingClientRect().right;
    root.setProperty('--pip-room-code-left', ((selfieRight + partnerLeft) / 2) + 'px');
    // Too narrow for the code between them (e.g. 320px phones): lift it above the circles.
    const code = document.getElementById('mobile-room-code');
    const codeW = code ? code.getBoundingClientRect().width : 0;
    root.setProperty('--pip-room-code-lift', (partnerLeft - selfieRight - 40 < codeW ? 60 : 0) + 'px');
  }

  _hideLobby() {
    this.lobbyEl.style.display = 'none';
    this._stopGamepadNav();
    this._stopPreviewLoop();
  }

  /** #400 D4 · the Tandem Token balance on the GARAGE button (js/wallet.js). */
  _refreshWallet() {
    const el = document.getElementById('lobby-wallet');
    if (!el) return;
    const w = loadWallet(walletStore());
    el.textContent = ' · 🪙 ' + w.coins.toLocaleString('en-US');
  }

  _setup() {
    // The garage lives in Slingshot only (no lobby button).

    // On a phone, the phone IS the controller: no WebHID pairing (phones have
    // no WebHID) and no "phone as controller" (that's a remote for a big screen).
    if (isMobile) {
      for (const id of ['btn-mode-connect-hid', 'btn-mode-connect-hid-hint', 'btn-mode-phone', 'set-phone', 'btn-host-room-code', 'host-join-qr', 'btn-versus-join-phone']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
    }

    // SOLO → always show level selection
    document.getElementById('btn-solo').addEventListener('click', async () => {
      analytics.trackFirstInput('solo');
      await this._requestMotion();
      this._syncMotionState();
      this._pendingMode = 'solo';
      this._detectAndSetInputMethod();
      // D6 (#400): a first-time player goes straight into the tutorial
      // (SKIP is on screen there) instead of a level list they can't read yet.
      const tutorial = LEVELS.find(l => l.isTutorial);
      if (tutorial && !isTutorialDone(tutorialStore())) {
        this.selectedLevel = tutorial;
        this._forceWizard = true;
        this._updateDifficultyVisibility(tutorial.id);
        analytics.trackEvent('tutorial_auto_start');
        this._startRide();
        return;
      }
      this._showStep(this.levelStep);
    });

    // RIDE TOGETHER → role selection. A recent room is rejoined from JOIN A
    // RIDE's Rejoin cards (#547), not from a pop-up here.
    document.getElementById('btn-together').addEventListener('click', async () => {
      analytics.trackFirstInput('together');
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
    this._initTouristEntry();   // E-6 · "ride the distance between you"

    document.getElementById('btn-back-level').addEventListener('click', () => {
      if (this._pendingMode === 'versus') {
        // Back to team setup — players stay joined, monitor restarts via _showStep.
        this._showStep(this.versusStep);
      } else if (this._pendingMode === 'multiplayer') {
        if (this._roomRole === 'captain') {
          // #167 · the captain takes the stoker back with them.
          if (this.net && this.net.connected) this.net.sendProfile(RoomProtocol.backToRoom());
          this._levelsToRoom();
        } else {
          // The stoker's level screen is their room now: Back leaves the ride.
          this._leaveRoomAsStoker();
        }
      } else if (this._pendingMode === 'local' && this._localSeatedOnHost) {
        // Back to the captain's screen with Player 2 still in the stoker seat.
        this._showStep(this.hostStep);
      } else {
        // Local co-op: backing out abandons the setup, so give P2's seat back.
        // The online room was already destroyed when they joined, so there is
        // no half-live host page to return to — a fresh RIDE TOGETHER makes a
        // new room and a clean join.
        if (this._pendingMode === 'local') this._leaveLocalP2('back from level select');
        this._showStep(this.modeStep);
      }
    });

    // Back buttons
    document.getElementById('btn-back-mode').addEventListener('click', () => {
      this._showStep(this.modeStep);
    });
    document.getElementById('btn-back-role-host').addEventListener('click', () => {
      // Don't wipe recent rooms on back-out — keep them so RIDE TOGETHER can
      // still offer to rejoin this room within the 5-min window. Only an
      // explicit "New Room" (rejoin prompt / stale-room timer) clears. (#318)
      if (this.net) { this.net.destroy(); this.net = null; }
      this._leaveLocalP2('back from host page');
      this._roomPartnerName = null;
      this._refreshHostNext();
      const hostStatus = document.getElementById('host-status');
      if (hostStatus) { hostStatus.textContent = ''; hostStatus.className = 'conn-status'; }
      document.getElementById('room-code-display').textContent = '----';
      document.getElementById('room-qr').innerHTML = '';
      this._hostRoomCode = null;   // #563
      this._showStep(this.roleStep);
    });
    document.getElementById('btn-back-role-join').addEventListener('click', () => {
      // Keep recent rooms on back-out (see btn-back-role-host) so rejoin
      // stays available. (#318)
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
      // #563 · on a desktop / TV the host step leads with one "Scan to join"
      // QR, and the online room opens only when it is wanted: a phone picks
      // "Play on this phone", or the code button (to type it elsewhere). A
      // phone captain needs the code for its partner at once, as before.
      if (!isMobile) {
        if (this.net) { this.net.destroy(); this.net = null; }
        this._hostRoomCode = null;
        document.getElementById('room-code-display').textContent = '----';
        document.getElementById('room-qr').innerHTML = '';
        const hostStatus = document.getElementById('host-status');
        if (hostStatus) { hostStatus.textContent = ''; hostStatus.className = 'conn-status'; }
        this._showStep(this.hostStep);
        return;
      }
      this._showStep(this.hostStep);
      this._createRoom();
    });
    // #563 · open the online room to type its code on another device.
    document.getElementById('btn-host-room-code')?.addEventListener('click', () => {
      if (!this.net && this._currentStep === this.hostStep) this._createRoom();
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

    // VERSUS (local split-screen team racing) — desktop-only, like local co-op:
    // needs multiple physical controllers on one machine.
    const btnVersus = document.getElementById('btn-versus');
    // #641: Versus is the full game's. The demo shows it shut, with a tag, and
    // a press says where it is rather than doing nothing.
    const versusInEdition = getEditionRules().versus;
    if (btnVersus && !isMobile && !versusInEdition) {
      btnVersus.style.display = '';
      btnVersus.classList.add('lobby-role-locked');
      btnVersus.style.opacity = '0.55';
      const desc = btnVersus.querySelector('.lobby-role-desc');
      if (desc) desc.textContent = '🔒 In the full game';
      btnVersus.addEventListener('click', () => {
        showInfoToast('🔒', 'Versus is in the full game', 'Race side by side, 2–4 players. Wishlist Tandemonium on Steam.');
        analytics.trackEvent('demo_locked', { what: 'versus' });
      });
    } else if (btnVersus && !isMobile) {
      btnVersus.style.display = '';
      btnVersus.addEventListener('click', async () => {
        analytics.trackEvent('versus_setup_opened');
        await this._requestMotion();
        this._syncMotionState();
        this._enterVersusStep();
      });
    }
    document.getElementById('btn-back-versus').addEventListener('click', () => {
      this._leaveVersus();
      this._showStep(this.roleStep);
    });
    // PAIR A CONTROLLER (mode screen + versus step): the WebHID grant a pad the
    // Gamepad API can't see needs — a Steam Controller is HID-only and a second
    // DualSense over Bluetooth never surfaces. Ported from the host step's
    // CONNECT A CONTROLLER. No slot is named: the device is pooled, and the
    // seat screen offers it as soon as it streams (its first A press seats it).
    // In Electron the main process picks the next un-granted device itself.
    this._wireHidPairButton('btn-mode-connect-hid', 'btn-mode-connect-hid-hint', 'mode');
    this._wireHidPairButton('btn-versus-connect-hid', 'btn-versus-connect-hid-hint', 'versus');

    document.getElementById('btn-versus-join-kb').addEventListener('click', () => {
      this._versusJoinKeyboard();
    });
    document.getElementById('btn-versus-continue').addEventListener('click', () => {
      if (!this._versusTeamsValid()) return;
      this._pendingMode = 'versus';
      this._showStep(this.levelStep);
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

    // Host step: CHOOSE LEVEL under Online (the partner on their own device
    // has connected) and under Local (a second controller took the stoker seat).
    // Replaces the old room step's PLAY GAME (Pete, 2026-10-23). PLAY_GAME is
    // still sent, so a stoker on an older build leaves its room step too.
    document.getElementById('btn-host-online-next').addEventListener('click', () => {
      if (this._roomRole !== 'captain' || !(this.net && this.net.connected)) return;
      this.net.sendProfile(RoomProtocol.playGame());
      this.net.sendProfile(RoomProtocol.difficultySync(this.selectedDifficulty));
      this._showRoomLevelsStep();
    });
    document.getElementById('btn-host-local-next').addEventListener('click', () => {
      if (!this._localSeatedOnHost || !this._localP2InputManager) return;
      this._pendingMode = 'local';
      this._showStep(this.levelStep);
    });

    // Levels step: START RIDE button — works for solo, multiplayer, and local co-op
    document.getElementById('btn-start-ride').addEventListener('click', () => {
      // #517: the Slingshot card was picked — START RIDE opens its garage.
      if (this._slingshotPicked && this._currentStep === this.levelStep) {
        this._slingshotPicked = false;
        this._pendingMode = 'slingshot';
        this._hideLobby();
        this.onSlingshotReady();
        analytics.trackEvent('slingshot_open');
        return;
      }
      // #641: the Daily Ride's gate (the demo opens it after the Tutorial and
      // Grandma's, then gives it three rides a day). The stoker never starts.
      if (this.selectedLevel && this.selectedLevel.isDaily && !this._dailyGateAllows()) return;
      this._startRide();
    });

    this._startRide = () => {
      if (this._pendingMode === 'multiplayer') {
        if (this._roomRole !== 'captain') return;
        // Send start ride to partner — block if not connected
        if (!this.net || !this.net.connected) {
          const statusEl = document.getElementById('status');
          if (statusEl) statusEl.textContent = 'Reconnecting to partner...';
          return;
        }
        // B-4: the captain picks the run's placement salt and ships it with
        // the start message, so both riders meet the same pylons.
        this._placementSalt = makePlacementSalt();
        this.net.sendProfile(RoomProtocol.startRide(this._placementSalt, this.selectedLevel?.seed ?? null, false, this.selectedDifficulty));
        this._transitionToGame();
      } else if (this._pendingMode === 'local') {
        // Local same-screen co-op: hand off the pre-constructed P2 InputManager
        // to the game. onLocalReady handles mode setup + instructions screen.
        this._hideLobby();
        this.onLocalReady({
          inputP2: this._localP2InputManager,
          sourceType: this._localP2Type,
        });
      } else if (this._pendingMode === 'versus') {
        // Versus: hand off both teams' pre-constructed InputManagers.
        if (!this._versusTeamsValid()) return;
        analytics.trackEvent('versus_start', {
          team_a: this._versusPlayers.filter(p => p.team === 'A').length,
          team_b: this._versusPlayers.filter(p => p.team === 'B').length,
        });
        this._hideLobby();
        this.onVersusReady({ teams: this._versusTeams() });
      } else {
        // Solo: start game directly
        this._hideLobby();
        this.onSolo();
      }
    };

    // JOIN RIDE buttons on the host page: one per P2 path. Each button
    // unambiguously commits to a specific device — no auto-picking when
    // multiple options are present.
    const btnJoinGp = document.getElementById('btn-local-join-gp');
    if (btnJoinGp) {
      btnJoinGp.addEventListener('click', () => {
        const state = this._detectLocalP2State();
        if (!state.hasGamepad) return;
        // P2 may be a Gamepad API pad, a WebHID device, or a seat the manager
        // already claimed.
        if (state.gpIndex === null && !state.hidDevice && !state.slotId) return;
        this._onLocalJoinClick('gamepad', state.gpIndex, state.hidDevice || null, { slotId: state.slotId });
      });
    }
    // "CONNECT A CONTROLLER": the missing pairing path. A pad that Chromium's
    // Gamepad API can't see (a Steam Controller Puck; a DualSense over BT in
    // 0x31 mode) only reaches the game once WebHID has been GRANTED for it,
    // and the only requestDevice() in the game was the P1 gyro toggle — so a
    // second controller could never be approved and never showed up to join.
    // requestDevice needs transient user activation, which this click has.
    const btnConnectHid = document.getElementById('btn-local-connect-hid');
    if (btnConnectHid) {
      btnConnectHid.addEventListener('click', async () => {
        const hintEl = document.getElementById('btn-local-connect-hid-hint');
        if (!this.controllerManager || !navigator.hid) return;
        if (btnConnectHid.disabled) return;
        btnConnectHid.disabled = true;
        if (hintEl) hintEl.textContent = 'Searching for a controller…';
        this._publishHeldHidDevices();
        try {
          const device = await this.controllerManager.connectHidForSlot('P2', { prompt: true });
          if (hintEl) {
            hintEl.textContent = device
              ? `Paired ${device.productName || 'controller'}`
              : 'No new controller found — turn it on, then try again';
          }
          console.log('[local] P2 HID connect →', device ? (device.productName || 'device') : 'nothing new');
        } catch (err) {
          console.warn('[local] P2 HID connect failed:', err);
          if (hintEl) hintEl.textContent = 'Pairing failed — try again';
        } finally {
          btnConnectHid.disabled = false;
        }
      });
    }

    const btnJoinKb = document.getElementById('btn-local-join-kb');
    if (btnJoinKb) {
      btnJoinKb.addEventListener('click', () => {
        const state = this._detectLocalP2State();
        if (!state.hasKeyboard) return;
        this._onLocalJoinClick('keyboard', null);
      });
    }

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
    this.toggleAchievements.addEventListener('click', () => this._openAchievements());   // #540
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
  /**
   * B-3 · the one line on a level card that gives a reason to ride it again.
   * Reads the local record store for the currently selected difficulty and
   * whichever mode this card list belongs to.
   */
  _recordLine(level, mode) {
    if (level.isTutorial || level.timerEnabled === false) return '';
    const cardMode = mode === 'versus' ? 'versus' : (mode === 'solo' || !mode ? 'solo' : 'coop');
    const store = records.load();
    // Today's Road is recorded under today's day (or week) key; the card's
    // level is the unresolved base, so pass the key it would ride today.
    const roadKey = level.isDaily ? dailyKey() : undefined;
    const best = records.getBest(store, records.key(records.levelRecordId(level, roadKey), this.selectedDifficulty, cardMode));
    const thresholds = getMedals(level.id, this.selectedDifficulty);
    if (!best) {
      return thresholds
        ? 'No ride yet · ' + records.MEDAL_ICON.gold + ' at ' + records.formatTime(thresholds.gold)
        : 'No ride yet';
    }
    const medal = records.medalFor(best.timeMs, thresholds);
    const next = records.nextMedal(medal);
    let line = 'Best ' + records.formatTime(best.timeMs);
    if (medal) line += ' · ' + records.MEDAL_ICON[medal];
    if (thresholds && next) line += ' · ' + records.MEDAL_ICON[next] + ' at ' + records.formatTime(thresholds[next]);
    return line;
  }

  /**
   * D-2 · the demo build is practice-only. Mirrors game._isDemo (the game owns
   * the Steam-side flag; this is the query-string half, which is what the demo
   * launch URL carries).
   */
  /**
   * PR #397 M1 · the rules this lobby picks by: this edition's, or in an online room the MOST RESTRICTIVE of the two sides (edition.mergeRoomRules).
   * Until the partner's room profile arrives it counts as an old client.
   */
  roomRules() {
    const mine = getEditionRules();
    return this._pendingMode === 'multiplayer' ? mergeRoomRules(mine, this._partnerRoom || null) : mine;
  }

  /** PR #397 M1 · { edition, caps } for this side's room profile. */
  roomProfileFields() {
    return roomProfileFields(getEditionRules());
  }

  /**
   * PR #397 M1 · the levelSync payload beyond the level id: the effective
   * difficulty, and for the shared road its kind, key and seed — the stoker
   * adopts these rather than resolving them from its own edition.
   */
  _levelSyncExtra(level) {
    const extra = { difficulty: this.selectedDifficulty };
    if (level && level.isDaily) {
      extra.key = level.key; extra.seed = level.seed;
      extra.roadKind = 'daily';
    }
    return extra;
  }

  get isDemoBuild() {
    // #400: one source of truth for what the demo restricts — js/edition.js.
    return isDemoEdition();
  }

  /**
   * The shared road with its identity attached (the Daily Ride, in both
   * editions since #641). Any other level comes back as is. `key`/`seed` are
   * the captain's when a stoker resolves it (C-2).
   */
  resolveRoadLevel(level, { key, seed } = {}) {
    if (!level || !level.isDaily) return level;
    return resolveDailyLevel(level, {
      key: key || dailyKey(), seed: typeof seed === 'number' ? seed : dailySeed()
    });
  }

  // ============================================================
  // E-6 / E-8 · "Ride the distance between you"
  // ============================================================
  //
  // Two addresses become a ride over real photogrammetry. This is the only
  // feature in the plan that is *about* the thing the persona actually feels:
  // the distance is the point, and the number on screen is the story.
  //
  // The route maths is pure and tested (js/tourist-route.js). This is the
  // form, the geocoding calls, and remembering the pair's last route so the
  // second ride is one button (E-8).

  /** E-8 · the last route this browser rode, or null. */
  _loadSavedRoute() {
    try {
      const raw = localStorage.getItem('tandemonium_tourist_route');
      const saved = raw ? JSON.parse(raw) : null;
      // #400: `to` is optional — one address is an open-world ride.
      if (!saved || !isValidPoint(saved.from)) return null;
      return saved.to == null || isValidPoint(saved.to) ? saved : null;
    } catch { return null; }
  }

  _saveRoute(from, to = null) {
    try {
      localStorage.setItem('tandemonium_tourist_route', JSON.stringify({ from, to: to || null, at: Date.now() }));
    } catch { /* private mode: the ride still works, it is just not remembered */ }
  }

  /**
   * Show the Tourist entry at all only when it can actually work. Without a
   * Maps key the mode can only disappoint, and an entry point that fails is
   * worse than no entry point — that is the #350 lesson.
   *
   * #400: the entry is a card in the SOLO level list (which couch co-op uses
   * too) and in the captain's RIDE TOGETHER list (_buildLevelCardsShared), not
   * a mode-screen button. Online: the captain plans, the end points go to the
   * stoker (RoomProtocol.touristPlan), and the game meets at a tiles-ready
   * barrier before the countdown (game._startCoopTourist).
   */
  _touristAvailable() {
    return this.roomRules().tourist && !!getMapsApiKey();   // M1: room needs a partner that can ride it
  }

  /** #400: "Map Tourist" alone, "Map Tourists" when two ride it. */
  _touristLabel() {
    return this._pendingMode === 'local' || this._pendingMode === 'multiplayer'
      ? 'Map Tourists' : 'Map Tourist';
  }

  /** The SOLO list is shared with couch co-op, so name the card as it is shown. */
  _refreshTouristCard() {
    // PR #397 m10: the SOLO list was built for one rider or for the couch;
    // rebuild it when the other one is about to see it (Slingshot card).
    const want = this._pendingMode === 'local' ? 'local' : this._pendingMode === 'solo' ? 'solo' : null;
    if (want && this._soloListFor && want !== this._soloListFor) this._rebuildLevelCards();
    const name = document.querySelector('#level-cards .level-card-tourist .level-card-name');
    if (name) name.textContent = this._touristLabel();
  }

  _openTouristStep() {
    // Who rides it: alone, two on this screen, or the room (captain plans).
    this._touristFor = this._pendingMode === 'local' || this._pendingMode === 'multiplayer'
      ? this._pendingMode : 'solo';
    const together = this._touristFor !== 'solo';
    const prompt = this.touristStep.querySelector('.lobby-prompt');
    if (prompt) prompt.textContent = together ? 'Map Tourists · Where will you ride?' : 'Map Tourist · Where will you ride?';
    const fromIn = document.getElementById('tourist-from');
    const toIn = document.getElementById('tourist-to');
    if (fromIn) fromIn.placeholder = 'Address or place';
    if (toIn) toIn.placeholder = together ? "Your partner's address or city" : 'Second address or city';
    if (this._touristFor === 'solo') this._pendingMode = 'tourist';
    this._forceWizard = false;
    this._showStep(this.touristStep);
    this._prefillTouristForm();
    analytics.trackEvent('tourist_open');
  }

  _initTouristEntry() {
    if (!this._touristAvailable()) return;     // no card is built either

    const back = document.getElementById('btn-back-tourist');
    if (back) back.addEventListener('click', () => {
      if (this._touristFor === 'multiplayer') { this._showRoomLevelsStep(); return; }
      this._pendingMode = this._touristFor === 'local' ? 'local' : 'solo';
      this._showStep(this.levelStep);
    });

    const from = document.getElementById('tourist-from');
    const to = document.getElementById('tourist-to');
    const go = document.getElementById('btn-tourist-ride');
    const onEdit = () => {
      const two = this._touristTwoAddresses();
      const ready = from.value.trim().length > 2 && (!two || to.value.trim().length > 2);
      go.disabled = !ready;
      go.textContent = two ? 'PLAN THE RIDE' : 'EXPLORE HERE';
      this._touristPlan = null;
      const preview = document.getElementById('tourist-preview');
      if (preview) preview.textContent = '';
    };
    this._onTouristEdit = onEdit;
    from.addEventListener('input', onEdit);
    to.addEventListener('input', onEdit);
    go.addEventListener('click', () => this._planTouristRide());

    // #400: one address explores around it; a second one plans a route.
    const add = document.getElementById('btn-tourist-add-to');
    const remove = document.getElementById('btn-tourist-remove-to');
    if (add) add.addEventListener('click', () => { this._setTouristTwoAddresses(true); to.focus(); onEdit(); });
    if (remove) remove.addEventListener('click', () => { to.value = ''; this._setTouristTwoAddresses(false); onEdit(); });
  }

  /** #400 · is the second-address field showing? */
  _touristTwoAddresses() {
    const row = document.getElementById('tourist-to-row');
    return !!row && row.style.display !== 'none';
  }

  _setTouristTwoAddresses(on) {
    const row = document.getElementById('tourist-to-row');
    const add = document.getElementById('btn-tourist-add-to');
    if (row) row.style.display = on ? '' : 'none';
    if (add) add.style.display = on ? 'none' : '';
  }

  /** E-8 · offer the last route back, so a repeat ride is one button. */
  _prefillTouristForm() {
    const saved = this._loadSavedRoute();
    const preview = document.getElementById('tourist-preview');
    const go = document.getElementById('btn-tourist-ride');
    if (!saved) {
      if (preview) preview.textContent = '';
      this._setTouristTwoAddresses(false);
      if (this._onTouristEdit) this._onTouristEdit();
      return;
    }
    document.getElementById('tourist-from').value = saved.from.label || '';
    document.getElementById('tourist-to').value = saved.to ? (saved.to.label || '') : '';
    this._setTouristTwoAddresses(!!saved.to);
    if (go) go.disabled = false;
    const plan = saved.to ? planRoute(saved.from, saved.to) : planExplore(saved.from);
    if (preview) {
      preview.innerHTML = saved.to
        ? 'Again? <strong>' + this._escape(saved.from.label) + '</strong> to <strong>' +
          this._escape(saved.to.label) + '</strong><br>' + this._escape(plan.headline)
        : 'Again? <strong>' + this._escape(saved.from.label) + '</strong><br>Open world · ride anywhere nearby';
    }
    this._touristPlan = plan;
    if (go) go.textContent = 'RIDE IT AGAIN';
  }

  /**
   * Geocode both ends, show what the ride will be, and — on the second press —
   * start it. Two presses on purpose: the distance is the reveal, and riding
   * straight past it would throw away the best moment this mode has.
   */
  async _planTouristRide() {
    const go = document.getElementById('btn-tourist-ride');
    const errorEl = document.getElementById('tourist-error');
    const preview = document.getElementById('tourist-preview');
    const fromText = document.getElementById('tourist-from').value;
    const toText = document.getElementById('tourist-to').value;
    const two = this._touristTwoAddresses() && toText.trim().length > 0;

    // Second press with a plan already on screen: ride it.
    if (this._touristPlan) {
      this._startTouristRide(this._touristPlan);
      return;
    }

    errorEl.textContent = '';
    go.disabled = true;
    go.textContent = 'FINDING…';

    // #400 · one address: find it and ride straight in (open world). No
    // two-press reveal — there is no distance to show.
    if (!two) {
      try {
        const from = await geocodeAddress(fromText);
        if (!isValidPoint(from)) throw new Error('could not place that address');
        this._saveRoute(from, null);
        analytics.trackEvent('tourist_explore_planned');
        go.disabled = false;
        go.textContent = 'EXPLORE HERE';
        this._startTouristRide(planExplore(from));
      } catch (err) {
        errorEl.textContent = String(err && err.message || err).replace(/^Error:\s*/, '');
        go.disabled = false;
        go.textContent = 'EXPLORE HERE';
        analytics.trackEvent('tourist_route_failed');
      }
      return;
    }

    try {
      const [from, to] = await Promise.all([
        geocodeAddress(fromText),
        geocodeAddress(toText)
      ]);
      if (!isValidPoint(from) || !isValidPoint(to)) throw new Error('could not place one of those');

      const plan = planRoute(from, to);
      this._touristPlan = plan;
      preview.innerHTML = '<strong>' + this._escape(from.label) + '</strong><br>to <strong>' +
        this._escape(to.label) + '</strong><br>' + this._escape(plan.headline) +
        (plan.route.capped
          ? '<br><span style="opacity:0.7">' + this._escape(skipLabel(plan.route)) +
            ' — you ride the first and last 2.5 km</span>'
          : '');
      go.disabled = false;
      go.textContent = 'RIDE IT';
      this._saveRoute(from, to);
      analytics.trackEvent('tourist_route_planned', {
        km: Math.round(plan.realM / 1000), capped: plan.route.capped
      });
    } catch (err) {
      // Inline, never a console exception: a mistyped address is the most
      // ordinary thing that can happen on this screen.
      errorEl.textContent = String(err && err.message || err).replace(/^Error:\s*/, '');
      go.disabled = false;
      go.textContent = 'PLAN THE RIDE';
      analytics.trackEvent('tourist_route_failed');
    }
  }

  async _startTouristRide(plan) {
    const forMode = this._touristFor || 'solo';
    if (forMode === 'multiplayer') {
      // Online co-op: the captain's plan travels as its two end points, then
      // the ordinary start message (flagged), and both sides enter the game.
      if (this._roomRole !== 'captain') return;
      const errorEl = document.getElementById('tourist-error');
      if (!this.net || !this.net.connected) {
        if (errorEl) errorEl.textContent = 'Reconnecting to your partner…';
        return;
      }
      // PR #397 m16: the captain finds the anchor's ground height ONCE, here,
      // outside the shared ready deadline, and sends it with the plan.
      if (!plan.anchor) {
        const go = document.getElementById('btn-tourist-ride');
        if (go) go.disabled = true;
        try {
          const o = await resolveOriginAt(plan.from);
          if (o && Number.isFinite(o.height)) plan.anchor = { height: o.height, anchored: !!o.anchored };
        } catch { /* the stoker falls back to its own lookup */ }
        if (go) go.disabled = false;
        if (!this.net || !this.net.connected) {
          if (errorEl) errorEl.textContent = 'Reconnecting to your partner…';
          return;
        }
      }
      this._roomTouristPlan = plan;
      this._placementSalt = makePlacementSalt();
      this.net.sendProfile(RoomProtocol.touristPlan(plan.from, plan.explore ? null : plan.to, plan.anchor));
      this.net.sendProfile(RoomProtocol.startRide(this._placementSalt, null, true, this.selectedDifficulty));
      analytics.trackEvent('tourist_ride_start', { km: Math.round(plan.realM / 1000), mode: 'online' });
      this._transitionToGame();
      return;
    }
    this._hideLobby();
    if (forMode === 'local') {
      this.onTouristReady({ plan, local: { inputP2: this._localP2InputManager, sourceType: this._localP2Type } });
    } else {
      this.onTouristReady({ plan });
    }
    analytics.trackEvent('tourist_ride_start', { km: Math.round(plan.realM / 1000), mode: forMode });
  }

  /**
   * #400 · the route this room's ride is for, once: the game takes it when the
   * ride starts (null for every ordinary ride).
   */
  takeRoomTouristPlan() {
    const plan = this._roomTouristPlan || null;
    this._roomTouristPlan = null;
    return plan;
  }

  /** Escape a geocoder-supplied label before it goes anywhere near innerHTML. */
  _escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * C-2 · the Daily Ride card text: which day it is, what you've done on it,
   * and when it changes. #641: in the demo, why it is shut (the Tutorial and
   * Grandma's open it; three rides a day) or how many rides are left.
   */
  _roadDescHtml(level) {
    const key = dailyKey();
    const gate = this._dailyGate();
    const rule = '<br><span class="level-card-daily-rule">' + DAILY_RULES_LINE + '</span>';
    if (!gate.ok) return '&#x1F512; ' + this._dailyGateText(gate) + rule;
    let line = dailyDescription(dailyStatus(browserStore(), key), key);
    if (gate.left != null) line += ' · ' + gate.left + ' of ' + this.roomRules().dailyRideCap + ' rides left';
    return line + rule;
  }

  /** #641 · can this device start another Daily Ride? (edition.dailyRideGate) */
  _dailyGate() {
    // Read the saved list, not this._achievements: the game holds its own
    // manager, and the Grandma's finish that opens the road is earned there.
    let earned = [];
    try {
      const raw = localStorage.getItem('tandemonium_achievements');
      if (raw) earned = JSON.parse(raw).map(a => a.id);
    } catch { /* empty */ }
    return dailyRideGate(this.roomRules(), ridesStarted(browserStore(), dailyKey()), earned);
  }

  /** #641 · the words for a shut Daily Ride. */
  _dailyGateText(gate) {
    if (gate.reason === 'needs') {
      const names = { tutorial_done: 'the Tutorial', home_sweet: 'Grandma’s' };
      const list = gate.needs.map(id => names[id] || id);
      return 'Finish ' + list.join(' and ') + ' to open the Daily Ride';
    }
    return 'That’s today’s ' + this.roomRules().dailyRideCap + ' rides · the full game rides it as often as you like';
  }

  /** #641 · true when a Daily Ride may start; otherwise says why and returns false. */
  _dailyGateAllows() {
    const gate = this._dailyGate();
    if (gate.ok) return true;
    showInfoToast('🔒', 'Daily Ride', this._dailyGateText(gate));
    analytics.trackEvent('daily_gate', { reason: gate.reason });
    return false;
  }

  /** B-3 · re-render the record line (and Today's Road's day line) on every visible level card. */
  _refreshRecordLines() {
    document.querySelectorAll('.level-card').forEach(card => {
      const line = card.querySelector('.level-card-record');
      if (!line) return;
      const base = LEVELS.find(l => l.id === card.dataset.levelId);
      if (!base) return;
      const level = base;
      // The day line changes after every ride on the Daily Ride, and the cards
      // are built once at boot. #641: so does its gate (the demo's lock).
      const desc = level.isDaily && card.querySelector('.level-card-desc');
      if (desc) desc.innerHTML = this._roadDescHtml(level);
      if (level.isDaily) this._applyDailyLock(card);
      const inVersus = !!card.closest('#versus-level-list, [id*="versus"]');
      line.textContent = this._recordLine(level, inVersus ? 'versus' : (this.net ? 'coop' : 'solo'));
    });
  }

  /**
   * #641 · show the Daily Ride card shut (greyed, skipped by the default pick
   * and by NEXT LEVEL) while its gate is closed. It stays clickable, so a
   * click explains what opens it.
   */
  _applyDailyLock(card) {
    const shut = !this._dailyGate().ok;
    card.classList.toggle('level-locked', shut);
    this._lockedLevelIds = this._lockedLevelIds || new Set();
    if (shut) this._lockedLevelIds.add(card.dataset.levelId);
    else this._lockedLevelIds.delete(card.dataset.levelId);
  }

  _buildLevelCardsShared({ container, isClickable, mode, showTutorial, startBtn, backBtn, step }) {
    container.innerHTML = '';
    const buttons = [];

    // Level unlock requirements: { levelId: achievementId }. None today —
    // the Castle (the only locked level) was removed in #400.
    const LEVEL_UNLOCK = {};

    // C-4 · levels the demo shows locked, pointing at the store. Empty since
    // the Castle was removed (#400).
    const demoLocked = new Set();

    // Check if gyro is active but uncalibrated (show recommendation, don't lock)
    const needsTuning = this._needsMotionTuning();

    // C-2: Today's Road is not in the VERSUS list — versus has its own rules
    // (two teams, one screen) and a shared daily result means nothing there.
    const isVersus = mode === 'versus';
    // #400: every list offers only what this edition includes.
    const rules = this.roomRules();   // PR #397 M1: a room offers what BOTH sides can ride
    const levels = LEVELS.filter(l =>
      (showTutorial || !l.isTutorial) && !(isVersus && l.isDaily) && levelAllowed(rules, l.id));
    this._lockedLevelIds = this._lockedLevelIds || new Set();   // read by NEXT LEVEL

    levels.forEach(level => {
      const isTutorial = level.isTutorial;
      const requiredAch = LEVEL_UNLOCK[level.id];
      const demoGated = demoLocked.has(level.id);
      const locked = demoGated ||
        (!isTutorial && requiredAch && !this._achievements.getEarnedIds().includes(requiredAch));
      if (locked) this._lockedLevelIds.add(level.id); else this._lockedLevelIds.delete(level.id);

      const card = document.createElement('button');
      card.className = 'level-card' + (locked ? ' level-locked' : '') + (isTutorial ? ' level-card-tutorial' : '');
      card.dataset.levelId = level.id;

      if (locked) {
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">&#x1F512;</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' +
            (demoGated ? 'In the full game &mdash; wishlist on Steam'
                       : 'Complete Grandma\'s House to unlock') +
          '</div>';
        card.disabled = true;
      } else {
        // Tutorial description adapts to calibration state
        let desc = isTutorial && needsTuning
          ? '\u2B50 Recommended for calibration'
          : level.description;
        // C-2: Today's Road says which day it is, what you have done on it, and
        // when the next road arrives \u2014 a daily thing nobody knows is daily is
        // just a level.
        if (level.isDaily) desc = this._roadDescHtml(level);
        card.innerHTML =
          '<div class="level-card-top">' +
            '<span class="level-card-icon">' + level.icon + '</span>' +
            '<span class="level-card-name">' + level.name + '</span>' +
          '</div>' +
          '<div class="level-card-desc">' + desc + '</div>' +
          // B-3: your best on this road, and the medal you are chasing. Says
          // "No ride yet" rather than nothing, so the line is a promise on the
          // first visit instead of an absence.
          '<div class="level-card-record">' + this._recordLine(level, mode) + '</div>';

        if (level.isDaily) this._applyDailyLock(card);   // #641
        if (isClickable) {
          card.addEventListener('click', () => {
            // #641: a shut Daily Ride explains itself instead of being picked.
            if (level.isDaily && !this._dailyGateAllows()) return;
            // C-2: Today's Road resolves its identity at the moment it is picked
            // — the day key and seed come from the clock now, not from whenever
            // this page was loaded (someone may have left it open overnight).
            this.selectedLevel = this.resolveRoadLevel(level);
            this._forceWizard = isTutorial;
            this._slingshotPicked = false;   // #517
            this._updateDifficultyVisibility(level.id);
            container.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            if (startBtn) startBtn.disabled = false;
            analytics.trackEvent('level_select', { level: level.id, difficulty: this.selectedDifficulty });
            if (level.isDaily) {
              analytics.trackEvent('daily_open', { key: this.selectedLevel.key });
            }
            if (this.net && this.net.connected) {
              // C-2: the captain's day key and seed are authoritative — a stoker
              // whose clock is on the other side of the 09:00 UTC rollover must
              // still ride the captain's road, not a different one.
              this.net.sendProfile(RoomProtocol.levelSync(level.id, this._levelSyncExtra(this.selectedLevel)));
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

    // Slingshot lives under SOLO: a mode, not a level. #517: picking its card
    // selects it like a level (it has no difficulty, so that row greys out)
    // and START RIDE opens its garage. #400: the edition decides (the demo
    // keeps it, with a stage cap).
    // PR #397 m10: not for couch co-op, which shares this list — the Slingshot
    // is one rider, and leaving through it silently dropped P2.
    this._soloListFor = mode !== 'solo' ? null : this._pendingMode === 'local' ? 'local' : 'solo';
    if (mode === 'solo' && isClickable && rules.slingshot.enabled && this._pendingMode !== 'local') {
      const card = document.createElement('button');
      card.className = 'level-card level-card-slingshot';
      card.dataset.levelId = 'slingshot';
      card.innerHTML =
        '<div class="level-card-top">' +
          '<span class="level-card-icon">&#127919;</span>' +
          '<span class="level-card-name">Slingshot</span>' +
        '</div>' +
        '<div class="level-card-desc">Pull back, aim, let go. Earn Tandem Tokens and upgrade.</div>';
      card.addEventListener('click', () => {
        container.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this._slingshotPicked = true;
        document.querySelectorAll('#difficulty-selector .difficulty-btn').forEach(b => {
          b.disabled = true;
          b.classList.add('diff-disabled');
        });
        if (startBtn) startBtn.disabled = false;
      });
      container.appendChild(card);
      buttons.push(card);
    }

    // E-6 / #400 · Tourist lives under SOLO too: a mode, not a level, so its
    // card opens the route-planning step. Only when it can work (a Maps key)
    // and the edition includes it — an entry point that fails is worse than
    // none (#350). Solo only: co-op Tourist is not built (see _initTouristEntry).
    if ((mode === 'solo' || mode === 'multiplayer') && isClickable && this._touristAvailable()) {
      const card = document.createElement('button');
      card.className = 'level-card level-card-tourist';
      card.dataset.levelId = 'tourist';
      card.innerHTML =
        '<div class="level-card-top">' +
          '<span class="level-card-icon">&#128205;</span>' +
          '<span class="level-card-name">' + this._touristLabel() + '</span>' +
        '</div>' +
        '<div class="level-card-desc">Two places on the map become a ride through real streets.</div>';
      card.addEventListener('click', () => this._openTouristStep());
      container.appendChild(card);
      buttons.push(card);
    }

    // Default selection: restore previous or pick first unlocked non-tutorial level
    if (isClickable) {
      this._slingshotPicked = false;   // #517: the cards were rebuilt; a level is picked below
      let defaultCard = null;
      if (this.selectedLevel) {
        // Restore previous selection
        defaultCard = container.querySelector('.level-card[data-level-id="' + this.selectedLevel.id + '"]:not(.level-locked):not(.level-card-slingshot):not(.level-card-tourist)');
      }
      if (!defaultCard) {
        // Pick first unlocked non-tutorial level (Grandma's)
        defaultCard = container.querySelector('.level-card:not(.level-locked):not(.level-card-tutorial):not(.level-card-slingshot):not(.level-card-tourist)');
      }
      if (defaultCard) {
        defaultCard.classList.add('selected');
        this.selectedLevel = this.resolveRoadLevel(LEVELS.find(l => l.id === defaultCard.dataset.levelId));
        this._forceWizard = !!(this.selectedLevel && this.selectedLevel.isTutorial);
        if (startBtn) startBtn.disabled = false;
        this._updateDifficultyVisibility(defaultCard.dataset.levelId);
        // Sync to partner on multiplayer re-entry
        if (this.net && this.net.connected) {
          this.net.sendProfile(RoomProtocol.levelSync(this.selectedLevel.id, this._levelSyncExtra(this.selectedLevel)));
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
    // Default focus to START RIDE button
    if (startBtn && isClickable) {
      this._stepDefaultFocus.set(step, navItems.indexOf(startBtn));
    }
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
    if (startBtn) { startBtn.disabled = true; startBtn.style.display = ''; }
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
      // Refresh items (new cards) while PRESERVING the current focus — don't
      // reset to the step default, which would jump focus off a toggle the
      // user just pressed (e.g. ALL/gyro rebuilds the cards). (#318)
      if (this.input && this.input.gamepadConnected) {
        this._stepFocus.refreshSpatial(this._stepNavItems());
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
    // C-2: Today's Road is one road at one difficulty for everyone — a shared
    // road that each player tunes to taste is not a shared road.
    const daily = LEVELS.find(l => l.id === levelId && l.isDaily);
    const roadDifficulty = daily && daily.fixedDifficulty;
    const forced = isTutorial ? 'chill' : (daily ? roadDifficulty : null);
    const diffBtns = document.querySelectorAll('#difficulty-selector .difficulty-btn');
    if (forced && !isTutorial) {
      diffBtns.forEach(b => {
        b.disabled = true;
        b.classList.add('diff-disabled');
        b.classList.toggle('selected', b.dataset.difficulty === forced);
      });
      this.selectedDifficulty = forced;
      this._syncForcedDifficulty();   // PR #397 M1
      this._refreshRecordLines();
      return;
    }
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
      this._syncForcedDifficulty();   // PR #397 M1
    }
  }

  /** PR #397 M1 · a forced difficulty (road, tutorial) goes to the stoker too. */
  _syncForcedDifficulty() {
    if (this._roomRole === 'captain' && this._pendingMode === 'multiplayer' && this.net && this.net.connected) {
      this.net.sendProfile(RoomProtocol.difficultySync(this.selectedDifficulty));
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
          // B-3: bests and medals are per difficulty, so the card lines have to
          // follow the choice the player just made.
          this._refreshRecordLines();
          // Sync difficulty to partner in multiplayer
          if (this.net && this.net.connected) {
            this.net.sendProfile(RoomProtocol.difficultySync(btn.dataset.difficulty));
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
        // #517: Help's Profile line said "Sign in with Google" here too.
        const helpProfile = document.getElementById('help-profile-desc');
        if (helpProfile) helpProfile.textContent = '— You are signed in with Steam; your scores save automatically';
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
    const popupAvatars = document.getElementById('profile-popup-avatars');
    const popupName = document.getElementById('profile-popup-name');
    const popupEmail = document.getElementById('profile-popup-email');
    const logoutBtn = document.getElementById('profile-popup-logout');

    // Initialize auth: Steam signs in by itself; everyone else can sign in
    // with Discord from the Profile popup (#612; Google is no longer offered).
    if (this._isSteam) this.auth.loginWithSteam();

    // Steam identity is automatic, so there's no meaningful logout on Steam (#332).
    // Elsewhere (web, or the desktop app without Steam) Discord can sign back in.
    if (this._isSteam && logoutBtn) logoutBtn.style.display = 'none';

    // Save original SVG to restore on logout
    const profileSvg = this.toggleProfile.innerHTML;
    // #517: the desktop/TV bar's Profile pill shows the picture too.
    const barProfile = document.getElementById('bar-profile');
    const barProfileSvg = barProfile ? barProfile.innerHTML : '';
    // #612: Discord's picture on the left of "Profile", Steam's on the right.
    const setBarAvatars = (pics) => {
      if (!barProfile) return;
      barProfile.innerHTML = barProfileSvg;
      const discord = pics.find((p) => p.provider === 'discord');
      const steam = pics.find((p) => p.provider === 'steam');
      const other = !discord && !steam ? pics[0] : null;
      const mk = (p) => {
        const img = document.createElement('img');
        img.className = 'bar-avatar';
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.dataset.provider = p.provider;
        img.src = this._avatarCache.get(p.avatar) || p.avatar;
        return img;
      };
      const svg = barProfile.querySelector('svg');
      if ((discord || other) && svg) svg.replaceWith(mk(discord || other));
      if (steam) barProfile.append(mk(steam));
    };

    const updateUI = (user) => {
      // P1's seat card shows their picture and name once signed in (#612).
      queueMicrotask(() => { try { this._refreshHostNext(); } catch (e) {} });
      if (user) {
        this.toggleProfile.classList.add('active');
        this.toggleLeaderboard.classList.add('active');
        const pics = identityPictures(user);
        popupAvatars.replaceChildren(...pics.map((p) => {
          const img = document.createElement('img');
          img.alt = p.provider;
          img.title = p.provider === 'discord' ? 'Discord' : p.provider === 'steam' ? 'Steam' : '';
          img.referrerPolicy = 'no-referrer';
          img.dataset.provider = p.provider;
          img.src = this._avatarCache.get(p.avatar) || p.avatar;
          return img;
        }));
        popupName.textContent = user.name || '';
        const linked = Object.keys(user.identities || {}).filter((k) => k !== 'google')
          .map((k) => (k === 'discord' ? 'Discord' : k === 'steam' ? 'Steam' : k));
        popupEmail.textContent = linked.length ? 'Signed in with ' + linked.join(' + ') : '';
        // A Steam player can add Discord; it puts both on one House Tandem account.
        const linkBtn = document.getElementById('profile-popup-link-discord');
        if (linkBtn) linkBtn.style.display = this.auth.hasIdentity('discord') ? 'none' : '';
        if (pics[0]) {
          const first = pics[0].avatar;
          this.toggleProfile.innerHTML = '<img src="' + (this._avatarCache.get(first) || first) + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">';
        }
        setBarAvatars(pics);
        // Fire-and-forget: fetch and upgrade to blob URLs
        const uncached = pics.map((p) => p.avatar).filter((a) => a && !this._avatarCache.has(a));
        if (uncached.length) {
          this._cacheAvatarUrls(uncached).then(() => {
            if (this.auth.getUser() !== user) return;
            const img = this.toggleProfile.querySelector('img');
            if (img && pics[0]) img.src = this._avatarCache.get(pics[0].avatar) || pics[0].avatar;
            setBarAvatars(pics);
          });
        }
      } else {
        this.toggleProfile.classList.remove('active');
        this.toggleLeaderboard.classList.remove('active');
        this.toggleProfile.innerHTML = profileSvg;
        setBarAvatars([]);
        this.profilePopup.classList.remove('visible');
      }
    };
    this._profileUpdateUI = updateUI;

    this.auth.onLogin(async (user) => {
      updateUI(user);
      this._hideProfileDevice();
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

      // A live online session (a ride, or a room with the partner in it) is never replaced by a
      // queued "sign in, then create / join": drop the queue instead.
      if (this.net && this.net.connected) { this._pendingAutoJoinCode = null; this._pendingCreateRoom = false; }
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
      // Push local achievements to server before clearing (no-op if none/anon)
      await this._achievements.syncToServer();
      this._achievements.clear();
      this.license.clear();
      this.auth.logout();
      updateUI(null);
      this._updateModeButtons();
      this._rebuildLevelCards();
    });

    // Steam build, signed out: sign back in with this PC's Steam account.
    const steamBtn = document.getElementById('profile-popup-steam');
    if (steamBtn) {
      steamBtn.style.display = this._isSteam ? '' : 'none';
      steamBtn.addEventListener('click', async () => {
        this._profileDiag('SIGN IN WITH STEAM');
        const ok = await this.auth.loginWithSteam();
        if (!ok) { this._showProfileError(this.auth.lastAuthError || 'Steam sign-in is unavailable'); return; }
        updateUI(this.auth.getUser());
        this._updateModeButtons();
        this.profilePopup.classList.remove('visible');
      });
    }

    // Back buttons close the popup
    document.getElementById('profile-popup-back').addEventListener('click', () => {
      this._profileDiag('CLOSE clicked');
      this.profilePopup.classList.remove('visible');
    });
    document.getElementById('profile-popup-signin-back').addEventListener('click', () => {
      this.profilePopup.classList.remove('visible');
    });

    // #612 · Sign in with Discord. On this device: go to Discord and back. In
    // the desktop app: open the system browser on the device-code page (the QR
    // under it does the same from a phone).
    document.getElementById('profile-popup-discord').addEventListener('click', async () => {
      if (window.electronApp && window.electronApp.openSignIn) {
        const dev = await this._showProfileDevice();
        if (dev) window.electronApp.openSignIn(dev.url);
        return;
      }
      const ok = await this.auth.signInWithDiscordRedirect();
      if (!ok) this._showProfileError(this.auth.lastAuthError || 'Discord sign-in is unavailable');
    });
    // A Steam player links Discord: always the device code (the system
    // browser in the desktop app, or a phone).
    document.getElementById('profile-popup-link-discord').addEventListener('click', async () => {
      const dev = await this._showProfileDevice();
      if (dev && window.electronApp && window.electronApp.openSignIn) window.electronApp.openSignIn(dev.url);
    });

    // Back from a Discord redirect: sign in with what it brought.
    this.auth.resumeFromRedirect().catch((e) => console.warn('AUTH: Discord redirect sign-in failed', e));
    // Pick up sign-ins linked elsewhere (Discord linked from the Steam build shows on the web).
    if (this.auth.isLoggedIn() && !this.auth.isTokenExpired()) {
      this.auth.refreshProfile().then((u) => { if (u) updateUI(u); }).catch(() => {});
    }

    // Close popup when clicking outside
    document.addEventListener('click', (e) => {
      if (!this.profilePopup.classList.contains('visible')) return;
      if (this.profilePopup.contains(e.target)) return;
      if (this.toggleProfile.contains(e.target)) return;
      this.profilePopup.classList.remove('visible');
    });

    // Leaderboard (#517: a kit sheet — its Close, the scrim, Esc and B all
    // close it; the video and the pad focus stop with it whatever closed it).
    this._leaderboardSheet = /** @type {any} */ (document.getElementById('leaderboard-modal'));
    this._leaderboardSheet.addEventListener('uf-sheet:close', () => this._onLeaderboardClosed());
    // #540: Achievements, a sibling sheet of the Leaderboard, and one
    // achievement's detail card, a second sheet over it.
    this._achievementsSheet = /** @type {any} */ (document.getElementById('achievements-modal'));
    this._achievementsSheet.addEventListener('uf-sheet:close', () => this._onAchievementsClosed());
    this._achDetailSheet = /** @type {any} */ (document.getElementById('ach-detail'));
    this._achDetailSheet.addEventListener('uf-sheet:close', () => this._onAchievementDetailClosed());
    // #548: the Dressing Room shell (cards are built per open by js/dressing-room.js).
    this._roomSheet = /** @type {any} */ (document.getElementById('dressing-room'));
    this._achDetailId = null;   // the badge the card is showing (focus returns to it)

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
    // `label` (not textContent): uf-button keeps its `sub` second line across it.
    btnSolo.label = 'SOLO RIDE';
    btnTogether.classList.remove('role-locked');
    btnTogether.label = 'RIDE TOGETHER';

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
    btnCaptain.variant = 'accent';
    btnCaptain.innerHTML = 'START A RIDE<br><span class="lobby-role-desc">Captain &middot; Front seat</span>';
  }

  // ── Permission toggles ──────────────────────────────────────
  // Track whether the browser permission has been obtained (separate from
  // the user's on/off toggle choice). Once a browser permission is granted
  // we remember it so re-enabling doesn't re-prompt.

  _toggleAll() {
    // Room media off: ALL covers only what's left (motion + music).
    if (!this._mediaEnabled) {
      const allOn = (!this._motionAvailable() || this.motionActive) && this.musicActive;
      if (allOn) {
        if (this._motionAvailable() && this.motionActive) this._toggleMotion();
        if (this.musicActive) this._toggleMusic();
      } else {
        if (this._motionAvailable() && !this.motionActive) this._toggleMotion();
        if (!this.musicActive) this._toggleMusic();
      }
      return;
    }
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
      if (this.input && this.input.gyroConnected) this._joystickOffForGyro();
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

  /**
   * Hot-swap support: when the user unplugs their active controller mid-
   * lobby, clear the motion UI state so a fresh controller triggers the
   * toggle to re-appear. Listens for slot P1's 'hid-unbound' event
   * (ControllerManager fires this when the physical device disconnects
   * or the slot detaches).
   */
  _setupGamepadHotSwap() {
    if (!this.controllerManager) return;
    this.controllerManager.getSlot('P1').on((slot, reason) => {
      if (reason !== 'hid-unbound') return;
      if (this._motionPermitted || this.motionActive) {
        console.log('Lobby: P1 HID detached, clearing motion state');
        this._motionPermitted = false;
        this.motionActive = false;
        this._setToggleActive('motion', false);
      }
    });
  }

  _updateAllToggle() {
    const motionOk = !this._motionAvailable() || this.motionActive;
    const mediaOk = !this._mediaEnabled || (this.cameraActive && this.audioActive);
    if (mediaOk && motionOk && this.musicActive) {
      this.toggleAll.classList.add('active');
    } else {
      this.toggleAll.classList.remove('active');
    }
  }

  _toggleCamera() {
    if (!this._mediaEnabled) return; // room media off (#400 D7)
    if (!this._hasCamera) return; // no camera hardware
    if (this.cameraActive) {
      this.cameraActive = false;
      this._setToggleActive('camera', false);
      this._applyVideoTrackState(false);
      // Notify partner to show avatar
      if (this.net && this.net.connected) {
        const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
        this.net.sendProfile(RoomProtocol.cameraToggle(false, user && user.avatar));
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
        this.net.sendProfile(RoomProtocol.cameraToggle(true));
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
        this.net.sendProfile(RoomProtocol.cameraToggle(true));
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
      // First time — request WebHID access via the manager. This is a
      // user-gesture path (triggered by a toggle click), so
      // navigator.hid.requestDevice is allowed. The manager pairs the
      // device into its pool and attaches it to P1's slot; slot events
      // (hid-bound) will flip motion UI state via the subscriber in
      // _runDesktopGamepadDetection.
      if (this.controllerManager) {
        this._publishHeldHidDevices();
        this.controllerManager.connectHidForSlot('P1').catch((err) => {
          console.warn('Gyro connect failed:', err);
        });
      }
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

  /**
   * #576 · a pad with a gyro steers by gyro: the stick starts OFF. Only a
   * default: a rider who has set the Joystick toggle themselves keeps their
   * choice (tandemonium_joystick in localStorage).
   */
  _joystickOffForGyro() {
    let saved = null;
    try { saved = localStorage.getItem('tandemonium_joystick'); } catch {}
    if (saved !== null || !this.joystickActive) return;
    // Never leave a rider with nothing to steer by: only once the gyro is live.
    if (!this.input || !this.input.motionEnabled) return;
    this.joystickActive = false;
    if (this.input) this.input.suppressGamepadLean = true;
    this._setToggleActive('joystick', false);
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
    slider.oninput = () => this._applySteeringFeel(slider.value / 100);

    const dismiss = () => {
      popup.classList.remove('visible');
      document.removeEventListener('click', outsideClick, true);
    };

    document.getElementById('btn-recalibrate').onclick = () => { this._recalibrateSteering(); dismiss(); };
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
    if (!this._mediaEnabled) return; // room media off (#400 D7)
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
    this._syncSystemBar();
  }

  // ============================================================
  // DESKTOP / TV SYSTEM BAR + CONTROLS SHEET (#428 layout A)
  // ============================================================
  // At ≥1024px the round toggle columns, the Back hint and the credits footer
  // give way to <uf-system-bar id="lobby-bar"> (css/lobby-tv.css). Its pills
  // run the same handlers as the toggles; Stick / Gyro steering live in the
  // Controls sheet (<uf-sheet id="controls-sheet">) behind one pill that names
  // the controller in use. Below 1024px none of this shows and the toggles
  // work as before.

  _initSystemBar() {
    const $ = (id) => document.getElementById(id);
    this._bar = $('lobby-bar');
    this._controlsSheet = $('controls-sheet');
    if (!this._bar || !this._controlsSheet) return;
    this._tvQuery = window.matchMedia('(min-width: 1024px)');
    const pill = (id, fn) => {
      const el = $(id);
      // stopPropagation: the popups' "click outside closes" listeners must not
      // see the pill click that just opened them.
      el?.addEventListener('click', (e) => { e.stopPropagation(); fn(el); });
      return el;
    };
    this._barPills = {
      help: pill('bar-help', () => this._openHelp()),
      leaderboard: pill('bar-leaderboard', () => this._openLeaderboard()),
      achievements: pill('bar-achievements', () => this._openAchievements()),   // #540
      profile: pill('bar-profile', (el) => { this._anchorPopup(this.profilePopup, el); this._toggleProfile(); }),
      controls: pill('bar-controls', () => this._openControlsSheet()),
      music: pill('bar-music', (el) => {
        if (this._volumePicker.classList.contains('visible')) { this._hideVolumePicker(); return; }
        this._anchorPopup(this._volumePicker, el);
        this._showVolumePicker();
      }),
      settings: pill('bar-settings', () => $('ctrl-settings-btn')?.click()),
      // #172: desktop app only; _syncSystemBar shows it on the mode step.
      quit: pill('bar-quit', () => this._openQuitSheet()),
    };
    this._bar.addEventListener('uf-system-bar:back', () => this._goBack());
    this._canQuit = canQuitApp(window);

    // Spatial focus: the pills join the toggle columns (hidden toggles and,
    // below 1024px, the hidden bar are skipped by the FocusController).
    const p = this._barPills;
    this._modeColumns[0].push(p.help, p.leaderboard, p.achievements, p.profile);
    this._modeColumns[2].push(p.controls, p.music, p.settings, p.quit);   // #517: Quit on the far right
    // The bike chooser's ‹ › join the D-pad focus too: a phone remote or a TV
    // remote has no L1 / R1, so ← from RIDE TOGETHER lands on › and OK changes
    // the bike. Hidden off the first page, where the focus skips them.
    this._modeColumns[0].push(...['bike-prev', 'bike-next'].map((id) => $(id)).filter(Boolean));
    // Explicit links (the nearest-by-geometry pick from RIDE TOGETHER is "Pair it").
    // Only in the TV layout: on a phone-width screen the chooser sits above the buttons.
    const linkChooser = () => {
      const tv = this._tvQuery.matches;
      for (const id of ['btn-together', 'btn-solo']) { const el = $(id); if (el) { if (tv) el.dataset.navLeft = 'bike-next'; else delete el.dataset.navLeft; } }
      const next = $('bike-next');
      if (next) { if (tv) next.dataset.navRight = 'btn-together'; else delete next.dataset.navRight; }
    };
    linkChooser();
    this._tvQuery.addEventListener?.('change', linkChooser);

    // Popups that lived inside the (now hidden) toggle columns move to <body>
    // on desktop and anchor above their pill; back in place on a phone.
    this._barPopups = ['profile-popup', 'volume-picker', 'keyboard-confirm-popup'].map((id) => {
      const el = $(id);
      return el ? { el, parent: el.parentNode, next: el.nextSibling } : null;
    }).filter(Boolean);
    const place = () => {
      for (const p2 of this._barPopups) {
        if (this._tvQuery.matches) { if (p2.el.parentNode !== document.body) { document.body.appendChild(p2.el); p2.el.classList.add('bar-popup'); } }
        else if (p2.el.parentNode !== p2.parent) { p2.parent.insertBefore(p2.el, p2.next); p2.el.classList.remove('bar-popup'); p2.el.style.left = p2.el.style.bottom = ''; }
      }
    };
    place();
    this._tvQuery.addEventListener('change', place);

    // Credits + version move into Help on desktop (the footer is hidden there).
    const credits = document.querySelector('#lobby .lobby-credits');
    const helpInner = $('help-modal-inner');
    if (credits && helpInner) {
      const copy = credits.cloneNode(true);
      copy.className = 'help-credits';   // not .lobby-credits: the old desktop CSS pins that to the screen bottom
      copy.querySelectorAll('[id]').forEach((el) => {
        const orig = $(el.id);
        el.removeAttribute('id');
        if (orig && (el.tagName === 'BUTTON')) el.addEventListener('click', () => orig.click());
      });
      helpInner.appendChild(copy);
      this._helpCredits = copy;
    }

    // ── Esc = Back for keyboard / mouse players (#428) ──
    // Closes whatever is open first (a kit sheet handles its own Esc and
    // marks the event; help, leaderboard, profile and volume popups here),
    // then steps back like ◯ / B. A text field keeps its own Esc.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!this.lobbyEl || this.lobbyEl.style.display === 'none') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector('.phone-qr-panel.open')) return;   // the phone panel closes itself
      if (document.querySelector('#options-overlay.visible')) return; // Options closes itself (game.js)
      if (this.helpModal && this.helpModal.open) { this._closeHelp(); e.preventDefault(); return; }
      if (this._leaderboardSheet && this._leaderboardSheet.open) { this._closeLeaderboard(); e.preventDefault(); return; }
      if (this.profilePopup && this.profilePopup.classList.contains('visible')) { this.profilePopup.classList.remove('visible'); e.preventDefault(); return; }
      if (this._volumePicker && this._volumePicker.classList.contains('visible')) { this._hideVolumePicker(); e.preventDefault(); return; }
      const flow = $('lobby-flow');
      if (flow && flow.current && flow.current !== 'lobby-mode') { this._goBack(); e.preventDefault(); }
    });

    // ── Join with a code (desktop keypad) ──
    const joinCode = /** @type {any} */ ($('join-code-tv'));
    if (joinCode) {
      joinCode.addEventListener('submit', (e) => {
        const status = $('join-status');
        if (status) { status.textContent = 'Connecting...'; status.className = 'conn-status'; status.style.display = ''; }
        this._joinRoom('TNDM-' + e.detail.code);
      });
      // A physical keyboard types straight in while the keypad is up.
      window.addEventListener('keydown', (e) => {
        if (!$('join-tv')?.classList.contains('on') || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === 'Backspace') { joinCode.backspace(); e.preventDefault(); }
        else if (e.key === 'Enter' && joinCode.complete) { joinCode.submit(); e.preventDefault(); }
        else if (e.key.length === 1 && joinCode.type(e.key)) e.preventDefault();
      });
    }

    // ── Controls sheet ──
    const sheet = this._controlsSheet;
    sheet.attachFocus(this._stepFocus);
    $('controls-done')?.addEventListener('click', () => sheet.close());
    $('set-stick')?.addEventListener('change', () => { this._toggleJoystick(); this._syncSystemBar(); });
    $('set-gyro')?.addEventListener('change', () => { this._toggleMotion(); this._syncSystemBar(); });
    $('set-phone')?.addEventListener('uf-setting:open', () => { sheet.close(); $('btn-mode-phone')?.click(); });
    const slider = /** @type {HTMLInputElement|null} */ ($('set-feel-slider'));
    if (slider) slider.addEventListener('input', () => this._applySteeringFeel(slider.value / 100));
    $('set-recalibrate')?.addEventListener('click', () => { this._recalibrateSteering(); sheet.close(); });
    sheet.addEventListener('uf-sheet:close', () => { this._stepFocus.setSlider(null); this._syncSystemBar(); });

    // ── Quit confirm (#172) ── desktop app only. The kit sheet handles B /
    // Esc / scrim / its Close control; QUIT asks main to app.quit().
    this._quitSheet = $('quit-sheet');
    if (this._quitSheet && this._canQuit) {
      this._quitSheet.attachFocus(this._stepFocus);
      $('quit-cancel')?.addEventListener('click', () => this._quitSheet.close());
      $('quit-confirm')?.addEventListener('click', () => {
        const btn = $('quit-confirm');
        if (btn) btn.setAttribute('disabled', '');   // one request: the window is on its way out
        analytics.trackEvent('app_quit', { from: 'lobby' });
        if (!requestAppQuit(window) && btn) btn.removeAttribute('disabled');
      });
    }
    this._syncSystemBar();
  }

  _openQuitSheet() {
    if (!this._quitSheet || !this._canQuit) return;
    const btn = document.getElementById('quit-confirm');
    if (btn) btn.removeAttribute('disabled');
    this._quitSheet.show();
  }

  /** Put a popup that now lives in <body> just above the pill that opened it. */
  _anchorPopup(popup, anchor) {
    if (!popup || !anchor || !popup.classList.contains('bar-popup')) return;
    const r = anchor.getBoundingClientRect();
    popup.style.left = `${Math.round(r.left + r.width / 2)}px`;
    popup.style.bottom = `${Math.round(window.innerHeight - r.top + 12)}px`;
  }

  _openControlsSheet() {
    this._syncSystemBar();
    const slider = /** @type {HTMLInputElement|null} */ (document.getElementById('set-feel-slider'));
    if (slider) slider.value = String(Math.round((TUNE.steeringFeel != null ? TUNE.steeringFeel : BALANCE_DEFAULTS.steeringFeel) * 100));
    // #430: on a controller, left/right moves the Steering feel slider (the
    // sheet is a vertical list, so up/down still moves between rows).
    if (slider) this._stepFocus.setSlider(slider);
    this._controlsSheet.show();
  }

  /** Steering feel, shared by the Motion popup's slider and the Controls sheet's. */
  _applySteeringFeel(feel) {
    const oldFeel = TUNE.steeringFeel;
    applySteeringFeel(feel);
    saveSteeringFeelPref(feel);   // #430: kept even with no calibration saved
    analytics.trackEvent('steering_feel_change', { value: feel, from_value: oldFeel });
    try {
      const tuningKey = this._tuningKey();
      const saved = localStorage.getItem(tuningKey);
      if (saved) {
        const data = JSON.parse(saved);
        data.steeringFeel = feel;
        localStorage.setItem(tuningKey, JSON.stringify(data));
      }
    } catch {}
  }

  /** Forget the saved gyro tuning so the calibration wizard runs on the next ride. */
  _recalibrateSteering() {
    try { localStorage.removeItem(this._tuningKey()); } catch {}
    this._forceWizard = true;
  }

  /** P1's controller identity (core), or null before anyone has pressed a button. */
  _p1Identity() {
    const mgr = this.controllerManager;
    const slot = mgr && mgr.getSlot && mgr.getSlot('P1');
    const claimed = !!(slot && slot.state === 'claimed' && mgr.slotIdentity);
    // #458: a WebHID binding's vid:pid names the pad (a Puck-paired Steam
    // Controller was "direct USB-C"); core's label-first lookup is the fallback.
    const hidId = claimed ? (slot.driver && slot.driver.entry ? identityOf(slot.driver.entry) : hidDeviceIdentity(slot.hidDevice)) : null;
    if (hidId) return hidId;
    return claimed ? slotIdentityHidFirst(slot, (s) => mgr.slotIdentity(s)) : null;
  }

  /**
   * Bring the bar, the Controls sheet and every family="auto" button prompt in
   * line with P1's controller and the steering toggles. Cheap; called from
   * _setToggleActive, step changes, the sheet, and ~1 Hz from the nav loop.
   */
  _syncSystemBar() {
    if (!this._bar) return;
    const id = this._p1Identity();
    const stick = !!this.joystickActive, gyro = !!this.motionActive;
    const mode = [stick && 'stick', gyro && 'gyro'].filter(Boolean).join(' + ') || 'buttons';
    const label = document.getElementById('bar-controls-label');
    if (label) {
      const text = id ? `${id.shortName} · ${mode}` : 'Controls';
      if (label.textContent !== text) label.textContent = text;
    }
    // #540: the Achievements pill reads "earned / total" (Pete: the count, not the word).
    const count = document.getElementById('bar-achievements-count');
    if (count && this._achievements) {
      if (!this._achTotal) this._achTotal = this._achievements.getAllDefinitions().length;
      const text = `${this._achievements.getEarnedIds().length} of ${this._achTotal}`;
      if (count.textContent !== text) count.textContent = text;
    }
    const Glyph = customElements.get('uf-controller-glyph');
    const key = id ? `${id.glyphFamily}${id.swapAB ? '/swap' : ''}` : 'generic';
    if (Glyph && key !== this._glyphKey) {
      this._glyphKey = key;
      Glyph.setDefault({ family: id ? id.glyphFamily : 'generic', swap: !!(id && id.swapAB) });
    }
    this._barPills?.music?.classList.toggle('active', !!this.musicActive);
    // Back shows on every step but the first.
    const flow = document.getElementById('lobby-flow');
    this._bar.back = flow && flow.current && flow.current !== 'lobby-mode' ? 'show' : 'hide';
    // #172: Quit sits next to Help on the mode step of the desktop app only
    // (the web build has the tab's close box; a phone has no pad).
    const quit = this._barPills?.quit;
    if (quit) {
      const want = this._canQuit && flow && flow.current === 'lobby-mode' ? '' : 'none';
      if (quit.style.display !== want) quit.style.display = want;
    }
    // The sheet, when open.
    const sheet = this._controlsSheet;
    if (!sheet || !sheet.open) return;
    const seat = document.getElementById('controls-seat');
    if (seat) {
      const me = id ? this.seatPerson(1) : null;
      Object.assign(seat, { who: me ? me.name : id ? id.shortName : 'No controller yet', pic: me ? me.pic : '', source: me ? me.source : '' });
      seat.dev = id ? `Player 1 · ${id.name}` : 'Press a button on a controller';
      seat.state = id ? 'joined' : 'open';
      seat.badge = id ? 'P1' : '';
    }
    const set = (sid, prop, v) => { const el = document.getElementById(sid); if (el && el[prop] !== v) el[prop] = v; };
    set('set-stick', 'checked', stick);
    set('set-gyro', 'checked', gyro);
    // Gyro defaults on whenever the controller's motion sensors are bound
    // (the desktop app grants every controller, so that's automatic there).
    // A browser that hasn't granted this controller yet needs one click.
    const gyroCapable = !!(id && id.entry && id.entry.capabilities && id.entry.capabilities.gyro);
    set('set-gyro', 'description', !gyroCapable ? 'Not available on this controller'
      : (gyro || this._motionPermitted) ? 'Tilt the controller to lean'
      : 'Turn on to connect the gyro (your browser asks once)');
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    const roster = document.getElementById('controls-roster');
    if (roster && this.controllerManager?.controllerRoster) {
      // fixRosterRow: a slot row's WebHID vid:pid names it (#458 item 14).
      roster.rows = this.controllerManager.controllerRoster(pads, {
        seatOf: (slotId) => (slotId === 'P1' ? { player: 1, seat: { role: 'player', label: 'P1 · you', tone: 'captain' } } : null),
        keyboard: true,
      }).map(fixRosterRow).map((r) => (r.player === 1 ? { ...r, person: this.seatPerson(1) } : r));
    }
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

  /**
   * Help, a kit <uf-sheet> since #459 (item 11): B / Esc / the scrim / its
   * Close all close it; the pad's View button and the Help pill open it (item
   * 18). `section` scrolls to an id inside (the footer's © → attributions).
   * @param {{ section?: string | null }} [opts]
   */
  _openHelp({ section = null } = {}) {
    this.helpModal.show();
    this._scrollHelpTo(section);
    this._gpPrevView = true;   // the press that opened it must not close it
  }

  _closeHelp() {
    this.helpModal.close();
  }

  /** Scroll the Help sheet's body to a section id, or the top. */
  _scrollHelpTo(id) {
    const body = this.helpModal && this.helpModal.body;
    if (!body) return;
    requestAnimationFrame(() => {
      const el = id ? document.getElementById(id) : null;
      if (el) body.scrollTop = Math.max(0, el.offsetTop - body.offsetTop - 8);
      else body.scrollTop = 0;
    });
  }

  _closeLeaderboard() {
    if (this._leaderboardSheet.open) this._leaderboardSheet.close();
    else this._onLeaderboardClosed();
  }

  /** The sheet closed (B, Esc, the scrim, its Close, or _closeLeaderboard). */
  _onLeaderboardClosed() {
    this._lbClearFocus();
  }

  _lbClearFocus() {
    document.querySelectorAll('#leaderboard-modal .gamepad-focus').forEach(el => el.classList.remove('gamepad-focus'));
  }

  // Tabs (main + sub) + the sheet's Close — the leaderboard's spatial focusable set.
  _lbFocusables() {
    return [
      ...document.querySelectorAll('#lb-main-tabs .lb-tab'),
      ...document.querySelectorAll('#lb-sub-tabs .lb-tab'),
      this._leaderboardSheet.querySelector('.uf-sheet__close'),
    ].filter(Boolean);
  }

  // ── #540 · Achievements: its own sheet, a sibling of the Leaderboard ──
  // Reached from the bar's Achievements pill (TV / desktop) or the round ⭐
  // toggle (phone). The badges + the sheet's Close are the pad's focus set.
  _achFocusables() {
    return [
      ...document.querySelectorAll('#lb-achievements .lb-ach-item'),
      this._achievementsSheet.querySelector('.uf-sheet__close'),
    ].filter(Boolean);
  }

  _openAchievements() {
    this._renderAchievements();
    this._achievementsSheet.show();
    if (this._achievementsSheet.body) this._achievementsSheet.body.scrollTop = 0;
    this._achResetFocus();
  }

  _achResetFocus(initial = null) {
    this._activeModal = 'achievements';
    this._modalBack = () => this._closeAchievements();
    this._modalFocus.setSpatial(this._achFocusables(), initial || document.querySelector('#lb-achievements .lb-ach-item'));
  }

  /**
   * LB / RB over the Achievements sheet: the focus jumps to the first badge of
   * the previous / next section, with that section's heading at the top.
   * LB inside a section goes to its own first badge first.
   * @param {-1|1} dir
   */
  _achJumpSection(dir) {
    const secs = Array.from(document.querySelectorAll('#lb-achievements .lb-ach-section'))
      .filter((sec) => sec.querySelector('.lb-ach-item'));
    if (!secs.length) return;
    const f = this._modalFocus.focused;
    const cur = f ? secs.findIndex((sec) => sec.contains(f)) : -1;
    let i;
    if (cur < 0) i = dir > 0 ? 0 : secs.length - 1;   // on Close (or nothing): RB → top, LB → last section
    else if (dir < 0 && f !== secs[cur].querySelector('.lb-ach-item')) i = cur;
    else i = Math.max(0, Math.min(secs.length - 1, cur + dir));
    const first = /** @type {HTMLElement} */ (secs[i].querySelector('.lb-ach-item'));
    this._modalFocus.focusElement(first);
    secs[i].scrollIntoView({ block: 'start', inline: 'nearest' });
  }

  _closeAchievements() {
    if (this._achievementsSheet.open) this._achievementsSheet.close();
    else this._onAchievementsClosed();
  }

  /** The sheet closed (B, Esc, the scrim, its Close): the detail card goes with it. */
  _onAchievementsClosed() {
    document.querySelectorAll('#achievements-modal .gamepad-focus').forEach(el => el.classList.remove('gamepad-focus'));
    if (this._achievementDetailOpen()) this._achDetailSheet.close();
    this._clearAchievementDim();
  }

  _lbResetFocus() {
    // Set up spatial focus over the tabs + close, defaulting to the active main
    // tab. The leaderboard branch in _pollGamepadNav drives it (#318).
    this._activeModal = 'leaderboard';
    this._modalBack = () => this._closeLeaderboard();
    this._modalFocus.setSpatial(this._lbFocusables(), document.querySelector('#lb-main-tabs .lb-tab.active'));
  }

  /** The popup's pad-focusable buttons, top to bottom (hidden ones skipped, #332). */
  _profileItems() {
    const ids = this.auth.isLoggedIn()
      ? ['profile-popup-link-discord', 'profile-popup-logout', 'profile-popup-back']
      : ['profile-popup-steam', 'profile-popup-discord', 'profile-popup-signin-back'];
    return ids.map((id) => document.getElementById(id)).filter((el) => el && el.style.display !== 'none');
  }

  /**
   * #612 · after a ride on Steam, a Player 1 without Discord linked gets the Profile card once
   * with a short reason and LINK DISCORD focused; NOT NOW closes it. At most once a week.
   */
  maybePromptLinkDiscord() {
    if (!this._linkPromptDue) return false;
    this._linkPromptDue = false;
    if (!this._isSteam || !this.auth.isLoggedIn() || this.auth.hasIdentity('discord')) return false;
    if (this.profilePopup.classList.contains('visible') || this._room) return false;
    let until = 0;
    try { until = Number(localStorage.getItem(LINK_PROMPT_SNOOZE_KEY) || 0); } catch (e) {}
    if (until > Date.now()) return false;
    try { localStorage.setItem(LINK_PROMPT_SNOOZE_KEY, String(Date.now() + LINK_PROMPT_SNOOZE_MS)); } catch (e) {}
    const pill = document.getElementById('bar-profile');
    if (pill && this._tvQuery && this._tvQuery.matches) this._anchorPopup(this.profilePopup, pill);
    this._linkPrompt = true;
    this._toggleProfile();
    return true;
  }

  _toggleProfile() {
    const signedIn = this.auth.isLoggedIn();
    const asPrompt = !!this._linkPrompt;   // opened by maybePromptLinkDiscord, this once
    this._linkPrompt = false;
    document.querySelector('.profile-popup-content').style.display = signedIn ? '' : 'none';
    document.getElementById('profile-popup-signin').style.display = signedIn ? 'none' : '';
    this.profilePopup.classList.toggle('visible');
    const open = this.profilePopup.classList.contains('visible');
    this._profileDiag(open ? 'opened' : 'closed by toggle');
    this._showProfileError('');
    // #612: on Steam without Discord, say why linking helps; the prompt's back button is NOT NOW.
    const promptEl = document.getElementById('profile-popup-prompt');
    if (promptEl) promptEl.hidden = !(signedIn && this._isSteam && !this.auth.hasIdentity('discord'));
    const backEl = document.getElementById('profile-popup-back');
    if (backEl) backEl.textContent = open && asPrompt ? 'NOT NOW' : 'CLOSE';   // (Pete: it only ever closed the popup; was RETURN TO LOBBY)
    // #612: a TV or the desktop app shows the QR steps as soon as the popup
    // opens (a phone is the easy way to type a Discord password). A phone or a
    // laptop browser just uses the button.
    if (open && !signedIn && ((this._tvQuery && this._tvQuery.matches) || navigator.userAgent.includes('Electron'))) {
      this._showProfileDevice();
    } else {
      this._hideProfileDevice(false);
    }
    // Reset gamepad focus for profile popup. Default focus is a non-closing
    // action (sign-in / log out) so opening with A then a stray A press
    // can't immediately dismiss the popup via the only focusable item. (#325)
    const items = this._profileItems();
    this.profilePopup.querySelectorAll('.gamepad-focus').forEach(el => el.classList.remove('gamepad-focus'));
    if (open && items[0]) items[0].classList.add('gamepad-focus');
    if (this._activeModal === 'profile') this._activeModal = null;   // rebuild the pad's list
  }

  /** One line in %USERPROFILE%\\tandemonium-diag.log (Steam build) / the console. */
  _profileDiag(msg) {
    try {
      if (window.electronApp && window.electronApp.diag) window.electronApp.diag('[profile] ' + msg);
      else console.debug('[profile]', msg);
    } catch (e) { /* no diag */ }
  }

  _setProfileDeviceStatus(text) {
    const el = document.getElementById('profile-popup-device-status');
    if (el) el.textContent = text;
  }

  /** A sign-in problem, shown under the heading of whichever section is open. */
  _showProfileError(text) {
    let el = document.getElementById('profile-popup-error');
    if (!el) {
      if (!text) return;
      el = document.createElement('div');
      el.id = 'profile-popup-error';
      el.className = 'profile-popup-device-status';
      el.setAttribute('role', 'alert');
    }
    const section = this.auth.isLoggedIn()
      ? document.querySelector('.profile-popup-content')
      : document.getElementById('profile-popup-signin');
    const back = section.querySelector('.profile-popup-back');
    if (el.parentNode !== section) section.insertBefore(el, back);
    el.textContent = text;
    el.hidden = !text;
  }

  /**
   * #612 · Show the device-code steps (QR + code) in the open section and
   * start polling. Signed in, the Discord sign-in is linked to this account.
   * Resolves the request ({ url, code }) or null when Discord is unavailable.
   */
  async _showProfileDevice() {
    const box = document.getElementById('profile-popup-device');
    if (!box) return null;
    const section = this.auth.isLoggedIn()
      ? document.querySelector('.profile-popup-content')
      : document.getElementById('profile-popup-signin');
    const back = section.querySelector('.profile-popup-back');
    if (box.parentNode !== section) section.insertBefore(box, back);
    box.hidden = false;
    this._showProfileError('');
    this._setProfileDeviceStatus('Getting a sign-in code…');
    let dev;
    try {
      dev = await this.auth.startDiscordDevice({
        onStatus: (s) => this._setProfileDeviceStatus(s === 'confirming' ? 'Confirm the code on your phone…' : 'Waiting for Discord…'),
        onDone: (user, info) => {
          if (user) {
            if (info && info.linked) showInfoToast('🔗', 'Discord linked', info.merged ? 'Your Discord and Steam accounts are now one' : 'Discord and Steam are one House Tandem account');
            if (this._profileUpdateUI) this._profileUpdateUI(user);
            return;
          }
          const err = info && info.error;
          if (!this.profilePopup.classList.contains('visible')) { this._hideProfileDevice(false); return; }
          // Expired or cancelled while the popup is still open: a fresh code.
          this._setProfileDeviceStatus(err === 'cancelled' ? 'Cancelled. Scan again to sign in.' : 'That code expired. Here is a new one.');
          setTimeout(() => { if (this.profilePopup.classList.contains('visible')) this._showProfileDevice(); }, 1500);
        },
      });
    } catch (e) {
      box.hidden = true;
      this._showProfileError(e.message || 'Discord sign-in is unavailable');
      return null;
    }
    const qrEl = document.getElementById('profile-popup-qr');
    try {
      const qr = qrcode(0, 'M');
      qr.addData(dev.url);
      qr.make();
      qrEl.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 1 });
    } catch (_) { qrEl.innerHTML = ''; }
    document.getElementById('profile-popup-code').textContent = dev.code || '';
    this._setProfileDeviceStatus('Waiting for Discord…');
    return dev;
  }

  /** Hide the QR steps. Stop (the default) also stops polling. */
  _hideProfileDevice(stop = true) {
    const box = document.getElementById('profile-popup-device');
    if (box) box.hidden = true;
    // Closing the popup keeps the code alive: the player may be mid-sign-in on
    // their phone. It is stopped on success, logout or expiry.
    if (stop) this.auth.cancelDiscordDevice();
  }

  _buildLeaderboardTabs() {
    const mainContainer = document.getElementById('lb-main-tabs');
    const tabs = [
      // #576: say what each list is — every rider's rides vs only yours.
      { id: 'solo', label: 'All Solo Rides' },
      { id: 'together', label: 'All Together Rides' },
      { id: 'you', label: 'My Rides' },   // #576: was "You", which read like a third board next to Solo
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
    // #576: no Grandma's-house clip over the board any more (it popped in and out between filters).
    if (this._lbMainTab === 'partners') return;
    LEVELS.forEach(level => {
      const btn = document.createElement('button');
      btn.className = 'lb-tab' + (level.id === this._lbSubLevel ? ' active' : '');
      btn.textContent = level.icon + ' ' + level.name;
      btn.dataset.levelId = level.id;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        this._lbSubLevel = level.id;
        this._renderLeaderboardContent();
      });
      container.appendChild(btn);
    });
  }

  async _openLeaderboard() {
    this._lbSubLevel = this.selectedLevel ? this.selectedLevel.id : 'grandma';

    // Reset main tabs active state
    const mainTabs = document.getElementById('lb-main-tabs');
    mainTabs.querySelectorAll('.lb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tabId === this._lbMainTab);
    });

    this._buildSubTabs();

    const level = LEVELS.find(l => l.id === this._lbSubLevel) || LEVELS[0];
    this._leaderboardSheet.heading = 'Leaderboard';

    this._leaderboardSheet.show();
    if (this._leaderboardSheet.body) this._leaderboardSheet.body.scrollTop = 0;
    this._renderLeaderboardContent();
    this._lbResetFocus();
  }

  async _renderLeaderboardContent() {
    const list = document.getElementById('leaderboard-list');
    const levelId = this._lbSubLevel;
    const level = LEVELS.find(l => l.id === levelId) || LEVELS[0];

    if (this._lbMainTab === 'you') {
      // Personal rides (#540: the badges moved to their own Achievements sheet)
      this._leaderboardSheet.heading = 'My Rides';
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
        list.innerHTML = this._renderEntries(entries, level, myId, { mine: true });
      } catch (e) {
        list.innerHTML = '<div class="lb-no-data">Could not load rides</div>';
      }
    } else if (this._lbMainTab === 'partners') {
      this._leaderboardSheet.heading = 'Partners';
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
      // SOLO or TOGETHER — every rider's rides, fastest first
      this._leaderboardSheet.heading = this._lbMainTab === 'solo' ? 'All Solo Rides' : 'All Together Rides';
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

  /** `mine`: the My Rides list — every row is you, so no You tag and no rank (#576). */
  _renderEntries(entries, level, myId, { mine = false } = {}) {
    const collectibleEmoji = '\uD83C\uDF81';

    return entries.map((e, i) => {
      const isYou = !mine && myId && e.user_id === myId;
      const diffHtml = DIFF_LABEL[e.difficulty] ? '<span class="lb-diff">' + DIFF_LABEL[e.difficulty] + '</span>' : '';
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
        (mine ? '' : '<span class="lb-rank">' + (i + 1) + '</span>') +
        avatar +
        '<span class="lb-name">' + this._escapeHtml((e.display_name || 'Player').split(' ')[0]) + youTag + '</span>' +
        modeHtml +
        diffHtml +
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

  /**
   * #401 · the badge screen: all 100 achievements grouped by section,
   * counters with their progress (3/7 days), hidden ones as ??? until earned.
   */
  _renderAchievements() {
    const container = document.getElementById('lb-achievements');
    if (!container) return;
    const sections = this._achievements.getSections();
    const defs = sections.flatMap(s => s.items);
    const earnedCount = defs.filter(d => d.earned).length;
    const fmt = v => Math.floor(v).toLocaleString('en-US');

    let html = '<div class="lb-ach-count"><span>' + earnedCount + '</span> / ' + defs.length + ' Unlocked</div>';
    for (const sec of sections) {
      const got = sec.items.filter(d => d.earned).length;
      html += '<div class="lb-ach-section" data-section="' + sec.id + '">' +
        '<div class="lb-ach-section-title">' + this._escapeHtml(sec.title) +
        ' <span class="lb-ach-section-count">' + got + '/' + sec.items.length + '</span></div>';
      html += '<div class="lb-achievement-grid">';
      sec.items.forEach(d => {
        const cls = (d.earned ? 'earned' : 'locked') + (d.secret ? ' secret' : '') + (d.demoLocked ? ' demo-locked' : '');
        const prog = d.progress && d.progress[0] > 0
          ? '<span class="lb-ach-progress">' + fmt(d.progress[0]) + '/' + fmt(d.progress[1]) + (d.unit ? ' ' + d.unit : '') + '</span>'
          : '';
        const tip = d.desc + (d.demoLocked ? ' (full game)' : '');
        // #540: a button — a tap, Enter, or the pad's A opens the detail card.
        html += '<button type="button" class="lb-ach-item ' + cls + '" data-ach="' + d.id + '" title="' + this._escapeHtml(tip) + '"' +
          ' aria-label="' + this._escapeHtml(d.name + (d.earned ? ', unlocked' : ', locked')) + '">' +
          '<span class="lb-ach-icon">' + d.icon + '</span>' +
          '<span class="lb-ach-name">' + this._escapeHtml(d.name) + '</span>' +
          prog +
        '</button>';
      });
      html += '</div></div>';
    }
    container.innerHTML = html;
    if (!container.dataset.achClicks) {
      container.dataset.achClicks = '1';
      container.addEventListener('click', (e) => {
        const tile = /** @type {HTMLElement} */ (e.target).closest('.lb-ach-item');
        if (tile) this._openAchievementDetail(tile.dataset.ach);
      });
    }
  }

  // ── #540 · one achievement's detail card ──
  // The badge lifts off the grid toward the camera (the grid behind dims), then
  // the card shows: the badge large, name, what to do, unlocked with its date
  // or locked (with a counter's progress), and its number. Hidden Chaos ones
  // keep their "?" until earned. B / Esc / Close go back to the grid with the
  // pad focus on the same badge.
  _achievementDetailOpen() {
    return !!(this._achDetailSheet && this._achDetailSheet.open);
  }

  _openAchievementDetail(id) {
    if (!id || this._achievementDetailOpen()) return;
    const d = this._achievements.getAllDefinitions().find(a => a.id === id);
    if (!d) return;
    this._achDetailId = id;
    this._renderAchievementDetail(d);
    const tile = /** @type {HTMLElement|null} */ (document.querySelector('#lb-achievements .lb-ach-item[data-ach="' + id + '"]'));
    const show = () => {
      this._achDetailSheet.heading = this._achievementSectionTitle(d.section);
      this._achDetailSheet.show();
      this._activeModal = 'achievement';
      this._modalBack = () => this._closeAchievementDetail();
      const close = this._achDetailSheet.querySelector('.uf-sheet__close');
      this._modalFocus.setSpatial([close].filter(Boolean), close);
    };
    this._liftBadge(tile, show);
  }

  _closeAchievementDetail() {
    if (this._achievementDetailOpen()) this._achDetailSheet.close();
  }

  /** The card closed (B, Esc, the scrim, its Close): back to the grid, focus on the same badge. */
  _onAchievementDetailClosed() {
    this._clearAchievementDim();
    const lift = document.getElementById('ach-lift');
    if (lift) lift.remove();
    document.querySelectorAll('#lb-achievements .lb-ach-item.lifting').forEach(el => el.classList.remove('lifting'));
    const id = this._achDetailId;
    this._achDetailId = null;
    if (!this._achievementsSheet.open) return;
    const tile = /** @type {HTMLElement|null} */ (id ? document.querySelector('#lb-achievements .lb-ach-item[data-ach="' + id + '"]') : null);
    this._achResetFocus(tile);
    if (tile) tile.focus({ preventScroll: true });
  }

  /** #576: undim the grid (the card closed, or the grid has the pad with no card and no lift on the way). */
  _clearAchievementDim() {
    const body = this._achievementsSheet && this._achievementsSheet.body;
    if (!body) return;
    body.getAnimations().forEach(a => a.cancel());
    body.style.filter = '';
    body.classList.remove('ach-dim');
  }

  _achievementSectionTitle(sectionId) {
    const sec = this._achievements.getSections().find(s => s.id === sectionId);
    return sec ? sec.title : 'Achievement';
  }

  _renderAchievementDetail(d) {
    const card = document.getElementById('ach-detail-card');
    if (!card) return;
    const fmt = v => Math.floor(v).toLocaleString('en-US');
    const total = this._achievements.getAllDefinitions().length;
    let state, kicker, status;
    if (d.earned) {
      state = 'earned'; kicker = 'Achievement unlocked';
      status = d.earnedAt ? 'Unlocked ' + this._longDate(d.earnedAt) : 'Unlocked';
    } else if (d.secret) {
      state = 'secret'; kicker = 'Hidden'; status = 'Revealed when you earn it';
    } else if (d.demoLocked) {
      state = 'full'; kicker = 'Full game'; status = 'Unlocks in the full game';
    } else if (d.progress && d.progress[0] > 0) {
      state = 'progress'; kicker = 'In progress';
      status = fmt(d.progress[0]) + ' / ' + fmt(d.progress[1]) + (d.unit ? ' ' + d.unit : '');
    } else {
      state = 'locked'; kicker = 'Locked'; status = 'Not yet';
    }
    const bar = state === 'progress'
      ? '<div class="ach-detail-bar"><i style="width:' + Math.round(100 * d.progress[0] / Math.max(1, d.progress[1])) + '%"></i></div>'
      : '';
    card.dataset.state = state;
    card.innerHTML =
      '<div class="ach-detail-kicker">' + kicker + '</div>' +
      '<div class="ach-detail-badge"><span>' + d.icon + '</span></div>' +
      '<div class="ach-detail-name">' + this._escapeHtml(d.name) + '</div>' +
      '<div class="ach-detail-desc">' + this._escapeHtml(d.desc) + '</div>' +
      this._medalTimesHtml(d) +
      '<div class="ach-detail-status">' + this._escapeHtml(status) + '</div>' + bar +
      '<div class="ach-detail-count">No. ' + d.n + ' of ' + total + '</div>';
  }

  /**
   * A medal achievement's live times, one per difficulty — what "gold on
   * Grandma's" means in seconds (race-config.js getMedals, so a retune shows
   * here too). '' for everything else.
   */
  _medalTimesHtml(d) {
    if (!d.medal || d.secret) return '';
    const level = LEVELS.find(l => l.id === d.medal.level);
    if (!level) return '';
    const parts = [['chill', 'Chill'], ['adventurous', 'Adventurous'], ['daredevil', 'Daredevil']].map(([key, label]) => {
      const m = getMedals(level.id, key);
      return m ? '<span class="ach-detail-time"><b>' + label + '</b> ' + records.formatTime(m[d.medal.rank]) + '</span>' : '';
    }).filter(Boolean);
    if (!parts.length) return '';
    const rank = d.medal.rank.charAt(0).toUpperCase() + d.medal.rank.slice(1);
    return '<div class="ach-detail-times">' + records.MEDAL_ICON[d.medal.rank] + ' ' + rank + ' time on ' + this._escapeHtml(level.name) + ': ' + parts.join(' · ') + '</div>';
  }

  /** "November 1, 2026" from ms since epoch, or the server's SQLite "2026-11-01 15:00:00" (UTC). */
  _longDate(when) {
    try {
      let v = when;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) v = v.replace(' ', 'T') + 'Z';
      const d = new Date(v);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) { return ''; }
  }

  /**
   * The reels' lead-in (#506), live: a copy of the badge lifts toward the
   * camera while the grid dims, then `done` opens the card. No motion (or no
   * tile on screen) → the card opens at once.
   */
  _liftBadge(tile, done) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const r = tile ? tile.getBoundingClientRect() : null;
    if (!tile || !r || !r.width || reduce || typeof tile.animate !== 'function') { done(); return; }
    const old = document.getElementById('ach-lift');
    if (old) old.remove();
    const c = /** @type {HTMLElement} */ (tile.cloneNode(true));
    c.id = 'ach-lift';
    c.classList.remove('gamepad-focus');
    c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
    document.body.appendChild(c);
    tile.classList.add('lifting');
    const W = window.innerWidth, H = window.innerHeight;
    const S = Math.min(0.6 * W / r.width, 0.45 * H / r.height);
    const dx = W / 2 - (r.left + r.width / 2), dy = H / 2 - (r.top + r.height / 2);
    const body = this._achievementsSheet.body;
    const anim = c.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + S + ')', opacity: 0.35 },
    ], { duration: 420, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' });
    if (body) body.classList.add('ach-dim');
    this._achLifting = true;
    let fired = false;
    const finish = () => { if (fired) return; fired = true; this._achLifting = false; c.remove(); tile.classList.remove('lifting'); done(); };
    anim.finished.then(finish, finish);
    setTimeout(finish, 700);   // a dropped animation never leaves the badge in limbo
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

  _checkPermissionStates() {
    // Only auto-enable on first load; don't override user's toggle choice on re-entry
    if (this._permissionsChecked) return;
    this._permissionsChecked = true;

    // Camera
    if (this._mediaEnabled && navigator.permissions) {
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
        const gp = this.input.getGamepadState();
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
      // Defer so input-manager's gamepadconnected handler has set gamepadConnected
      setTimeout(() => this._updateBackHint(this._currentStep), 0);
      // Set up spatial step focus now that a gamepad is present (#318).
      this._applyStepSpatialFocus(this._currentStep);
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
    });

    // Desktop/Electron startup claim-on-pad-presence is handled by
    // _runDesktopGamepadDetection (uses ControllerManager.claimFirstAvailable).
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
          this._fixedBackBtn.textContent = '\u2190 Back';
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

  /**
   * C-2 · `?daily=YYYY-MM-DD` opens the lobby on Today's Road.
   *
   * The date in the link is only used to decide whether the link has expired:
   * a road is only playable on its own day (everyone rides the same one, and a
   * result on yesterday's road is not comparable with anyone's). An expired
   * link lands on today's road with a toast saying so, rather than an error.
   */
  _checkDailyLink() {
    let param = null;
    try { param = new URLSearchParams(window.location.search).get('daily'); } catch { return; }
    if (!param) return;

    const today = dailyKey();
    const expired = param !== today;
    const level = LEVELS.find(l => l.isDaily);
    if (!level) return;

    this._pendingMode = 'solo';
    this.selectedLevel = this.resolveRoadLevel(level, { key: today });
    this._updateDifficultyVisibility('daily');
    this._showStep(this.levelStep);
    this._refreshRecordLines();
    const card = document.querySelector('.level-card[data-level-id="daily"]');
    if (card) {
      document.querySelectorAll('.level-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const startBtn = document.getElementById('btn-start-ride');
      if (startBtn) startBtn.disabled = false;
    }
    if (expired) {
      showInfoToast('📅', 'That road has expired', 'Here’s today’s Daily Ride instead.');
    }
    analytics.trackEvent('daily_link', { key: param, expired });
  }

  async _checkAutoJoin() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (!roomParam) { this._checkDailyLink(); return; }

    // B4a: drop ?room= but keep demo/media so a reload stays in this edition.
    history.replaceState(null, '', window.location.pathname + carriedQuery(window.location.search));
    const code = roomParam.toUpperCase();
    const fullCode = code.startsWith('TNDM-') ? code : 'TNDM-' + code;

    try { await this._requestMotion(); } catch (_) {}
    // Dismiss tap-to-start overlay — user already acted by navigating via URL
    if (this._tapOverlay) this._dismissTapOverlay();

    // No login required to join an invite. The relay accepts unauthenticated
    // connections (worker/relay.js — auth is optional), and the manual join
    // paths (btn-stoker / btn-join) never gated on login either. Sign-in stays
    // available via the profile toggle for achievements/leaderboards, but it
    // must not block joining a room from a QR/shared link. (Issue #312)
    this._showStep(this.joinStep);
    // Put the last 4 chars in the text input and pre-set for spinners
    const suffix = fullCode.slice(-4);
    document.getElementById('room-code-input').value = suffix;
    this._lastFailedCode = fullCode;
    this._joinRoom(fullCode);
  }

  async _createRoom() {
    this._replaceNet();
    this._roomPartnerName = null;   // a new room: no partner yet (the room bar, the host seat)
    this._hostRoomCode = null;   // #563: set once the relay has us in the room
    this._partnerRoom = null; this._refusedLevelId = null;   // PR #397 M1: a new partner, not heard from yet
    const netEpoch = this._netSession.epoch;
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
      if (!this._netSession.isCurrent(netEpoch)) return;
      codeEl.textContent = code;
      this._hostRoomCode = code;   // #563: the room is open (a phone may be waiting for it)
      this._syncHostJoinQr();
      this._updateCardHeader(this._currentStep);
      statusEl.textContent = 'Waiting for partner...';

      // Save room to localStorage for rejoin after refresh
      this._roomStore.save(code, 'captain');

      // Generate the join QR + shareable URL (with long-press-to-copy).
      renderRoomQR(code);
    };

    this.net.onConnected = () => {
      if (!this._netSession.isCurrent(netEpoch)) return;
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
        if (!this._netSession.isCurrent(netEpoch)) return;
        this._showRoomStep('captain');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      if (!this._netSession.isCurrent(netEpoch)) return;
      statusEl.textContent = reason || 'Disconnected';
      statusEl.className = 'conn-status error';
    };

    // Auth error: token was rejected by relay — try silent refresh first. Acts on
    // THIS transport (the one the ride also uses), and only until it is destroyed: across
    // the awaits this.net can be replaced or nulled (2026-11-06 diag: "Cannot set
    // properties of null (_relayToken)").
    const capNet = this.net;
    capNet.onAuthError = async () => {
      const live = () => this._netSession.isCurrent(netEpoch) && !capNet._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for captain — refreshing token');
      statusEl.textContent = 'Session expired, refreshing...';
      statusEl.className = 'conn-status';
      const refreshed = await this.auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        // Token refreshed — retry room creation
        const freshToken = await this.auth.getRelayToken(code, 'captain');
        if (!live()) return;
        if (freshToken) capNet._relayToken = freshToken;
        capNet.enterRoom(code, 'captain');
      } else {
        // The relay also takes a connection with no valid token (worker/relay.js), and a refused
        // socket is usually the network: keep dialling (the transport backs off). Only on the
        // host step queue "sign in, then make the room" — mid-ride that would replace the ride's
        // transport once a login lands.
        statusEl.textContent = 'Reconnecting...';
        capNet.enterRoom(code, 'captain');
        if (this._currentStep === this.hostStep) this._pendingCreateRoom = true;
      }
    };

    this.net.enterRoom(code, 'captain');
  }

  async _joinRoom(code) {
    this._replaceNet();
    this._roomPartnerName = null;
    this._partnerRoom = null; this._refusedLevelId = null;   // PR #397 M1
    const netEpoch = this._netSession.epoch;
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
      if (!this._netSession.isCurrent(netEpoch)) return;
      statusEl.textContent = 'Waiting for captain...';
      // Save room to localStorage for rejoin after refresh
      this._roomStore.save(code, 'stoker');
    };

    this.net.onConnected = () => {
      if (!this._netSession.isCurrent(netEpoch)) return;
      this._lastFailedCode = null;
      statusEl.textContent = 'Connected!';
      statusEl.className = 'conn-status connected';
      analytics.trackEvent('room_connect', { type: this.net.connectionType || 'p2p' });
      setTimeout(() => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        this._showRoomStep('stoker');
      }, 1000);
    };

    this.net.onDisconnected = (reason) => {
      if (!this._netSession.isCurrent(netEpoch)) return;
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
    const stoNet = this.net;
    stoNet.onAuthError = async () => {
      const live = () => this._netSession.isCurrent(netEpoch) && !stoNet._destroyed;
      if (!live()) return;
      console.warn('LOBBY: Relay auth failed for stoker — refreshing token');
      statusEl.textContent = 'Session expired, refreshing...';
      statusEl.className = 'conn-status';

      const refreshed = await this.auth.ensureValidToken();
      if (!live()) return;
      if (refreshed) {
        const freshToken = await this.auth.getRelayToken(code, 'stoker');
        if (!live()) return;
        statusEl.textContent = 'Reconnecting...';
        stoNet.retryWithToken(freshToken || stoNet._relayToken);
        if (!freshToken && this._currentStep === this.joinStep) this._pendingAutoJoinCode = code;
      } else {
        // As the captain's: keep dialling; queue the sign-in rejoin only on the join step.
        statusEl.textContent = 'Reconnecting...';
        stoNet.retryWithToken(stoNet._relayToken);
        if (this._currentStep === this.joinStep) this._pendingAutoJoinCode = code;
      }
    };

    this.net.enterRoom(code, 'stoker');
  }

  // ── NetworkManager lifecycle ─────────────────────────────────

  // `this.net` is the live room NetworkManager, owned by `_netSession`. Kept as
  // a getter/setter so existing `this.net.*` reads and `this.net = …` writes
  // (teardown to null, return-from-game re-attach) are unchanged. (#318 Step 3)
  get net() { return this._netSession.net; }
  set net(v) { this._netSession.net = v; }

  // Tear down the current NetworkManager (if any) and create a fresh one,
  // bumping the session epoch so in-flight callbacks captured by closures on
  // the prior instance early-return instead of clobbering UI for the new room.
  // Callers capture `this._netSession.epoch` right after and guard their
  // callback bodies with `this._netSession.isCurrent(epoch)`.
  _replaceNet() {
    return this._netSession.replace();
  }

  // ── Room Persistence ─────────────────────────────────────────
  // Recent-room localStorage now lives in js/lobby/room-store.js
  // (this._roomStore: .save() / .clear() / .getRecent()). (#318 Step 3)

  /**
   * JOIN A RIDE's "Rejoin a recent ride" row (#547): one kit card per room
   * from the last 5 minutes (front seat or back seat), newest first. A pick
   * rejoins in the seat you had (_rejoinRoom). No recent rooms, no row.
   * Returns the cards so the step's focus scope can lead with them.
   */
  _renderRejoinCards() {
    const wrap = document.getElementById('join-rejoin');
    const list = document.getElementById('join-rejoin-cards');
    if (!wrap || !list) return [];
    const rooms = this._roomStore.getRecent()
      .slice().sort((x, y) => y.timestamp - x.timestamp).slice(0, 3);
    list.textContent = '';
    wrap.hidden = rooms.length === 0;
    const now = Date.now();
    return rooms.map((r) => {
      const code = String(r.roomCode || '').replace(/^TNDM-/, '');
      const mins = Math.floor((now - r.timestamp) / 60000);
      const card = /** @type {any} */ (document.createElement('uf-card'));
      card.className = 'join-rejoin-card';
      card.dataset.room = r.roomCode;
      card.setAttribute('heading', 'Rejoin ' + code);
      card.setAttribute('description', r.partnerName ? 'with ' + r.partnerName : (r.role === 'captain' ? 'Your room' : 'Your partner’s room'));
      card.setAttribute('footer', (r.role === 'captain' ? 'Front seat' : 'Back seat') + ' · ' + (mins < 1 ? 'just now' : mins + ' min ago'));
      card.addEventListener('click', () => this._rejoinRoom(r));
      list.appendChild(card);
      return card;
    });
  }

  /** The Rejoin cards currently shown on JOIN A RIDE (#547). */
  _rejoinCards() {
    const wrap = document.getElementById('join-rejoin');
    if (!wrap || wrap.hidden) return [];
    return Array.from(wrap.querySelectorAll('.join-rejoin-card'));
  }

  /** Rejoin a recent room in the seat you had (#547; was _handleRejoinCheck). */
  async _rejoinRoom(saved) {
    if (!saved || this._rejoining) return true;
    this._rejoining = true;
    setTimeout(() => { this._rejoining = false; }, 1500);
    // Rejoin: skip role selection, go straight to connection
    await this._requestMotion();
    this._pendingMode = 'multiplayer';

    if (saved.role === 'captain') {
      this._showStep(this.hostStep);
      // Re-use _createRoom logic but with saved code
      this._replaceNet();
      this._roomPartnerName = null;
      const netEpoch = this._netSession.epoch;
      this.net._fallbackUrl = RELAY_URL;
      this.net.cameraEnabled = this.cameraActive;
      this.net.audioEnabled = this.audioActive;
      const statusEl = document.getElementById('host-status');
      const codeEl = document.getElementById('room-code-display');
      statusEl.textContent = 'Rejoining room...';
      statusEl.className = 'conn-status';

      const relayToken = await this.auth.getRelayToken(saved.roomCode, 'captain');
      if (!this._netSession.isCurrent(netEpoch)) return true;
      if (relayToken) this.net._relayToken = relayToken;

      // Acquire local media early so it's ready when P2P connects
      await this.net.acquireLocalMedia(this._cameraPermitted, this._audioPermitted);
      if (!this._netSession.isCurrent(netEpoch)) return true;

      this.net.onRoomJoined = () => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        codeEl.textContent = saved.roomCode;
        this._updateCardHeader(this._currentStep);
        statusEl.textContent = 'Waiting for partner...';
        this._roomStore.save(saved.roomCode, 'captain');
        // Start stale room timer
        this._startStaleRoomTimer(statusEl);
      };

      this.net.onConnected = () => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        this._clearStaleRoomTimer();
        statusEl.textContent = 'Partner connected!';
        statusEl.className = 'conn-status connected';
        // Buffer profile messages during the 1s delay so none are lost
        this._rejoinMessageQueue = [];
        this.net.onProfileReceived = (profile) => this._rejoinMessageQueue.push(profile);
        setTimeout(() => {
          if (!this._netSession.isCurrent(netEpoch)) return;
          this._showRoomStep('captain');
        }, 1000);
      };

      this.net.onDisconnected = (reason) => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        statusEl.textContent = reason || 'Disconnected';
        statusEl.className = 'conn-status error';
      };

      // A refused socket (usually the network): keep dialling; the transport backs off.
      { const rjNet = this.net; rjNet.onAuthError = () => { if (!rjNet._destroyed) rjNet.retryWithToken(rjNet._relayToken); }; }
      this.net.enterRoom(saved.roomCode, 'captain');
    } else {
      this._showStep(this.joinStep);
      // #547: already on JOIN A RIDE; show the status line, not the row or spinners.
      const row = document.getElementById('join-rejoin');
      if (row) row.hidden = true;
      if (this._spinnerActive) this._showSpinners(false);
      this._applyStepSpatialFocus(this.joinStep);
      // Re-use _joinRoom logic with saved code
      this._replaceNet();
      this._roomPartnerName = null;
      const netEpoch = this._netSession.epoch;
      this.net._fallbackUrl = RELAY_URL;
      this.net.cameraEnabled = this.cameraActive;
      this.net.audioEnabled = this.audioActive;
      const statusEl = document.getElementById('join-status');
      statusEl.textContent = 'Rejoining room...';
      statusEl.className = 'conn-status';

      const relayToken = await this.auth.getRelayToken(saved.roomCode, 'stoker');
      if (!this._netSession.isCurrent(netEpoch)) return true;
      if (relayToken) this.net._relayToken = relayToken;

      // Acquire local media early so it's ready when P2P connects
      await this.net.acquireLocalMedia(this._cameraPermitted, this._audioPermitted);
      if (!this._netSession.isCurrent(netEpoch)) return true;

      this.net.onRoomJoined = () => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        statusEl.textContent = 'Waiting for captain...';
        this._roomStore.save(saved.roomCode, 'stoker');
        this._startStaleRoomTimer(statusEl);
      };

      this.net.onConnected = () => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        this._clearStaleRoomTimer();
        statusEl.textContent = 'Connected!';
        statusEl.className = 'conn-status connected';
        // Buffer profile messages during the 1s delay so none are lost
        this._rejoinMessageQueue = [];
        this.net.onProfileReceived = (profile) => this._rejoinMessageQueue.push(profile);
        setTimeout(() => {
          if (!this._netSession.isCurrent(netEpoch)) return;
          this._showRoomStep('stoker');
        }, 1000);
      };

      this.net.onDisconnected = (reason) => {
        if (!this._netSession.isCurrent(netEpoch)) return;
        statusEl.textContent = reason || 'Could not connect';
        statusEl.className = 'conn-status error';
      };

      { const rjNet = this.net; rjNet.onAuthError = () => { if (!rjNet._destroyed) rjNet.retryWithToken(rjNet._relayToken); }; }
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
            if (this.net && this.net.roomCode) this._roomStore.clear(this.net.roomCode);
            else this._roomStore.clear();
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

  /**
   * The partner connected: set up the room session. There is no room step any
   * more (Pete, 2026-10-23): the captain stays on the host step, which now
   * shows the partner and enables Online CHOOSE LEVEL; the stoker goes
   * straight to level select, waiting for the captain.
   */
  _showRoomStep(role) {
    this._roomRole = role;
    this._pendingMode = 'multiplayer';
    this._partnerCameraOn = true; // assume on until cameraToggle received

    // Set role labels on PiP circles
    const selfieLabel = document.getElementById('selfie-pip-label');
    const partnerLabel = document.getElementById('partner-pip-label');
    if (selfieLabel) selfieLabel.textContent = role === 'captain' ? 'CAPTAIN' : 'STOKER';
    if (partnerLabel) partnerLabel.textContent = role === 'captain' ? 'STOKER' : 'CAPTAIN';
    this._syncRoomSeats(role);

    if (role === 'captain') {
      if (this._currentStep !== this.hostStep) this._showStep(this.hostStep);
      this._refreshHostNext();
    } else {
      this._showRoomLevelsStep();
    }

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
    this.net.sendProfile(RoomProtocol.bikeSync(this.selectedPresetKey));

    // Send profile with avatar + achievements so partner sees them in room
    this._sendRoomProfile();

    // Notify partner of current camera state so they show video or avatar
    const camUser = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
    this.net.sendProfile(RoomProtocol.cameraToggle(this.cameraActive, camUser && camUser.avatar));

    // Handle partner disconnect while in room or levels
    const roomNet = this.net;
    this.net.onDisconnected = (reason) => {
      if (this.net !== roomNet) return;   // a newer room already replaced this one
      const waitText = document.getElementById('level-wait-text');
      const hostStatus = document.getElementById('host-status');
      // This device lost its seat (the room was opened somewhere else): say that, not "partner".
      const why = roomNet._evicted ? (reason || 'This room was opened somewhere else')
        : reason === PARTNER_LEFT_REASON ? reason : 'Partner disconnected';
      if (waitText) { waitText.textContent = why; waitText.style.display = ''; }
      if (hostStatus) { hostStatus.textContent = why; hostStatus.className = 'conn-status error'; }
      document.getElementById('btn-start-ride').style.display = 'none';
      this._setRoomSeat('partner', { who: 'LEFT', dev: 'disconnected', state: 'open' });
      setTimeout(() => {
        // Only this room's transport, and only if the lobby is still on it (not a fresh room).
        try { roomNet.destroy(); } catch (e) { /* already gone */ }
        if (this.net !== roomNet) return;
        this.net = null;
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
    const hasLiveTrack = hasVideo && stream.getVideoTracks().some(t => t.readyState === 'live');

    if (this._partnerCameraOn && hasVideo) {
      partnerVideo.style.display = 'block';
      partnerVideo.play().catch(() => {});
      if (partnerAvatar) partnerAvatar.style.display = 'none';
    } else if (!this._partnerCameraOn) {
      // Partner explicitly turned off camera — show avatar
      if (partnerVideo) partnerVideo.style.display = 'none';
      if (partnerAvatar) {
        partnerAvatar.src = this._partnerAvatarUrl
          ? (this._avatarCache.get(this._partnerAvatarUrl) || this._partnerAvatarUrl)
          : DEFAULT_AVATAR_SVG;
        partnerAvatar.style.display = 'block';
      }
    } else if (!hasVideo && this._partnerCameraOn) {
      // Camera on but stream not yet available — show avatar temporarily,
      // then retry in case stream arrives shortly
      if (partnerAvatar) {
        partnerAvatar.src = this._partnerAvatarUrl
          ? (this._avatarCache.get(this._partnerAvatarUrl) || this._partnerAvatarUrl)
          : DEFAULT_AVATAR_SVG;
        partnerAvatar.style.display = 'block';
      }
      if (partnerVideo) partnerVideo.style.display = 'none';
      // Retry to catch stream arriving after a delay
      setTimeout(() => this._updatePartnerPip(), 2000);
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

    // Room media off (#400 D7): no media call to place.
    if (!this._mediaEnabled) return;

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

  /** Online room: leave level select, resetting its multiplayer bits. The
   *  captain goes back to the host step (partner still shown); the stoker's
   *  level screen is its room, so it stays there, waiting. */
  _levelsToRoom() {
    const startBtn = document.getElementById('btn-start-ride');
    const waitText = document.getElementById('level-wait-text');
    const prompt = document.getElementById('level-prompt');
    if (startBtn) startBtn.style.display = 'none';
    if (waitText) waitText.style.display = 'none';
    if (prompt) prompt.style.display = 'none';
    // Reset difficulty selector interactivity
    const diffSel = document.getElementById('difficulty-selector');
    if (diffSel) { diffSel.style.opacity = ''; diffSel.style.pointerEvents = ''; }
    if (this._roomRole === 'captain') {
      this._showStep(this.hostStep);
      this._refreshHostNext();
    } else {
      this._showRoomLevelsStep();
    }
  }

  /** The stoker backs out of the ride: leave the room for the role screen. */
  _leaveRoomAsStoker() {
    if (this.net) { this.net.destroy(); this.net = null; }
    this._removePipLobbyMode();
    for (const id of ['selfie-pip', 'partner-pip']) { const v = /** @type {any} */ (document.getElementById(id)); if (v) v.srcObject = null; }
    for (const id of ['selfie-pip-wrap', 'partner-pip-wrap']) { const w = document.getElementById(id); if (w) w.style.display = 'none'; }
    const waitText = document.getElementById('level-wait-text');
    if (waitText) waitText.style.display = 'none';
    this._showStep(this.roleStep);
  }

  /**
   * The host step's two CHOOSE LEVEL buttons and the stoker seat, from state:
   * Online is enabled once the partner on their own device is connected,
   * Local once a second controller sits in the stoker seat. Whichever side
   * has the stoker dims the other (Pete, 2026-10-23).
   */
  _refreshHostNext() {
    const step = this.hostStep;
    const onBtn = /** @type {any} */ (document.getElementById('btn-host-online-next'));
    const locBtn = /** @type {any} */ (document.getElementById('btn-host-local-next'));
    const back = document.getElementById('btn-back-role-host');
    if (!step || !onBtn || !locBtn) return;
    const online = !!(this.net && this.net.connected && this._roomRole === 'captain');
    const local = !online && !!(this._localSeatedOnHost && this._localP2InputManager);
    onBtn.disabled = !online;
    locBtn.disabled = !local;
    step.classList.toggle('host-online-on', online);
    step.classList.toggle('host-local-on', local);
    const sto = /** @type {any} */ (document.getElementById('host-seat-stoker'));
    if (sto) {
      if (!sto._openHint) sto._openHint = sto.hint;
      if (online) Object.assign(sto, { who: this._roomPartnerName || 'Partner', dev: 'Online', state: 'joined', hint: '', pic: '', source: '' });
      else if (local) Object.assign(sto, { dev: '', state: 'joined', hint: '' }, this._seatWho(2, this._localP2NameBeforeAccount || this._localP2Name || 'Player 2'));
      else Object.assign(sto, { who: 'Waiting for partner…', dev: '', state: 'open', hint: sto._openHint || '', pic: '', source: '' });
      // P2 in the corner once someone sits there, like the captain's P1.
      sto.badge = online || local ? 'P2' : '';
    }
    const cands = this._currentStep === step && this._detectLocalJoinCandidates ? (this._detectLocalJoinCandidates() || []) : [];
    this._renderHostSeats(cands);
    const status = document.getElementById('host-status');
    if (status && local) { status.textContent = 'Online room closed: riding on this screen'; status.className = 'conn-status'; }
    // #563: the "Scan to join" QR while the stoker seat is open, and the room
    // code button until the online room is open.
    this._syncHostJoinQr();
    const codeBtn = !isMobile && !this._hostRoomCode && !online && !local ? document.getElementById('btn-host-room-code') : null;
    const items = [online && onBtn, local && locBtn, codeBtn, back].filter(Boolean);
    this._stepItems.set(step, items);
    this._stepCenterItems.set(step, items);
    this._stepDefaultFocus.set(step, 0);
    if (this._currentStep === step) this._applyStepSpatialFocus(step);
  }

  /**
   * #563 · the host step's one "Scan to join" QR (desktop / TV). Each phone
   * that scans it chooses: Control the TV (a phone seat on the shared pad
   * room, #562) or Play on this phone (the online partner: the RIDE TOGETHER
   * room opens only then, openRoomForPhone). Up while the partner seat is
   * free; the seats it offers close when it goes. Cheap to call often.
   */
  _syncHostJoinQr() {
    if (isMobile) return;
    const step = this.hostStep;
    if (!step) return;
    const online = !!(this.net && this.net.connected && this._roomRole === 'captain');
    const local = !online && !!(this._localSeatedOnHost && this._localP2InputManager);
    const on = this._currentStep === step && !online && !local;
    const pool = this.phonePool;
    if (this.padRoom) this.padRoom.allowPlay = on;
    // Only the offer this step made is withdrawn (versus has its own panel).
    if (pool && on && !this._hostOffering) { this._hostOffering = true; pool.setOffering(true); }
    else if (pool && !on && this._hostOffering) { this._hostOffering = false; pool.setOffering(false); }
    const qr = /** @type {any} */ (document.getElementById('host-join-qr'));
    if (qr) {
      const link = on && pool ? (pool.joinLink({ play: true }) || '') : '';
      if (qr.value !== link) qr.value = link;
      const caption = !on ? ''
        : !link ? (pool && pool.joinedEntries().length >= 3 ? 'Every phone seat is taken' : 'Opening…')
        : this._hostRoomCode ? 'Scan with your phone, or type this code on another device:' : 'Scan with your phone';
      if (qr.caption !== caption) qr.caption = caption;
    }
    step.classList.toggle('host-join-off', !on);
    step.classList.toggle('host-room-open', !!this._hostRoomCode);
    const codeBtn = document.getElementById('btn-host-room-code');
    if (codeBtn) codeBtn.style.display = on && !this._hostRoomCode ? '' : 'none';
  }

  /**
   * #563 · a phone on the host step's QR chose "Play on this phone": open the
   * RIDE TOGETHER room now (or reuse the one already open) and hand back its
   * code and join link. Null when that isn't on offer any more (another
   * screen, the partner seat taken) or the room didn't open in time.
   * @returns {Promise<{code: string, url: string}|null>}
   */
  async openRoomForPhone() {
    const allowed = () => !isMobile && this._currentStep === this.hostStep
      && !(this.net && this.net.connected) && !this._localSeatedOnHost;
    if (!allowed()) return null;
    if (!this._hostRoomCode && !this.net) this._createRoom();
    for (const t0 = Date.now(); !this._hostRoomCode && Date.now() - t0 < 15000;) {
      await new Promise((r) => setTimeout(r, 150));
      if (!allowed() || !this.net) return null;
    }
    const code = this._hostRoomCode;
    return code ? { code, url: joinUrl(code) } : null;
  }

  _handleRoomMessage(profile) {
    if (!profile || !profile.type) {
      // Profile message (avatar, name, achievements)
      if (profile && profile.name) {
        this._setRoomSeat('partner', { who: profile.name, state: 'joined' });
        // Save partner name for recent rooms display
        if (this.net && this.net.roomCode && this._roomRole) {
          this._roomStore.save(this.net.roomCode, this._roomRole, profile.name);
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
        this._partnerAchievements = profile.achievements;
        const shape = window.matchMedia('(min-width: 1024px)').matches ? 'rect' : undefined;
        updateBadgeDisplay('partner-badges', profile.achievements, shape);
        this._renderRoomPlayers();
      }
      if (profile) this._notePartnerRoom(profile);   // PR #397 M1
      return;
    }

    if (profile.type === ROOM_MSG.BIKE_SYNC) {
      // Partner changed bike — no label update needed (keep role-only labels)
    } else if (profile.type === ROOM_MSG.LEVEL_SYNC) {
      // Stoker: highlight captain's level selection
      const picked = LEVELS.find(l => l.id === profile.levelId);
      // PR #397 m17: a level (or a Today's Road) this side's edition does not
      // offer is refused — the captain hears why, this side stays on the list.
      const verdict = levelSyncVerdict(getEditionRules(), picked, profile);
      if (!verdict.ok) {
        this._refusedLevelId = profile.levelId;
        this._refusedReason = verdict.reason;
        if (this.net && this.net.connected) this.net.sendProfile(RoomProtocol.levelRefused(profile.levelId, verdict.reason));
        return;
      }
      this._refusedLevelId = null;
      // C-2: for Today's Road, take the captain's key and seed rather than
      // reading this device's clock — otherwise a stoker on the far side of
      // the 09:00 UTC rollover would ride a different road with the same name.
      this.selectedLevel = picked && picked.isDaily
        ? resolveDailyLevel(picked, { key: profile.key || dailyKey(), seed: typeof profile.seed === 'number' ? profile.seed : dailySeed() })
        : (picked || this.selectedLevel);
      // Track if captain selected tutorial — stoker needs _forceWizard too
      this._forceWizard = (profile.levelId === 'tutorial');
      const container = document.getElementById('level-cards');
      container.querySelectorAll('.level-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.levelId === profile.levelId);
      });
      // Update difficulty selector (disable harder options for tutorial)
      this._updateDifficultyVisibility(profile.levelId);
      // PR #397 M1: the captain's effective difficulty wins over the one this
      // side would force (e.g. a full stoker on a demo captain's road).
      if (typeof profile.difficulty === 'string' && profile.difficulty) this._adoptDifficulty(profile.difficulty);
    } else if (profile.type === ROOM_MSG.CAMERA_TOGGLE) {
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
    } else if (profile.type === ROOM_MSG.DIFFICULTY_SYNC) {
      // Stoker: update difficulty selection to match captain's choice
      this._adoptDifficulty(profile.difficulty);
    } else if (profile.type === ROOM_MSG.LEVEL_REFUSED) {
      // PR #397 m17 · Captain: the stoker's edition can't ride that level.
      this._onLevelRefused(profile);
    } else if (profile.type === ROOM_MSG.BACK_TO_ROOM) {
      // #167 · Stoker: the captain went back from level select; follow them.
      if (this._currentStep === this.levelStep) this._levelsToRoom();
    } else if (profile.type === ROOM_MSG.PLAY_GAME) {
      // Stoker: captain pressed CHOOSE LEVEL. A new stoker is already on level
      // select; this re-syncs it (and moves an older build off its room step).
      this._showRoomLevelsStep();
    } else if (profile.type === ROOM_MSG.TOURIST_PLAN) {
      // #400 · Stoker: the captain planned a Tourist route. Rebuild the same
      // plan from the two end points (pure, deterministic); held until the
      // flagged START_RIDE that follows.
      // A null `to` is an open-world ride around `from` (#400).
      this._stokerTouristPlan = !isValidPoint(profile.from) ? null
        : isValidPoint(profile.to) ? planRoute(profile.from, profile.to)
        : profile.to == null ? planExplore(profile.from) : null;
      // PR #397 m16: the captain's anchor height, when it sent one.
      if (this._stokerTouristPlan && profile.anchor && Number.isFinite(profile.anchor.height)) {
        this._stokerTouristPlan.anchor = { height: profile.anchor.height, anchored: !!profile.anchor.anchored };
      }
    } else if (profile.type === ROOM_MSG.START_RIDE) {
      // PR #397 m17: never ride a level this edition refused — stay on the list
      // and say so again (an old captain ignores it and rides alone).
      if (this._refusedLevelId && !profile.tourist) {
        if (this.net && this.net.connected) this.net.sendProfile(RoomProtocol.levelRefused(this._refusedLevelId, this._refusedReason));
        return;
      }
      // #400: a Tourist ride carries its route; any other ride clears it.
      // A flagged start without a usable route still goes to the barrier (as
      // a plan that cannot load), so the pair returns to the room together.
      this._roomTouristPlan = profile.tourist ? (this._stokerTouristPlan || { unusable: true }) : null;
      this._stokerTouristPlan = null;
      // Stoker: captain started the ride. Take the captain's placement salt and
      // world seed — they are authoritative for what the road contains (B-4).
      this._placementSalt = profile.placementSalt || 0;
      if (typeof profile.worldSeed === 'number' && this.selectedLevel) {
        this.selectedLevel = { ...this.selectedLevel, seed: profile.worldSeed };
      }
      // #623: ride the captain's difficulty, whatever this screen last had.
      if (typeof profile.difficulty === 'string' && profile.difficulty) this._adoptDifficulty(profile.difficulty);
      this._transitionToGame();
    }
  }

  /** Stoker: show and keep the captain's difficulty. */
  _adoptDifficulty(difficulty) {
    this.selectedDifficulty = difficulty;
    document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
    document.querySelectorAll('.difficulty-btn[data-difficulty="' + difficulty + '"]')
      .forEach(b => b.classList.add('selected'));
  }

  /**
   * PR #397 M1 · the partner's { edition, caps } arrived (in its untyped room
   * profile). The room's rules may have changed: a captain on the level list
   * rebuilds it (and re-syncs the selection) so both sides ride the same road.
   */
  _notePartnerRoom(profile) {
    const next = partnerFromProfile(profile);
    const prev = this._partnerRoom || null;
    this._partnerRoom = next;
    const same = prev && prev.edition === next.edition &&
      JSON.stringify(prev.caps) === JSON.stringify(next.caps);
    if (same) return;
    if (this._pendingMode === 'multiplayer' && this._currentStep === this.levelStep) {
      this._buildRoomLevelCards(this._roomRole === 'captain');
    }
  }

  /** PR #397 m17 · Captain: the stoker refused the level; stay on the list. */
  _onLevelRefused(profile) {
    if (this._roomRole !== 'captain') return;
    this._lastLevelRefused = profile.levelId || '';   // read by smoke:tourist
    if (profile.reason === 'demo') {
      showInfoToast('🔒', 'Your partner is on the demo',
        'They can ride the Tutorial, Grandma’s House and the Daily Ride with you.');
    } else {
      showInfoToast('🔒', 'Your partner can’t ride that one', 'Pick another level to ride together.');
    }
    const startBtn = document.getElementById('btn-start-ride');
    if (startBtn && this._pendingMode === 'multiplayer') startBtn.disabled = true;
    document.querySelectorAll('#level-cards .level-card.selected').forEach(c => c.classList.remove('selected'));
  }

  _sendRoomProfile() {
    if (!this.net || !this.net.connected) return;
    const profile = { achievements: this._achievements.getEarned() };
    const user = this.auth && this.auth.isLoggedIn() ? this.auth.getUser() : null;
    if (user) {
      if (user.avatar) profile.avatar = user.avatar;
      if (user.name) profile.name = user.name;
    }
    // Anonymous players (joined via invite without signing in) have no name —
    // give the partner a friendly label instead of a blank. (Issue #312)
    if (!profile.name) profile.name = GUEST_NAME;
    Object.assign(profile, this.roomProfileFields());   // PR #397 M1: { edition, caps }
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

  // ============================================================
  // LOCAL MULTIPLAYER — JOIN RIDE on host page (same-screen co-op)
  // ============================================================

  /**
   * Start the RAF loop that watches for a second input source while the
   * captain is on the host room-code page. Each frame we detect whether
   * a P2 path exists (second gamepad, or keyboard when P1 is on a gamepad)
   * and show/hide the two JOIN RIDE buttons independently — one per P2
   * device option, with the gamepad button labeled with the pad's name.
   * Also polls the unclaimed gamepad's A button so P2 can fire JOIN RIDE
   * with their own controller.
   */
  _startLocalJoinMonitor() {
    if (isMobile) return; // Local MP is desktop-only.
    const btnGp = document.getElementById('btn-local-join-gp');
    const btnKb = document.getElementById('btn-local-join-kb');
    const btnConnect = document.getElementById('btn-local-connect-hid');
    const gpNameEl = document.getElementById('btn-local-join-gp-name');
    const gpHintEl = document.getElementById('btn-local-join-gp-hint');
    const joinSection = document.getElementById('local-join-section');
    const detectedEl = document.getElementById('local-join-detected');
    const capLabel = document.getElementById('local-join-captain-label');
    const capNameEl = document.getElementById('local-join-captain-name');
    const hint = document.getElementById('host-local-hint');
    if (!btnGp || !btnKb) return;
    this._localP2APrev = false;
    this._localP2AnyPrev = false;
    this._localP2FlashTimer = null;
    // Re-render on entry rather than trusting the cached key from last time:
    // the buttons' visibility is DOM state that survives leaving the page.
    this._localLastJoinState = null;

    // Briefly flash btnGp's border so the second player gets visual
    // confirmation that the system sees their button press. Covers the
    // "which controller is P2?" UX ask from #204.
    const flashP2Button = () => {
      btnGp.classList.remove('p2-flash');
      // Force a reflow so the animation re-runs if it was already playing.
      void btnGp.offsetWidth;
      btnGp.classList.add('p2-flash');
      if (this._localP2FlashTimer) clearTimeout(this._localP2FlashTimer);
      this._localP2FlashTimer = setTimeout(() => {
        btnGp.classList.remove('p2-flash');
        this._localP2FlashTimer = null;
      }, 500);
    };

    // Seed HID cache immediately on monitor start
    if (navigator.hid) {
      navigator.hid.getDevices().then(devices => {
        this._cachedHIDDevices = devices;
        this._hidCacheTime = performance.now();
      }).catch(() => {});
    }

    const tick = () => {
      if (this._currentStep !== this.hostStep) {
        this._localJoinMonitorRAF = null;
        return;
      }
      // Refresh HID device cache every 2 seconds
      if (navigator.hid && performance.now() - this._hidCacheTime > 2000) {
        this._hidCacheTime = performance.now();
        navigator.hid.getDevices().then(devices => {
          this._cachedHIDDevices = devices;
        }).catch(() => {});
      }
      const state = this._detectLocalP2State();
      // Every CONNECTED controller that could be Player 2 (same detector as
      // versus; owner = Player 1). One JOIN button each; any button on that
      // pad joins. The single legacy button only shows when this list is empty.
      const candidates = this._detectLocalJoinCandidates();
      this._renderLocalJoinCandidates(candidates);
      this._renderHostSeats(candidates);
      this._pollSeatedP2Wardrobe();
      // #578 · a seated local Player 2 presses B on their own pad to get up.
      // Primed true on the seat's first frame so the press that joined (if it
      // was B) doesn't unseat them straight away. #548: while the Dressing Room
      // is open their B belongs to their card (and the close re-primes this).
      if (this._room) {
        this._localP2PrevB = true;
      } else if (this._localSeatedOnHost && this._localP2Type === 'gamepad' && this._localP2InputManager) {
        const im = this._localP2InputManager;
        if (typeof im.pollGamepad === 'function') im.pollGamepad();
        const p2gp = im.getGamepadState ? im.getGamepadState() : null;
        const bIdx = im._gpSwapAB ? 0 : 1;
        const bDown = !!(p2gp && p2gp.buttons && p2gp.buttons[bIdx] && p2gp.buttons[bIdx].pressed);
        const prevB = this._localP2PrevB === undefined ? true : this._localP2PrevB;
        this._localP2PrevB = bDown;
        if (bDown && !prevB) {
          this._localP2PrevB = undefined;
          // Remember which controller stood up: no press joins until it has let
          // go of every button. The B is still down, and the manager can hand
          // the same body straight back on a new slot; with only a flag, one
          // frame polling another pad cleared it and the held B re-seated the
          // player ("press B twice to stand up", TV playtest 2026-11-06).
          this._standUpHold = { device: (im._slot && im._slot.hidDevice) || null, gpIndex: im._slot ? im._slot.gamepadIndex : null, at: performance.now() };
          this._leaveLocalP2('stood up (B)');
          // The B is still down: no pad joins again until it lets go.
          this._localP2APrev = true;
          for (const k of this._versusPrevButtons.keys()) if (k.startsWith('local:')) this._versusPrevButtons.set(k, { any: true });
          this._refreshHostNext();
          this._localJoinMonitorRAF = requestAnimationFrame(tick);
          return;
        }
      } else {
        this._localP2PrevB = undefined;
      }
      // The stoker seat is taken (online partner, or a local Player 2): presses don't join.
      // Nor while the controller that just stood up still holds a button.
      const standingUp = this._standUpStillHeld();
      const seatOpen = !(this.net && this.net.connected) && !this._localSeatedOnHost && !standingUp;
      for (const c of candidates) {
        const gp = c.pollGp;
        if (!gp || !gp.buttons) continue;
        const key = 'local:' + c.key;
        const prev = this._versusPrevButtons.get(key) || { any: true };
        let any = false;
        for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i] && gp.buttons[i].pressed) { any = true; break; }
        // Any button joins except B (stand up). Edge on "any" so a held B
        // followed by A still needs a fresh press.
        const joins = isJoinPress(gp, this._padSwapsAB(gp, c.name));
        if (seatOpen && joins && !prev.any) {
          this._versusPrevButtons.set(key, { any });
          this._diag(`[local] join press on ${c.name} (${c.kind})`, 'join-press');
          this._onLocalJoinClick('gamepad', c.gpIndex ?? null, c.device || null, { slotId: c.slotId, name: c.name, phone: c.entry });
          // Desktop/TV: still on this step with Player 2 seated; keep watching.
          if (this._currentStep === this.hostStep) this._localJoinMonitorRAF = requestAnimationFrame(tick);
          return;
        }
        this._versusPrevButtons.set(key, { any });
      }
      const listed = candidates.length > 0;

      // Dirty-check the visible state before touching the DOM (avoids layout
      // churn every frame when nothing has changed).
      // No second pad visible yet, but WebHID could still pair one — offer it.
      // This is the state a Steam-launched session lands in with a Puck + a
      // DualSense: only one of them has ever been granted.
      // Offer pairing unless Player 2 is ALREADY on a live WebHID pad. Gating
      // it on "no pad found" or "the pad looks dead" made the one route that
      // works in the awkward cases appear only after a timeout, or not at all
      // — you cannot find a button that is conditional on the diagnosis being
      // right. A Gamepad-API pad is never the finished article anyway: gyro
      // steering needs WebHID, so pairing is a real upgrade even when the
      // buttons do work.
      const p2OnWebHid = !!(state.hidLive && state.hidLive.streaming);
      const canPairHid = !!navigator.hid && !p2OnWebHid && !navigator.userAgent.includes('Electron');   // browser-only fallback
      const stateKey = `${state.hasGamepad}|${state.hasKeyboard}|${state.gpIndex}|${!!state.hidDevice}|${state.slotId || ''}|${state.gpName}|${state.p1GpName}|${!!state.hintVisible}|${canPairHid}|${!!state.gpSilent}`;
      if (stateKey !== this._localLastJoinState) {
        this._localLastJoinState = stateKey;
        // Show/hide the entire join section based on whether any P2 path exists
        if (joinSection) {
          joinSection.style.display = (state.available || canPairHid) ? '' : 'none';
        }
        if (btnConnect) btnConnect.style.display = canPairHid ? '' : 'none';
        btnGp.style.display = (state.hasGamepad && !listed) ? '' : 'none';
        btnKb.style.display = state.hasKeyboard ? '' : 'none';
        if (state.hasGamepad && gpNameEl) {
          gpNameEl.textContent = state.gpName || 'CONTROLLER';
        }
        // Controller-specific action button hint. A pad that is paired but has
        // never sent a report can't answer a button press, so say that instead
        // of telling the player to press something that cannot work.
        if (state.hasGamepad && gpHintEl) {
          const actionBtn = this._getActionButtonLabel(state.gpRawId);
          const silent = state.gpSilent || (state.hidLive && !state.hidLive.streaming);
          if (silent) {
            gpHintEl.innerHTML = 'No input from this controller yet — click here to join';
          } else {
            gpHintEl.innerHTML = 'Press <strong>' + actionBtn + '</strong> (or any button) to join, or click here';
          }
        }

        // One line per state change, into tandemonium-diag.log: which source
        // found the pad and whether it is actually sending.
        const live = state.hidLive;
        this._diag('[local] P2 candidate: ' + (state.hasGamepad
          ? `${state.gpName} via ${state.via || 'gamepad-api'} gpIndex=${state.gpIndex}` +
            ` slot=${state.slotId || '-'}` +
            (live ? ` streaming=${live.streaming} everPressed=${live.everPressed} lastReport=${live.msSinceReport ?? 'never'}ms` : ' (no hid entry)')
          : `none (keyboard=${state.hasKeyboard}, p1=${state.p1GpName || '-'})`) +
          ` | silent=${!!state.gpSilent} pairButton=${canPairHid ? 'shown' : 'hidden'}`, 'candidate');
        // "2nd controller detected!" label
        if (detectedEl) {
          detectedEl.style.display = state.hasGamepad ? '' : 'none';
        }
        // Captain label: show whenever at least one P2 path is available,
        // so the user can verify which physical controller is captain vs
        // which one will be P2.
        if (capLabel && capNameEl) {
          if (state.available && (state.p1GpName || state.hasKeyboard)) {
            capNameEl.textContent = state.p1GpName || 'KEYBOARD';
          }
        }
        if (hint) {
          // Hint only appears when neither button is visible AND local MP
          // is blocked (e.g. captain on keyboard, no gamepad attached).
          hint.style.display = (!state.hasGamepad && !state.hasKeyboard && state.hintVisible) ? '' : 'none';
        }
      }

      // Poll the unclaimed gamepad's buttons so P2 can fire the 🎮 button
      // with their own controller (not P1's — which is still driving menu
      // navigation). No analogous poll for the ⌨️ button: browsers already
      // fire click on Enter/Space when it's focused.
      //
      // Two separate checks on the unclaimed pad:
      //   1. A button (index 0) → commits to JOIN RIDE
      //   2. Any button at all → triggers a brief visual flash on btnGp
      //      so the second player gets confirmation their controller is
      //      seen as P2 before they commit
      // Source the pad to poll: real Gamepad API entry when the browser
      // sees one, else the ControllerManager's P2 slot synthetic
      // (populated from HID reports for BT-silent DualSense).
      let gp = null;
      if (state.hasGamepad) {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        if (state.gpIndex !== null) {
          gp = pads[state.gpIndex] || null;
        }
        // Found in a manager seat: read that seat (HID synthetic or its pad).
        if (!gp && state.slotId && this.controllerManager) {
          const seat = this.controllerManager.getSlot(state.slotId);
          gp = (seat && (seat.effectiveGamepad(pads) || seat.synthetic)) || null;
        }
        // Found over WebHID: read THAT device's own synthetic, populated from
        // its parsed reports even before any slot claims it. Match by identity
        // first, then by vid:pid — navigator.hid.getDevices() can hand back a
        // different handle object for the same physical device.
        if (!gp && state.hidDevice && this.controllerManager) {
          const want = state.hidDevice;
          let entry = this.controllerManager._hidPool.get(want);
          if (!entry) {
            for (const e of this.controllerManager._hidPool.values()) {
              if (e.device === want) { entry = e; break; }
            }
          }
          if (!entry) {
            for (const e of this.controllerManager._hidPool.values()) {
              if (e.device.vendorId === want.vendorId && e.device.productId === want.productId) { entry = e; break; }
            }
          }
          gp = entry ? entry.synthetic : null;
        }
        // Last resort: the P2 slot's synthetic. Deliberately AFTER the detected
        // device — P2 can be holding a different controller entirely, and
        // reading it here would poll the wrong pad forever.
        if (!gp && this.controllerManager) {
          gp = this.controllerManager.getSlot('P2')?.synthetic || null;
        }
      }
      if (gp) {
          // Any-button flash (includes A, so flashing fires before the
          // commit action but that's fine — commit still happens).
          let anyPressed = false;
          if (gp.buttons) {
            for (let i = 0; i < gp.buttons.length; i++) {
              if (gp.buttons[i] && gp.buttons[i].pressed) { anyPressed = true; break; }
            }
          }
          if (anyPressed && !this._localP2AnyPrev) {
            flashP2Button();
            console.log('P2 button press detected on slot', state.gpIndex);
          }
          this._localP2AnyPrev = anyPressed;

          // Commit on any button but B. ✕ is index 0 only under Chromium's
          // standard mapping; a pad it doesn't recognise reports raw HID
          // order, where ✕ can be index 1, so there any button joins. On a
          // standard pad B is "stand up" and never seats (isJoinPress).
          const aPressed = isJoinPress(gp, this._padSwapsAB(gp, state.gpName));
          if (aPressed) {
            const pressed = [];
            for (let i = 0; i < gp.buttons.length; i++) if (gp.buttons[i] && gp.buttons[i].pressed) pressed.push(i);
            this._diag(`[local] P2 poll: pressed=[${pressed.join(',')}] mapping=${gp.mapping || '(non-standard)'} → joining`, 'poll');
          }
          if (aPressed && !this._localP2APrev && !standingUp) {
            console.log('P2 action button pressed — joining as gamepad', state.gpIndex, state.slotId || '');
            this._localP2APrev = true;
            this._onLocalJoinClick('gamepad', state.gpIndex, state.hidDevice || null,
              { slotId: state.slotId });
            // #578: desktop/TV stays on this step with Player 2 seated; keep
            // watching (their B stands them up). This path used to stop the loop.
            if (this._currentStep === this.hostStep) this._localJoinMonitorRAF = requestAnimationFrame(tick);
            return;
          }
          if (!anyPressed) this._localP2APrev = false;
      }

      this._localJoinMonitorRAF = requestAnimationFrame(tick);
    };
    this._localJoinMonitorRAF = requestAnimationFrame(tick);
  }

  /**
   * Does this pad report Nintendo-order A/B (the Cyclone quirk)? Looked up by
   * its Gamepad id, else its display name, the way InputManager sets _gpSwapAB.
   * @param {{ id?: string }|null|undefined} gp @param {string} [name]
   */
  _padSwapsAB(gp, name) {
    const key = (gp && gp.id) || name || '';
    return !!(key && ControllerRegistry.getGamepadQuirks(key).swapAB);
  }

  /**
   * Is the controller that just stood up (B) still holding any button? Read
   * from wherever it is now: a slot that holds its HID device or pad, the
   * pool, or the Gamepad API. Clears once it reads released (or after 3 s, so
   * a missed release can never lock joining).
   */
  _standUpStillHeld() {
    const hold = this._standUpHold;
    if (!hold) return false;
    if (performance.now() - hold.at > 3000) { this._standUpHold = null; return false; }
    const down = (gp) => !!(gp && gp.buttons && gp.buttons.some((b) => b && b.pressed));
    const m = this.controllerManager;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let held = false;
    if (hold.device && m) {
      for (const s of m.slots) if (s.hidDevice === hold.device && (down(s.synthetic) || down(s._hidEntry && s._hidEntry.synthetic))) held = true;
      for (const e of m._hidPool.values()) if (e.device === hold.device && down(e.synthetic)) held = true;
    }
    if (hold.gpIndex != null && down(pads[hold.gpIndex])) held = true;
    if (!held) this._standUpHold = null;
    return held;
  }

  _stopLocalJoinMonitor() {
    if (this._room) this._room.close('left');
    if (this._localJoinMonitorRAF !== null) {
      cancelAnimationFrame(this._localJoinMonitorRAF);
      this._localJoinMonitorRAF = null;
    }
    if (this._localP2FlashTimer) {
      clearTimeout(this._localP2FlashTimer);
      this._localP2FlashTimer = null;
    }
    const btnGp = document.getElementById('btn-local-join-gp');
    if (btnGp) btnGp.classList.remove('p2-flash');
    this._localLastJoinState = null;
    this._localP2APrev = false;
    this._localP2AnyPrev = false;
  }

  /**
   * Determine whether a P2 input path exists right now, and what to label the
   * gamepad button with when one is available.
   * @returns {{available: boolean, hasGamepad: boolean, hasKeyboard: boolean, gpIndex: number|null, gpName: string|null, p1GpName?: string|null, hintVisible?: boolean}}
   */
  _detectLocalP2State() {
    // Force P1 to claim a gamepad slot if it hasn't already, before we
    // compute what's "unclaimed" for P2. Without this, if two gamepads
    // were plugged in before launch (so neither triggered a
    // gamepadconnected event) and the user clicks JOIN RIDE inside the
    // ~1 second desktop gamepad poll window, this.input.gamepadIndex is
    // still null — and the "first unclaimed" loop below picks slot 0 as
    // P2. Then P1's pollGamepad later claims slot 0 too, and both
    // InputManagers read the same physical controller while the second
    // gamepad is completely ignored. Calling pollGamepad() synchronously
    // runs P1's "first available" fallback so p1GpIndex is populated
    // before the comparison. See #204 for the full repro.
    const gamepads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    // Force P1 to claim a gamepad slot if it hasn't already. Without this,
    // the "first unclaimed" loop below would pick slot 0 as P2 on the
    // frame the user arrives at the host page (ControllerManager only
    // auto-claims on user input), and pressing A on what the UI labels
    // "P2" would end up claiming P1 instead. See #204 repro.
    if (this.input && this.input.gamepadIndex === null && this.controllerManager) {
      this.controllerManager.claimFirstAvailable('P1', gamepads);
    }

    // ControllerManager owns orphan recovery + HID pool reattach, so the
    // stale-Gamepad-API-slot recovery that used to live here is no longer
    // needed — the P1 slot's state tracks the physical controller via
    // stable ID, not via a potentially-shifting navigator.getGamepads index.
    const p1GpIndex = this.input.gamepadIndex;

    // Find the first attached gamepad that isn't P1's (note: the array can be
    // sparse with holes at un-activated slots, so filter for truthy entries).
    // Prefer a pad that is actually DELIVERING INPUT. The first non-P1 entry
    // is not good enough: Chromium keeps stale post-reconnect ghosts, and a
    // pad Steam has taken for its Desktop layout reports the right name while
    // its buttons go to the mouse instead of to us. Both show the right name
    // and never report a press, so the join can never fire.
    const now = performance.now();
    this._trackPadActivity(gamepads, now);
    let unclaimedGpIndex = null;
    let unclaimedGpName = null;
    let bestRank = 99;
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp || i === p1GpIndex) continue;
      // Steam's XInput twin of P1's WebHID Steam Controller is the same
      // physical pad (#362) — never offer it as a second player.
      if (isSteamTwinPad(gp)) continue;
      const stickMag = Math.max(
        Math.abs(gp.axes[0] || 0), Math.abs(gp.axes[1] || 0),
        Math.abs(gp.axes[2] || 0), Math.abs(gp.axes[3] || 0));
      // 0 = has delivered input; 1 = quiet but plausible; 2 = quiet AND sticks
      // pinned off-centre, the classic ghost signature.
      const rank = this._padHasInput(i) ? 0 : (stickMag > 0.5 ? 2 : 1);
      if (rank < bestRank) {
        bestRank = rank;
        unclaimedGpIndex = i;
        unclaimedGpName = this._prettyGamepadName(gp.id);
        if (rank === 0) break;
      }
    }
    this._diag('[local] pads: ' + this._padTable(gamepads), 'pads');
    // Debug: log gamepad state once when it changes (avoids per-frame spam)
    const debugKey = `p1=${p1GpIndex} unclaimed=${unclaimedGpIndex} slots=${gamepads.length}`;
    if (debugKey !== this._lastGpDebugKey) {
      this._lastGpDebugKey = debugKey;
      const slotInfo = [];
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) slotInfo.push(`[${i}] ${gamepads[i].id}`);
      }
      console.log('Local MP gamepad detection:', debugKey, slotInfo.join(' | '));
    }
    const p1IsGamepad = p1GpIndex !== null;
    // Keyboard is only a valid P2 input if P1 isn't using it (we block kb+kb
    // because a single physical keyboard can't serve two players without key
    // collisions on arrows / A / D).
    const keyboardAvailable = p1IsGamepad;

    // Captain's controller name for the UI label. If P1 is on a real
    // gamepad, read the pretty name from this.input._gpName; otherwise
    // it'll render as "Keyboard" (or just stay hidden if neither side
    // has any input at all).
    const p1GpName = (p1IsGamepad && this.input && this.input._gpName)
      ? this._prettyGamepadName(this.input._gpName)
      : null;

    // A Gamepad-API candidate that has delivered input wins outright. One that
    // has not is held back until the WebHID/Steam sources have had their turn —
    // a pad we can actually read beats one that only looks right — and is
    // returned at the end if nothing better exists, flagged as silent so the
    // page offers pairing instead of a button that cannot answer.
    const gpCandidate = unclaimedGpIndex === null ? null : {
      available: true,
      hasGamepad: true,
      hasKeyboard: keyboardAvailable,
      gpIndex: unclaimedGpIndex,
      gpName: unclaimedGpName,
      gpRawId: gamepads[unclaimedGpIndex] ? gamepads[unclaimedGpIndex].id : null,
      via: 'gamepad-api',
      gpSilent: !this._padHasInput(unclaimedGpIndex) && this._padSilentFor(unclaimedGpIndex, now) > 3000,
      p1GpName,
    };
    if (gpCandidate && !gpCandidate.gpSilent) return gpCandidate;

    // The second pad may not be on the Gamepad API at all, and P1 may not be
    // on WebHID — a DualSense that Steam re-emits as an XInput pad can hold
    // P1 while the Steam Controller (vendor HID via the Puck, invisible to the
    // Gamepad API) is the one wanting to join. So look everywhere the manager
    // can see a pad, regardless of what P1 is on:
    const mgr = this.controllerManager;
    const p1Slot = (this.input && this.input._slot) || null;
    if (mgr) {
      // 1. A seat the manager already claimed for it (HID-activity claims land
      //    in the next empty slot even in the lobby). Idle Puck receiver
      //    siblings are not controllers (see isPresentableEntry).
      for (const s of mgr.slots || []) {
        if (s === p1Slot || s.state === 'empty') continue;
        if (s.gamepadIndex != null && s.gamepadIndex === p1GpIndex) continue;
        if (s.gamepadIndex != null && isSteamTwinPad(gamepads[s.gamepadIndex])) continue;
        const hid = s._hidEntry || null;
        if (hid && !isPresentableEntry(hid)) continue;
        if (this._isP1HidEntry(hid, p1Slot)) continue;
        const reg = hid ? ControllerRegistry.getEntry(hid.device.vendorId, hid.device.productId) : null;
        const raw = hid ? (hid.device.productName || (reg && reg.name) || 'Controller') : (s.controllerLabel || 'Controller');
        return {
          available: true,
          hasGamepad: true,
          hasKeyboard: keyboardAvailable,
          gpIndex: s.gamepadIndex ?? null,
          slotId: s.id,
          hidDevice: hid ? hid.device : null,
          hidLive: this._hidLiveness(hid),
          via: 'seat',
          gpName: hid ? prettyHidName(hid.device, raw) : this._prettyGamepadName(raw),
          gpRawId: s.controllerLabel || raw,
          p1GpName,
        };
      }
      // 2. A live, unclaimed WebHID pad still in the pool.
      const pooled = mgr.presentablePoolEntries().find((e) => !this._isP1HidEntry(e, p1Slot));
      if (pooled) {
        const d = pooled.device;
        const reg = ControllerRegistry.getEntry(d.vendorId, d.productId);
        return {
          available: true,
          hasGamepad: true,
          hasKeyboard: keyboardAvailable,
          gpIndex: null,
          hidDevice: d,
          hidLive: this._hidLiveness(pooled),
          via: 'pool',
          gpName: prettyHidName(d, (reg && reg.name) || 'Controller'),
          gpRawId: d.productName || '',
          p1GpName,
        };
      }
    }
    // 3. WebHID fallback: approved HID devices the pool hasn't picked up
    //    (BT DualSense + Steam on Windows). Uses a cached device list refreshed
    //    every 2 seconds to avoid async calls in the per-frame monitor loop.
    if (this._cachedHIDDevices) {
      for (const d of this._cachedHIDDevices) {
        if (this.input && d === this.input.gyroDevice) continue; // skip P1
        const entry = ControllerRegistry.getEntry(d.vendorId, d.productId);
        if (!entry) continue;
        if (mgr) {
          // Already seated (any slot) → not a second controller.
          if ((mgr.slots || []).some((sl) => sl._hidEntry && sl._hidEntry.device === d)) continue;
          // A Steam Puck exposes several same-vid:pid interfaces and only the
          // one a body streams on is a controller. When P1 rides the Puck, the
          // idle sibling receivers are still "approved devices" here — offering
          // one as P2 seats a phantom whose fusion never integrates (no gyro,
          // and the seat labelled as a second Steam Controller). Same filter
          // the controller lists use.
          const pooled = mgr._hidPool ? mgr._hidPool.get(d) : null;
          if (pooled && !isPresentableEntry(pooled)) continue;
        }
        const name = prettyHidName(d, entry.name);
        return {
          available: true,
          hasGamepad: true,
          hasKeyboard: keyboardAvailable,
          gpIndex: null,
          hidDevice: d,
          hidLive: this._hidLiveness(mgr && mgr._hidPool ? mgr._hidPool.get(d) : null),
          via: 'approved-hid',
          gpName: name,
          gpRawId: d.productName || '',
          p1GpName,
        };
      }
    }
    // Nothing better turned up — offer the silent pad, honestly labelled.
    if (gpCandidate) return gpCandidate;
    if (keyboardAvailable) {
      return {
        available: true,
        hasGamepad: false,
        hasKeyboard: true,
        gpIndex: null,
        gpName: null,
        p1GpName,
      };
    }
    // P1 is on keyboard with no second gamepad → local MP blocked.
    // Show a hint encouraging the captain to plug a controller in.
    return {
      available: false,
      hasGamepad: false,
      hasKeyboard: false,
      gpIndex: null,
      gpName: null,
      p1GpName,
      hintVisible: true,
    };
  }

  /**
   * Resolve a raw `navigator.getGamepads()[i].id` string to a short display
   * name for the JOIN RIDE button. Prefers the known-driver name from
   * ControllerRegistry (e.g. "DualSense", "Switch Pro", "Xbox") and falls
   * back to stripping the "(STANDARD GAMEPAD Vendor: xxxx Product: yyyy)"
   * suffix browsers add to generic ids.
   */
  _prettyGamepadName(rawId) {
    // #458: a pattern-only match names the family, not one variant (js/lobby/controller-labels.js).
    return prettyGamepadName(rawId);
  }

  /**
   * Return the platform-appropriate label for the "confirm" face button
   * so the join hint reads "Press ✕ to join" / "Press A to join" etc.
   */
  _getActionButtonLabel(rawGamepadId) {
    if (!rawGamepadId) return 'A';
    const info = ControllerRegistry.identifyFromGamepadId(rawGamepadId);
    if (info) {
      const proto = info.protocol;
      if (proto === 'dualsense') return '\u2715'; // ✕
      if (proto === 'switch-pro') return 'B'; // Bottom face button on Nintendo layout
    }
    return 'A'; // Xbox / generic
  }

  /**
   * Handle a JOIN RIDE click. Tears down any in-flight online MP session,
   * constructs the P2 InputManager, and routes the captain directly to the
   * level-select screen with _pendingMode='local'. The actual game-side
   * setup happens on START RIDE via onLocalReady.
   *
   * @param {'gamepad'|'keyboard'} sourceType
   * @param {number|null} gamepadSlot — gamepad index when sourceType is 'gamepad'
   * @param {HIDDevice|null} [hidDevice] — WebHID device when Gamepad API is blind
   */
  /**
   * Tell the Electron WebHID picker which devices we ALREADY hold (pooled or
   * seated), so a requestDevice() meant to pair a second controller doesn't
   * hand back the one we have. The manager answers what it holds; main runs
   * the core's pickNewHidDevice over it. No-op outside Electron. Call
   * immediately before any connectHidForSlot() that may prompt.
   */
  _publishHeldHidDevices() {
    const api = (typeof window !== 'undefined' && window.electronApp) || null;
    if (!api || typeof api.setHeldHidDevices !== 'function') return;
    const mgr = this.controllerManager;
    if (!mgr || typeof mgr.heldHidDescriptors !== 'function') return;
    try { api.setHeldHidDevices(mgr.heldHidDescriptors()); } catch (e) { /* not fatal */ }
  }

  /**
   * Watch every Gamepad-API pad for signs of life. Chromium keeps stale
   * entries after a Bluetooth reconnect that are indistinguishable from a live
   * pad at rest — same id, same button count, buttons that never move. The
   * ControllerManager already refuses to claim those blind (stuck-stick skip,
   * activity-based claim); the host page's "first pad that isn't P1" rule had
   * no such guard and would happily offer a dead entry as Player 2, which
   * looks exactly like a join button that ignores you.
   *
   * What counts is INPUT — a button pressed, or a stick that actually moved.
   * `timestamp` alone does not: Chromium bumps it whenever it refreshes a pad,
   * so a controller Steam has taken for its Desktop layout (buttons translated
   * to mouse clicks and never delivered as gamepad buttons) ticks along
   * happily while reporting nothing usable. Judging liveness by timestamp
   * called that pad healthy and hid the WebHID pairing route that would have
   * fixed it. Stick MAGNITUDE doesn't count either — a ghost's axes are pinned
   * but constant, so only a CHANGE is evidence.
   *
   * The converse still isn't true — an untouched live pad shows nothing — so
   * this ranks candidates and offers alternatives, never excludes.
   */
  _trackPadActivity(gamepads, now) {
    if (!this._padWatch) this._padWatch = new Map();
    const AXIS_DELTA = 0.15; // past stick jitter and drift
    const seen = new Set();
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;
      seen.add(i);
      let pressed = '';
      for (let b = 0; b < gp.buttons.length; b++) if (gp.buttons[b] && gp.buttons[b].pressed) pressed += b + ',';
      const axes = (gp.axes || []).map((a) => a || 0);
      let rec = this._padWatch.get(i);
      if (!rec) {
        rec = { ts: gp.timestamp, pressed, axes, since: now, inputAt: 0, tickedAt: 0 };
        this._padWatch.set(i, rec);
      }
      if (rec.ts !== gp.timestamp) { rec.ts = gp.timestamp; rec.tickedAt = now; }
      let moved = pressed !== '' || pressed !== rec.pressed;
      if (!moved) {
        for (let a = 0; a < axes.length; a++) {
          if (Math.abs(axes[a] - (rec.axes[a] || 0)) > AXIS_DELTA) { moved = true; break; }
        }
      }
      rec.pressed = pressed;
      rec.axes = axes;
      if (moved) rec.inputAt = now;
    }
    for (const i of [...this._padWatch.keys()]) if (!seen.has(i)) this._padWatch.delete(i);
  }

  /** Has this pad delivered any real input (button or stick) since we started? */
  _padHasInput(index) {
    const rec = this._padWatch && this._padWatch.get(index);
    return !!(rec && rec.inputAt > 0);
  }

  /** How long we have watched this pad without a single usable input (ms). */
  _padSilentFor(index, now) {
    const rec = this._padWatch && this._padWatch.get(index);
    if (!rec) return 0;
    return now - (rec.inputAt || rec.since);
  }

  /** Compact pad table for the diag log — what Chromium actually reports. */
  _padTable(gamepads) {
    const parts = [];
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;
      const rec = this._padWatch && this._padWatch.get(i);
      // input: real button/stick activity. ticking: Chromium is refreshing the
      // pad. ticking without input is the signature of a pad something else
      // (Steam's Desktop layout) has taken over.
      parts.push(`[${i}] ${this._prettyGamepadName(gp.id)} input=${this._padHasInput(i)}` +
        ` ticking=${!!(rec && rec.tickedAt)} pressed=[${rec ? rec.pressed.replace(/,$/, '') : ''}]`);
    }
    return parts.length ? parts.join(' | ') : '(no pads)';
  }

  /**
   * Is a pooled/seated HID entry actually SENDING? A device can be granted,
   * pooled and correctly named from its vid:pid while never streaming a single
   * input report — it then shows up as a detected controller whose buttons
   * never change, which looks exactly like "the join button is broken".
   */
  _hidLiveness(entry) {
    if (!entry) return null;
    return {
      streaming: (entry.hidActiveSince || 0) > 0,
      everPressed: !!entry._everPressed,
      msSinceReport: entry.lastRawReportAt ? Math.round(performance.now() - entry.lastRawReportAt) : null,
    };
  }

  /**
   * One line into tandemonium-diag.log (Electron only). Repeats are suppressed
   * PER KIND, so two lines that alternate — a per-frame state line and an
   * occasional event line — don't keep re-triggering each other.
   */
  _diag(msg, kind = msg) {
    if (!this._lastDiagLine) this._lastDiagLine = new Map();
    if (this._lastDiagLine.get(kind) === msg) return;
    this._lastDiagLine.set(kind, msg);
    console.log(msg);
    const api = (typeof window !== 'undefined' && window.electronApp) || null;
    if (api && typeof api.diag === 'function') { try { api.diag(msg); } catch (e) { /* not fatal */ } }
  }

  /**
   * Undo a local co-op join: release Player 2's seat back to the pool and drop
   * the InputManager built for it.
   *
   * Joining had no reverse. Backing out of level select dropped to the mode
   * screen with the seat still claimed, `_localP2InputManager` still set and
   * `_pendingMode` still 'local' — invisible state that then made a second
   * join behave differently from the first, with nothing on screen to explain
   * why. Versus already does this per seat (releaseSlotToPool on leave); local
   * co-op is the same idea for its single guest seat.
   */
  _leaveLocalP2(reason) {
    const im = this._localP2InputManager;
    const slot = im && im._slot;
    this._releasePhone(im);   // #562: a phone goes back to the join list
    if (slot && slot.id !== 'P1' && this.controllerManager) {
      this.controllerManager.releaseSlotToPool(slot.id);
    }
    if (im) this._diag(`[local] P2 left (${reason}): released ${slot ? slot.id : 'no slot'}`, 'leave');
    this._localP2InputManager = null;
    this._localP2Type = null;
    this._localSeatedOnHost = false;
    this._localP2Name = null;
    this._localP2NameBeforeAccount = null;
    // #612: the seat is empty, so no account sits on it (the controller still remembers it).
    try { this.seatAccounts.bindSeat(2, null); } catch (e) {}
    if (this._pendingMode === 'local') this._pendingMode = null;
    // Force the host page to re-render its join UI next time it is shown.
    this._localLastJoinState = null;
  }

  /** Is Player 1 riding a Steam Controller (the Puck's fan-out family)? */
  _p1IsSteamPad() {
    const p1 = this.input;
    const proto = (p1 && p1._slot && p1._slot.driver && p1._slot.driver.entry && p1._slot.driver.entry.protocol) || '';
    return proto === 'steam-controller';
  }

  /**
   * Does this pooled HID entry belong to the controller Player 1 is riding?
   *
   * Comparing entry objects is not enough. When P1 steers through Steam Input
   * its ControllerManager slot holds no HID entry at all, so the Steam
   * Controller's own streaming Puck interface sits in the pool looking
   * unclaimed — and gets offered as Player 2. Worse, it IS a live WebHID
   * device, so the page concludes P2 is sorted and hides the pairing button
   * that would have fixed things. That is the "it appeared and then went away
   * after a couple of seconds" report: before the silence threshold the
   * Gamepad-API pad answered, after it this did.
   *
   * When P1 DOES hold a slot entry, only that exact device is excluded — a
   * second body streaming on another interface of the same Puck is a genuine
   * second controller and must stay available.
   */
  _isP1HidEntry(entry, p1Slot) {
    if (!entry) return false;
    const p1Entry = p1Slot && p1Slot._hidEntry;
    if (p1Entry) return entry === p1Entry || entry.device === p1Entry.device;
    // No slot entry to compare against: attribute a fan-out (multi-receiver)
    // interface to P1 when P1 is riding that family of pad.
    const fanout = !!(entry.driver && entry.driver.constructor && entry.driver.constructor.needsSiblingFanout);
    return fanout && this._p1IsSteamPad();
  }

  /**
   * @param {'gamepad'|'keyboard'} sourceType
   * @param {number|null} gamepadSlot  Gamepad API index of the joining pad, if any
   * @param {HIDDevice|null} [hidDevice]  its WebHID device, if that is how we found it
   * @param {{slotId?: string}} [opts]  the manager seat that already holds it
   */
  _onLocalJoinClick(sourceType, gamepadSlot, hidDevice = null, opts = {}) {
    this._diag(`[local] JOIN fired: type=${sourceType} gpIndex=${gamepadSlot} ` +
      `hid=${hidDevice ? (hidDevice.productName || 'device') : '-'} slot=${opts.slotId || '-'}`, 'join-fired');
    // Guard: if the monitor hasn't seen a P2 path, bail.
    if (sourceType !== 'gamepad' && sourceType !== 'keyboard') return;
    // The stoker seat is taken: by the online partner, or by a local Player 2.
    if (this.net && this.net.connected) return;
    if (this._localSeatedOnHost && this._localP2InputManager) return;
    // Record that local JOIN RIDE won the race vs. any pending online stoker.
    analytics.trackEvent('room_local_claimed', {
      p2_source: sourceType,
      had_net: !!this.net,
    });
    // Tear down the online MP attempt so the TNDM-XXXX room stops accepting
    // remote stokers. Any in-flight online connection gets rejected.
    //
    // Drop it from Recent Rooms too. The room is gone the moment local co-op
    // claims it, so leaving it there means the next RIDE TOGETHER opens the
    // rejoin prompt offering a room that cannot be rejoined — and, since that
    // prompt is modal, it looks like RIDE TOGETHER stopped going to the
    // join/room screen at all.
    if (this.net) {
      try { if (this.net.roomCode) this._roomStore.clear(this.net.roomCode); } catch (e) {}
      try { this.net.destroy(); } catch (e) {}
      this.net = null;
    }
    if (sourceType === 'gamepad' && opts.phone) {
      // #562 · a phone: its own InputManager is Player 2's. It is "connected"
      // while the phone is, so the drop pause treats it like a pad.
      this._localP2InputManager = opts.phone.attach('Player 2');
      this._localP2Type = 'gamepad';
    } else if (sourceType === 'gamepad') {
      // Seat the pad now, in the slot the detection found it in (a manager
      // claim may already have put it in P2..P4), else P2. Seating explicitly
      // — rather than waiting for the slot to claim on first input — means a
      // WebHID-found pad has its gyro fusion from the first frame of the ride.
      const mgr = this.controllerManager;
      let slot = (mgr && opts.slotId) ? mgr.getSlot(opts.slotId) : null;
      if (!slot && mgr) {
        slot = mgr.getSlot('P2');
        if (slot && slot.state === 'empty') {
          if (hidDevice) mgr.claimHidDeviceForSlot('P2', hidDevice);
          else if (gamepadSlot != null) {
            const pads = navigator.getGamepads ? navigator.getGamepads() : [];
            if (pads[gamepadSlot]) mgr.claimPadForSlot('P2', pads[gamepadSlot], pads);
          }
        }
      }
      // ControllerManager slot owns HID pool + fusion. InputManager consumes
      // the slot; HID pre-connect / gyro calibration happens automatically
      // when the slot claims.
      this._localP2InputManager = new InputManager({
        slot: slot || null,
        enableKeyboard: false,
        enableMotion: false,
        enableTouch: false,
      });
      this._localP2Type = 'gamepad';

      // Mirror P1's input toggles
      this._localP2InputManager.suppressGamepadLean = !this.joystickActive;

      // Arm motion so the tilt pipeline in pollGamepad applies gyro lean
      // as soon as the slot's fusion finishes calibrating.
      if (this.motionActive || hidDevice) {
        this._localP2InputManager.motionEnabled = true;
      }

    } else {
      // Keyboard P2: no slot needed.
      this._localP2InputManager = new InputManager({
        enableKeyboard: true,
        enableMotion: false,
        enableTouch: false,
      });
      this._localP2Type = 'keyboard';
    }
    this._pendingMode = 'local';
    this._diag(`[local] JOIN seated: P2 on ${this._localP2Type}` +
      (this._localP2InputManager && this._localP2InputManager._slot ? ` slot=${this._localP2InputManager._slot.id}` : ' slot=none') +
      ' — advancing to level select', 'join-seated');
    // Desktop/TV: Player 2 sits in the stoker seat and the captain presses
    // Local CHOOSE LEVEL (Pete, 2026-10-23). The narrow layout has no seats,
    // so it still goes straight to level select.
    if (window.matchMedia('(min-width: 1024px)').matches && this._currentStep === this.hostStep) {
      this._localSeatedOnHost = true;
      // The seat card names the pad (#581: a join through the legacy P2 poll
      // carries no name and the card read "Player 2").
      const p2Slot = this._localP2InputManager && this._localP2InputManager._slot;
      const mgr = this.controllerManager;
      const slotName = (sourceType !== 'keyboard' && p2Slot && p2Slot.state === 'claimed' && mgr && mgr.slotIdentity)
        ? slotIdentityHidFirst(p2Slot, (sl) => mgr.slotIdentity(sl)).shortName : null;
      this._localP2Name = opts.name || slotName || (sourceType === 'keyboard' ? 'Keyboard' : 'Player 2');
      this._localP2NameBeforeAccount = null;
      // #612: a controller that remembers its player (Steam: by serial) sits down signed in.
      try {
        const key = this._lookKeyFor({ n: 2, input: this._localP2InputManager, type: sourceType === 'keyboard' ? 'keyboard' : 'gamepad', slotId: p2Slot ? p2Slot.id : null });
        this.seatAccounts.bindSeat(2, key);
        this._refreshSeatNames();
      } catch (e) {}
      this._refreshHostNext();
      return;
    }
    this._showStep(this.levelStep);
  }

  // ============================================================
  // VERSUS — local split-screen team racing (2-4 players, issue #351)
  // ============================================================

  /**
   * Enter the versus team-setup screen. P1 (the lobby's own InputManager)
   * auto-joins Team A; everyone else joins from the monitor loop by
   * pressing A on an unclaimed pad, or via the keyboard button.
   */
  /**
   * Describe P1's current physical source. gamepadIndex is USELESS for
   * this — HID pseudo-pad claims (BT DualSense in 0x31 mode, the normal
   * state in Electron) leave it null. gamepadConnected covers Gamepad API,
   * and HID-slot bindings.
   */
  _versusP1Descriptor() {
    const inp = this.input;
    if (!inp) return { type: 'keyboard', name: 'KEYBOARD' };
    if (inp.gamepadConnected) {
      const slot = inp._slot;
      if (slot?.hidDevice) return { type: 'gamepad', name: prettyHidName(slot.hidDevice, inp._gpName || slot.controllerLabel) };
      const raw = inp._gpName || slot?.controllerLabel;
      return { type: 'gamepad', name: this._prettyGamepadName(raw) };
    }
    return { type: 'keyboard', name: 'KEYBOARD' };
  }

  /**
   * Wire a PAIR A CONTROLLER button: requestDevice() from the click (user
   * activation), pool the device, report in the hint line.
   * @param {string} btnId @param {string} hintId @param {string} tag log prefix
   */
  _wireHidPairButton(btnId, hintId, tag) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    // Desktop builds grant every HID device in main (setDevicePermissionHandler)
    // and pool them at boot — the button is a browser-only fallback.
    if (navigator.userAgent.includes('Electron')) { btn.style.display = 'none'; return; }
    // No WebHID to pair with: a TV's browser (Google TV has none) or any browser
    // without navigator.hid. A dead-end link is worse than none.
    if (isTV || !navigator.hid) { btn.style.display = 'none'; return; }
    btn.addEventListener('click', async () => {
      const hintEl = document.getElementById(hintId);
      const say = (t) => { if (hintEl) { hintEl.textContent = t; hintEl.style.display = t ? '' : 'none'; } };
      if (!this.controllerManager || !navigator.hid) { say('WebHID is not available in this browser'); return; }
      if (btn.hasAttribute('disabled')) return;
      btn.setAttribute('disabled', '');
      say('Pick the controller in the browser prompt…');
      this._publishHeldHidDevices();
      try {
        const device = await this.controllerManager.connectHidForSlot(null, { prompt: true });
        say(device
          ? `Paired ${device.productName || 'controller'} — press a button on it`
          : 'No new controller found — turn it on, then try again');
        console.log(`[${tag}] HID pair →`, device ? (device.productName || 'device') : 'nothing new');
      } catch (err) {
        console.warn(`[${tag}] HID pair failed:`, err);
        say('Pairing failed — try again');
      } finally {
        btn.removeAttribute('disabled');
      }
    });
  }

  _enterVersusStep() {
    // Tear down any in-flight online session — versus is purely local.
    if (this.net) {
      try { this.net.destroy(); } catch (e) {}
      this.net = null;
    }
    this._pendingMode = 'versus';
    this._versusPlayers = [];
    this._versusPrevButtons.clear();
    this._versusLastCardsKey = null;
    this._versusCandidates = [];

    // Give P1 one last chance to bind a visible pad BEFORE suspending
    // auto-claim (pads plugged in pre-launch never fire gamepadconnected;
    // same rationale as _detectLocalP2State's forced claim).
    if (this.input && this.input.gamepadIndex === null && this.controllerManager) {
      const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
      this.controllerManager.claimFirstAvailable('P1', pads);
    }

    // While this screen is open, the join monitor is the ONLY claimer.
    // Without this, ingestFrame's activity-claim would grab a joiner's
    // first button press into the first empty slot — P1's — hijacking a
    // keyboard-driven P1. Cleared in _leaveVersus and on START RIDE
    // (game._onVersusReady side).
    if (this.controllerManager) this.controllerManager.autoClaimSuspended = true;

    // Seed the WebHID device cache (same pattern as the co-op monitor) so
    // hid candidates can be labeled before their first report arrives.
    if (navigator.hid) {
      navigator.hid.getDevices().then(devices => {
        this._cachedHIDDevices = devices;
        this._hidCacheTime = performance.now();
      }).catch(() => {});
    }

    // P1 auto-joins Team A.
    const p1 = this._versusP1Descriptor();
    this._versusPlayers.push({
      n: 1,
      type: p1.type,
      gpIndex: this.input ? this.input.gamepadIndex : null,
      slotId: 'P1',
      name: p1.name,
      team: 'A',
      input: this.input,
    });

    // Debug: ?versusbot=1 fills Team B with a synthetic rider so split-
    // screen, streaming separation, and the finish flow are testable with
    // one human. The game drives its taps at a fixed cadence (_stepTeam).
    // m19: local servers / ?dev=1 only (js/versus/versus-bot.js).
    if (versusBotAllowed(window.location.search, window.location.hostname, window.location.protocol)) {
      this._versusPlayers.push({
        n: 2,
        type: 'bot',
        gpIndex: null,
        slotId: null,
        name: 'BOT',
        team: 'B',
        input: new InputManager({
          enableKeyboard: false,
          enableMotion: false,
          enableTouch: false,
        }),
      });
    }

    this._showStep(this.versusStep); // starts the monitor
  }

  /**
   * A joined pad leaves its seat (B): the slot goes back to the pool so the
   * pad is a CONNECTED candidate again and can rejoin with A. Never the host.
   */
  _versusUnseat(p) {
    if (!p || p.slotId === 'P1' || p.input === this.input) return;
    this._versusPlayers = this._versusPlayers.filter(x => x !== p);
    this._releasePhone(p.input);   // #562
    if (p.type === 'gamepad' && p.slotId) this.controllerManager?.releaseSlotToPool(p.slotId);
    this._versusPrevButtons.delete('member:' + p.n);
    this._versusLastCardsKey = null;
    this._diag(`[versus] P${p.n} left their seat (${p.name})`);
    analytics.trackEvent('versus_player_left', { source: p.type, players: this._versusPlayers.length });
  }

  /** CONNECTED controllers that could be Player 2: everything but what Player 1 holds. */
  _detectLocalJoinCandidates() {
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    const owned = { devices: new Set(), indices: new Set(), slotIds: new Set(['P1']) };
    if (this.input) {
      if (this.input.gamepadIndex !== null) owned.indices.add(this.input.gamepadIndex);
      if (this.input._slot?.hidDevice) owned.devices.add(this.input._slot.hidDevice);
    }
    return this._detectJoinCandidates(pads, owned);
  }

  /**
   * Desktop/TV captain's room (#428 round 5): the co-op <uf-team> (captain
   * seated, stoker waiting for any controller — the first one to press
   * joins, via the monitor's edge poll) and a <uf-controller-roster> strip of
   * every controller that could take the back seat. Dirty-checked; the phone
   * layout keeps its JOIN AS PLAYER 2 buttons.
   */
  _renderHostSeats(candidates) {
    const strip = document.getElementById('host-roster');
    const cap = document.getElementById('host-seat-captain');
    if (!strip || !cap) return;
    const p1 = this._p1Identity() || (this.input && this.input.gamepadIndex == null ? KEYBOARD_IDENTITY : null);
    // Who holds the stoker seat: the online partner, or a local Player 2 (2026-10-23).
    const online = !!(this.net && this.net.connected && this._roomRole === 'captain');
    const p2Im = this._localSeatedOnHost ? this._localP2InputManager : null;
    const p2Slot = p2Im && p2Im._slot ? p2Im._slot.id : null;
    const stokerSeat = { team: 'coop', role: 'stoker', label: 'Stoker', tone: 'stoker' };
    const key = (p1 ? p1.shortName : '') + '§' + candidates.map(c => c.key).join('|') +
      '§' + (online ? 'online:' + (this._roomPartnerName || '') : '') + (p2Im ? 'p2:' + (p2Slot || this._localP2Type) : '') +
      '§' + this._personKey(1) + '§' + (p2Im ? this._personKey(2) : '');
    if (key === this._hostSeatsKey) return;
    this._hostSeatsKey = key;
    Object.assign(cap, { dev: '' }, this._seatWho(1, p1 ? p1.shortName : 'You'));
    const rows = [];
    if (p1) rows.push({ key: 'p1', name: p1.name, shortName: p1.shortName, glyphFamily: p1.glyphFamily, swapAB: p1.swapAB, state: 'seated', player: 1, person: this.seatPerson(1), seat: { team: 'coop', role: 'captain', label: 'Captain', tone: 'captain' } });
    let p2Listed = false;
    for (const c of candidates) {
      const id = this._versusIdentity(c);
      const isP2 = !!p2Slot && c.slotId === p2Slot;
      if (isP2) p2Listed = true;
      rows.push({ key: c.key, name: id.name, shortName: id.shortName, glyphFamily: id.glyphFamily, swapAB: id.swapAB,
        state: isP2 ? 'seated' : 'connected', player: isP2 ? 2 : null, seat: isP2 ? stokerSeat : null, person: isP2 ? this.seatPerson(2) : null });
    }
    if (p2Im && !p2Listed) {
      // A seated pad drops out of the join candidates; name and glyph come from
      // its own slot so a Switch Pro shows Nintendo prompts, not generic (#472).
      const mgr = this.controllerManager;
      const p2SlotObj = p2Im._slot && p2Im._slot.state === 'claimed' ? p2Im._slot : null;
      const pid = this._localP2Type !== 'keyboard' && p2SlotObj && mgr ? slotIdentityHidFirst(p2SlotObj, (s) => mgr.slotIdentity(s)) : null;
      const p2 = this.seatPerson(2);
      const own = p2 ? this._localP2NameBeforeAccount : this._localP2Name;   // the seat's own name, not the account's
      const n = own || (this._localP2Type === 'keyboard' ? 'Keyboard' : (pid ? pid.shortName : 'Player 2'));
      rows.push({ key: 'p2', name: own || (pid ? pid.name : n), shortName: n, person: p2,
        glyphFamily: this._localP2Type === 'keyboard' ? 'keyboard' : (pid ? pid.glyphFamily : 'generic'),
        swapAB: pid ? !!pid.swapAB : false, state: 'seated', player: 2, seat: stokerSeat });
    }
    if (online) {
      const n = this._roomPartnerName || 'Partner';
      rows.push({ key: 'online', name: n + ' (online)', shortName: n, glyphFamily: 'generic', swapAB: false, state: 'seated', player: 2, seat: stokerSeat });
    }
    strip.rows = rows;
    // #548 · WARDROBE for Player 1 and, once seated locally, Player 2 (an online partner dresses on their own screen).
    const wardrobePlayers = [{ n: 1, input: this.input, type: this.input && this.input.gamepadConnected ? 'gamepad' : 'keyboard', slotId: 'P1' }];
    if (p2Im) wardrobePlayers.push({ n: 2, input: p2Im, type: this._localP2Type || 'gamepad', slotId: p2Slot });
    this._renderWardrobeButtons('host-wardrobe', wardrobePlayers, this.hostStep);
    // A mouse user can still seat someone: clicking the open seat joins the first candidate.
    const sto = document.getElementById('host-seat-stoker');
    if (sto && !sto._wired) {
      sto._wired = true;
      sto.addEventListener('click', () => {
        const c = (this._detectLocalJoinCandidates() || [])[0];
        if (c) this._onLocalJoinClick('gamepad', c.gpIndex ?? null, c.device || null, { slotId: c.slotId, name: c.name, phone: c.entry });
      });
    }
  }

  /** One JOIN AS PLAYER 2 button per candidate, in the host step (dirty-checked). */
  _renderLocalJoinCandidates(candidates) {
    const wrap = document.getElementById('local-join-candidates');
    if (!wrap) return;
    const key = candidates.map(c => c.key + ':' + c.name).join('|');
    if (key === this._localCandidatesKey) return;
    this._localCandidatesKey = key;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    wrap.innerHTML = '';
    for (const c of candidates) {
      const b = document.createElement('uf-button');
      b.className = 'lobby-btn-p2-gp';
      b.setAttribute('data-key', c.key);
      b.innerHTML = `<span class="btn-local-join-main">JOIN AS PLAYER 2</span><span class="btn-local-join-padname">${esc(c.name)}</span><span class="btn-local-join-hint">CONNECTED · press any button on it, or click</span>`;
      b.addEventListener('click', () => this._onLocalJoinClick('gamepad', c.gpIndex ?? null, c.device || null, { slotId: c.slotId, name: c.name, phone: c.entry }));
      wrap.appendChild(b);
    }
    const detectedEl = document.getElementById('local-join-detected');
    if (detectedEl && candidates.length) detectedEl.style.display = '';
    const joinSection = document.getElementById('local-join-section');
    if (joinSection && candidates.length) joinSection.style.display = '';
  }

  /** Leave versus setup: release joined slots (not P1's) and clear state. */
  _leaveVersus() {
    if (this._room) this._room.close('left');
    this._stopVersusMonitor();
    for (const p of this._versusPlayers) {
      this._releasePhone(p.input);   // #562
      if (p.slotId === 'P1' || p.type !== 'gamepad' || !p.slotId) continue;
      // Return HID entries to the pool cleanly so re-entering the screen
      // (or co-op) can claim them again.
      this.controllerManager?.releaseSlotToPool(p.slotId);
    }
    if (this.controllerManager) this.controllerManager.autoClaimSuspended = false;
    this._versusPlayers = [];
    this._versusCandidates = [];
    this._versusLastCardsKey = null;
    this._pendingMode = null;
  }

  _startVersusMonitor() {
    if (isMobile) return;
    if (this._versusMonitorRAF !== null) return;

    // Keyboard team-switch: arrows move the keyboard-typed player (P1 when
    // P1 is on keyboard, else the keyboard joiner). Gamepad players use
    // their own d-pad/stick, polled in the tick below.
    this._versusKeyHandler = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const kbPlayer = this._versusPlayers.find(p => p.type === 'keyboard');
      if (!kbPlayer) return;
      // Same rule as the pad: a keyboard Player 1 walking the bottom bar
      // with the arrows isn't switching team (#581).
      if (kbPlayer.input === this.input && this._versusFocusInBar()) return;
      this._versusSwitchTeam(kbPlayer, e.key === 'ArrowLeft' ? 'A' : 'B');
    };
    window.addEventListener('keydown', this._versusKeyHandler);

    const tick = () => {
      if (this._currentStep !== this.versusStep) {
        this._versusMonitorRAF = null;
        return;
      }
      const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];

      // Refresh the WebHID device cache every 2s (hot-plug labeling).
      if (navigator.hid && performance.now() - this._hidCacheTime > 2000) {
        this._hidCacheTime = performance.now();
        navigator.hid.getDevices().then(devices => {
          this._cachedHIDDevices = devices;
        }).catch(() => {});
      }

      // Re-sync P1's live source. gamepadConnected-based: covers Gamepad
      // API pads, HID-claimed slots (gamepadIndex null!), and Steam Input.
      const p1 = this._versusPlayers[0];
      if (p1) {
        const d = this._versusP1Descriptor();
        if (p1.type !== d.type || p1.name !== d.name) {
          p1.type = d.type;
          p1.name = d.name;
        }
        p1.gpIndex = this.input ? this.input.gamepadIndex : null;
      }

      // 1) Detect joinable controllers from all sources (Gamepad API,
      //    HID pool/slots, Steam Input) and poll each for a join press.
      this._versusCandidates = this._detectVersusCandidates(pads);
      for (const c of this._versusCandidates) {
        const gp = c.pollGp;
        if (!gp || !gp.buttons) continue;
        const prev = this._versusPrevButtons.get(c.key) || { a: false, left: false, right: false };
        const a = !!(gp.buttons[0] && gp.buttons[0].pressed);
        if (a && !prev.a) {
          // _versusJoinCandidate enforces seats itself — including the
          // keyboard-P1 takeover when the roster is otherwise full.
          this._diag(`[versus] join press on ${c.name} (${c.kind}${c.gpIndex != null ? ', gp ' + c.gpIndex : ''}${c.device ? ', hid ' + (c.device.productName || 'device') : ''}${c.slotId ? ', slot ' + c.slotId : ''})`, 'versus-join-press');
          this._versusJoinCandidate(c);
        }
        prev.a = a;
        this._versusPrevButtons.set(c.key, prev);
      }

      // 2) Joined pad players: d-pad/stick left/right edge → pick team.
      //    getGamepadState() unifies the sources (real pad and HID synthetic
      //    both expose buttons 14/15 + axes[0]).
      //    Joiner InputManagers aren't in the game loop's poll set until
      //    the race starts, so poll them here.
      for (const p of this._versusPlayers) {
        if (!p.input || p.input === this.input || p.type === 'keyboard' || p.type === 'bot') continue;
        p.input.pollGamepad();
        p.input.consumeTaps();
      }
      for (const p of this._versusPlayers) {
        if (p.type !== 'gamepad' || !p.input) continue;
        const gp = p.input.getGamepadState();
        if (!gp || !gp.buttons) continue;
        const key = 'member:' + p.n;
        const prev = this._versusPrevButtons.get(key) || { a: false, b: true, left: false, right: false, y: true };
        const left = !!(gp.buttons[14] && gp.buttons[14].pressed) || (gp.axes[0] || 0) < -0.6;
        const right = !!(gp.buttons[15] && gp.buttons[15].pressed) || (gp.axes[0] || 0) > 0.6;
        const y = !!(gp.buttons[3] && gp.buttons[3].pressed);
        // #548 · the Dressing Room is open: every seated pad belongs to its card; keep the edge
        // state current so the press that closes it can't fire "leave seat" or a team switch.
        if (this._room) {
          const bi = p.input._gpSwapAB ? 0 : 1;
          this._versusPrevButtons.set(key, { a: !!(gp.buttons[0] && gp.buttons[0].pressed), b: !!(gp.buttons[bi] && gp.buttons[bi].pressed), left, right, y });
          continue;
        }
        if (y && !prev.y && p.slotId !== 'P1' && p.input !== this.input) {
          prev.y = y; prev.left = left; prev.right = right;
          this._versusPrevButtons.set(key, prev);
          this._openDressingRoom(p.n);
          continue;
        }
        prev.y = y;
        // B on a joined pad = leave your seat (back to CONNECTED). Not the host:
        // P1's B is "back" through the step's FocusController. `b` primes true
        // so a B held from before the join can't fire on the first frame.
        const bIdx = p.input._gpSwapAB ? 0 : 1;
        const b = !!(gp.buttons[bIdx] && gp.buttons[bIdx].pressed);
        // Player 1's pad also drives the step's focus (#581): while the
        // highlight sits on the bottom bar (Back / Help / Profile …), left and
        // right walk the pills — they don't move Player 1's team.
        if (!(p.input === this.input && this._versusFocusInBar())) {
          if (left && !prev.left) this._versusSwitchTeam(p, 'A');
          if (right && !prev.right) this._versusSwitchTeam(p, 'B');
        }
        if (b && !prev.b && p.input !== this.input && p.slotId !== 'P1') { prev.b = b; this._versusPrevButtons.set(key, prev); this._versusUnseat(p); continue; }
        prev.b = b;
        prev.left = left;
        prev.right = right;
        this._versusPrevButtons.set(key, prev);
      }

      // 3) Keyboard join button: visible only when no keyboard player yet.
      //    (One physical keyboard can't serve two players — same rule as co-op.)
      const kbBtn = document.getElementById('btn-versus-join-kb');
      if (kbBtn) {
        const hasKb = this._versusPlayers.some(p => p.type === 'keyboard');
        const show = !hasKb && this._versusPlayers.length < 4;
        const disp = show ? '' : 'none';
        if (kbBtn.style.display !== disp) kbBtn.style.display = disp;
      }

      // 4) Continue button + cards.
      const contBtn = document.getElementById('btn-versus-continue');
      if (contBtn) contBtn.disabled = !this._versusTeamsValid();
      this._renderVersusCards();

      this._versusMonitorRAF = requestAnimationFrame(tick);
    };
    this._versusMonitorRAF = requestAnimationFrame(tick);
  }

  /**
   * Enumerate joinable controllers, one candidate per physical pad:
   * - gamepad: unclaimed navigator.getGamepads() pads (Xbox/Switch/USB).
   * - hid: ControllerManager pool entries + claimed-but-unowned slots.
   *   This is the PRIMARY path in Electron: the PlayStation driver flips
   *   BT DualSenses to 0x31 full-report mode at boot, which removes them
   *   from the Gamepad API entirely — their synthetics are the only
   *   button source.
   */
  /** Stable id for a HIDDevice (distinguishes identical pads). */
  _deviceKeyId(device) {
    let id = this._versusDeviceIds.get(device);
    if (!id) {
      id = this._versusNextDeviceId++;
      this._versusDeviceIds.set(device, id);
    }
    return id;
  }

  _detectVersusCandidates(pads) {
    // Even with all four seats filled, a pad can still TAKE OVER a
    // keyboard-typed P1 seat (see _versusJoinCandidate), so keep
    // detecting while that escape hatch applies.
    const p1 = this._versusPlayers[0];
    const canConvertP1 = !!(p1 && p1.type === 'keyboard');
    if (this._versusPlayers.length >= 4 && !canConvertP1) return [];
    const owned = { devices: new Set(), indices: new Set(), slotIds: new Set() };
    for (const p of this._versusPlayers) {
      if (p.type !== 'gamepad' || !p.input) continue;
      const slot = p.input._slot;
      if (slot?.hidDevice) owned.devices.add(slot.hidDevice);
      if (slot) owned.slotIds.add(slot.id);
      if (p.input.gamepadIndex !== null) owned.indices.add(p.input.gamepadIndex);
    }
    return this._detectJoinCandidates(pads, owned);
  }

  /**
   * The CONNECTED controllers that could join: live Gamepad-API pads, pooled
   * WebHID devices that are streaming, claimed-but-unowned HID slots — minus
   * everything `owned` already seats. Shared by
   * the versus step (owners = its players) and the RIDE TOGETHER host step
   * (owner = Player 1). Each candidate carries `pollGp` for a join press.
   * @param {Gamepad[]} pads
   * @param {{ devices: Set<any>, indices: Set<number>, slotIds: Set<string> }} owned
   */
  _detectJoinCandidates(pads, owned) {
    const out = [];
    const mgr = this.controllerManager;
    // #562 · joined phones that aren't seated: controllers like any other.
    // The entry carries a standard-mapping synthetic, so the screens poll it
    // exactly as they poll a pad.
    for (const entry of this.phonePool ? this.phonePool.presentableEntries() : []) {
      out.push({ kind: 'phone', key: 'phone:' + entry.n, entry, name: entry.identity.name, pollGp: entry.synthetic });
    }
    const ownedDevices = owned.devices;
    const ownedIndices = owned.indices;
    const ownedSlotIds = owned.slotIds;
    // Gamepad API pads. A controller Steam has captured arrives here too, as
    // Steam's virtual XInput pad (emulation mode, docs/steam-input.md).
    const gpCands = [];
    for (const gp of pads) {
      if (!gp || ownedIndices.has(gp.index)) continue;
      if (isSteamTwinPad(gp)) continue;   // Steam's XInput twin of a WebHID Steam Controller (#362)
      gpCands.push({
        kind: 'gamepad',
        key: 'gp:' + gp.index,
        gpIndex: gp.index,
        gp,
        name: this._prettyGamepadName(gp.id),
        pollGp: gp,
      });
    }
    // A pad a slot already holds over WebHID is listed through that slot (or
    // not at all, when its owner is seated): drop its Gamepad twin (#581).
    out.push(...withoutHeldTwins(gpCands, mgr ? mgr.slots : []));

    if (mgr) {
      // Pool entries (unclaimed HID pads — synthetics live pre-claim).
      const now = performance.now();
      for (const entry of mgr._hidPool.values()) {
        if (ownedDevices.has(entry.device)) continue;
        // Only interfaces that are actively streaming input reports are
        // real, joinable controllers. Wireless dongles pool every HID
        // interface they expose — the Steam Controller Puck has FIVE, of
        // which exactly one emits STATE reports — and a single connected
        // controller was showing as three join cards. Silent interfaces
        // (and powered-off pads) never/no longer emit, so a freshness
        // window filters them; a sleeping pad's card appears the moment
        // a button press wakes it, which matches the join hint anyway.
        if (!entry.hidActiveSince || now - entry.hidActiveSince > 5000) continue;
        // Dual-interface pads: a visible unclaimed Gamepad API pad that
        // shares this device's productName is the SAME pad — one card. Its
        // Gamepad entry may be frozen (a DualSense switched on after launch:
        // Chromium listed it from its compat-mode reports, then the driver
        // flipped it to 0x31 and only the synthetic sees presses, #581), so
        // the card polls both sources; the join claims the pad and the
        // manager attaches this entry to the seat (claimPadForSlot).
        const hidName = (entry.device.productName || '').trim().toLowerCase();
        const twin = hidName ? out.find(c => c.kind === 'gamepad' && !c.device && c.gp.id.toLowerCase().includes(hidName)) : null;
        if (twin) {
          twin.device = entry.device;
          twin.name = prettyHidName(entry.device);
          twin.pollGp = mergedPollGp(twin.gp, entry.synthetic);
          continue;
        }
        out.push({
          kind: 'hid',
          key: 'hid:' + this._deviceKeyId(entry.device),
          device: entry.device,
          name: prettyHidName(entry.device),
          pollGp: entry.synthetic,
        });
      }
      // Claimed slots holding a device no member owns — a pad that
      // activity-claimed a slot while navigating menus BEFORE this screen
      // suspended auto-claim. Joining adopts that slot.
      for (const s of mgr.slots) {
        if (s.state !== 'claimed' || !s.hidDevice) continue;
        if (ownedSlotIds.has(s.id) || ownedDevices.has(s.hidDevice)) continue;
        out.push({
          kind: 'hid',
          key: 'hidslot:' + s.id,
          device: s.hidDevice,
          slotId: s.id,
          name: prettyHidName(s.hidDevice, s.controllerLabel),
          // Its adopted Gamepad entry too, when it has one: a press on either counts.
          pollGp: s.gamepadIndex != null ? mergedPollGp(pads[s.gamepadIndex], s.synthetic) : s.synthetic,
        });
      }
    }
    return out; // all live candidates — join-time logic enforces seats
  }

  /**
   * #581 · the game is releasing a slot (it held a Steam Controller's XInput
   * twin, or its Steam Controller was switched off): whoever the lobby seated on
   * it gets up. Player 1 stays bound to slot P1 and falls back to the keyboard
   * until a pad claims it again.
   */
  _dropSeat(slotId, why = 'released') {
    this._diag(`[seat] ${slotId} ${why}: released`, 'drop-seat:' + slotId);
    const im = this._localP2InputManager;
    if (im && im._slot && im._slot.id === slotId) this._leaveLocalP2('Steam XInput twin');
    const p = (this._versusPlayers || []).find((x) => x.slotId === slotId && x.input !== this.input);
    if (p) this._versusUnseat(p);
  }

  /** Is the step's highlight on the bottom bar (the Help / Profile / Quit pills)? */
  _versusFocusInBar() {
    const el = this._stepFocus && this._stepFocus.focusedEl;
    return !!(el && typeof el.closest === 'function' && el.closest('#lobby-bar'));
  }

  _stopVersusMonitor() {
    if (this._versusMonitorRAF !== null) {
      cancelAnimationFrame(this._versusMonitorRAF);
      this._versusMonitorRAF = null;
    }
    if (this._versusKeyHandler) {
      window.removeEventListener('keydown', this._versusKeyHandler);
      this._versusKeyHandler = null;
    }
    this._versusPrevButtons.clear();
  }

  /**
   * Join a detected candidate as the next player. Handles all three
   * sources: Gamepad API pads (explicit slot claim), WebHID devices
   * (explicit HID claim or adopting the slot a pre-screen activity-claim
   * landed on), and Steam Input controllers (handle-bound InputManager,
   * no slot involved).
   */
  _versusJoinCandidate(c) {
    const mgr = this.controllerManager;
    const p1 = this._versusPlayers[0];
    const seatsLeft = this._versusPlayers.length < 4;
    // Escape hatch: a keyboard-typed P1 is a placeholder seat. When no
    // regular seat/slot is available, a joining pad TAKES OVER P1 —
    // P1's InputManager is permanently bound to slot P1, so claiming the
    // pad there makes it Player 1's controller directly. This is how
    // "keyboard + 4 pads" resolves to a full 4-pad roster.
    const canConvertP1 = !!(p1 && p1.type === 'keyboard' && mgr);
    if (!seatsLeft && !canConvertP1) {
      this._diag(`[versus] join ignored (roster full): ${c.name}`);
      return;
    }

    const convertP1 = (claimFn) => {
      const slotP1 = mgr.getSlot('P1');
      if (!slotP1) return false;
      // Pad may sit on another slot from a pre-screen activity claim —
      // move it home to P1.
      if (c.slotId && c.slotId !== 'P1') mgr.releaseSlotToPool(c.slotId);
      if (slotP1.state !== 'empty') return false;
      if (!claimFn()) return false;
      p1.type = 'gamepad';
      p1.name = c.name;
      p1.gpIndex = this.input.gamepadIndex;
      if (c.kind === 'hid') {
        this.input.motionEnabled = true;
        this.input.startTiltCalibration();
      }
      this._diag(`[versus] keyboard P1 seat taken over by ${c.name}`);
      analytics.trackEvent('versus_player_joined', { source: c.kind, players: this._versusPlayers.length, p1_takeover: true });
      return true;
    };

    // #458 item 2: an empty P1 (keyboard placeholder) is the first seat a pad
    // fills, not the last one.
    const seat = versusJoinSeat(this._versusPlayers, {
      p1SlotEmpty: !!(mgr && mgr.getSlot('P1') && mgr.getSlot('P1').state === 'empty'),
      kind: c.kind,
    });
    if (seat.takeP1 && canConvertP1) {
      const took = c.kind === 'hid'
        ? convertP1(() => mgr.claimHidDeviceForSlot('P1', c.device))
        : (c.gp ? convertP1(() => mgr.claimPadForSlot('P1', c.gp)) : false);
      if (took) return;
    }

    const usedSlots = new Set(this._versusPlayers.map(p => p.slotId).filter(Boolean));
    usedSlots.add('P1'); // regular joiners never take P1's slot (see convertP1)
    let input = null;
    let slotId = null;
    let gpIndex = null;

    if (c.kind === 'phone') {
      // #562 · a phone brings its own InputManager; no slot. It never takes
      // over a keyboard Player 1 (that seat is bound to slot P1).
      if (!seatsLeft) { this._diag(`[versus] join ignored (roster full): ${c.name}`); return; }
      input = c.entry.attach();
    } else if (c.kind === 'hid') {
      let slot = null;
      if (seatsLeft) {
        if (c.slotId && !usedSlots.has(c.slotId)) {
          // Adopt the slot ingestFrame claimed before this screen opened
          // (still claimed: a failed P1 takeover releases it).
          slot = mgr?.getSlot(c.slotId) || null;
          if (slot && slot.state !== 'claimed') slot = null;
        }
        if (!slot && mgr) {
          for (const id of ['P2', 'P3', 'P4']) {
            if (usedSlots.has(id)) continue;
            slot = mgr.claimHidDeviceForSlot(id, c.device);
            if (slot) break;
          }
        }
      }
      if (!slot) {
        if (canConvertP1 && convertP1(() => mgr.claimHidDeviceForSlot('P1', c.device))) return;
        this._diag(`[versus] join ignored (no free slot): ${c.name}`);
        return;
      }
      slotId = slot.id;
      input = new InputManager({
        slot,
        enableKeyboard: false,
        enableMotion: false,
        enableTouch: false,
      });
      // HID pads carry gyro (that's why they're in 0x31 mode) — arm it.
      input.motionEnabled = true;
      input.startTiltCalibration();
    } else { // 'gamepad'
      if (seatsLeft) {
        for (const s of mgr?.slots || []) {
          if (s.gamepadIndex === c.gpIndex && !usedSlots.has(s.id)) { slotId = s.id; break; }
        }
        if (!slotId && mgr) {
          for (const id of ['P2', 'P3', 'P4']) {
            if (usedSlots.has(id)) continue;
            if (mgr.claimPadForSlot(id, c.gp)) { slotId = id; break; }
          }
        }
      }
      if (!slotId) {
        if (canConvertP1 && convertP1(() => mgr.claimPadForSlot('P1', c.gp))) return;
        this._diag(`[versus] join ignored (no free slot): ${c.name}`);
        return;
      }
      gpIndex = c.gpIndex;
      const gpSlot = mgr.getSlot(slotId);
      input = new InputManager({
        slot: gpSlot,
        enableKeyboard: false,
        enableMotion: false,
        enableTouch: false,
      });
      // The pad's WebHID entry rode along (claimPadForSlot attached it): it
      // carries the gyro, so arm it as a HID join would (#581).
      if (gpSlot && gpSlot._hidEntry) {
        input.motionEnabled = true;
        input.startTiltCalibration();
      } else if (this.motionActive) input.motionEnabled = true;
    }

    input.suppressGamepadLean = !this.joystickActive;

    const sizeA = this._versusPlayers.filter(p => p.team === 'A').length;
    const sizeB = this._versusPlayers.filter(p => p.team === 'B').length;
    const n = seat.n ?? this._versusPlayers.length + 1;
    this._versusPlayers.push({
      n,
      type: 'gamepad',
      gpIndex,
      slotId,
      name: c.name,
      team: sizeB < sizeA ? 'B' : 'A',
      input,
    });
    this._versusPlayers.sort((a, b) => a.n - b.n);
    if (c.kind === 'phone') c.entry.host.setLabel('Player ' + n);
    this._diag(`[versus] ${c.name} joined as player ${n} (${c.kind}${slotId ? ', slot ' + slotId : ''})`);
    analytics.trackEvent('versus_player_joined', {
      source: c.kind,
      players: this._versusPlayers.length,
    });
  }

  /** Join the (single) keyboard player. */
  _versusJoinKeyboard() {
    if (this._versusPlayers.length >= 4) return;
    if (this._versusPlayers.some(p => p.type === 'keyboard')) return;
    const input = new InputManager({
      enableKeyboard: true,
      enableMotion: false,
      enableTouch: false,
    });
    const sizeA = this._versusPlayers.filter(p => p.team === 'A').length;
    const sizeB = this._versusPlayers.filter(p => p.team === 'B').length;
    this._versusPlayers.push({
      n: lowestFreePlayerNumber(this._versusPlayers) ?? this._versusPlayers.length + 1,
      type: 'keyboard',
      gpIndex: null,
      slotId: null,
      name: 'KEYBOARD',
      team: sizeB < sizeA ? 'B' : 'A',
      input,
    });
    this._versusPlayers.sort((a, b) => a.n - b.n);
    analytics.trackEvent('versus_player_joined', {
      source: 'keyboard',
      players: this._versusPlayers.length,
    });
  }

  /** Move a player to `team` if that side has room. */
  _versusSwitchTeam(player, team) {
    if (player.team === team) return;
    const size = this._versusPlayers.filter(p => p.team === team).length;
    if (size >= 2) return;
    player.team = team;
  }

  _versusTeamsValid() {
    const a = this._versusPlayers.filter(p => p.team === 'A').length;
    const b = this._versusPlayers.filter(p => p.team === 'B').length;
    return a >= 1 && a <= 2 && b >= 1 && b <= 2;
  }

  /** Teams payload for onVersusReady: two entries, A then B. */
  _versusTeams() {
    const member = (p) => ({
      n: p.n,   // #548: the player number keys their look (js/player-look.js)
      input: p.input,
      type: p.type,
      slotId: p.slotId,
      name: p.name,
      // The seat card's own name ("Steam Controller"), for messages in sentences.
      label: (() => { try { return this._versusIdentity(p).shortName || null; } catch { return null; } })(),
      isP1: p.slotId === 'P1',
    });
    return [
      { id: 'A', members: this._versusPlayers.filter(p => p.team === 'A').map(member) },
      { id: 'B', members: this._versusPlayers.filter(p => p.team === 'B').map(member) },
    ];
  }

  /**
   * Re-render the versus seats when membership/teams/candidates change
   * (dirty-checked). #428: two kit <uf-team>s of <uf-seat>s — seated players,
   * then joinable controllers offered for the open seats ("press ✕ to join",
   * clickable; their own A press also joins via the monitor's edge poll),
   * then open seats — and a <uf-controller-roster> strip under them listing
   * EVERY controller the step can see (a fifth one used to appear nowhere).
   */
  _renderVersusCards() {
    const candidates = this._versusCandidates || [];
    const key = this._versusPlayers.map(p => `${p.n}:${p.team}:${p.name}:${p.slotId || ''}:${p.type === 'bot' ? '' : this._personKey(p.n)}`).join('|')
      + '§' + candidates.map(c => `${c.key}:${c.name}`).join('|');
    if (key === this._versusLastCardsKey) return;
    this._versusLastCardsKey = key;
    // tandemonium-diag.log: what the screen offers (the TV has no console).
    this._diag('[versus] seats: ' + (this._versusPlayers.map(p => `P${p.n}=${p.name}(${p.type}${p.slotId ? ',' + p.slotId : ''})`).join(' ') || '-')
      + ' | joinable: ' + (candidates.map(c => `${c.name}(${c.kind}${c.gpIndex != null ? ',gp' + c.gpIndex : ''}${c.device ? ',hid:' + (c.device.productName || '?') : ''}${c.slotId ? ',' + c.slotId : ''})`).join(' ') || '-'), 'versus-seats');

    // Offer joinable controllers to the emptier team first (mirrors the team
    // auto-assignment a join will actually make).
    const roomIn = (team) => 2 - this._versusPlayers.filter(p => p.team === team).length;
    const joinFor = { A: [], B: [] };
    let roomA = roomIn('A'), roomB = roomIn('B');
    for (const c of candidates) {
      const sizeA = this._versusPlayers.filter(p => p.team === 'A').length + joinFor.A.length;
      const sizeB = this._versusPlayers.filter(p => p.team === 'B').length + joinFor.B.length;
      if (roomB > 0 && (sizeB < sizeA || roomA <= 0)) { joinFor.B.push(c); roomB--; }
      else if (roomA > 0) { joinFor.A.push(c); roomA--; }
    }

    const glyph = (id) => `<uf-controller-glyph size="sm" button="confirm" family="${id.glyphFamily}"${id.swapAB ? ' swap' : ''}></uf-controller-glyph>`;
    for (const team of ['A', 'B']) {
      const box = document.getElementById(`versus-team-${team.toLowerCase()}`);
      if (!box) continue;
      const tone = team === 'A' ? 'team-a' : 'team-b';
      const seats = [];
      for (const p of this._versusPlayers.filter(pl => pl.team === team)) {
        const id = this._versusIdentity(p);
        const seat = document.createElement('uf-seat');
        Object.assign(seat, { seat: `Player ${p.n}`, tone, state: 'joined', badge: `P${p.n}` }, p.type === 'bot' ? { who: id.shortName } : this._seatWho(p.n, id.shortName));
        seats.push(seat);
      }
      for (const c of joinFor[team]) {
        const id = this._versusIdentity(c);
        const seat = document.createElement('uf-seat');
        Object.assign(seat, { seat: team === 'A' ? 'Join team blue' : 'Join team red', tone, who: id.shortName, state: 'candidate', hint: `press ${glyph(id)} to join` });
        seat.addEventListener('click', () => this._versusJoinCandidate(c));
        seats.push(seat);
      }
      while (seats.length < 2) {
        const seat = document.createElement('uf-seat');
        Object.assign(seat, { seat: 'Open seat', tone, who: 'Open', state: 'open', hint: 'press <uf-controller-glyph size="sm" button="confirm"></uf-controller-glyph> on any controller' });
        seats.push(seat);
      }
      box.querySelectorAll(':scope > uf-seat').forEach((el) => el.remove());
      box.append(...seats);
    }
    this._renderVersusControllers(candidates);
    this._renderWardrobeButtons('versus-wardrobe', this._versusPlayers.filter((p) => p.type !== 'bot'), this.versusStep);
  }

  /**
   * What to call a versus player or candidate, and which prompts to draw for
   * it — core's identity (shortName, glyphFamily, swapAB), from whatever the
   * versus detection knows about it: a manager slot, a Gamepad-API pad, a
   * WebHID device, or the keyboard.
   */
  /** #562 · a seat gave its phone back: it is a free controller again. */
  _releasePhone(input) {
    const e = this.phonePool && input && input.remoteOnly ? this.phonePool.entryForInput(input) : null;
    if (e) e.release();
  }

  _versusIdentity(x) {
    if (x.type === 'keyboard') return KEYBOARD_IDENTITY;
    // #562 · a phone (a candidate, or a seat riding with one): generic prompts.
    const phone = x.kind === 'phone' ? x.entry : (x.input && x.input.remoteOnly && this.phonePool ? this.phonePool.entryForInput(x.input) : null);
    if (phone) return identityOf(null, phone.identity.name);
    if (x.type === 'bot') return identityOf(null, 'Bot');
    if (x.kind === 'gamepad' && x.gp) return identifyGamepadId(x.gp.id);
    if (x.kind === 'hid' && x.device) return hidDeviceIdentity(x.device) || identifyHidDevice(x.device);
    if (x.slotId === 'P1' && x.input === this.input) {
      const p1 = this._p1Identity();
      if (p1 && (p1.entry || p1.glyphFamily !== 'generic')) return p1;
    }
    const mgr = this.controllerManager;
    if (x.slotId && mgr && mgr.slotIdentity) {
      const slot = mgr.getSlot ? mgr.getSlot(x.slotId) : null;
      const id = slot ? slotIdentityHidFirst(slot, (s) => mgr.slotIdentity(s)) : mgr.slotIdentity(x.slotId);
      if (id.entry || id.glyphFamily !== 'generic') return id;
    }
    const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
    const pad = x.gpIndex != null ? pads[x.gpIndex] : null;
    if (pad) return identifyGamepadId(pad.id);
    return identityOf(null, x.name ? x.name.charAt(0) + x.name.slice(1).toLowerCase() : 'Controller');
  }

  /**
   * The versus controller strip: every controller this step can see — seated
   * players (badge P1–P4 in team colour) and every joinable controller
   * ("press ✕ to join", or "seats full" once four are seated). Rows use the
   * shape core's controllerRoster() returns, built from versus's own
   * detection.
   */
  _renderVersusControllers(candidates) {
    const strip = document.getElementById('versus-roster');
    if (!strip) return;
    const connection = (x) => (x.type === 'keyboard' ? 'keyboard'
      : (x.kind === 'hid' || (x.input && x.input._slot && x.input._slot._hidEntry)) ? 'webhid' : 'gamepad');
    const rows = [];
    for (const p of this._versusPlayers) {
      const id = this._versusIdentity(p);
      rows.push({
        key: 'p' + p.n, name: id.name, shortName: id.shortName, glyphFamily: id.glyphFamily, swapAB: id.swapAB,
        state: 'seated', player: p.n, connection: connection(p), person: p.type === 'bot' ? null : this.seatPerson(p.n),
        seat: { team: p.team === 'A' ? 'a' : 'b', role: 'player', label: `P${p.n}`, tone: p.team === 'A' ? 'team-a' : 'team-b' },
      });
    }
    for (const c of candidates) {
      const id = this._versusIdentity(c);
      rows.push({ key: c.key, name: id.name, shortName: id.shortName, glyphFamily: id.glyphFamily, swapAB: id.swapAB, state: 'connected', player: null, seat: null, connection: connection(c) });
    }
    strip.rows = rows;
  }

  _removePipLobbyMode() {
    const selfieWrap = document.getElementById('selfie-pip-wrap');
    const partnerWrap = document.getElementById('partner-pip-wrap');
    // Remove lobby/level classes and set inline display:block to prevent
    // base CSS display:none from flashing the PiPs invisible before
    // game-recorder shows them. Room media off (#400 D7): the in-ride
    // selfie/partner PiP frames stay hidden.
    const pipDisplay = this._mediaEnabled ? 'block' : 'none';
    if (selfieWrap) {
      selfieWrap.classList.remove('pip-lobby-mode', 'pip-level-mode');
      selfieWrap.style.display = pipDisplay;
    }
    if (partnerWrap) {
      partnerWrap.classList.remove('pip-lobby-mode', 'pip-level-mode');
      partnerWrap.style.display = pipDisplay;
    }
  }

  showRoom(net, role) {
    // Called by game.js _returnToRoom() after a ride together: back to level select
    this.net = net;
    this._roomRole = role;
    this._pendingMode = 'multiplayer';

    this.lobbyEl.style.display = '';
    if (this._previewModel) this._startPreviewLoop();

    // Set role labels on PiP circles
    const selfieLabel = document.getElementById('selfie-pip-label');
    const partnerLabel = document.getElementById('partner-pip-label');
    if (selfieLabel) selfieLabel.textContent = role === 'captain' ? 'CAPTAIN' : 'STOKER';
    if (partnerLabel) partnerLabel.textContent = role === 'captain' ? 'STOKER' : 'CAPTAIN';
    this._syncRoomSeats(role);

    // After a ride together both land on level select (Pete, 2026-10-23): the
    // captain picks the next level, the stoker waits. The captain also sends
    // PLAY_GAME so a stoker on an older build leaves its room step.
    this._showRoomLevelsStep();
    if (role === 'captain' && this.net && this.net.connected) {
      this.net.sendProfile(RoomProtocol.playGame());
      this.net.sendProfile(RoomProtocol.difficultySync(this.selectedDifficulty));
    }

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
      this.net.sendProfile(RoomProtocol.bikeSync(this.selectedPresetKey));
      this._sendRoomProfile();
      const user = this.auth && this.auth.isLoggedIn() && this.auth.getUser();
      this.net.sendProfile(RoomProtocol.cameraToggle(this.cameraActive, user && user.avatar));
    }

    // Re-register disconnect handler for room
    const roomNet = this.net;
    this.net.onDisconnected = (reason) => {
      if (this.net !== roomNet) return;   // a newer room already replaced this one
      const waitText = document.getElementById('level-wait-text');
      const hostStatus = document.getElementById('host-status');
      // This device lost its seat (the room was opened somewhere else): say that, not "partner".
      const why = roomNet._evicted ? (reason || 'This room was opened somewhere else')
        : reason === PARTNER_LEFT_REASON ? reason : 'Partner disconnected';
      if (waitText) { waitText.textContent = why; waitText.style.display = ''; }
      if (hostStatus) { hostStatus.textContent = why; hostStatus.className = 'conn-status error'; }
      document.getElementById('btn-start-ride').style.display = 'none';
      this._setRoomSeat('partner', { who: 'LEFT', dev: 'disconnected', state: 'open' });
      setTimeout(() => {
        // Only this room's transport, and only if the lobby is still on it (not a fresh room).
        try { roomNet.destroy(); } catch (e) { /* already gone */ }
        if (this.net !== roomNet) return;
        this.net = null;
        this._removePipLobbyMode();
        this._showStep(this.roleStep);
      }, 2000);
    };

    // Back from a ride whose transport already gave up or lost its seat: its onDisconnected
    // has fired (into the game) and will not fire again, so this room would sit on
    // "Reconnecting…" for good. Lost the seat: say so and leave. Gave up: try once more —
    // a fresh reconnect cycle that ends in this handler if it fails again.
    if (!roomNet.connected) {
      if (roomNet._evicted) roomNet.onDisconnected(`This room was opened somewhere else`);
      else if (roomNet._gaveUp) roomNet.retryConnection();
    }

    // Refresh carousel visual on re-entry
    this._applyPresetToPreview();
  }

  // ── Gamepad code spinners ─────────────────────────────────────

  _showSpinners(show) {
    const spinnerWrap = document.getElementById('gamepad-code-spinners');
    const inputWrap = document.querySelector('.room-code-join-wrap');
    if (!spinnerWrap || !inputWrap) return;
    // Desktop/TV (#428): the kit keypad replaces the spinners. The step's
    // spatial focus drives its keys (_applyStepSpatialFocus); Done joins.
    const tvJoin = document.getElementById('join-tv');
    if (tvJoin && this._tvQuery && this._tvQuery.matches) {
      this._spinnerActive = false;
      spinnerWrap.style.display = 'none';
      inputWrap.style.display = show ? 'none' : '';
      tvJoin.classList.toggle('on', show);
      const joinBtn = document.getElementById('btn-join');
      if (joinBtn) joinBtn.style.display = show ? 'none' : '';
      if (show) {
        const code = /** @type {any} */ (document.getElementById('join-code-tv'));
        if (code) code.clear();
        this._applyStepSpatialFocus(this.joinStep);
      }
      return;
    }
    if (tvJoin) tvJoin.classList.remove('on');
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
        const isPS = info && info.protocol === 'dualsense';
        const isXbox = info && info.protocol === 'xbox';
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
      const gp = this.input.getGamepadState();
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
    // Set up the spatial step focus for the current step on (re)start — initial
    // load and show() set _currentStep directly without going through
    // _showStep, so the highlight + d-pad/stick nav need seeding here too (#318).
    this._applyStepSpatialFocus(this._currentStep);
    // Singleton RAF loop: _startGamepadNav runs again on every re-entry from
    // gameplay (show()), so cancel any prior loop first. Otherwise the loops
    // accumulate and each frame polls the pad N times, double-firing confirms
    // (e.g. opening the profile popup AND advancing the step in one press). (#332)
    if (this._pollRafId) cancelAnimationFrame(this._pollRafId);
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
      const isPS = info && info.protocol === 'dualsense';
      const isXbox = info && info.protocol === 'xbox';
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
    if ((step === this.hostStep || (step === this.levelStep && this._pendingMode === 'multiplayer')) && code && code !== '----') {
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
   * RAF-based gamepad polling loop. Handles the modal branches (profile/
   * leaderboard/help/rejoin/spinner) and LB/RB bike-color bumpers inline, then
   * delegates step navigation to the spatial FocusController (_stepFocus.poll()
   * — up/down/left/right move to the nearest on-screen focusable, A confirms,
   * B backs out). (#318)
   */
  _pollGamepadNav() {
    // Bar label / glyph family / an open Controls sheet: a few times a second is plenty.
    const nowSync = performance.now();
    if (!this._lastBarSync || nowSync - this._lastBarSync > (this._controlsSheet && this._controlsSheet.open ? 200 : 1000)) {
      this._lastBarSync = nowSync;
      this._syncSystemBar();
      // #576: a gyro that shows up late (Steam Input, a later HID grant) still turns the stick default off.
      if (this.joystickActive && this.input && this.input.gyroConnected) this._joystickOffForGyro();
    }
    this._pollRafId = requestAnimationFrame(() => this._pollGamepadNav());
    this._syncLevelRoomBar();

    // Whether the step-nav section ran last frame. Reset each frame; set true
    // only when we reach it, so a modal frame (early return) flips it false and
    // the next step frame re-primes the spatial controller's edges (#318).
    const ranLast = this._stepNavRanLastFrame;
    this._stepNavRanLastFrame = false;

    // #548 · the Dressing Room is open: it polls every seated pad itself (P1's included),
    // so this runs before the P1 gate below. Step nav re-primes when it returns.
    if (this._room) { this._room.poll(); return; }
    // A seated local Player 2's △ / Y opens theirs (polled here, every frame, whether or not
    // Player 1 is on a pad: the host join monitor does not tick on after the seat fills).
    if (this._currentStep === this.hostStep) this._pollSeatedP2Wardrobe();

    if (!this.input || !this.input.gamepadConnected) return;

    // ...or while the phone QR panel is on top (it takes B / Start itself);
    // the next frame here re-primes, so the closing press isn't reused.
    if (document.querySelector('.phone-qr-panel.open')) return;

    // Don't process lobby navigation while options overlay is open
    const optOverlay = document.getElementById('options-overlay');
    if (optOverlay && optOverlay.classList.contains('visible')) return;

    // Auto-switch to spinners on join step when gamepad is active and join failed
    if (this._currentStep === this.joinStep && !this._spinnerActive && this._lastFailedCode) {
      this._setSpinnerValuesFromCode(this._lastFailedCode);
      this._spinnerReshow = true;
      this._showSpinners(true);
    }

    const gp = this.input.getGamepadState();
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

    // #548 · △ / Y on the seat screens: Player 1 opens the Dressing Room (their card in Edit).
    const y = !!(gp.buttons[3] && gp.buttons[3].pressed);
    if (y && !this._gpPrevY && !this._activeModal && (this._currentStep === this.hostStep || this._currentStep === this.versusStep)) {
      this._gpPrevY = y;
      this._openDressingRoom(1);
      return;
    }
    this._gpPrevY = y;

    // LB/RB bumpers (buttons 4/5) — cycle bike color; over the Achievements
    // sheet they jump a section instead (and leave the bike alone).
    const lb = gp.buttons[4] && gp.buttons[4].pressed;
    const rb = gp.buttons[5] && gp.buttons[5].pressed;
    if (this._achievementsSheet && this._achievementsSheet.open) {
      if (!this._achievementDetailOpen() && this._activeModal === 'achievements') {
        if (lb && !this._gpPrevLB) this._achJumpSection(-1);
        if (rb && !this._gpPrevRB) this._achJumpSection(1);
      }
    } else if (lb && !this._gpPrevLB && this._bikePrev) {
      this._bikePrev();
      this._flashBumper(document.getElementById('bike-prev'));
    }
    if (rb && !this._gpPrevRB && this._bikeNext && !(this._achievementsSheet && this._achievementsSheet.open)) {
      this._bikeNext();
      this._flashBumper(document.getElementById('bike-next'));
    }
    this._gpPrevLB = lb;
    this._gpPrevRB = rb;

    // If profile popup is open, navigate between logout and back (skip the
    // logout button when it's hidden — Electron/Steam — so gamepad focus can't
    // land on or confirm an invisible control). (#332)
    if (this.profilePopup.classList.contains('visible')) {
      const items = this._profileItems();
      if (this._activeModal !== 'profile') {
        this._activeModal = 'profile';
        this._modalBack = () => { this._profileDiag('closed by B'); this.profilePopup.classList.remove('visible'); };
        this._modalFocus.setItems(items);
        this._profileDiag('pad list: ' + items.map((el) => el.id).join(', '));
      }
      // Steam playtest (2026-11-07): RETURN TO LOBBY "did nothing" on the TV.
      // Log what the pad sends while the popup is open, to the diag file.
      if ((a && !this._profPrevA) || (b && !this._profPrevB)) {
        const f = items.find((el) => el.classList.contains('gamepad-focus'));
        this._profileDiag((a ? 'A' : 'B') + ' down · focus ' + (f ? f.id : 'none') + ' · pad ' + (gp.id || '?'));
      }
      this._profPrevA = a; this._profPrevB = b;
      this._modalFocus.poll();
      return;
    }
    // #517 · the Music pill's volume picker (High / Med / Low / Mute): the pad
    // moves along it and A picks (which closes it); B closes it. Focus goes
    // back to the Music pill either way.
    if (this._volumePicker && this._volumePicker.classList.contains('visible')) {
      if (this._activeModal !== 'volume') {
        this._activeModal = 'volume';
        this._modalBack = () => this._hideVolumePicker();
        const btns = Array.from(this._volBtns || []);
        this._modalFocus.setSpatial(btns, btns.find((b) => b.classList.contains('active')) || btns[0]);
      }
      this._modalFocus.poll();
      return;
    }

    // #540: an achievement's detail card over the leaderboard — only its Close
    // to focus; B closes it and the grid gets the pad back (uf-sheet:close).
    if (this._achievementDetailOpen()) {
      if (this._activeModal !== 'achievement') {
        this._activeModal = 'achievement';
        this._modalBack = () => this._closeAchievementDetail();
        const close = this._achDetailSheet.querySelector('.uf-sheet__close');
        this._modalFocus.setSpatial([close].filter(Boolean), close);
      }
      this._modalFocus.poll();
      return;
    }
    // #540: the Achievements sheet — the badges and Close form the spatial
    // set; the right stick scrolls, d-pad past the last row scrolls (onEdge).
    if (this._achievementsSheet && this._achievementsSheet.open) {
      scrollWithStick(this._achievementsSheet.body, gp.axes[3]);
      // #576: no card open and no badge lifting, so nothing should dim the grid.
      if (!this._achLifting && this._achievementsSheet.body.classList.contains('ach-dim')) this._clearAchievementDim();
      if (this._activeModal !== 'achievements') this._achResetFocus();
      else this._modalFocus.refreshSpatial(this._achFocusables());
      this._modalFocus.poll();
      return;
    }
    // Leaderboard (#517: a kit sheet, like Help)
    if (this._leaderboardSheet && this._leaderboardSheet.open) {
      // Right stick (axis 3) scrolls the sheet (focus nav is over the tabs and
      // Close); d-pad up / down past the last row scrolls too (onEdge).
      scrollWithStick(this._leaderboardSheet.body, gp.axes[3]);
      // Tabs (main + sub) + close form a small spatial grid (#318). Sub-tabs
      // rebuild on main-tab change, so refresh the set each frame; B closes.
      if (this._activeModal !== 'leaderboard') {
        this._activeModal = 'leaderboard';
        this._modalBack = () => this._closeLeaderboard();
        this._modalFocus.setSpatial(this._lbFocusables(), document.querySelector('#lb-main-tabs .lb-tab.active'));
      } else {
        this._modalFocus.refreshSpatial(this._lbFocusables());
      }
      this._modalFocus.poll();
      return;
    }
    if (this.helpModal.open) {
      // Right stick Y scrolls the help content (the kit sheet's body scrolls);
      // #517: so do d-pad / left stick up and down — Help has nothing to focus.
      scrollWithStick(this.helpModal.body, gp.axes[3]);
      if (up && !this._gpPrevUp) scrollPage(this.helpModal.body, 'up');
      if (down && !this._gpPrevDown) scrollPage(this.helpModal.body, 'down');
      // B closes (#459: as does the sheet's own Esc / scrim / Close); View again too.
      const viewNow = !!(gp.buttons[8] && gp.buttons[8].pressed);
      if ((b && !this._gpPrevB) || (viewNow && !this._gpPrevView)) {
        this._closeHelp();
      }
      this._gpPrevView = viewNow;
      this._gpPrevUp = up; this._gpPrevDown = down;
      this._gpPrevLeft = left; this._gpPrevRight = right;
      this._gpPrevA = a; this._gpPrevB = b;
      return;
    }

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

    // Reaching here means no modal is open — release a linear modal controller
    // (profile/rejoin) if one was active, clearing its highlight.
    if (this._activeModal) { this._modalFocus.clear(); this._activeModal = null; this._modalBack = null; }

    // #459 item 18 · the pad's View / Share / Create button (buttons[8]) opens
    // Help on every step, the same glyph the Help pill and the pause menu show.
    const view = !!(gp.buttons[8] && gp.buttons[8].pressed);
    if (view && !this._gpPrevView) { this._gpPrevView = view; this._openHelp(); return; }
    this._gpPrevView = view;

    // Step navigation: delegated to the spatial FocusController (#318).
    // Lazily seed the scope the first time we run with a gamepad — covers
    // controllers that connect async without a 'gamepadconnected' event (e.g.
    // a WebHID DualSense), which otherwise left the mode screen un-navigable
    // until the first _showStep.
    if (this._stepFocus.items.length === 0) this._applyStepSpatialFocus(this._currentStep);
    // Re-prime edges when returning from a modal (ranLast captured at the top
    // of this poll) so a held button across the transition isn't read as a
    // fresh press.
    if (!ranLast) this._stepFocus.reprime();
    this._stepNavRanLastFrame = true;
    this._stepFocus.poll();

    // _gpPrev* are still maintained for the LB/RB bumpers + the modal branches.
    this._gpPrevUp = up;
    this._gpPrevDown = down;
    this._gpPrevLeft = left;
    this._gpPrevRight = right;
    this._gpPrevA = a;
    this._gpPrevB = b;
  }

  _goBack() {
    const backBtn = this._stepBack.get(this._currentStep);
    if (backBtn) backBtn.click();
  }

  _clearFocusHighlight() {
    const prev = this.lobbyEl.querySelector('.gamepad-focus');
    if (prev) prev.classList.remove('gamepad-focus');
  }

  /**
   * Every step focusable, center column first and the help / leaderboard /
   * profile column last. Spatial nav moves by geometry, so the order only
   * decides the fallback when the wanted element isn't visible: it is never
   * Help (#458 item 10).
   */
  _stepNavItems() {
    const [left = [], center = [], ...rest] = this._modeColumns;
    return [...center, ...rest.flat(), ...left];
  }

  /**
   * Where a step's focus starts: its primary action (#458 item 10). Versus
   * starts on CHOOSE LEVEL even while it waits for a second team (joiners
   * press on their own pads; P1's confirm used to open Help). Otherwise the
   * step's registered default when it is visible and enabled, else the first
   * visible, enabled center item. The host step's CHOOSE LEVEL buttons come
   * and go through _refreshHostNext.
   */
  _stepPrimaryFocus(step, centerItems) {
    const shown = (el) => !!el && el.getBoundingClientRect().width > 0;
    const usable = (el) => shown(el) && !el.disabled && !el.hasAttribute('disabled');
    if (step === this.versusStep) {
      const cont = document.getElementById('btn-versus-continue');
      if (shown(cont)) return cont;
    }
    const preferred = centerItems[this._stepDefaultFocus.get(step) || 0] || null;
    if (usable(preferred)) return preferred;
    return centerItems.find(usable) || preferred;
  }

  /**
   * Hand the current step's full focusable set (all toggle columns + the
   * active step's center items) to the spatial FocusController, focusing the
   * step's primary action. Only highlights when a gamepad is connected
   * (matching the old _applyFocusHighlight gate). Called from _showStep and on
   * gamepad hot-connect. (#318)
   */
  _applyStepSpatialFocus(step) {
    if (!step) return;
    if (this.input && this.input.gamepadConnected) {
      // Desktop join step: the keypad's keys + Delete / Join are the scope.
      const tvJoin = step === this.joinStep && document.getElementById('join-tv');
      const keypad = tvJoin && tvJoin.classList.contains('on') ? /** @type {any} */ (document.getElementById('join-keypad-tv')) : null;
      let centerItems = (keypad && keypad.focusables()) || this._stepCenterItems.get(step) || [];
      // #547: JOIN A RIDE's Rejoin cards come first, and focus starts on the newest.
      if (step === this.joinStep) centerItems = [...this._rejoinCards(), ...centerItems];
      this._modeColumns[1] = centerItems;
      const defaultEl = this._stepPrimaryFocus(step, centerItems);
      this._stepFocus.setSpatial(this._stepNavItems(), defaultEl);
    } else {
      this._stepFocus.clear();
    }
  }

  // ============================================================
  // DRESSING ROOM (#548) — every seated player dresses their goose at once
  // ============================================================
  //
  // Opened from a WARDROBE button under the seats (mouse / P1's pad) or △ / Y on any seated pad.
  // The room (js/dressing-room.js) shows one card per seated player and polls every seated pad
  // itself: each card is driven only by its own controller. While it is open _pollGamepadNav
  // hands every frame to it, the versus member loop and the host step's #578 stand-up B wait,
  // and the close re-primes their edge state. Picks save at once (js/player-look.js); the geese
  // follow on the next frame (game._syncRiderLooks) and the pad light as soon as it is picked.

  /**
   * The controller-identity key a player's look is saved under (#241): the HID
   * serial when the host exposes one, else vendor:product + the slot.
   * @param {{type?: string, input?: any, slotId?: string|null, n?: number}} p
   */
  _lookKeyFor(p) {
    if (!p || p.type === 'keyboard') return 'keyboard';
    const input = p.input;
    const slot = input && input._slot;
    const dev = slot && slot.hidDevice;
    if (dev) return padKeyFor({ serial: dev.serialNumber || null, vendorId: dev.vendorId, productId: dev.productId, slotId: slot.id });
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    const gp = input && input.gamepadIndex != null ? pads[input.gamepadIndex] : null;
    const vp = gp ? vidPidFromGamepadId(gp.id) : null;
    if (vp) return padKeyFor({ ...vp, slotId: (slot && slot.id) || p.slotId || null });
    if (gp) return padKeyFor({ name: gp.id, slotId: (slot && slot.id) || p.slotId || null });   // XInput pads carry no vendor:product
    if (input && input.steamInputHandle != null) return padKeyFor({ kind: 'steam', slotId: p.slotId || (p.n ? 'P' + p.n : null) });
    return null;
  }

  /**
   * Binds the seated players' pads to their looks, and under the co-op seats says
   * "Press Y for wardrobe" (each seated pad's △ / Y opens its own card). No buttons
   * (TV playtest 2026-11-06): versus says it in its join hint already. A mouse can
   * still click the line to open Player 1's card.
   * @param {string} rowId @param {Array<{n: number, input?: any, type?: string, slotId?: string|null}>} players @param {HTMLElement} step
   */
  _renderWardrobeButtons(rowId, players, step) {
    const row = document.getElementById(rowId);
    if (!row) return;
    for (const p of players) playerLooks.bindPad(p.n, this._lookKeyFor(p));
    if (step === this.versusStep || row._wardrobeHint) return;
    row._wardrobeHint = true;
    const hint = document.createElement('p');
    hint.className = 'versus-join-hint wardrobe-hint';
    hint.id = rowId + '-hint';
    hint.innerHTML = 'Press <uf-controller-glyph button="north" size="sm"></uf-controller-glyph> for wardrobe';
    hint.addEventListener('click', () => this._openDressingRoom(1));
    row.appendChild(hint);
  }

  /**
   * The seated players for the Dressing Room, read every frame: {n, input, type, label, team, seat}.
   * Versus: each team's first member is its captain, the second its stoker. Co-op: P1 captain,
   * a locally seated P2 stoker (an online partner dresses on their own screen).
   */
  _roomPlayers() {
    const out = [];
    if (this._currentStep === this.versusStep) {
      for (const team of ['A', 'B']) {
        const members = this._versusPlayers.filter((p) => p.team === team && p.type !== 'bot');
        members.forEach((p, i) => {
          let label = p.name || `Player ${p.n}`;
          try { label = this._versusIdentity(p).shortName || label; } catch (e) {}
          out.push({ n: p.n, input: p.input, type: p.type, slotId: p.slotId || null, label, team, seat: i === 0 ? 'Captain' : 'Stoker' });
        });
      }
      return out.sort((a, b) => a.n - b.n);
    }
    const id = this._p1Identity();
    const onPad = !!(this.input && this.input.gamepadConnected);
    out.push({ n: 1, input: this.input, type: onPad ? 'gamepad' : 'keyboard', slotId: 'P1', label: id ? id.shortName : (onPad ? 'Controller' : 'Keyboard'), team: null, seat: 'Captain' });
    if (this._localSeatedOnHost && this._localP2InputManager) {
      const im = this._localP2InputManager;
      out.push({ n: 2, input: im, type: this._localP2Type || 'gamepad', slotId: im._slot ? im._slot.id : null, label: this._localP2Name || 'Player 2', team: null, seat: 'Stoker' });
    }
    return out;
  }

  /** #612 · players 2–4's own House Tandem sign-ins (js/seat-accounts.js), made on first use. */
  get seatAccounts() {
    if (!this._seatAccounts) {
      let store = null;
      try { store = window.localStorage; } catch (e) {}
      this._seatAccounts = new SeatAccounts({ store });
      // A seat that signs in or out renames its seat cards (P2's "Player 2" becomes their name),
      // and a newly signed-in account's earned achievements come down so none is awarded twice.
      this._seatSynced = new Set();
      this._seatAccounts.onChange((n) => {
        try { this._refreshSeatNames(); } catch (e) {}
        const a = this._seatAccounts.get(n);
        if (a && !this._seatSynced.has(a.user.id)) {
          this._seatSynced.add(a.user.id);
          fetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${a.token}` } })
            .then((r) => (r.ok ? r.json() : null))
            .then((me) => { if (me && me.achievements) this.seatAchievements.mergeEarned(a.user.id, me.achievements.map((x) => x.achievement_id)); })
            .catch(() => { this._seatSynced.delete(a.user.id); });
        }
      });
    }
    return this._seatAccounts;
  }

  /** #612 · a signed-in seat's own achievements (js/seat-achievements.js). */
  get seatAchievements() {
    if (!this._seatAchievements) {
      let store = null;
      try { store = window.localStorage; } catch (e) {}
      this._seatAchievements = new SeatAchievements({ store });
    }
    return this._seatAchievements;
  }

  /**
   * #612 · who sits in seat n, for the picture and name next to their controller: Player 1 is
   * the game's own account (its Steam sign-in first in the Steam app, else Discord), seats 2–4
   * their own Discord sign-ins. The name is the account's (what the rest of the game calls them).
   * { name, pic, source } or null when nobody is signed in.
   */
  seatPerson(n) {
    let user = null;
    if (n === 1) user = this.auth && this.auth.isLoggedIn() ? this.auth.getUser() : null;
    else { try { const a = this.seatAccounts.get(n); user = a && a.user; } catch (e) {} }
    if (!user) return null;
    const ids = user.identities || {};
    const order = n === 1 && this._isSteam ? ['steam', 'discord'] : ['discord', 'steam'];
    for (const p of order) {
      if (ids[p] && (ids[p].avatar || ids[p].name)) return { name: user.name || ids[p].name || 'Player ' + n, pic: ids[p].avatar || '', source: p };
    }
    const src = user.provider === 'steam' || user.provider === 'discord' ? user.provider : '';
    return { name: user.name || 'Player ' + n, pic: user.avatar || '', source: src };
  }

  /** A seat card's fields for seat n: the person's name and picture over their controller, else the controller. */
  _seatWho(n, controllerName) {
    const p = this.seatPerson(n);
    return p ? { who: p.name, pic: p.pic, source: p.source, dev: controllerName || '' } : { who: controllerName, pic: '', source: '' };
  }

  _personKey(n) { const p = this.seatPerson(n); return p ? [p.name, p.pic, p.source].join(',') : ''; }

  /** The signed-in name for seat n (2–4), or null. */
  seatAccountName(n) {
    const a = n > 1 ? this.seatAccounts.get(n) : null;
    return a && a.user ? a.user.name : null;
  }

  /** Seat names follow their sign-ins: local Player 2's seat card and the versus names. */
  _refreshSeatNames() {
    const name = this.seatAccountName(2);
    if (this._localSeatedOnHost) {
      if (name) { if (!this._localP2NameBeforeAccount) this._localP2NameBeforeAccount = this._localP2Name || 'Player 2'; this._localP2Name = name; }
      else if (this._localP2NameBeforeAccount) { this._localP2Name = this._localP2NameBeforeAccount; this._localP2NameBeforeAccount = null; }
    }
    try { this._refreshHostNext(); } catch (e) {}
  }

  /**
   * #612 · the Wardrobe's account row for each card. Player 1 is the game's own account (sign
   * in, or Link Discord on Steam); seats 2–4 are SeatAccounts. A device code shows as a QR
   * on the card; the desktop app also opens the system browser on it.
   */
  _wardrobeAccounts() {
    const listeners = new Set();
    const emit = (n) => { for (const fn of listeners) { try { fn(n); } catch (e) {} } };
    const seats = this.seatAccounts;
    const offSeats = seats.onChange(emit);
    void offSeats;
    const openBrowser = (url) => { if (url && window.electronApp && window.electronApp.openSignIn) window.electronApp.openSignIn(url); };
    const p1 = () => {
      const dev = this.auth._device;
      if (dev && !dev.stopped) return { state: 'pending', code: dev.code, url: dev.url, status: this._p1DeviceStatus || 'pending' };
      if (this.auth.isLoggedIn()) {
        const u = this.auth.getUser();
        return {
          state: 'signed-in', name: u.name, pics: identityPictures(u), person: this.seatPerson(1),
          linkable: !this.auth.hasIdentity('discord'), canSignOut: false,
        };
      }
      return { state: 'signed-out', error: this._p1DeviceError || null };
    };
    // Pete, 2026-11-06: one QR on the TV at a time. While one seat's code is open, every
    // other Sign in waits (greyed, "Waiting for P2 to sign in…"); Hide frees it.
    const openSeat = () => {
      const dev = this.auth._device;
      if (dev && !dev.stopped) return 1;
      for (const n of [2, 3, 4]) if (seats.pending(n)) return n;
      return null;
    };
    const withWait = (n, v) => {
      const busy = openSeat();
      if (busy && busy !== n && v.state !== 'pending') v.blockedBy = busy;
      return v;
    };
    return {
      view: (n) => {
        if (n === 1) return withWait(1, p1());
        const dev = seats.pending(n);
        if (dev) return { state: 'pending', code: dev.code, url: dev.url, status: dev.status };
        const a = seats.get(n);
        if (a) return withWait(n, { state: 'signed-in', name: a.user.name, pics: identityPictures(a.user), person: this.seatPerson(n), canSignOut: true });
        const err = seats.lastError && seats.lastError.n === n ? seats.lastError.error : null;
        return withWait(n, { state: 'signed-out', error: err === 'cancelled' ? 'Cancelled.' : err === 'expired' ? 'That code expired. Try again.' : err });
      },
      bind: (n, padKey) => { if (n > 1) seats.bindSeat(n, padKey); },
      signIn: async (n) => {
        const busy = openSeat();
        if (busy && busy !== n) return;   // someone else's QR is open
        if (n === 1) {
          this._p1DeviceError = null;
          try {
            const dev = await this.auth.startDiscordDevice({
              onStatus: (s) => { this._p1DeviceStatus = s; emit(1); },
              onDone: (user, info) => {
                this._p1DeviceStatus = null;
                if (user) {
                  if (info && info.linked) showInfoToast('🔗', 'Discord linked', info.merged ? 'Your Discord and Steam accounts are now one' : 'Discord and Steam are one House Tandem account');
                  if (this._profileUpdateUI) this._profileUpdateUI(user);
                } else this._p1DeviceError = info && info.error === 'cancelled' ? 'Cancelled.' : 'That code expired. Try again.';
                emit(1);
              },
            });
            emit(1);
            openBrowser(dev && dev.url);
          } catch (e) { this._p1DeviceError = e.message || 'Discord sign-in is unavailable'; emit(1); }
          return;
        }
        if (seats.lastError && seats.lastError.n === n) seats.lastError = null;
        try {
          // Seats 2–4 use the QR only (Pete, 2026-11-07). This PC's browser is signed in to
          // P1's Discord, so opening it here would sign P2's seat in as P1.
          await seats.startSignIn(n);
        } catch (e) { seats.lastError = { n, error: e.message || 'Discord sign-in is unavailable' }; emit(n); }
      },
      signOut: (n) => { if (n > 1) seats.signOut(n); },
      cancel: (n) => {
        if (n === 1) { this.auth.cancelDiscordDevice(); this._p1DeviceStatus = null; emit(1); return; }
        seats.cancel(n);
      },
      onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  /** Open the Dressing Room with player n's card in Edit (everyone else Ready). */
  _openDressingRoom(n) {
    if (!this._roomSheet || this._room) return;
    if (!this._roomPlayers().some((p) => p.n === n)) return;
    // Low tier (TV): cards without the 3D preview, so the lobby's polling never stalls.
    const lowTier = getCurrentTier() === 'low';
    this._room = new DressingRoom({
      sheet: this._roomSheet,
      roster: () => this._roomPlayers(),
      padKeyFor: (p) => this._lookKeyFor(p),
      controllerManager: this.controllerManager,
      makePreview: lowTier ? null : () => new DressingRoomPreview(),
      onLookChanged: (who, kind, val) => window.dispatchEvent(new CustomEvent('tandemonium:look-changed', { detail: { n: who, kind, val } })),
      onClose: () => this._onRoomClosed(),
      // #611: reward outfits (the robot) stay locked until this device's achievements earn them
      lockedOutfits: () => lockedOutfits(GOOSE_OUTFITS, this._achievements ? this._achievements.getEarnedIds() : []),
      lockHint: (k) => outfitLockHint(GOOSE_OUTFITS[k], this._achievements ? this._achievements.getEarnedIds() : []),
      accounts: this._wardrobeAccounts(),
    });
    this._room.show(n);
  }

  /** The room closed: every seated pad goes back to its screen with its edges primed. */
  _onRoomClosed() {
    const room = this._room;
    this._room = null;
    // The press that closed it (B, or A on BACK TO SEATS) is still down: the versus member loop,
    // #578's stand-up B and the Y handlers must see it as already pressed.
    for (const p of this._versusPlayers) this._versusPrevButtons.set('member:' + p.n, { a: true, b: true, left: true, right: true, y: true });
    this._p2PrevY = true;
    this._localP2PrevB = true;
    this._gpPrevY = true;
    if (room) for (const n of room.cards.keys()) window.dispatchEvent(new CustomEvent('tandemonium:look-changed', { detail: { n, closed: true } }));
  }

  /** Host step: a seated local Player 2's △ / Y opens the Dressing Room with their card in Edit. */
  _pollSeatedP2Wardrobe() {
    const im = this._localSeatedOnHost ? this._localP2InputManager : null;
    if (!im || this._localP2Type === 'keyboard') { this._p2PrevY = true; return; }
    const gp = im.getGamepadState ? im.getGamepadState() : null;
    const y = !!(gp && gp.buttons && gp.buttons[3] && gp.buttons[3].pressed);
    if (y && !this._p2PrevY && !this._room && !this._activeModal) this._openDressingRoom(2);
    this._p2PrevY = y;
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
    this._presetKeys = ['default', ...Object.keys(this._presetData), ...SPECIAL_BIKE_KEYS];

    // Setup mini 3D preview
    const canvas = document.getElementById('bike-preview-canvas');
    const w = canvas.clientWidth || 220;
    const h = canvas.clientHeight || 132;

    // Low quality tier: no anti-aliasing (fixed at creation), 1x resolution,
    // no shadows and a slower redraw (setQualityTier).
    const lowTier = getCurrentTier() === 'low';
    this._previewRenderer = new THREE.WebGLRenderer({
      canvas, antialias: !lowTier
    });
    this._previewRenderer.setSize(w, h);
    this._previewRenderer.setClearColor(0x8b7355, 1);
    this._previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this._previewRenderer.toneMappingExposure = 1.2;
    this._previewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.setQualityTier(getCurrentTier());

    this._previewScene = new THREE.Scene();
    this._previewScene.fog = new THREE.Fog(0x8b7355, 6, 14);
    this._previewCamera = new THREE.PerspectiveCamera(previewFov(w / h), w / h, 0.1, 100);
    this._previewCamera.position.set(0, 1.4, 4.2);
    this._previewCamera.lookAt(0, 0.5, 0);

    // Follow the canvas's CSS box (#428): the renderer used to be sized once
    // here, so a window or TV-size change (or the desktop layout giving the
    // preview a different box) stretched it. setSize(…, false) leaves the CSS
    // size to the stylesheet.
    if (typeof ResizeObserver !== 'undefined') {
      this._previewResize = new ResizeObserver(() => {
        const cw = canvas.clientWidth, ch = canvas.clientHeight;
        if (!cw || !ch || !this._previewRenderer) return;
        this._previewRenderer.setSize(cw, ch, false);
        this._previewCamera.aspect = cw / ch;
        this._previewCamera.fov = previewFov(cw / ch);   // #521: a taller box shows more ground, not less bike
        this._previewCamera.updateProjectionMatrix();
      });
      this._previewResize.observe(canvas);
    }

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

    // Load bike model — the chooser shows the original recolorable frame so the
    // color presets apply here (the in-game bike is the fused riders model).
    const loader = new GLTFLoader();
    loader.load(CHOOSER_MODEL_PATH, (gltf) => {
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

  /** Earned achievement ids (the AchievementManager when the lobby has it, else its store). */
  _earnedAchievementIds() {
    if (this._achievements) return this._achievements.getEarnedIds();
    try {
      const raw = localStorage.getItem('tandemonium_achievements');
      return raw ? JSON.parse(raw).map(a => a.id) : [];
    } catch { return []; }
  }

  /**
   * #611 · a special bike's own model in the chooser, loaded the first time it is shown: sized like the
   * tandem preview, its own loop (the Time Warp's TimeWarpFX) on a mixer, materials kept so a locked
   * silhouette can be undone.
   */
  _loadSpecialPreview(key, onReady) {
    this._specialPreviews = this._specialPreviews || {};
    const have = this._specialPreviews[key];
    if (have) { if (have.model) onReady(have); return; }
    const def = SPECIAL_BIKES[key];
    const sp = this._specialPreviews[key] = { model: null };
    new GLTFLoader().load(def.model, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      model.scale.setScalar(3.0 / Math.max(size.x, size.y, size.z));
      model.updateMatrixWorld(true);
      const b2 = new THREE.Box3().setFromObject(model);
      const c = b2.getCenter(new THREE.Vector3());
      model.position.set(-c.x, -b2.min.y, -c.z);
      const mats = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.castShadow = true;
        mats.push([o.material, o.material.clone()]);
      });
      const mixer = new THREE.AnimationMixer(model);
      const clip = def.fx && gltf.animations.find(x => x.name === def.fx);
      let fx = null;
      if (clip) {
        const cut = clip.clone();
        const keep = boneFilterFor(def.fx);
        cut.tracks = cut.tracks.filter(t => keep(trackBone(t.name)));
        fx = mixer.clipAction(cut);
        fx.play();
        fx.paused = true;
      }
      model.visible = false;
      if (this._previewPivot) this._previewPivot.add(model);
      Object.assign(sp, { model, mats, mixer, fx, dark: false });
      onReady(sp);
    }, undefined, (err) => console.warn(def.name + ' preview failed to load:', err));
  }

  /** Dark silhouette (locked) or its own colours (unlocked). */
  _setSpecialDark(sp, dark) {
    if (!sp || !sp.model || sp.dark === dark) return;
    sp.dark = dark;
    for (const [m, orig] of sp.mats) {
      if (dark) {
        if (m.color) m.color.set(0x050505);
        if (m.emissive) m.emissive.set(0x000000);
        if (m.map) m.map = null;
        m.metalness = 0; m.roughness = 1;
      } else {
        m.copy(orig);
      }
      m.needsUpdate = true;
    }
    if (dark && sp.fx) { sp.fx.time = 0; sp.mixer.update(0); }   // (the orange pops tucked away)
  }

  /** Hide every special bike's preview model (a paint preset or another special bike is showing). */
  _hideSpecialPreviews(exceptKey = null) {
    for (const [k, sp] of Object.entries(this._specialPreviews || {})) if (k !== exceptKey && sp.model) sp.model.visible = false;
  }

  /**
   * #611 · a special bike in the chooser: its own model; locked = a dark silhouette with "n of N" over it;
   * earned = its colours (and its loop); a bike not rideable yet says so and leaves the ride on the default.
   */
  _applySpecialToPreview(key, nameEl) {
    const def = SPECIAL_BIKES[key];
    const prog = rewardProgress(def.reward, this._earnedAchievementIds());
    const locked = !prog.unlocked;
    if (this._previewModel) this._previewModel.visible = false;
    this._hideSpecialPreviews(key);
    this._loadSpecialPreview(key, (sp) => {
      if (this._presetKeys[this._presetIndex] !== key) return;   // moved on while it loaded
      sp.model.visible = true;
      this._setSpecialDark(sp, locked);
    });
    let hintEl = document.getElementById('bike-hint');
    if (!hintEl) {
      hintEl = document.createElement('div');
      hintEl.id = 'bike-hint';
      hintEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.5);margin-top:2px;text-align:center;';
      nameEl.parentNode.insertBefore(hintEl, nameEl.nextSibling);
    }
    this.selectedPreset = null;
    hintEl.dataset.special = key;
    if (locked) {
      this.selectedPresetKey = 'default';
      nameEl.style.color = 'rgba(255,255,255,0.3)';
      nameEl.textContent = '\uD83D\uDD12 ' + def.name;
      hintEl.innerHTML = `<span class="bike-count" style="font-size:18px;font-weight:700;color:rgba(255,255,255,0.85)">${prog.have} of ${prog.need}</span>`
        + `<br><span style="color:rgba(255,255,255,0.55)">${def.unit}</span>`;
      hintEl.title = def.reward === 'timeWarp'
        ? `${def.name}: any ${prog.need} of the ${prog.total} achievements that don't need real days`
        : `${def.name}: any ${prog.need} of the ${prog.total} solo achievements (player bots)`;
      hintEl.style.display = '';
      return;
    }
    nameEl.style.color = def.color;
    nameEl.textContent = def.icon + ' ' + def.name;
    if (!def.rideable) {
      this.selectedPresetKey = 'default';
      hintEl.innerHTML = '<span style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.85)">Coming soon</span>';
      hintEl.title = `${def.name} is earned; riding it comes in a later update`;
      hintEl.style.display = '';
      return;
    }
    this.selectedPresetKey = key;
    hintEl.style.display = 'none';
    hintEl.title = '';
    delete hintEl.dataset.special;
    analytics.trackEvent('bike_color_change', { preset_key: key });
  }

  _applyPresetToPreview() {
    const key = this._presetKeys[this._presetIndex];
    const nameEl = document.getElementById('bike-name');
    // #611: the reward bikes (their own models) lock by their own achievement counts, demo or not
    if (isSpecialBike(key)) { this._applySpecialToPreview(key, nameEl); return; }
    if (this._previewModel) this._previewModel.visible = true;
    this._hideSpecialPreviews();
    { const h = document.getElementById('bike-hint'); if (h) delete h.dataset.special; }
    // #641: the demo rides Grandma's Classic and Marmalade Express; the other
    // colours show, shut, as the full game's.
    const demoLocked = !bikeAllowed(getEditionRules(), key);
    const locked = demoLocked || (HOLIDAY_BIKES[key] && !this._isHolidayUnlocked(key));
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
      if (demoLocked) {
        hintEl.textContent = 'In the full game';
        hintEl.style.display = '';
      } else {
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
      }

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
    if ((this._currentStep === this.hostStep || (this._currentStep === this.levelStep && this._pendingMode === 'multiplayer')) && this.net && this.net.connected) {
      this.net.sendProfile(RoomProtocol.bikeSync(this.selectedPresetKey));
    }
  }

  /** Quality tier, live: Low drops the bike preview's shadows, resolution and frame rate. @param {'low'|'medium'|'high'} tier */
  setQualityTier(tier) {
    this._previewLow = tier === 'low';
    const r = this._previewRenderer;
    if (!r) return;
    r.setPixelRatio(this._previewLow ? 1 : Math.min(window.devicePixelRatio, 2));
    if (r.shadowMap.enabled === this._previewLow) {
      r.shadowMap.enabled = !this._previewLow;
      if (this._previewScene) this._previewScene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
    }
  }

  _startPreviewLoop() {
    if (this._previewRafId) return;
    let frame = 0;
    const animate = () => {
      this._previewRafId = requestAnimationFrame(animate);
      // Low: every third frame (~20 fps), turning three steps at a time.
      const step = this._previewLow ? 3 : 1;
      if (frame++ % step !== 0) return;
      if (this._previewPivot) {
        this._previewPivot.rotation.y += 0.008 * step;
      }
      // #611 · the Time Warp's clock and flames run in the chooser too (not while it's a locked silhouette)
      for (const sp of Object.values(this._specialPreviews || {})) {
        if (!sp.model || !sp.model.visible || !sp.fx || sp.dark) continue;
        sp.fx.time = (performance.now() / 1000) % sp.fx.getClip().duration;
        sp.mixer.update(0);
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
      this._previewRenderer.forceContextLoss();   // free the context now, not at GC
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
