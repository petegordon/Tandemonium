// ============================================================
// GAME — orchestrator + boot (entry point)
// ============================================================

import * as THREE from 'three';
import { isMobile, isAndroid, isIOS, EVT_COUNTDOWN, EVT_START, EVT_RESET, EVT_GAMEOVER, EVT_CHECKPOINT, EVT_FINISH, EVT_RETURN_ROOM, MSG_PROFILE, TUNE, BALANCE_DEFAULTS, GUEST_NAME, applyDifficulty, applySteeringFeel, snapshotTuningBase } from './config.js';
import { RaceManager } from './race-manager.js';
import { getLevelById, LEVELS } from './race-config.js';
import { ContributionTracker } from './contribution-tracker.js';
import { CollectibleManager } from './collectibles.js';
import { ObstacleManager } from './obstacles.js';
import { AchievementManager, showAchievementToast, updateBadgeDisplay } from './achievements.js';
import { InputManager, readDualSenseSourcePref, readGyroRollMode } from './input-manager.js';
import { FocusController } from './nav/focus-controller.js';
import { ROOM_MSG } from './lobby/room-protocol.js';
import { PedalController } from './pedal-controller.js';
import { SharedPedalController } from './shared-pedal-controller.js';
import { BalanceController } from './balance-controller.js';
import { BikeModel } from './bike-model.js';
import { RemoteBikeState } from './remote-bike-state.js';
import { ChaseCamera } from './chase-camera.js';
import { FrontViewCamera } from './front-view-camera.js';
import { FinishCameraAnimation } from './finish-camera-animation.js';
import { World } from './world.js';
import { HUD } from './hud.js';
import { GrassParticles } from './grass-particles.js';
import { Lobby } from './lobby.js';
import { GameRecorder } from './game-recorder.js';
import { ArchIndicator } from './arch-indicator.js';
import { AudioEngine, MOTIF } from './audio-engine.js';
import { hapticCrash, hapticTreeHit, hapticCheckpoint, hapticFinish, hapticOffRoad, setHapticSources } from './haptics.js';
import { DDAManager } from './dda-manager.js';
import * as analytics from './analytics.js';
import { perfProbe } from './perf-probe.js';
import { detectHardware, getCachedProfile, clearHardwareCache } from './hardware-detect.js';
import { ControllerRegistry } from '../shared/drivers/controller-registry.js';
import { ControllerManager } from '../shared/manager.js';

// Demo checkpoint limit removed — demo users play the tutorial instead
const TUNING_KEY_PREFIX = 'tandemonium_motion_tuning';

// Grace period before surfacing the "reconnecting" badge / freezing the race.
// A brief partner phone-lock self-heals within ~1-2s (relay close → fast
// reconnect + the partner force-reconnects on unlock), so debouncing the
// presentation avoids a jarring freeze-flash for blips. See #320.
const RECONNECT_GRACE_MS = 2000;

// Tutorial phase boundaries — sequential layout so all phases are visible ahead
const TUTORIAL_PHASES = {
  1: { runwayStart: 0,   contentStart: 30,  contentEnd: 80  },
  2: { runwayStart: 80,  contentStart: 105, contentEnd: 158 },
  3: { runwayStart: 158, contentStart: 180, contentEnd: 225 }
};

// Per-phase item layouts at absolute sequential distances
const TUTORIAL_ITEMS = {
  1: {
    // Same side first, shallow offsets, wide spacing
    collectibles: [
      { d: 38, offset: 1.0 },   // right
      { d: 53, offset: 1.0 },   // right (same side — just repeat the lean)
      { d: 68, offset: -1.0 },  // left (now learn the other direction)
      { d: 78, offset: -1.0 }   // left (same side — confirm you can do it)
    ],
    obstacles: []
  },
  2: {
    // Pylon weaving — 12m spacing for more reaction time
    collectibles: [],
    obstacles: [
      { d: 112, offset: -1.0 },
      { d: 124, offset: 1.0 },
      { d: 136, offset: -1.0 },
      { d: 148, offset: 1.0 }
    ]
  },
  3: {
    // Combines collecting + dodging — alternating sides, wider offsets
    collectibles: [
      { d: 185, offset: 1.8 },
      { d: 200, offset: -1.8 },
      { d: 215, offset: 1.8 }
    ],
    obstacles: [
      { d: 192, offset: -1.0 },
      { d: 207, offset: 1.0 },
      { d: 222, offset: -1.0 }
    ]
  }
};

class Game {
  constructor() {
    // Renderer — quality resolution: user override > URL param > hardware detect > default
    const _qualityParam = new URLSearchParams(window.location.search).get('quality');
    const _qualityPref = (() => { try { return localStorage.getItem('tandemonium_quality'); } catch(e) { return null; } })();
    const _hwCached = getCachedProfile();
    this._autoLowEnd = false;

    if (_qualityParam === 'low' || _qualityPref === 'low') {
      this._lowQuality = true;
    } else if (_qualityParam === 'high' || _qualityPref === 'high') {
      this._lowQuality = false;
    } else if (_hwCached && _hwCached.tier === 'low') {
      this._lowQuality = true;
      this._autoLowEnd = true;
    } else {
      this._lowQuality = false;
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile && !this._lowQuality, preserveDrawingBuffer: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this._lowQuality ? 0.5 : Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = !isMobile && !this._lowQuality;
    if (!isMobile && !this._lowQuality) this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.prepend(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();

    // Sky gradient: rich blue top → soft light blue at horizon
    const skyCanvas = document.createElement('canvas');
    skyCanvas.width = 1;
    skyCanvas.height = 512;
    const ctx = skyCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#1a6abf');   // deep blue (zenith)
    grad.addColorStop(0.3, '#3e9ce0');   // mid blue
    grad.addColorStop(0.6, '#8ecbf0');   // light blue
    grad.addColorStop(0.85, '#c8e4f8');  // pale sky
    grad.addColorStop(1.0, '#e4f0f8');   // near-white horizon
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1, 512);
    const skyTex = new THREE.CanvasTexture(skyCanvas);
    skyTex.magFilter = THREE.LinearFilter;
    this.scene.background = skyTex;

    // Fog matches horizon color for seamless blending
    this.scene.fog = new THREE.FogExp2(0xe4f0f8, 0.006);

    // Camera (FOV 70 for portrait)
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 500
    );

    // Controller manager — owns slot/claim state, HID pool, sensor fusion.
    // P1 = slot[0], P2 = slot[1]. Shared with the Lobby so join detection
    // in the lobby and in-race input read from the same source of truth.
    this.controllerManager = new ControllerManager({ slotIds: ['P1', 'P2'] });
    // Fire-and-forget: pair approved HID devices, auto-request any
    // remaining via Electron (gated by env detection inside the manager),
    // and listen for hot-plug events.
    this.controllerManager.autoPoolApprovedHid()
      .then(() => {
        if (navigator.userAgent.includes('Electron')) {
          return this.controllerManager.electronAutoRequestDevice();
        }
      })
      .then(() => this.controllerManager.wireHidHotplug())
      .catch((err) => console.warn('controller manager init failed', err));

    // Components
    this.input = new InputManager({ slot: this.controllerManager.getSlot('P1') });
    // Default haptic target: P1's InputManager. Updated in _onLocalReady
    // to include P2's InputManager so both players rumble on shared events.
    setHapticSources([this.input]);
    this.pedalCtrl = new PedalController(this.input);
    this.balanceCtrl = new BalanceController(this.input);
    this.world = new World(this.scene, { lowEnd: this._lowQuality });
    this.bike = new BikeModel(this.scene);
    this.bike.roadPath = this.world.roadPath;
    this.chaseCamera = new ChaseCamera(this.camera);
    // Picture-in-picture front-facing "selfie cam" of the bike (lower-right).
    this.frontView = new FrontViewCamera(this.camera);
    this.hud = new HUD(this.input);
    this.grassParticles = new GrassParticles(this.scene);
    this.archIndicator = new ArchIndicator(this.scene);
    this._partnerBikeColor = null;
    this.recorder = new GameRecorder(this.renderer.domElement, this.input);
    // NOTE: clip recording is NOT gated on the general _lowQuality render flag.
    // The recorder runs its own GPU-readback probe (_detectLowEndDevice) to
    // decide if recording is viable. A coarse/stale hardware-tier
    // classification was wrongly disabling clips on capable desktops even when
    // that probe passed (issue: sup=true at construction, then overridden).
    // Manual "Low" in Options still disables recording (see _setQuality).

    // Mode
    this.mode = 'solo'; // 'solo' | 'captain' | 'stoker' | 'local'
    this.net = null;
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    // Local multiplayer (same-screen): second InputManager + balance controller for P2.
    // Created in _onLocalReady when P2 clicks JOIN RIDE on the host page; null otherwise.
    this.inputP2 = null;
    this.balanceCtrlP2 = null;
    this._localP2Type = null; // 'gamepad' | 'keyboard'
    this._mpPrevUpP2 = false;
    this._mpPrevDownP2 = false;
    this._localP2Disconnected = false;
    this._partnerHasTilt = undefined; // undefined = unknown, true/false = received
    this._onPartnerTiltStatus = null;
    this._stokerReady = false;        // captain-side: stoker tapped through start prompt
    this._onStokerReady = null;
    this._partnerCanSteer = true;     // captain-side: partner has a working steering input
    this._partnerMethod = null;       // captain-side: partner's chosen input method
    this._chosenInputMethod = null;   // stoker-side: input picked on the start screen
    this._inputChoiceOpen = false;    // stoker-side: input-choice overlay is up
    this._partnerServerId = null;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    // Reusable remoteData object (avoid per-frame allocation)
    this._remoteData = { remoteLean: 0, remoteLastFoot: null, remoteLastTapTime: 0 };
    this._stateSendTimer = 0;
    this._stateSendInterval = 1 / 30; // 30Hz
    this._leanSendTimer = 0;
    this._leanSendInterval = 1 / 30; // 30Hz
    this._mpPrevUp = false;
    this._mpPrevDown = false;
    this._stokerWasFallen = false;
    this._stokerTimeoutShown = false;
    this._reconnecting = false;
    this._reconnectGraceTimer = null; // debounce timer for _showReconnecting (#320)

    // Recording partner pedal flash tracking
    this._recLastTapTime = 0;
    this._recLastFoot = null;
    this._recFlashTimer = 0;
    this._recFlashFoot = null;
    this._recFlashWrong = false;

    // Recording checkpoint flash tracking
    this._checkpointFlashTime = 0;

    // Options overlay state
    this._optionsOpen = false;
    this._gpPrevStart = false;
    this._gpPrevB = false;
    this._initOptionsOverlay();

    // Async hardware detection (first visit, no cache, no manual override)
    if (!_hwCached && _qualityPref !== 'high' && _qualityPref !== 'low' && _qualityParam !== 'high' && _qualityParam !== 'low') {
      detectHardware().then(result => {
        if (result.tier === 'low' && !this._lowQuality) {
          this._autoLowEnd = true;
          this._lowQuality = true;
          this.renderer.setPixelRatio(0.5);
          this.renderer.shadowMap.enabled = false;
          // Don't disable clip recording here — the recorder's own GPU-readback
          // probe is authoritative; auto low-end render quality shouldn't kill
          // clips on a machine that can actually record. (Manual Low still does.)
          this._updateOptionsQualityUI();
        }
      });
    }

    // D-pad + face button edge detection for gameplay buttons
    this._dpadPrevUp = false;
    this._dpadPrevDown = false;
    this._dpadPrevLeft = false;
    this._dpadPrevRight = false;
    this._gpPrevY = false;
    this._gpPrevA = false;
    this._gpPrevL3 = false;

    // Tap center of screen to recalibrate tilt (mobile)
    this.renderer.domElement.addEventListener('touchstart', (e) => {
      if (this.state !== 'playing') return;
      if (!this.input.motionEnabled && !this.input.gyroConnected) return;
      this._recalibrateTilt();
    });

    // WebGL context loss recovery — prevent grey screen on mobile
    // (Creating a 2nd WebGL context for victory video can evict the main one on iOS)
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('WebGL context lost — will restore when available');
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      console.log('WebGL context restored');
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(this._lowQuality ? 0.5 : Math.min(window.devicePixelRatio, 2));
    });

    // FPS tracking for analytics
    this._fpsFrameTimes = [];  // rolling buffer of frame durations (seconds)
    this._fpsMinDt = Infinity; // shortest frame time seen during ride
    this._fpsMaxDt = 0;        // longest frame time seen during ride

    // DDA (Dynamic Difficulty Adjustment)
    this.ddaManager = null;
    this._assistWeight = 0;

    // Calibration tip (shown once per session)
    this._shownCalibTip = false;

    // Victory overlay input cooldown
    this._overlayCooldownUntil = 0;

    // Safety mode (on by default)
    this.safetyMode = true;
    this.safetyBtn = document.getElementById('safety-btn');
    this.safetyBtn.addEventListener('click', () => {
      this.safetyMode = !this.safetyMode;
      this.safetyBtn.className = 'side-btn ' + (this.safetyMode ? 'safety-on' : 'safety-off');
      this.safetyBtn.textContent = 'SAFETY\n' + (this.safetyMode ? 'ON' : 'OFF');
    });

    // Speed mode (off by default)
    this.autoSpeed = false;
    this.speedBtn = document.getElementById('speed-btn');
    this.speedBtn.addEventListener('click', () => {
      this.autoSpeed = !this.autoSpeed;
      this.speedBtn.className = 'side-btn ' + (this.autoSpeed ? 'speed-on' : 'speed-off');
      this.speedBtn.textContent = this.autoSpeed ? 'ON\nSPEED' : 'SPEED';
    });

    // Assist button (hidden by default, shown by DDA)
    this.assistBtn = document.getElementById('assist-btn');
    this.assistBtn.addEventListener('click', () => {
      if (this._assistWeight > 0) {
        this._assistWeight = 0;
        this.assistBtn.className = 'side-btn assist-off';
        this.assistBtn.textContent = 'ASSIST';
      } else {
        this._assistWeight = 0.65;
        this.assistBtn.className = 'side-btn assist-on';
        this.assistBtn.textContent = 'ASSIST\nON';
      }
    });

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', () => {
      this._resetGame();
    });


    // Lobby / Room button
    this._lobbyBtn = document.getElementById('lobby-btn');
    this._lobbyBtn.addEventListener('click', () => {
      if (analytics.getCurrentRideId()) {
        analytics.endRide({
          completed: false,
          abandon_reason: 'lobby_button',
          distance: this.bike ? this.bike.distanceTraveled : 0,
        });
      }
      if (this.net) {
        this._returnToRoom();
      } else {
        this._returnToLobby();
      }
    });

    // Try Again from disconnect overlay
    this._onTap('btn-try-reconnect', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      this._clearOverlayButtons();
      if (this.net) this.net.retryConnection();
    });

    // Return to lobby from disconnect overlay
    this._onTap('btn-return-lobby', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      this._clearOverlayButtons();
      this._returnToLobby();
    });

    // Game Over: save clip
    this._onTap('btn-gameover-clip', () => {
      if (this.recorder) this.recorder.saveClip();
    });

    // Game Over: skip checkpoint (DDA)
    this._onTap('btn-skip-checkpoint', () => {
      analytics.trackRideEvent('dda_assist_accepted', this.bike ? this.bike.distanceTraveled : 0, {
        type: 'checkpoint_skip',
      });
      if (this.ddaManager) {
        this.ddaManager.acceptedCount++;
        this.ddaManager.skipsUsed++;
      }
      this._hideGameOver();
      if (this.raceManager) {
        // Find next unpassed checkpoint
        let nextCp = this.raceManager.raceDistance;
        for (const cp of this.raceManager.checkpoints) {
          if (!this.raceManager.passedCheckpoints.has(cp)) {
            nextCp = cp;
            break;
          }
        }
        // Mark it as passed with score penalty
        this.raceManager.passedCheckpoints.add(nextCp);
        this.raceManager.resetSegmentTimer(nextCp);
        this.bike.resetToDistance(nextCp);
        if (this.ddaManager) this.ddaManager.onCheckpointPassed(nextCp);
        this._showCheckpointFlash();
      }
      this._resumeCountdown();
    });

    // Game Over: restart
    this._onTap('btn-restart', () => {
      if (this.mode === 'stoker' && this.net) {
        // Stoker requests restart — captain drives the reset
        this._hideGameOver();
        this.net.sendEvent(EVT_RESET);
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'Waiting for captain...';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
        return;
      }
      this._hideGameOver();
      this._resetGame();
    });

    // Game Over: return to room (stay connected)
    this._onTap('btn-gameover-room', () => {
      this._hideGameOver();
      this._returnToRoom();
    });

    // Game Over: quit (full disconnect)
    this._onTap('btn-gameover-lobby', () => {
      this._hideGameOver();
      if (analytics.getCurrentRideId()) {
        analytics.endRide({
          completed: false,
          abandon_reason: 'end_ride',
          distance: this.bike ? this.bike.distanceTraveled : 0,
        });
      }
      this._returnToLobby();
    });


    // Race
    this.raceManager = null;
    this.contributionTracker = null;
    this.collectibleManager = null;

    // Achievements (persists across sessions)
    this.achievements = new AchievementManager();
    this._updateBadges();

    // Contribution bar elements
    this._contribBar = document.getElementById('contribution-bar');
    this._contribCaptain = document.getElementById('contrib-captain');
    this._contribStoker = document.getElementById('contrib-stoker');

    // Victory overlay buttons
    this._onTap('btn-play-again', () => {
      analytics.trackConversion('replay_click', this.mode !== 'solo' ? 'mp_results' : 'solo_results');
      if (this.mode === 'stoker' && this.net) {
        // Stoker requests restart — captain drives the reset
        this._hideVictory();
        this.net.sendEvent(EVT_RESET);
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'Waiting for captain...';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
        return;
      }
      this._hideVictory();
      this._resetGame(false, true);
    });
    this._onTap('btn-next-level', () => {
      this._hideVictory();
      // Advance to next level
      const curIdx = LEVELS.indexOf(this.lobby.selectedLevel);
      if (curIdx >= 0 && curIdx < LEVELS.length - 1) {
        this.lobby.selectedLevel = LEVELS[curIdx + 1];
        this._resetGame(false, true);
      } else {
        this._returnToLobby();
      }
    });
    // Victory: return to room (stay connected)
    this._onTap('btn-victory-room', () => {
      this._hideVictory();
      this._returnToRoom();
    });

    // Victory: quit (full disconnect)
    this._onTap('btn-victory-lobby', () => {
      this._hideVictory();
      analytics.setPage('lobby');
      this._returnToLobby();
    });

    // Overlay gamepad navigation (game-over, victory, disconnect, tutorial-end,
    // options, input-choice) — driven by the shared nav-core FocusController
    // (#318). Vertical button stack + an optional slider (steering-feel), with
    // a confirm cooldown (_overlayCooldownUntil) so a held A / a just-opened
    // victory screen can't be dismissed instantly.
    this._overlayFocus = new FocusController({
      input: this.input,
      orientation: 'vertical',
      canConfirm: () => performance.now() >= this._overlayCooldownUntil,
    });

    // Game state
    this.state = 'lobby'; // 'lobby' | 'instructions' | 'countdown' | 'playing' | 'finishCinematic' | 'gameover' | 'victory'
    this._finishCinematic = null;
    this.countdownTimer = 0;
    this._lastCountNum = 3;
    this.instructionsEl = document.getElementById('instructions');
    this.audioEngine = new AudioEngine();
    this.audioCtx = null; // mirrors audioEngine.ctx once created (recorder API)

    // Lobby
    this.lobby = new Lobby({
      onSolo: () => this._onSolo(),
      onMultiplayerReady: (net, mode) => this._onMultiplayerReady(net, mode),
      onLocalReady: (opts) => this._onLocalReady(opts),
      input: this.input,
      controllerManager: this.controllerManager,
    });

    // Background music
    this._musicEl = new Audio('assets/Krampus Workshop.mp3');
    this._musicEl.loop = true;
    this._musicEl.volume = this.lobby.musicVolume;
    // In-game music mute button
    this._musicBtn = document.getElementById('music-btn');
    this._updateMusicBtnIcon();
    this._musicBtn.addEventListener('click', () => {
      this.lobby._toggleMusic();
      this._updateMusicBtnIcon();
    });

    // Volume changes from lobby slider
    this.lobby.onVolumeChanged = (vol) => {
      this._musicEl.volume = vol;
    };

    this.lobby.onMusicChanged = (on) => {
      if (on) {
        this.audioEngine.crossfade(this.audioEngine.musicBus, 1.0, 0.3);
        this._musicEl.play().catch(() => {});
      } else {
        // Ramp to silence first, then pause; avoids the old iOS looping
        // artifact without needing to disconnect the source node.
        if (this.audioEngine.musicBus) {
          this.audioEngine.crossfade(this.audioEngine.musicBus, 0, 0.25);
          setTimeout(() => { try { this._musicEl.pause(); } catch (e) {} }, 280);
        } else {
          this._musicEl.pause();
        }
      }
      this._updateMusicBtnIcon();
    };

    // First-visit: the "Tap to Start" overlay in lobby.js handles autoplay unlock.
    // Returning visitors (overlay skipped): start music on first user interaction.
    if (this.lobby.musicActive) {
      this._musicEl.play().catch(() => {});
    }
    if (!this.lobby._tapOverlay) {
      const startMusic = () => {
        if (this.lobby.musicActive) {
          this._musicEl.play().catch(() => {});
        }
        document.removeEventListener('pointerdown', startMusic, true);
        document.removeEventListener('keydown', startMusic, true);
        document.removeEventListener('click', startMusic, true);
      };
      document.addEventListener('pointerdown', startMusic, true);
      document.addEventListener('keydown', startMusic, true);
      // Gamepad A button triggers el.click() in lobby — synthetic clicks
      // don't fire pointerdown, so listen for click too.
      document.addEventListener('click', startMusic, true);
    }

    // Keyboard shortcuts for music: M = toggle mute, Shift+M = volume slider
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.code === 'KeyV') {
        // Toggle the front-facing PiP "selfie cam" of the bike.
        if (this.frontView) this.frontView.toggle();
        return;
      }
      if (e.code === 'KeyM') {
        if (e.shiftKey) {
          // Shift+M: toggle volume picker in lobby
          if (this.state === 'lobby') {
            if (this.lobby._volumePicker.classList.contains('visible')) {
              this.lobby._hideVolumePicker();
            } else {
              this.lobby._showVolumePicker();
            }
          }
        } else {
          // M: toggle mute
          this.lobby._toggleMusic();
          this._updateMusicBtnIcon();
        }
      }
    });

    // Resize
    window.addEventListener('resize', () => this._onResize());

    // ---- Analytics session init ----
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    analytics.initSession({
      device_type: isMobile ? 'mobile' : 'desktop',
      input_method: null,
      referrer: document.referrer || null,
      is_stoker: !!roomParam,
      joined_via_url: !!roomParam,
      room_code: roomParam ? (roomParam.startsWith('TNDM-') ? roomParam : 'TNDM-' + roomParam) : null,
      google_uid: (this.lobby.auth && this.lobby.auth.isLoggedIn() && this.lobby.auth.getUser())
        ? this.lobby.auth.getUser().serverId || null : null,
      platform: window.steam ? 'steam' : (navigator.userAgent.includes('Electron') ? 'electron' : 'browser'),
      screen_width: window.screen.width,
      screen_height: window.screen.height,
    });
    analytics.setPage('landing');

    // Start loop
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ============================================================
  // LOBBY CALLBACKS
  // ============================================================

  /** True when the player is in demo mode — disabled during playtest. */
  get _isDemo() {
    return false;
  }

  _onSolo() {
    this.mode = 'solo';
    this.bike.applyPreset(this.lobby.selectedPreset);
    this._lobbyBtn.textContent = 'LOBBY';

    // Load saved tuning on every solo start
    this._loadSavedTuning();

    // Tutorial is launched explicitly via "Learn to Ride" button, not auto-forced
    if (this.lobby._forceWizard) {
      this._startTutorialRide();
      return;
    }

    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  _onMultiplayerReady(net, mode) {
    this.mode = mode;
    this.net = net;
    this._lobbyBtn.textContent = 'ROOM';
    this.bike.applyPreset(this.lobby.selectedPreset);

    // The lobby's InputManager may already hold motion permission (granted via
    // a user gesture in the lobby). Our game InputManager is a separate
    // instance, so proactively attach its motion listeners here — iOS grants
    // permission per page, so no new prompt is needed. This guarantees an
    // invited player gets tilt even if the captain starts before they tap.
    if (this.lobby && this.lobby.input && this.lobby.input.motionReady) {
      this.input.ensureMotionListening();
    }

    // Load saved tuning so multiplayer tilt players get tutorial calibration benefit
    this._loadSavedTuning();

    // Setup shared pedal controller
    this.sharedPedal = new SharedPedalController();

    // Setup remote bike state for stoker
    if (mode === 'stoker') {
      this.remoteBikeState = new RemoteBikeState();
    }

    // Network callbacks
    this.net.onPedalReceived = (source, foot) => {
      // Track remote pedal for HUD flash
      this._remoteLastFoot = foot;
      this._remoteLastTapTime = performance.now();
      // Captain feeds stoker taps into shared pedal physics
      if (this.mode === 'captain' && this.sharedPedal) {
        this.sharedPedal.receiveTap(source, foot);
      }
    };

    this.net.onStateReceived = (state) => {
      if (this.mode === 'stoker' && this.remoteBikeState) {
        this.remoteBikeState.pushState(state);
        // Use captain's authoritative timer to prevent drift
        if (state.timerRemaining !== undefined && this.raceManager) {
          this.raceManager.segmentTimeRemaining = state.timerRemaining;
        }
      }
    };

    this.net.onLeanReceived = (leanValue) => {
      this.remoteLean = leanValue;
    };

    this.net.onEventReceived = (eventType) => {
      if (eventType === EVT_COUNTDOWN) {
        // Tutorial stoker: scene already set up in _startTutorialRide —
        // just resume the countdown from captain's calibration finish
        if (this._tutorialActive && (this.state === 'waiting' || this.state === 'countdown')) {
          this.state = 'countdown';
          this.countdownTimer = 3.0;
          document.getElementById('status').textContent = '';
        } else {
          this._startCountdown();
        }
      } else if (eventType === EVT_START) {
        // Stoker receives GO from captain — clear countdown flavor so "1" doesn't stick
        this.state = 'playing';
        if (this.raceManager) this.raceManager.start();
        const flavorNum = document.getElementById('countdown-flavor-num');
        const flavorIcon = document.getElementById('countdown-flavor-icon');
        const flavorText = document.getElementById('countdown-flavor-text');
        if (flavorNum) { flavorNum.textContent = 'GO!'; flavorNum.className = 'tick-go pop'; }
        if (flavorIcon) flavorIcon.textContent = '';
        if (flavorText) flavorText.textContent = '';
        this._playBeep(800, 0.4);
        setTimeout(() => {
          if (this.state === 'playing' && flavorNum) {
            flavorNum.textContent = '';
            flavorNum.className = '';
          }
        }, 1000);
      } else if (eventType === EVT_RESET) {
        this._hideGameOver();
        this._hideVictory();
        // Clear TOO SLOW overlay if showing
        const flash = document.getElementById('timeout-flash');
        if (flash) flash.classList.remove('visible');
        this._stokerTimeoutShown = false;
        // Reset segment timer so countdown restarts from checkpoint
        if (this.raceManager) {
          this.raceManager.resetSegmentTimer(this.bike.distanceTraveled);
        }
        this._resetGame(true);
      } else if (eventType === EVT_GAMEOVER) {
        // Idempotent: captain may retry-send GAMEOVER for reliability.
        if (this.state === 'playing') this._showGameOver(true);
      } else if (eventType === EVT_CHECKPOINT) {
        this._showCheckpointFlash();
      } else if (eventType === EVT_FINISH) {
        // Idempotent: captain may retry-send FINISH for reliability.
        if (this.state === 'victory' || this.state === 'finishCinematic') return;
        // Tutorial: show completion screen instead of normal victory
        if (this._tutorialActive) {
          this._showStokerTutorialComplete();
        } else {
          this._startFinishCinematic(true);
        }
      } else if (eventType === EVT_RETURN_ROOM) {
        this._returnToRoom();
      }
    };

    this.net.onReconnecting = (attempt, max) => {
      if (this.state !== 'lobby') {
        this._armReconnectGrace();
      }
    };

    this.net.onConnected = () => {
      this._hideReconnecting();
      document.getElementById('disconnect-overlay').style.display = 'none';
      // Re-establish media call after data reconnection (only if P2P is already up)
      if (this.mode === 'captain' && this.net.transport === 'p2p') {
        this._initiateMediaCall();
      }
    };

    // P2P upgrade: both sides initiate media call now that PeerJS is available
    this.net.onP2PUpgrade = () => {
      this._mediaRetryCount = 0;
      this._initiateMediaCall();
      analytics.trackEvent('room_p2p_upgrade', { succeeded: true });
      if (this.net.roomCode) {
        analytics.trackRoomUpdate(this.net.roomCode, { p2p_upgrade_succeeded: 1 });
      }
    };

    this.net.onDisconnected = (reason) => {
      this._hideReconnecting();
      this.recorder.clearPartnerStream();
      updateBadgeDisplay('partner-badges', []);
      analytics.trackEvent('room_disconnect', {
        disconnected_role: this.mode === 'captain' ? 'stoker' : 'captain',
        during_ride: this.state === 'playing',
      });
      if (this.net.roomCode) {
        analytics.trackRoomUpdate(this.net.roomCode, { disconnect_count_increment: 1 });
      }
      if (this.state !== 'lobby') {
        this._showDisconnect(reason);
      }
    };

    // Set audio enabled from lobby toggle
    this.net.audioEnabled = this.lobby.audioActive;

    // Media call: when partner's stream arrives (video + audio)
    this.net.onRemoteStream = (remoteStream) => {
      this.recorder.setPartnerStream(remoteStream);
      // If partner camera is off, show avatar instead of black video
      if (!this.lobby._partnerCameraOn && this.lobby._partnerAvatarUrl) {
        this.recorder.showPartnerAvatar(
          this.lobby._avatarCache.get(this.lobby._partnerAvatarUrl) || this.lobby._partnerAvatarUrl
        );
      }
      // Mix remote audio into clip recording (stoker side)
      if (this.net._localMediaStream) {
        this.recorder.addAudioStreams(this.net._localMediaStream, remoteStream);
      } else {
        this.recorder.addAudioStreams(null, remoteStream);
      }
    };

    // Partner profile: avatar + achievements
    this.net.onProfileReceived = (profile) => {
      // Capture authoritative finish stats from captain
      if (profile && profile.type === 'finishStats') {
        this._remoteFinishStats = profile;
        return;
      }
      // Handle tilt status from partner (motion availability only — NOT a
      // steering-capability signal; a desktop partner steers without tilt).
      if (profile && profile.type === 'tiltStatus') {
        this._partnerHasTilt = profile.hasTilt;
        if (this._onPartnerTiltStatus) this._onPartnerTiltStatus(profile.hasTilt);
        return;
      }
      // Stoker confirmed they picked an input on their start screen (captain
      // gate). canSteer reflects whether they have ANY working steering input.
      if (profile && profile.type === 'playerReady') {
        this._stokerReady = true;
        this._partnerHasTilt = profile.hasTilt;
        this._partnerCanSteer = (profile.canSteer !== false);
        this._partnerMethod = profile.method || null;
        if (this.hud) this.hud.partnerCanSteer = this._partnerCanSteer;
        if (this._onStokerReady) this._onStokerReady();
        return;
      }
      // Handle camera toggle from partner during gameplay
      if (profile && profile.type === ROOM_MSG.CAMERA_TOGGLE) {
        if (profile.enabled) {
          // Partner turned camera on — show video if stream exists
          if (this.recorder.partnerVideo && this.recorder.partnerVideo.srcObject) {
            this.recorder.partnerVideo.style.display = 'block';
            this.recorder.partnerVideo.play().catch(() => {});
            if (this.recorder.partnerAvatar) this.recorder.partnerAvatar.style.display = 'none';
            this.recorder.partnerActive = true;
          }
        } else {
          // Partner turned camera off — show avatar
          const avatarUrl = profile.avatar || this.lobby._partnerAvatarUrl;
          if (avatarUrl) this.recorder.showPartnerAvatar(this.lobby._avatarCache.get(avatarUrl) || avatarUrl);
        }
        return;
      }
      // Ignore room sync messages (bikeSync, levelSync, startRide, playGame, difficultySync)
      if (profile && profile.type) return;
      // Show partner avatar if no active video stream
      if (profile.avatar && !this.recorder.partnerActive) {
        this.recorder.showPartnerAvatar(this.lobby._avatarCache.get(profile.avatar) || profile.avatar);
      }
      // Render partner achievement badges
      if (profile.achievements) {
        updateBadgeDisplay('partner-badges', profile.achievements);
      }
      // Capture partner server ID for score attribution
      if (profile.serverId) this._partnerServerId = profile.serverId;
      // Partner bike color for arch indicator
      if (profile.bikeColor) {
        this._partnerBikeColor = profile.bikeColor;
        this.archIndicator.updatePartnerColor(profile.bikeColor);
      }
    };

    // Media call is already established from the room — don't re-initiate.
    // Re-initiating closes the existing call, which kills the working streams
    // and breaks video playback on iOS.
    // The onRemoteStream handler above will handle any new streams if the
    // call is renegotiated.

    // Show partner avatar immediately if their camera is known to be off
    if (!this.lobby._partnerCameraOn && this.lobby._partnerAvatarUrl) {
      this.recorder.showPartnerAvatar(
        this.lobby._avatarCache.get(this.lobby._partnerAvatarUrl) || this.lobby._partnerAvatarUrl
      );
    }

    // Store room role for return-to-room
    this._roomRole = mode;

    // Update partner gauge label to show partner's role
    const partnerTitle = document.querySelector('#partner-gauge .gauge-title');
    if (partnerTitle) partnerTitle.textContent = mode === 'captain' ? 'STOKER' : 'CAPTAIN';

    // Show partner gauge + pedal indicators immediately
    document.getElementById('partner-gauge').style.display = '';
    document.getElementById('partner-pedal-up').style.display = 'flex';
    document.getElementById('partner-pedal-down').style.display = 'flex';

    // Hide side buttons for stoker (only captain/solo control safety/speed/reset)
    if (mode === 'stoker') {
      document.getElementById('side-buttons').style.display = 'none';
    }

    // Show connection badge (suppress gamepad badge to avoid overlap)
    document.getElementById('conn-badge').style.display = 'block';
    const connGp = document.getElementById('conn-gamepad');
    if (connGp) connGp.style.display = this.input.gamepadConnected ? 'inline' : 'none';
    this.input.suppressGamepadBadge = true;
    const gpBadge = document.getElementById('gamepad-badge');
    if (gpBadge) gpBadge.style.display = 'none';

    // Check for multiplayer tutorial (Learn to Ride together)
    if (this.lobby._forceWizard) {
      this._startTutorialRide();
      return;
    }

    // Show instructions
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  /**
   * Enter local multiplayer mode. Called from the lobby when P2 clicks JOIN RIDE
   * on the host room page. Sets up a second InputManager / BalanceController for P2
   * and transitions to the pre-ride instructions screen.
   *
   * @param {Object} opts
   * @param {InputManager} opts.inputP2 — pre-constructed P2 input manager
   * @param {'gamepad'|'keyboard'} opts.sourceType — how P2 is driving input
   */
  _onLocalReady({ inputP2, sourceType }) {
    this.mode = 'local';
    this.net = null;
    this.inputP2 = inputP2;
    this._localP2Type = sourceType;
    this.balanceCtrlP2 = new BalanceController(inputP2);
    this._lobbyBtn.textContent = 'LOBBY';
    this.bike.applyPreset(this.lobby.selectedPreset);
    this._loadSavedTuning();

    // Shared pedal controller: P1 taps as 'captain', P2 taps as 'stoker'.
    this.sharedPedal = new SharedPedalController();

    // If P2 is keyboard, P1 must release its keyboard subscription so random
    // typing doesn't double-fire into both players.
    if (sourceType === 'keyboard') {
      this.input.keyboardActive = false;
      this.input.keys = {};
    }

    // Reset edge-detect + remote-tap state for both players
    this._mpPrevUp = false;
    this._mpPrevDown = false;
    this._mpPrevUpP2 = false;
    this._mpPrevDownP2 = false;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this.remoteLean = 0;

    // Partner gauge: show P2 lean + pedal indicators (reuses the online MP HUD)
    document.getElementById('partner-gauge').style.display = '';
    document.getElementById('partner-pedal-up').style.display = 'flex';
    document.getElementById('partner-pedal-down').style.display = 'flex';
    const partnerTitle = document.querySelector('#partner-gauge .gauge-title');
    if (partnerTitle) partnerTitle.textContent = 'PLAYER 2';

    // Tag the body so local-mode-specific CSS (contribution bar recolor, etc.)
    // can take effect. Cleared in _returnToLobby.
    document.body.classList.add('mode-local');

    // Route haptics to BOTH players in local MP so shared events (crash,
    // checkpoint, off-road, finish) rumble each controller independently.
    setHapticSources([this.input, this.inputP2]);

    // P2's gyro comes in via the ControllerManager's HID pool — the
    // matching entry is already attached to the P2 slot at claim time,
    // and its SensorFusion has been calibrating since the device was
    // paired at boot. Nothing to do here.
    if (sourceType === 'gamepad' && this.inputP2) {
      this.inputP2.motionEnabled = true;
      this.inputP2.startTiltCalibration();
    }

    // Show instructions (tap to start)
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  // ============================================================
  // START / COUNTDOWN
  // ============================================================

  _setupStartHandler() {
    // Invited player (stoker) in online multiplayer: present an explicit input
    // choice instead of a bare "tap to start". This makes their steering input
    // deliberate, and on mobile the tap on "Tilt" is the user gesture that
    // grants motion permission — fixing the case where the captain's countdown
    // would otherwise start before they ever enabled motion. The choice doubles
    // as the readiness signal the captain waits on.
    if (this.mode === 'stoker') {
      this._stokerChooseInputAndReady();
      return;
    }

    let started = false;
    const doStart = async () => {
      if (this.state !== 'instructions' || started) return;
      started = true;

      // Request iOS motion permission on first tap
      if (this.input.needsMotionPermission) {
        await this.input.requestMotionPermission();
      }

      // On mobile, wait briefly for motion events to arrive
      if (isMobile && !this.input.motionEnabled && !this.input.gyroConnected) {
        await new Promise(r => {
          const check = () => { if (this.input.motionEnabled) return r(); };
          check();
          const iv = setInterval(check, 100);
          setTimeout(() => { clearInterval(iv); r(); }, 1500);
        });
        if (!this.input.motionEnabled) {
          if (this.mode === 'solo') {
            // Solo: block gameplay — tilt is required to steer
            started = false;
            this.instructionsEl.classList.add('hidden');
            const action = await this._showMotionFixOverlay();
            if (action === 'back' || !this.input.motionEnabled) {
              this._returnToRoom();
              return;
            }
            this.instructionsEl.classList.remove('hidden');
          } else {
            // Multiplayer: tell partner we have no tilt, then check if they do
            this.net.sendProfile({ type: 'tiltStatus', hasTilt: false });
            // Wait briefly for partner's tilt status response
            const partnerHasTilt = await new Promise(r => {
              // If we already know partner has tilt, resolve immediately
              if (this._partnerHasTilt) return r(true);
              // Listen for partner's tiltStatus message
              const prev = this._onPartnerTiltStatus;
              this._onPartnerTiltStatus = (has) => { this._onPartnerTiltStatus = prev; r(has); };
              // Timeout: assume partner has tilt if no response (they may be on desktop/keyboard)
              setTimeout(() => r(this._partnerHasTilt !== false), 3000);
            });
            if (partnerHasTilt) {
              const statusEl = document.getElementById('status');
              statusEl.textContent = 'Tilt not available — your partner will steer';
              statusEl.style.color = '#ffaa00';
              await new Promise(r => setTimeout(r, 2000));
              statusEl.textContent = '';
            } else {
              // Neither player has tilt — block gameplay
              started = false;
              this.instructionsEl.classList.add('hidden');
              const action = await this._showMotionFixOverlay();
              if (action === 'back' || !this.input.motionEnabled) {
                this._returnToRoom();
                return;
              }
              this.instructionsEl.classList.remove('hidden');
              // Notify partner we fixed it
              this.net.sendProfile({ type: 'tiltStatus', hasTilt: true });
            }
          }
        }
      }

      // In multiplayer, notify partner of our tilt status
      if (this.net && this.input.motionEnabled) {
        this.net.sendProfile({ type: 'tiltStatus', hasTilt: true });
      }

      // Remove document-level start handlers now that we've started
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('click', handler);

      // In multiplayer, only captain initiates countdown.
      // (Stokers don't reach doStart — they ready up via the input-choice
      // overlay in _stokerChooseInputAndReady. This branch is a safety net.)
      if (this.mode === 'stoker') {
        this.instructionsEl.classList.add('hidden');
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'Waiting for captain...';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
        return;
      }

      // Captain: don't start until the stoker has tapped through their start
      // prompt (so they were given the motion opportunity) and confirmed their
      // status to us. They can still play without motion if they declined —
      // we only gate on them being READY, not on them having tilt. A timeout
      // prevents a backgrounded/AFK partner from hard-locking the start.
      if (this.mode === 'captain' && this.net && this.net.connected) {
        await this._awaitStokerReady();
      }

      this._startCountdown();
    };

    const handler = (e) => {
      e.preventDefault();
      doStart();
    };
    document.addEventListener('touchstart', handler, { passive: false });
    document.addEventListener('click', handler);

    // Gamepad button polling to start
    const pollGamepadStart = () => {
      if (this.state !== 'instructions' || started) return;
      if (this.input.gamepadConnected) {
        const gp = this.input.getGamepadState();
        if (gp) {
          for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) {
              doStart();
              return;
            }
          }
        }
      }
      requestAnimationFrame(pollGamepadStart);
    };
    requestAnimationFrame(pollGamepadStart);
  }

  // Stoker flow: show the input-choice overlay, then signal readiness to the
  // captain with the chosen method and whether we can steer at all.
  async _stokerChooseInputAndReady() {
    // On reconnect / re-entry within the same session (e.g. the phone locked
    // and reopened), don't re-ask how to steer if we already picked a
    // still-valid input — just re-confirm readiness. Avoids a redundant
    // overlay (and any motion prompt) when we already hold a working handle.
    if (this._chosenInputMethod && this._inputMethodValid(this._chosenInputMethod)) {
      const method = this._chosenInputMethod;
      this._readyWithInput({
        method,
        canSteer: method !== 'none',
        hasTilt: method === 'motion' && !!this.input.motionEnabled,
      });
      return;
    }

    // On mobile, try to silently re-establish motion if permission was granted
    // in a prior session (iOS persists it per origin). requestPermission()
    // resolves 'granted' WITHOUT a prompt when already allowed; a non-gesture
    // call when NOT yet granted just rejects (no prompt). So this either brings
    // motion alive — letting us skip the redundant choice — or harmlessly fails
    // and we fall through to the overlay (whose tap then grants permission).
    if (isMobile && !this.input.motionEnabled) {
      try { await this.input.requestMotionPermission(); } catch (_) {}
      this.input.ensureMotionListening();
      await this._waitForMotion(600);
    }

    // First entry: if the lobby already established a valid steering input
    // (toggles / connected controller / motion granted), don't re-ask — that
    // choice is redundant with the lobby. Only fall through to the overlay when
    // there's no working input yet, which on mobile means motion still needs a
    // tap gesture to grant permission.
    const detected = this._detectStokerInput();
    if (detected) {
      this._chosenInputMethod = detected;
      this._readyWithInput({ method: detected, canSteer: true, hasTilt: detected === 'motion' });
      return;
    }

    const choice = await this._showStokerInputChoice();
    this._chosenInputMethod = choice.method;
    this._readyWithInput(choice);
  }

  // Resolve once motion events are firing, or after `ms` (whichever first).
  _waitForMotion(ms) {
    return new Promise((resolve) => {
      if (this.input.motionEnabled) return resolve();
      const iv = setInterval(() => {
        if (this.input.motionEnabled) { clearInterval(iv); clearTimeout(t); resolve(); }
      }, 50);
      const t = setTimeout(() => { clearInterval(iv); resolve(); }, ms);
    });
  }

  // Best-effort detection of the steering input the invited player already has
  // working (established via the lobby). Returns null only when there's no
  // usable input yet — the case that genuinely needs the choice overlay.
  _detectStokerInput() {
    if (isMobile) {
      if (this.input.motionEnabled) return 'motion';
      if (this.input.gamepadConnected) return 'gamepad';
      if (this.input.gyroConnected) return 'gyro';
      return null; // needs the overlay (grant motion, or "I can't")
    }
    // Desktop always has at least the keyboard, so the overlay is never needed.
    if (this.input.gyroConnected) return 'gyro';
    if (this.input.gamepadConnected) return 'gamepad';
    return 'keyboard';
  }

  // Is the given steering method currently usable (valid handle present)?
  _inputMethodValid(method) {
    switch (method) {
      case 'motion':   return !!this.input.motionEnabled;
      case 'gyro':     return !!this.input.gyroConnected;
      case 'gamepad':  return !!this.input.gamepadConnected;
      case 'keyboard': return true;
      case 'none':     return true; // deliberately not steering
      default:         return false;
    }
  }

  // Tell the captain we're ready (with our chosen method) and wait for the ride.
  _readyWithInput(choice) {
    if (this.net) {
      this.net.sendProfile({ type: 'playerReady', method: choice.method, canSteer: choice.canSteer, hasTilt: choice.hasTilt });
      // Keep legacy tiltStatus so the captain's in-game "partner steers" checks
      // (and any older client) still see our motion availability.
      this.net.sendProfile({ type: 'tiltStatus', hasTilt: choice.hasTilt });
    }
    this.instructionsEl.classList.add('hidden');
    const statusEl = document.getElementById('status');
    if (statusEl) {
      statusEl.textContent = 'Waiting for captain…';
      statusEl.style.color = '#ffffff';
      statusEl.style.fontSize = '';
    }
  }

  // Overlay letting the invited player pick how they steer. Resolves with
  // { method, canSteer, hasTilt }. Reuses the overlay gamepad-nav system so a
  // gamepad-only desktop player can select with the D-pad + A.
  _showStokerInputChoice() {
    const options = [];
    if (isMobile) {
      options.push({ method: 'motion', label: '📱 Tilt to steer', desc: 'Use your phone’s motion' });
      if (this.input.gamepadConnected) options.push({ method: 'gamepad', label: '🎮 Gamepad', desc: 'Steer with the stick' });
      options.push({ method: 'none', label: '🚫 I can’t — partner steers', desc: 'Pedal only' });
    } else {
      options.push({ method: 'keyboard', label: '⌨️ Keyboard', desc: 'A / D or ← →' });
      if (this.input.gamepadConnected) options.push({ method: 'gamepad', label: '🎮 Gamepad', desc: 'Steer with the stick' });
      if (this.input.gyroConnected) options.push({ method: 'gyro', label: '🌀 Controller gyro', desc: 'Tilt your controller' });
    }

    const overlay = document.createElement('div');
    overlay.id = 'input-choice-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;';
    const btnRows = options.map((o, i) =>
      '<button class="input-choice-btn" data-idx="' + i + '" style="display:block;width:100%;margin:8px 0;padding:14px 18px;border-radius:10px;border:none;background:#2a2a4e;color:#fff;font-family:inherit;font-size:1.05em;font-weight:bold;cursor:pointer;text-align:left;">' +
        o.label + '<div style="font-size:0.75em;font-weight:normal;opacity:0.7;margin-top:2px;">' + o.desc + '</div>' +
      '</button>'
    ).join('');
    overlay.innerHTML =
      '<div style="background:#1a1a2e;border-radius:16px;padding:24px 28px;max-width:340px;width:86%;text-align:center;color:#fff;font-family:inherit;">' +
        '<div style="font-size:1.3em;font-weight:bold;margin-bottom:6px;color:#a6f;">How will you steer?</div>' +
        '<div id="input-choice-note" style="font-size:0.9em;line-height:1.4;margin-bottom:16px;opacity:0.85;">Pick your input to join the ride.</div>' +
        btnRows +
      '</div>';
    document.body.appendChild(overlay);

    this._inputChoiceOpen = true;
    this._overlayCooldownUntil = performance.now() + 350;
    const btnEls = Array.from(overlay.querySelectorAll('.input-choice-btn'));
    this._setOverlayButtons(btnEls);

    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        this._inputChoiceOpen = false;
        this._clearOverlayButtons();
        overlay.remove();
        resolve(result);
      };
      const noteEl = overlay.querySelector('#input-choice-note');
      btnEls.forEach((btn) => {
        btn.addEventListener('click', async () => {
          const o = options[Number(btn.dataset.idx)];
          if (o.method === 'motion') {
            // Always (re)request from THIS tap — it's a guaranteed user gesture.
            // Don't gate on needsMotionPermission: a prior non-gesture attempt
            // (e.g. the lobby's auto-join) may have failed without prompting,
            // and iOS only honors requestPermission() from a real gesture.
            if (!this.input.motionEnabled) {
              await this.input.requestMotionPermission();
              this.input.ensureMotionListening();
            }
            // Wait briefly for sensor events to confirm motion actually works.
            await this._waitForMotion(1500);
            if (this.input.motionEnabled) {
              finish({ method: 'motion', canSteer: true, hasTilt: true });
            } else if (noteEl) {
              noteEl.textContent = 'Couldn’t enable motion — check browser settings, or pick another option.';
              noteEl.style.color = '#ffaa00';
            }
            return;
          }
          if (o.method === 'none') {
            finish({ method: 'none', canSteer: false, hasTilt: false });
            return;
          }
          // keyboard / gamepad / gyro — steering arbitrates from live input.
          finish({ method: o.method, canSteer: true, hasTilt: false });
        });
      });
    });
  }

  // Captain-side gate: wait for the stoker to confirm they've tapped through
  // their start prompt (and thus had the chance to enable motion). Resolves
  // immediately if they're already ready; otherwise shows a waiting status and
  // falls through after a timeout so an AFK/backgrounded partner can't lock us.
  async _awaitStokerReady() {
    const statusEl = document.getElementById('status');
    if (!this._stokerReady) {
      // Hide the start overlay so the waiting status is visible.
      this.instructionsEl.classList.add('hidden');
      if (statusEl) {
        statusEl.textContent = 'Waiting for partner to be ready…';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
      }
      const STOKER_READY_TIMEOUT_MS = 30000;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this._onStokerReady = null;
          resolve();
        };
        this._onStokerReady = finish;
        const timer = setTimeout(finish, STOKER_READY_TIMEOUT_MS);
      });
      // Briefly confirm the partner's readiness to the captain before we go.
      this._showPartnerReadyStatus();
      await new Promise((r) => setTimeout(r, 1000));
    } else {
      this._showPartnerReadyStatus();
    }
  }

  // Show the captain a short confirmation of the partner's readiness and how
  // they steer. Distinguishes "can't steer" (you steer) from a working input.
  _showPartnerReadyStatus() {
    const statusEl = document.getElementById('status');
    if (!statusEl) return;
    if (this._partnerCanSteer === false) {
      statusEl.textContent = 'Partner can’t steer — you steer';
      statusEl.style.color = '#ffaa00';
    } else {
      const labels = { motion: 'Tilt', gyro: 'Gyro', gamepad: 'Gamepad', keyboard: 'Keyboard' };
      const m = labels[this._partnerMethod];
      statusEl.textContent = m ? ('Partner ready — ' + m) : 'Partner ready';
      statusEl.style.color = '#00cc66';
    }
  }

  _startCountdown() {
    this.state = 'countdown';
    this.countdownTimer = 3.0;
    this._hideGameOver();
    this._hideVictory();
    this.instructionsEl.classList.add('hidden');

    // Show in-game music button
    this._musicBtn.style.display = 'block';
    this._updateMusicBtnIcon();

    // Apply difficulty preset and create DDA manager
    const difficultyName = this.lobby.selectedDifficulty || 'adventurous';
    applyDifficulty(difficultyName);
    this.ddaManager = new DDAManager(difficultyName);
    this._assistWeight = 0;

    // Apply auto-speed from difficulty preset (Chill/Tutorial cruise automatically)
    if (TUNE.autoSpeed != null) {
      this.autoSpeed = TUNE.autoSpeed;
      this.speedBtn.className = 'side-btn ' + (this.autoSpeed ? 'speed-on' : 'speed-off');
      this.speedBtn.textContent = this.autoSpeed ? 'ON\nSPEED' : 'SPEED';
    }

    // Reset background adaptation state for fresh ride
    this._adaptState = null;

    // Recenter THEN recapture bias for a new ride. Two layered protections:
    //
    // 1. recenterGyro() clears motionOffset, _gyroRollAccum, _smoothedLean,
    //    motionLean, and calls fusion.reset() (orientation → identity).
    //    Without it, orientation drift accumulated during lobby browsing
    //    can leave motionLean saturated at ±1.0 — joystick input then sums
    //    with the saturated value, clamps to 0, and the player can only
    //    neutralize the pull, not flip past center (#285).
    // 2. calibrateGyro() restarts the slot's gyro-rate bias capture
    //    (~1.5s). The 3s countdown overlaps the window, so the user's
    //    stationary hold gives a clean bias for orientation integration.
    //    Without it, a bias baked during a shaky boot pickup causes rapid
    //    drift → bike oscillates extreme L/R.
    //
    // Note: fusion.startCalibration() does NOT reset orientation — only
    // fusion.reset() does. So step 1 is required to clear saturated state;
    // step 2 alone is not sufficient. _resetGame already runs this same
    // pair (recenter then enter countdown which calibrates); duplicating
    // here is harmless because recenterGyro is idempotent.
    //
    // Skip both if tutorial calibration flow already ran (better data).
    if (this.input.motionEnabled && !this._calibHoldSamples) {
      if (this.input.gyroConnected) {
        this.input.recenterGyro();
        this.input.calibrateGyro();
      }
      this.input.startTiltCalibration();
    }
    if (this.inputP2 && this.inputP2.motionEnabled) {
      if (this.inputP2.gyroConnected) {
        this.inputP2.recenterGyro();
        this.inputP2.calibrateGyro();
      }
      this.inputP2.startTiltCalibration();
    }
    // Prime P2's held-detection stamp so the _updateLocal isActive() gate
    // doesn't zero out their gyro lean on frame 1. The stamp was last set
    // at InputManager construction (JOIN RIDE in the lobby); if >10s of
    // level browsing + instructions elapsed before countdown starts, P2
    // would already be "inactive" and their contribution would hard-gate
    // to 0 until their first trigger press, then snap in and jerk the
    // bike. Re-priming here covers the two-human case without weakening
    // the one-human desk-controller protection — that still self-corrects
    // after 10s of trigger silence.
    if (this.inputP2) this.inputP2._markActive();

    const statusEl = document.getElementById('status');
    statusEl.textContent = '';
    this._lastCountNum = 3;

    // Create race manager + contribution tracker + collectibles from selected level
    const level = this.lobby.selectedLevel;
    // Show level icon + flavor text + countdown number
    const flavorIcon = document.getElementById('countdown-flavor-icon');
    const flavorText = document.getElementById('countdown-flavor-text');
    const flavorNum = document.getElementById('countdown-flavor-num');
    if (flavorIcon) flavorIcon.textContent = level.icon;
    if (flavorText) flavorText.textContent = level.description;
    if (flavorNum) {
      flavorNum.textContent = '3';
      flavorNum.className = 'tick-3 pop';
    }
    this.raceManager = new RaceManager(level);
    this.hud.raceManager = this.raceManager;
    this.balanceCtrl.resetSteerFrames();
    if (this.balanceCtrlP2) this.balanceCtrlP2.resetSteerFrames();
    this.contributionTracker = new ContributionTracker(this.mode);
    if (this.collectibleManager) this.collectibleManager.destroy();
    this.collectibleManager = new CollectibleManager(this.scene, this.world.roadPath, level, this.camera, difficultyName);
    if (this.obstacleManager) this.obstacleManager.destroy();
    this.obstacleManager = new ObstacleManager(this.scene, this.world.roadPath, level, this.camera, difficultyName);

    // Wire up collectibles total for analytics
    this.raceManager.setCollectiblesTotal(this.collectibleManager.getTotalItems());

    // Analytics: start ride tracking (only if no ride is already active —
    // _startCountdown is also called on restart-from-beginning after early crashes)
    if (!analytics.getCurrentRideId()) {
      analytics.setPage('ride');
      analytics.startRide({
        level: level.id,
        role: this.mode,
        room_code: this.net ? this.net.roomCode : null,
        difficulty: difficultyName,
        bike_preset: this.lobby.selectedPresetKey,
        steering_feel: TUNE.steeringFeel,
      });
    }
    this.hud.initProgress(level);
    this.hud.initTimer();
    // Show initial segment budget during countdown
    const firstTarget = this.raceManager.checkpoints.length > 0 ? this.raceManager.checkpoints[0] : this.raceManager.raceDistance;
    const initialBudget = this.raceManager._segmentBudget(firstTarget);
    this.hud.updateTimer(initialBudget, initialBudget);
    this.hud.showCollectibles(level);
    this.world.setRaceMarkers(level, this.camera);

    // Tutorial: place all items from all phases so they're visible ahead
    if (level.isTutorial && this._tutorialActive) {
      this._initAllTutorialItems();
    }


    // Setup arch tilt indicator (only for motion/gyro input)
    const playerColor = this._getFrameColor(this.lobby.selectedPreset);
    if (this.input.motionEnabled || this.input.gyroConnected) {
      const partnerColor = this._partnerBikeColor || '#888888';
      this.archIndicator.setup(this.mode, playerColor, partnerColor);
    }

    // Hot air balloons in the bike's color
    this.world.setBalloonColor(playerColor);

    // Show contribution bar in multiplayer
    if (this.mode !== 'solo') {
      this._contribBar.style.display = 'block';
    } else {
      this._contribBar.style.display = 'none';
    }

    // Init audio before recording so beeps are captured.
    // Eagerly resume + play silent buffer to warm up iOS audio pipeline
    // (avoids 2-3s delay on first real sound).
    this.audioEngine.ensureContext();
    this.audioEngine.resume();
    this.audioEngine.warmup();
    this.audioCtx = this.audioEngine.ctx; // kept as an alias for the recorder

    // Start recording + selfie immediately so they're visible during countdown.
    // Passing the engine lets startBuffer attach its mix destination directly.
    this.recorder.setLabels(this.mode);
    this.recorder.startBuffer(this.audioCtx, this.lobby.audioActive, this.audioEngine);
    if (this.lobby.cameraActive) {
      this.recorder.startSelfie(this.net && this.net._localMediaStream);
    } else if (this.lobby.auth && this.lobby.auth.isLoggedIn()) {
      const user = this.lobby.auth.getUser();
      if (user && user.avatar) this.recorder.showAvatarPip(this.lobby._avatarCache.get(user.avatar) || user.avatar);
    }

    // Route background music through the shared audio engine so it lands on
    // the music bus (duckable + captured by the recorder automatically).
    this.audioEngine.connectMusicElement(this._musicEl);
    // Play music if enabled
    if (this.lobby.musicActive) {
      this._musicEl.play().catch(() => {});
    }
    // St2 — duck music during gameplay vs the lobby.
    this.audioEngine.duckMusic(0.55, 0.8);
    // Sp3 — start procedural bike motion loop (silent until speed rises).
    this.audioEngine.startBike();

    this._playBeep(400, 0.15);

    // Captain notifies stoker (suppressed during tutorial calibration)
    if (this.mode === 'captain' && this.net && !this._suppressCountdownEvent) {
      this.net.sendEvent(EVT_COUNTDOWN);
    }

    // Send profile to partner (avatar + achievements)
    this._sendProfile();

    // Show calibration tip once per session during first countdown
    if (!this._shownCalibTip && (this.input.motionEnabled || this.input.gyroConnected)) {
      this._shownCalibTip = true;
      const tip = document.getElementById('calib-tip');
      if (tip) {
        tip.style.display = 'block';
        setTimeout(() => { tip.style.display = 'none'; }, 4000);
      }
    }
  }

  _updateCountdown(dt) {
    this.countdownTimer -= dt;
    const flavorNum = document.getElementById('countdown-flavor-num');

    if (this.countdownTimer <= 0) {
      this.state = 'playing';
      // Show "GO!" in the flavor block
      const flavorIcon = document.getElementById('countdown-flavor-icon');
      const flavorText = document.getElementById('countdown-flavor-text');
      if (flavorIcon) flavorIcon.textContent = '';
      if (flavorText) flavorText.textContent = '';
      if (flavorNum) {
        flavorNum.textContent = 'GO!';
        flavorNum.className = 'tick-go';
        // Re-trigger pop animation synced with beep
        flavorNum.offsetHeight;
        flavorNum.classList.add('pop');
      }
      this._playBeep(800, 0.4);
      if (this.raceManager) this.raceManager.start();

      // Update analytics input method now that motion/gyro has had time to activate
      const steerSrc = this.balanceCtrl.getSteerSource();
      if (steerSrc && steerSrc !== 'none') {
        const methodMap = { keyboard: 'keyboard', gamepad: 'gamepad_stick', motion: 'tilt', 'gamepad-gyro': 'gamepad_gyro' };
        analytics.setInputMethod(methodMap[steerSrc] || steerSrc);
      }

      // Captain sends EVT_START to stoker
      if (this.mode === 'captain' && this.net) {
        this.net.sendEvent(EVT_START);
      }

      setTimeout(() => {
        if ((this.state === 'playing' || this.state === 'countdown') && flavorNum) {
          flavorNum.textContent = '';
          flavorNum.className = '';
        }
      }, 1000);
      return;
    }

    const num = Math.ceil(this.countdownTimer);
    if (num !== this._lastCountNum) {
      if (flavorNum) {
        flavorNum.className = 'tick-' + num;
        flavorNum.textContent = '' + num;
        // Re-trigger pop animation synced with beep
        flavorNum.offsetHeight;
        flavorNum.classList.add('pop');
      }
      this._lastCountNum = num;
      this._playBeep(400, 0.15);
    }
  }

  // Thin wrappers over audioEngine so existing call sites keep working. The
  // engine routes everything through the sfx bus and the recorder tap.
  _playBeep(freq, duration) {
    this.audioEngine.tone(freq, duration, { type: 'triangle', gain: 0.14 });
  }

  _playChime(freq, duration) {
    this.audioEngine.chime(freq, duration);
  }

  // Ti1 — noise-based crash impact used for crashes and tree hits.
  _playCrash(intensity = 1) {
    this.audioEngine.crash(intensity);
  }

  _onTimerExpired() {
    // Analytics: timeout ride event
    if (this.bike && this.raceManager) {
      const cpIdx = this.raceManager.passedCheckpoints.size;
      analytics.trackRideEvent('timeout', this.bike.distanceTraveled, {
        checkpoint_index: cpIdx,
        time_elapsed_ms: this.raceManager.getElapsedMs(),
        input_method: analytics.getInputMethod(),
      });
      analytics.flushRideEvents();
    }

    // DDA: timeout counts as a failure
    if (this.ddaManager && this.mode !== 'stoker') {
      let checkpointD = 0;
      if (this.raceManager && this.raceManager.passedCheckpoints.size > 0) {
        checkpointD = Math.max(...this.raceManager.passedCheckpoints);
      }
      this.ddaManager.recordFailure(checkpointD);
    }

    // Dismiss the countdown overlay immediately so "1" doesn't stick
    this.hud.hideTimer();

    // Show "TOO SLOW!" overlay, pause, then reset to last checkpoint
    const flash = document.getElementById('timeout-flash');
    flash.classList.remove('visible');
    void flash.offsetWidth; // force reflow to restart animations
    flash.classList.add('visible');
    this._playCrash(0.9);

    // Freeze gameplay during the pause
    this.state = 'gameover';

    setTimeout(() => {
      flash.classList.remove('visible');
      this.state = 'playing';
      // Reset segment timer before _resetGame so it reinits properly
      if (this.raceManager) {
        this.raceManager.resetSegmentTimer(this.bike.distanceTraveled);
      }
      this._resetGame();
    }, 2000);
  }

  _showCheckpointFlash() {
    // Animated text overlay
    const el = document.getElementById('checkpoint-flash');
    if (el) {
      el.classList.remove('animate');
      void el.offsetWidth; // force reflow to restart animation
      el.classList.add('animate');
    }
    // Track for recording compositor
    this._checkpointFlashTime = performance.now();
    // Rising chime using the shared Tandemonium motif (Re4)
    this._playChime(MOTIF.C5, 0.25);
    setTimeout(() => this._playChime(MOTIF.E5, 0.25), 100);
    setTimeout(() => this._playChime(MOTIF.G5, 0.35), 200);
  }

  // ============================================================
  // RESET / DISCONNECT / RETURN TO LOBBY
  // ============================================================

  _resetGame(fromRemote = false, fromBeginning = false) {
    // Analytics: track reset/restart
    analytics.trackRideEvent('reset', this.bike ? this.bike.distanceTraveled : 0, {
      from_beginning: fromBeginning,
      checkpoint: this.raceManager ? this.raceManager.passedCheckpoints.size : 0,
    });

    // Resume from last checkpoint if the race was in progress (not finished/victory)
    let checkpointD = 0;
    if (!fromBeginning && this.raceManager &&
        !this.raceManager.finished && this.raceManager.passedCheckpoints.size > 0) {
      checkpointD = Math.max(...this.raceManager.passedCheckpoints);
    }

    if (checkpointD > 0) {
      this.bike.resetToDistance(checkpointD);
    } else {
      this.bike.fullReset();
    }

    // Reset segment timer for current segment on checkpoint restart
    if (this.raceManager && checkpointD > 0) {
      this.raceManager.restartCount++;
      this.raceManager.resetSegmentTimer(checkpointD);
    }

    // DDA: apply invisible adjustments on restart
    if (this.ddaManager && this.mode !== 'stoker') {
      this.ddaManager.applyInvisibleAdjustments();
    }

    // Reset collectibles collected after this checkpoint
    if (this.collectibleManager && checkpointD > 0) {
      this.collectibleManager.resetToCheckpoint(checkpointD);
      if (this.raceManager) {
        this.raceManager.collectiblesCount = this.collectibleManager.collected;
      }
      this.hud.updateCollectibles(this.collectibleManager.collected, this.collectibleManager.getTotalItems());
    }

    this.grassParticles.clear();
    this._stokerWasFallen = false;
    this._remoteFinishStats = null;

    // Clear TOO SLOW overlay if stuck
    const flash = document.getElementById('timeout-flash');
    if (flash) flash.classList.remove('visible');
    this._stokerTimeoutShown = false;

    if (this.mode === 'solo') {
      this.pedalCtrl = new PedalController(this.input);
    } else if (this.sharedPedal) {
      this.sharedPedal = new SharedPedalController();
    }

    this.chaseCamera.initialized = false;

    // Recenter gyro to absorb any orientation drift from the previous game.
    // Without this, quaternion integration errors (especially over BT where
    // report timing is jittery) accumulate across games and cause a persistent
    // pull to one side. Full re-calibration (150 samples, ~1.5s) would
    // conflict with the 3s countdown — recenter is instant and the continuous
    // stillness calibration keeps the bias fresh in the background.
    if (this.input.gyroConnected) {
      this.input.recenterGyro();
    }
    // Local multiplayer: recenter P2's gyro too
    if (this.inputP2 && this.inputP2.gyroConnected) {
      this.inputP2.recenterGyro();
    }
    // Mobile tilt calibration (10 samples, ~167ms)
    if (this.input.motionEnabled) {
      this.input.startTiltCalibration();
    }

    // Refresh HUD so speed/distance reflect the reset state during countdown
    this.hud.update(this.bike, this.input, this.pedalCtrl || this.sharedPedal, 0);

    // Captain always broadcasts reset so stoker also resets.
    // Stoker receiving EVT_RESET calls _resetGame(fromRemote=true) which won't re-send.
    if (this.net && this.mode === 'captain') {
      this.net.sendEvent(EVT_RESET);
    }

    if (checkpointD > 0) {
      this._resumeCountdown();
    } else {
      this._startCountdown();
    }
  }

  _resumeCountdown() {
    this.state = 'countdown';
    this.countdownTimer = 3.0;
    this.instructionsEl.classList.add('hidden');

    const statusEl = document.getElementById('status');
    statusEl.textContent = '';
    statusEl.style.fontSize = '';
    this._lastCountNum = 3;

    // Show animated countdown "3" in flavor overlay (same as _startCountdown)
    const flavorNum = document.getElementById('countdown-flavor-num');
    if (flavorNum) {
      flavorNum.textContent = '3';
      flavorNum.className = 'tick-3 pop';
    }

    // Re-show the segment timer (hidden by _onTimerExpired / _showGameOver)
    if (this.raceManager) {
      this.hud.initTimer();
      this.hud.updateTimer(this.raceManager.segmentTimeRemaining, this.raceManager.segmentTimeTotal);
    }

    this._playBeep(400, 0.15);

    if (this.mode === 'captain' && this.net) {
      this.net.sendEvent(EVT_COUNTDOWN);
    }
  }

  // Debounce: arm a grace timer that surfaces the reconnecting UI only if the
  // drop hasn't self-healed by then. Brief partner phone-locks recover within
  // the window, so the captain never sees a freeze-flash for them (#320).
  _armReconnectGrace() {
    if (this._reconnecting) return;        // already shown
    if (this._reconnectGraceTimer) return; // already pending
    this._reconnectGraceTimer = setTimeout(() => {
      this._reconnectGraceTimer = null;
      this._showReconnecting();
    }, RECONNECT_GRACE_MS);
  }

  _showReconnecting() {
    this._reconnecting = true;
    document.getElementById('conn-badge').classList.add('reconnecting');
  }

  _hideReconnecting() {
    if (this._reconnectGraceTimer) {
      clearTimeout(this._reconnectGraceTimer);
      this._reconnectGraceTimer = null;
    }
    this._reconnecting = false;
    document.getElementById('conn-badge').classList.remove('reconnecting');
  }

  _showMotionFixOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'motion-fix-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;';
    overlay.innerHTML =
      '<div style="background:#1a1a2e;border-radius:16px;padding:24px 28px;max-width:340px;text-align:center;color:#fff;font-family:inherit;">' +
        '<div style="font-size:1.3em;font-weight:bold;margin-bottom:12px;color:#ffaa00;">Tilt Sensor Not Detected</div>' +
        '<div style="font-size:0.95em;line-height:1.5;margin-bottom:16px;">' +
          'This game requires your phone\'s motion sensor to steer.<br><br>' +
          '<b>Try these fixes:</b><br>' +
          '1. Check browser settings &rarr; enable "Motion &amp; Orientation"<br>' +
          '2. Try <b>Safari</b> (iPhone) or <b>Chrome</b> (Android)<br>' +
          '3. Restart your browser and try again' +
        '</div>' +
        '<div style="display:flex;gap:12px;justify-content:center;">' +
          '<button id="btn-motion-retry" style="padding:10px 20px;border-radius:8px;border:none;background:#44ff66;color:#000;font-weight:bold;font-size:1em;cursor:pointer;">Try Again</button>' +
          '<button id="btn-motion-back" style="padding:10px 20px;border-radius:8px;border:none;background:#444;color:#fff;font-size:1em;cursor:pointer;">Back to Lobby</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    return new Promise((resolve) => {
      // Auto-detect if motion becomes available (user toggled setting in background)
      const pollIv = setInterval(() => {
        if (this.input.motionEnabled) {
          clearInterval(pollIv);
          overlay.remove();
          resolve('fixed');
        }
      }, 200);

      document.getElementById('btn-motion-retry').addEventListener('click', async () => {
        if (this.input.needsMotionPermission) {
          await this.input.requestMotionPermission();
        }
        // Wait up to 2s for sensor to respond
        await new Promise(r => {
          const iv = setInterval(() => { if (this.input.motionEnabled) { clearInterval(iv); r(); } }, 100);
          setTimeout(() => { clearInterval(iv); r(); }, 2000);
        });
        if (this.input.motionEnabled) {
          clearInterval(pollIv);
          overlay.remove();
          resolve('fixed');
        }
      });

      document.getElementById('btn-motion-back').addEventListener('click', () => {
        clearInterval(pollIv);
        overlay.remove();
        resolve('back');
      });
    });
  }

  _showDisconnect(reason) {
    const overlay = document.getElementById('disconnect-overlay');
    const msg = document.getElementById('disconnect-msg');
    overlay.style.display = 'flex';
    msg.textContent = reason || 'Partner disconnected';

    // Register buttons for gamepad navigation
    const btns = [
      document.getElementById('btn-try-reconnect'),
      document.getElementById('btn-return-lobby')
    ];
    this._setOverlayButtons(btns);
  }

  _showGameOver(fromRemote = false) {
    this.state = 'gameover';
    this.hud.hideTimer();
    if (this.raceManager) this.raceManager.crashCount++;
    hapticCrash();

    // Crash analytics already recorded at impact time in _recordCrash()
    this._lastCrashCause = null;

    // DDA: record failure at current checkpoint
    let checkpointD = 0;
    if (this.raceManager && this.raceManager.passedCheckpoints.size > 0) {
      checkpointD = Math.max(...this.raceManager.passedCheckpoints);
    }
    if (this.ddaManager && this.mode !== 'stoker') {
      this.ddaManager.recordFailure(checkpointD);
      const ddaResult = this.ddaManager.evaluate(checkpointD);

      // Show skip button if DDA recommends it
      const skipBtn = document.getElementById('btn-skip-checkpoint');
      if (skipBtn) {
        skipBtn.style.display = ddaResult.offerSkip ? '' : 'none';
        if (ddaResult.offerSkip) this.ddaManager.markSkipOffered();
      }

      // Show assist button if DDA recommends it
      if (ddaResult.offerAssist) {
        this.ddaManager.markAssistOffered();
        const assistBtn = document.getElementById('assist-btn');
        if (assistBtn) assistBtn.style.display = '';
      }
    }

    // Clear HUD status text so "CRASHED! Resetting..." doesn't bleed through
    document.getElementById('status').textContent = '';
    document.getElementById('gameover-overlay').style.display = 'flex';

    // Show clip button only when recording is active
    const clipBtn = document.getElementById('btn-gameover-clip');
    if (clipBtn) {
      clipBtn.style.display = (this.recorder && this.recorder.buffering) ? '' : 'none';
    }

    // Show "Return to Room" in multiplayer
    const roomBtn = document.getElementById('btn-gameover-room');
    if (roomBtn) roomBtn.style.display = this.net ? '' : 'none';

    // Adjust lobby button text for solo vs multiplayer
    const lobbyBtn = document.getElementById('btn-gameover-lobby');
    if (lobbyBtn) lobbyBtn.textContent = this.net ? 'END RIDE TOGETHER' : 'END RIDE';

    const skipBtn = document.getElementById('btn-skip-checkpoint');
    const btns = [clipBtn, document.getElementById('btn-restart'), skipBtn, roomBtn, document.getElementById('btn-gameover-lobby')]
      .filter(el => el && el.style.display !== 'none');
    this._setOverlayButtons(btns);

    // Input cooldown: on mobile, pedal taps and button taps share the same
    // touch area. On desktop/TV, pedal inputs are separate from selection.
    if (isMobile) {
      this._overlayCooldownUntil = performance.now() + 3000;
      btns.forEach(b => b.style.pointerEvents = 'none');
      setTimeout(() => btns.forEach(b => b.style.pointerEvents = ''), 3000);
    }

    if (!fromRemote && this.net && this.net.connected) {
      // Terminal event — retry a few times so a transient drop doesn't
      // leave the stoker stuck on a "playing" screen.
      this.net.sendEventReliable(EVT_GAMEOVER);
    }
  }

  _hideGameOver() {
    document.getElementById('gameover-overlay').style.display = 'none';
    this._clearOverlayButtons();
  }

  /** Dismiss any stray full-screen overlays that sit above the lobby (z-index 60)
   *  and cancel pending timers that would re-show them. */
  _hideAllOverlays() {
    for (const id of ['stoker-cta-overlay', 'disconnect-overlay']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // Tutorial overlays
    const tutPrompt = document.getElementById('tutorial-prompt');
    if (tutPrompt) tutPrompt.classList.remove('visible');
    const tutCrash = document.getElementById('tutorial-crash');
    if (tutCrash) tutCrash.classList.remove('visible');
    const tutComplete = document.getElementById('tutorial-complete');
    if (tutComplete) tutComplete.classList.remove('visible');
    const tutArrow = document.getElementById('coaching-dodge-arrow');
    if (tutArrow) tutArrow.classList.remove('visible');
    const tutCollect = document.getElementById('coaching-collect-indicator');
    if (tutCollect) tutCollect.classList.remove('visible');
    const offRoadWarn = document.getElementById('coaching-offroad-warning');
    if (offRoadWarn) offRoadWarn.classList.remove('visible');
    const calibOverlay = document.getElementById('calib-flow-overlay');
    if (calibOverlay) calibOverlay.style.display = 'none';
    if (this._stokerCTATimer) { clearTimeout(this._stokerCTATimer); this._stokerCTATimer = null; }
    this._clearOverlayButtons();
  }


  /** Show Steam Wishlist CTA after riding together as unlicensed stoker. */
  _showStokerCTA() {
    if (window.steam) return; // Steam users already own the game
    const overlay = document.getElementById('stoker-cta-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const contBtn = document.getElementById('btn-stoker-cta-continue');
    if (contBtn) this._setOverlayButtons([contBtn]);
    if (contBtn) {
      contBtn.onclick = () => {
        overlay.style.display = 'none';
        this._clearOverlayButtons();
        this._hideVictory();
        if (this.net) {
          this._returnToRoom();
        } else {
          this._returnToLobby();
        }
      };
    }
  }

  _handleRaceEvent(raceEvent) {
    if (raceEvent.event === 'checkpoint') {
      this._showCheckpointFlash();
      hapticCheckpoint();

      // Analytics: checkpoint ride event
      analytics.trackRideEvent('checkpoint', raceEvent.distance, {
        checkpoint_index: raceEvent.passed,
        speed: this.bike ? this.bike.speed : 0,
      });
      analytics.flushRideEvents();

      // DDA: reset adjustments on checkpoint pass
      if (this.ddaManager) {
        this.ddaManager.onCheckpointPassed(raceEvent.distance);
      }

      // Notify stoker
      if (this.mode === 'captain' && this.net) {
        this.net.sendEvent(EVT_CHECKPOINT);
      }
    } else if (raceEvent.event === 'finish') {
      // Tutorial completion is handled by _updateTutorial, not the normal victory flow
      if (this._tutorialActive) return;
      hapticFinish();

      // Kick off the cinematic finish camera; victory overlay reveals
      // when the swing-and-zoom sequence completes.
      this._startFinishCinematic();

      // Send authoritative finish stats to stoker so their side can run
      // its own cinematic in lockstep. FINISH is one-shot and terminal —
      // use the reliable variant so a single dropped packet at the
      // relay/WebRTC boundary doesn't strand the stoker on a frozen
      // race screen.
      if (this.mode === 'captain' && this.net && this.net.connected) {
        this.raceManager.inputSource = this.balanceCtrl.getSteerSource();
        this.net.sendProfile({
          type: 'finishStats',
          raceSummary: this.raceManager.getSummary(this.bike.distanceTraveled),
          contribSummary: this.contributionTracker ? this.contributionTracker.getSummary() : null,
        });
        this.net.sendEventReliable(EVT_FINISH);
      }
    }
  }

  _onCollect(count) {
    if (this.raceManager) this.raceManager.collectiblesCount += count;
    this.hud.updateCollectibles(this.collectibleManager.collected, this.collectibleManager.getTotalItems());
    this.bike.boostTimer = 3; // 3-second speed boost
    this._playBeep(1200, 0.1);
    setTimeout(() => this._playBeep(1600, 0.08), 80);

    // Analytics: collectible ride event
    analytics.trackRideEvent('collectible', this.bike.distanceTraveled, {
      collectible_type: this.lobby.selectedLevel?.collectibles || 'presents',
    });
  }

  _checkAchievements(dt) {
    const state = {
      distance: this.bike.distanceTraveled,
      cumulativeDistance: this.achievements.getCumulativeDistance(),
      speed: this.bike.speed,
      dt,
      offsetScore: this.sharedPedal ? this.sharedPedal.offsetScore : 0,
      collectibles: this.collectibleManager ? this.collectibleManager.collected : 0,
      totalCollectibles: this.collectibleManager ? this.collectibleManager.getTotalItems() : 0,
      finishedLevel: null,
      isMultiplayer: this.mode !== 'solo',
      safePct: 0,
    };

    if (this.contributionTracker) {
      const summary = this.contributionTracker.getSummary();
      if (summary.mode === 'solo') {
        state.safePct = summary.solo.safePct;
      } else {
        state.safePct = Math.max(summary.captain.safePct, summary.stoker.safePct);
      }
    }

    const newlyEarned = this.achievements.check(state);
    newlyEarned.forEach(a => {
      showAchievementToast(a);
      this._updateBadges();
      analytics.trackEvent('achievement_earned', {
        achievement_id: a.id,
        ride_id: analytics.getCurrentRideId(),
      });
    });
  }

  _checkFinishAchievements() {
    const level = this.lobby.selectedLevel;
    // Record this ride's distance for cumulative tracking
    this.achievements.addCompletedDistance(this.bike.distanceTraveled);
    const state = {
      distance: this.bike.distanceTraveled,
      cumulativeDistance: this.achievements.getCumulativeDistance(),
      speed: 0,
      dt: 0,
      offsetScore: 0,
      collectibles: this.collectibleManager ? this.collectibleManager.collected : 0,
      totalCollectibles: this.collectibleManager ? this.collectibleManager.getTotalItems() : 0,
      finishedLevel: level.id,
      bikeKey: this.lobby.selectedPresetKey,
      raceDistance: level.distance,
      crashes: this.raceManager ? this.raceManager.crashCount : 0,
      restarts: this.raceManager ? this.raceManager.restartCount : 0,
      isMultiplayer: this.mode !== 'solo',
      safePct: this.contributionTracker ? (() => {
        const s = this.contributionTracker.getSummary();
        if (this.mode === 'solo') return s.solo.safePct;
        return this.mode === 'captain' ? s.captain.safePct : s.stoker.safePct;
      })() : 0,
      syncDuration: 0,
    };
    const newlyEarned = this.achievements.check(state);
    newlyEarned.forEach(a => {
      showAchievementToast(a);
      this._updateBadges();
    });
  }

  _updateBadges() {
    updateBadgeDisplay('selfie-badges', this.achievements.getEarned());
    this._sendProfile();
  }


  _recalibrateTilt() {
    if (this.input.motionEnabled) {
      this.input.startTiltCalibration();
    }
    if (this.input.gyroConnected) {
      this.input.calibrateGyro();
    }
    // Flash the calibrate overlay briefly
    const flash = document.getElementById('calibrate-flash');
    if (flash) {
      flash.style.display = 'block';
      setTimeout(() => { flash.style.display = 'none'; }, 800);
    }
  }

  _getFrameColor(presetData) {
    if (!presetData) return '#888888';
    const entry = presetData['Cylinder006_cycle_0'];
    return entry?.color || '#888888';
  }

  _sendProfile() {
    if (!this.net || !this.net.connected) return;
    const profile = { achievements: this.achievements.getEarned() };
    if (this.lobby.auth && this.lobby.auth.isLoggedIn()) {
      const user = this.lobby.auth.getUser();
      if (user) {
        if (user.avatar) profile.avatar = user.avatar;
        if (user.name) profile.name = user.name;
        if (user.serverId) profile.serverId = user.serverId;
      }
    }
    // Anonymous players have no name — show a friendly label to the partner. (#312)
    if (!profile.name) profile.name = GUEST_NAME;
    profile.bikeColor = this._getFrameColor(this.lobby.selectedPreset);
    this.net.sendProfile(profile);
  }

  /**
   * Begin the cinematic finish: a stylized slow-motion swing around the
   * bike that ends on a tight artistic close-up of the front of the
   * frame. The victory overlay is held back until the camera move
   * completes.
   */
  _startFinishCinematic(fromRemote = false) {
    this.state = 'finishCinematic';
    this._finishFromRemote = fromRemote;
    this.hud.hideTimer();
    // Briefly damp the chase cam's residual shake so the cinematic
    // starts from a clean pose.
    if (this.chaseCamera) this.chaseCamera.shakeAmount = 0;
    this._finishCinematic = new FinishCameraAnimation(this.camera, this.bike);
  }

  /**
   * Drive the finish-line cinematic: slow-mo bike physics, full-rate
   * camera move, then hand off to _showVictory when the sequence ends.
   */
  _updateFinishCinematic(dt) {
    const cinematic = this._finishCinematic;
    if (!cinematic) {
      this._showVictory(this._finishFromRemote);
      return;
    }

    const slowDt = dt * cinematic.getTimeScale();

    // Let the bike roll out under its own friction with neutral input
    // so wheels and pedals keep turning briefly into the slow-motion.
    if (this.bike) {
      const neutralPedal = { crankAngle: this.bike.crankAngle, braking: false, acceleration: 0, wobble: 0 };
      const neutralBalance = { leanInput: 0, gyroActive: false };
      this.bike.update(neutralPedal, neutralBalance, slowDt, true, false);
    }

    // Keep the world streaming so terrain/scenery don't pop while the
    // bike rolls forward, but at slow-motion pace.
    if (this.world) {
      this.world.update(this.bike.position, this.bike.roadD, slowDt);
    }
    if (this.grassParticles) {
      this.grassParticles.update(this.bike, slowDt);
    }

    // Camera moves at real time so the cinematic timing is consistent
    // regardless of the bike's slow-mo wind-down.
    const done = cinematic.update(dt);

    this.renderer.render(this.scene, this.camera);

    if (done) {
      cinematic.cleanup();
      this._finishCinematic = null;
      // Reset chase cam so a future race doesn't snap from the
      // close-up pose.
      if (this.chaseCamera) this.chaseCamera.initialized = false;
      this._showVictory(this._finishFromRemote);
    }
  }

  _showVictory(fromRemote = false) {
    this.state = 'victory';
    this.hud.hideTimer();
    const overlay = document.getElementById('victory-overlay');
    overlay.classList.add('visible');

    const level = this.lobby.selectedLevel;
    // Victory title includes role in multiplayer
    const victoryTitle = document.getElementById('victory-title');
    if (this.mode === 'local') {
      victoryTitle.textContent = 'YOU BOTH MADE IT!';
    } else if (this.mode === 'captain' || this.mode === 'stoker') {
      victoryTitle.textContent = 'YOU MADE IT ' + this.mode.toUpperCase() + '!';
    } else {
      victoryTitle.textContent = 'YOU MADE IT!';
    }
    document.getElementById('victory-destination').textContent =
      level.icon + ' ' + level.name;

    // Animated chromakey destination video at top of victory screen
    this._startVictoryVideo(level);

    // Build stats
    const statsEl = document.getElementById('victory-stats');
    statsEl.innerHTML = '';

    // Use remote authoritative stats on stoker side, local stats otherwise
    let summary, contribData;
    if (fromRemote && this._remoteFinishStats) {
      summary = this._remoteFinishStats.raceSummary;
      contribData = this._remoteFinishStats.contribSummary;
      // Per-side fix: the captain's raceSummary carries the captain's own
      // inputSource, which the stoker would otherwise display as if it were
      // theirs (#196). Steering source is strictly local — it's never sent
      // over the wire because BalanceController.getSteerSource() only sees
      // the frames accumulated on this side. Overwrite with the stoker's
      // own value here so the victory screen's input-source row matches
      // what this player actually used.
      if (this.mode === 'stoker' && this.balanceCtrl) {
        summary = { ...summary, inputSource: this.balanceCtrl.getSteerSource() };
      }
    } else if (this.raceManager) {
      this.raceManager.inputSource = this.balanceCtrl.getSteerSource();
      summary = this.raceManager.getSummary(this.bike.distanceTraveled);
      contribData = this.contributionTracker ? this.contributionTracker.getSummary() : null;
    }

    if (summary) {
      const collectIcon = level.collectibles === 'gems' ? '\uD83D\uDC8E' : '\uD83C\uDF81'; // 💎 or 🎁
      const distStr = summary.distance >= 1000 ? (summary.distance / 1000).toFixed(2) + ' km' : summary.distance + ' m';

      // Build left and right column stats
      const left = [
        { icon: '\u23F1\uFE0F', value: summary.timeFormatted },          // ⏱️ Time
        { icon: '\uD83D\uDEB4', value: distStr },                         // 🚴 Distance
      ];
      const inputSourceEmoji = { keyboard: '\uD83D\uDCBB', gamepad: '\uD83D\uDD79\uFE0F', motion: '\uD83D\uDCF1', 'gamepad-gyro': '\uD83C\uDFAE' };
      const diffNames = { chill: 'Chill', adventurous: 'Adventurous', daredevil: 'Daredevil', tutorial: 'Tutorial' };
      const diffName = diffNames[this.lobby.selectedDifficulty] || this.lobby.selectedDifficulty;
      left.push({ icon: '\u26A1', value: diffName }); // ⚡ Difficulty
      const right = [
        { icon: '\u2601\uFE0F', value: summary.checkpointsPassed + '/' + summary.checkpointsTotal }, // ☁️ Checkpoints
      ];
      if (summary.collectibles > 0) {
        right.push({ icon: collectIcon, value: '' + summary.collectibles });
      }
      // Top grid shows a single input source for solo / online MP. In local
      // mode we skip it here because the contribution breakdown below shows
      // BOTH players' input sources per-column (no need to duplicate P1's).
      if (this.mode !== 'local' && summary.inputSource && summary.inputSource !== 'none') {
        right.push({ icon: inputSourceEmoji[summary.inputSource] || '', value: summary.inputSource });
      }

      // Solo performance stats
      let soloStats = null;
      if (contribData) {
        if (contribData.mode !== 'multiplayer') {
          const solo = contribData.solo;
          const pedalPct = solo.totalTaps > 0 ? Math.round((solo.correctTaps / solo.totalTaps) * 100) : 0;
          left.push({ icon: '\uD83E\uDDB6', value: pedalPct + '%' });       // 🦶 Pedal accuracy
          right.push({ icon: '\u2696\uFE0F', value: solo.safePct + '%' });   // ⚖️ Balance
        } else {
          soloStats = contribData;
        }
      }

      // Render two-column grid
      const maxRows = Math.max(left.length, right.length);
      let html = '<div class="victory-stats-grid">';
      for (let i = 0; i < maxRows; i++) {
        const l = left[i];
        const r = right[i];
        html += '<div class="vs-cell">' + (l ? '<span class="vs-icon">' + l.icon + '</span> <strong>' + l.value + '</strong>' : '') + '</div>';
        html += '<div class="vs-cell">' + (r ? '<span class="vs-icon">' + r.icon + '</span> <strong>' + r.value + '</strong>' : '') + '</div>';
      }
      html += '</div>';

      // Perfect ride / crashes
      if (summary.crashes > 0) {
        html += '<div class="victory-stat">\uD83D\uDCA5 Crashes: <strong>' + summary.crashes + '</strong></div>';
      } else {
        html += '<div class="victory-stat victory-perfect">\u2B50 No Crashes! \u2B50</div>';
      }
      if (summary.restarts > 0) {
        html += '<div class="victory-stat">\uD83C\uDFC1 Restarts: <strong>' + summary.restarts + '</strong></div>';
      }

      statsEl.innerHTML = html;

      // Multiplayer contribution breakdown (online captain/stoker OR local co-op)
      if (soloStats && soloStats.mode === 'multiplayer') {
        const contrib = soloStats;
        const isLocal = this.mode === 'local';
        // In local mode we know both players' input sources because both
        // InputManagers live on this machine; in online mode we only know
        // our own side's, so the partner column is left without an icon.
        const p1SteerSource = this.balanceCtrl ? this.balanceCtrl.getSteerSource() : 'none';
        const p2SteerSource = (isLocal && this.balanceCtrlP2) ? this.balanceCtrlP2.getSteerSource() : 'none';
        const sourceIcon = (src) => {
          if (!src || src === 'none') return '';
          return inputSourceEmoji[src] || '';
        };
        const captainLabel = isLocal ? 'P1 CAPTAIN' : 'CAPTAIN';
        const stokerLabel = isLocal ? 'P2 STOKER' : 'STOKER';
        const p1SourceRow = isLocal && p1SteerSource !== 'none'
          ? '<div>' + sourceIcon(p1SteerSource) + ' <strong>' + p1SteerSource + '</strong></div>'
          : '';
        const p2SourceRow = isLocal && p2SteerSource !== 'none'
          ? '<div>' + sourceIcon(p2SteerSource) + ' <strong>' + p2SteerSource + '</strong></div>'
          : '';
        const contribDiv = document.createElement('div');
        contribDiv.className = 'victory-contrib';
        contribDiv.innerHTML =
          '<div class="victory-contrib-header">' +
            '<span class="contrib-label captain-label">' + captainLabel + ' ' + contrib.captain.overallPct + '%</span>' +
            '<span class="contrib-label stoker-label">' + stokerLabel + ' ' + contrib.stoker.overallPct + '%</span>' +
          '</div>' +
          '<div class="victory-contrib-bar">' +
            '<div class="contrib-fill-captain" style="width:' + contrib.captain.overallPct + '%"></div>' +
            '<div class="contrib-fill-stoker" style="width:' + contrib.stoker.overallPct + '%"></div>' +
          '</div>' +
          '<div class="victory-contrib-detail">' +
            '<div class="contrib-col">' +
              p1SourceRow +
              '<div>\uD83E\uDDB6 <strong>' + contrib.captain.totalTaps + '</strong></div>' +
              '<div>\u2696\uFE0F <strong>' + contrib.captain.safePct + '%</strong></div>' +
              '<div>\uD83D\uDEE3\uFE0F <strong>' + contrib.captain.onRoadPct + '%</strong></div>' +
            '</div>' +
            '<div class="contrib-col">' +
              p2SourceRow +
              '<div>\uD83E\uDDB6 <strong>' + contrib.stoker.totalTaps + '</strong></div>' +
              '<div>\u2696\uFE0F <strong>' + contrib.stoker.safePct + '%</strong></div>' +
              '<div>\uD83D\uDEE3\uFE0F <strong>' + contrib.stoker.onRoadPct + '%</strong></div>' +
            '</div>' +
          '</div>';
        statsEl.appendChild(contribDiv);
      }
    }

    // Analytics: end ride with full metrics
    if (summary) {
      const contribStats = contribData
        ? (contribData.mode === 'solo' ? contribData.solo
           : contribData[this.mode] || contribData.captain)
        : {};
      const fpsStats = this._getFpsStats();
      analytics.endRide({
        completed: true,
        duration_ms: summary.timeMs,
        distance: summary.distance,
        checkpoints_passed: summary.checkpointsPassed,
        checkpoints_total: summary.checkpointsTotal,
        collectibles: summary.collectibles,
        collectibles_total: summary.collectiblesTotal || 0,
        crash_count: summary.crashes,
        timeout_count: summary.timeoutCount || 0,
        restarts: summary.restarts,
        max_speed: contribData ? contribData.maxSpeed : null,
        avg_speed: contribData ? contribData.avgSpeed : null,
        balance_safe_pct: contribStats.safePct,
        balance_danger_pct: contribStats.dangerPct,
        on_road_pct: contribStats.onRoadPct,
        center_pct: contribStats.centerPct,
        avg_lateral_offset: contribStats.avgLateral,
        lean_input_total: contribStats.leanInputTotal,
        lean_correction_total: contribStats.leanCorrectionTotal,
        pedal_taps: contribStats.totalTaps,
        pedal_correct: contribStats.correctTaps,
        pedal_wrong: contribStats.wrongTaps,
        pedal_power: contribStats.totalPower,
        offset_quality: this.sharedPedal ? this.sharedPedal.offsetScore : null,
        contribution_pct: contribStats.overallPct || null,
        dda_assists_offered: this.ddaManager ? this.ddaManager.offeredCount : 0,
        dda_assists_accepted: this.ddaManager ? this.ddaManager.acceptedCount : 0,
        dda_skips_used: this.ddaManager ? this.ddaManager.skipsUsed : 0,
        safety_used: this.safetyMode ? 1 : 0,
        avg_fps: fpsStats.avg_fps,
        min_fps: fpsStats.min_fps,
      });
      this._resetFpsStats();
      analytics.setPage(this.mode !== 'solo' ? 'mp_results' : 'solo_results');

      // Send WebRTC quality stats for multiplayer rides
      if (this.net && this.net.roomCode) {
        const quality = this.net.getQualityStats();
        if (quality) {
          analytics.trackRoomUpdate(this.net.roomCode, quality);
        }
      }
    }

    // Check finish-specific achievements
    this._checkFinishAchievements();

    // Auto-submit score if logged in
    this._submitScore();

    // Show NEXT LEVEL button if there's a next level
    const nextBtn = document.getElementById('btn-next-level');
    const playAgainBtn = document.getElementById('btn-play-again');
    const curIdx = LEVELS.indexOf(this.lobby.selectedLevel);
    const hasNext = nextBtn && curIdx >= 0 && curIdx < LEVELS.length - 1;
    if (nextBtn) {
      nextBtn.style.display = hasNext ? '' : 'none';
    }
    // Move accent style to "Next Level" when available
    if (hasNext) {
      playAgainBtn.classList.remove('lobby-btn-accent');
      nextBtn.classList.add('lobby-btn-accent');
    } else {
      playAgainBtn.classList.add('lobby-btn-accent');
      if (nextBtn) nextBtn.classList.remove('lobby-btn-accent');
    }

    // Show "Return to Room" in multiplayer
    const roomBtn = document.getElementById('btn-victory-room');
    if (roomBtn) roomBtn.style.display = this.net ? '' : 'none';

    // Adjust lobby button text for solo vs multiplayer
    const victoryLobbyBtn = document.getElementById('btn-victory-lobby');
    if (victoryLobbyBtn) victoryLobbyBtn.textContent = this.net ? 'END RIDE TOGETHER' : 'END RIDE';

    // Gamepad navigation for victory buttons
    const victoryBtns = [playAgainBtn, document.getElementById('btn-victory-lobby')];
    // Include "next level" if visible, and default-focus it
    if (hasNext) {
      victoryBtns.splice(1, 0, nextBtn);
    }
    // Include "return to room" if in multiplayer
    if (roomBtn && this.net) {
      victoryBtns.splice(victoryBtns.length - 1, 0, roomBtn);
    }
    this._setOverlayButtons(victoryBtns, hasNext ? 1 : 0);

    // Re4 — victory uses the same C-E-G motif as the checkpoint chime,
    // giving Tandemonium a recognizable audio signature across cues.
    this._playChime(MOTIF.C5, 0.3);
    setTimeout(() => this._playChime(MOTIF.E5, 0.3), 140);
    setTimeout(() => this._playChime(MOTIF.G5, 0.55), 280);
    setTimeout(() => this._playChime(MOTIF.G5 * 2, 0.6), 420);

    // Input cooldown to prevent accidental taps while pedaling. On mobile,
    // the same touch area is used for pedaling and button taps, so a cooldown
    // prevents misfires. On desktop/TV, pedal inputs (triggers/keys) are
    // separate from selection inputs (A button/mouse), so no cooldown needed.
    if (isMobile) {
      this._overlayCooldownUntil = performance.now() + 5000;
      victoryBtns.forEach(b => b.style.pointerEvents = 'none');
      setTimeout(() => victoryBtns.forEach(b => b.style.pointerEvents = ''), 5000);
    }

    // Show purchase CTA for unlicensed stokers after victory
    if (this.mode === 'stoker' && !this.lobby.license.isLicensed) {
      this._stokerCTATimer = setTimeout(() => {
        this._stokerCTATimer = null;
        if (this.state === 'lobby') return;
        this._showStokerCTA();
      }, 6000);
    }
  }

  async _submitScore() {
    const auth = this.lobby.auth;
    if (!auth || !auth.isLoggedIn()) return;
    // Demo mode: don't save scores to leaderboard
    if (this._isDemo) return;

    const level = this.lobby.selectedLevel;
    const raceSummary = this.raceManager ? this.raceManager.getSummary(this.bike.distanceTraveled) : null;
    if (!raceSummary) return;

    const difficulty = this.lobby.selectedDifficulty || 'adventurous';
    const data = {
      levelId: level.id,
      distance: raceSummary.distance,
      timeMs: raceSummary.timeMs,
      mode: this.mode,
      collectiblesCount: this.collectibleManager ? this.collectibleManager.collected : 0,
      inputSource: raceSummary.inputSource,
      newAchievements: this.achievements.getNewThisSession().map(a => a.id),
      difficulty,
      safetyUsed: this.safetyMode,
      scoreMultiplier: TUNE.scoreMultiplier || 1.0,
    };

    if (this.contributionTracker) {
      const contrib = this.contributionTracker.getSummary();
      const myServerId = auth.user ? auth.user.serverId : null;
      // Online MP: per-role server-ID split. Only applies when this.mode is
      // 'captain' or 'stoker' (online roles). Local MP runs with
      // this.mode === 'local' and has no server-side role distinction —
      // attribute the contribution as if it were solo.
      const isOnlineMp = contrib.mode === 'multiplayer'
        && (this.mode === 'captain' || this.mode === 'stoker')
        && contrib.captain && contrib.stoker;
      if (isOnlineMp) {
        const myRole = this.mode;
        const partnerRole = myRole === 'captain' ? 'stoker' : 'captain';
        contrib[myRole].userId = myServerId;
        contrib[partnerRole].userId = this._partnerServerId;
        data.contributions = { captain: contrib.captain, stoker: contrib.stoker };
      } else {
        // Solo OR local MP — attribute to the local user. contribution-tracker
        // returns a captain shape in local MP; treat it as solo for submission.
        const contribToSubmit = contrib.solo || contrib.captain || contrib.stoker;
        if (contribToSubmit) {
          contribToSubmit.userId = myServerId;
          data.contributions = { solo: contribToSubmit };
        }
      }
    }

    try {
      await auth.submitScore(data);
      // Achievements own their server sync now; inject the identity (token
      // provider) so they can authorize it. (#318 Step 4)
      this.achievements.setIdentity(auth);
      const syncResult = await this.achievements.syncToServer();
      if (syncResult && syncResult.achievements) {
        this.achievements.mergeFromServer(
          syncResult.achievements.map(a => ({ id: a.achievement_id, earnedAt: a.earned_at }))
        );
      }
    } catch (e) {}
  }

  _hideVictory() {
    document.getElementById('victory-overlay').classList.remove('visible');
    // Clear stale pointer-events cooldown on victory buttons
    for (const id of ['btn-play-again', 'btn-next-level', 'btn-victory-room', 'btn-victory-lobby']) {
      const el = document.getElementById(id);
      if (el) el.style.pointerEvents = '';
    }
    this.hud.hideProgress();
    this.hud.hideTimer();
    this._contribBar.style.display = 'none';
    this._clearOverlayButtons();
    this._stopVictoryVideo();
  }

  _startVictoryVideo(level) {
    // Clean up any existing victory video loop before starting a new one
    this._stopVictoryVideo();

    // Video config per level
    const videoConfigs = {
      grandma: {
        src: 'assets/grandma_house_chromakey.mp4',
        maskSrc: 'assets/grandma_house_chromakey_mask.png',
        trimStart: 0.00, trimEnd: 5.50,
        threshold: -0.02, smoothness: 0.110
      }
    };
    const cfg = videoConfigs[level.id];
    if (!cfg) {
      document.getElementById('victory-video').style.display = 'none';
      return;
    }

    const canvas = document.getElementById('victory-video');
    canvas.style.display = '';
    const ctx = canvas.getContext('2d');

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

    // Load mask image for transparency
    let maskCanvas = null;
    let maskData = null;
    if (cfg.maskSrc) {
      const maskImg = new Image();
      maskImg.onload = () => {
        maskCanvas = document.createElement('canvas');
        maskCanvas.width = canvas.width;
        maskCanvas.height = canvas.height;
        const mctx = maskCanvas.getContext('2d');
        mctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
        maskData = mctx.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      maskImg.src = cfg.maskSrc;
    }

    // 2D canvas chromakey — avoids creating a second WebGL context
    // which can cause context loss (grey screen crash) on iOS
    const threshold = cfg.threshold;
    const smooth = cfg.smoothness;
    // Store state on this._victoryVideo so _stopVictoryVideo can cancel
    // the current pending frame (animId changes every frame).
    const state = { video, animId: 0 };
    this._victoryVideo = state;
    const animate = () => {
      state.animId = requestAnimationFrame(animate);
      if (video.readyState < 2) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;

      for (let i = 0; i < d.length; i += 4) {
        // Apply mask if loaded
        if (maskData && maskData[i] > 128) {
          d[i + 3] = 0;
          continue;
        }
        // Green-screen removal
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const greenDom = g - Math.max(r, b);
        let alpha = 1.0 - Math.min(1, Math.max(0, (greenDom - threshold) / smooth));
        if (alpha < 0.03) {
          d[i + 3] = 0;
        } else {
          // Spill suppression
          const spillMax = 0.5 * (r + b) + 0.05;
          if (g > spillMax) d[i + 1] = Math.round(spillMax * 255);
          d[i + 3] = Math.round(alpha * 255);
        }
      }
      ctx.putImageData(imageData, 0, 0);
    };
    animate();
  }

  _stopVictoryVideo() {
    if (!this._victoryVideo) return;
    const v = this._victoryVideo;
    cancelAnimationFrame(v.animId);
    v.video.pause();
    v.video.src = '';
    this._victoryVideo = null;
  }

  _updateMusicBtnIcon() {
    if (this.lobby.musicActive) {
      this._musicBtn.classList.remove('muted');
      // Show note icon (already in SVG)
      this._musicBtn.querySelector('svg').style.opacity = '';
    } else {
      this._musicBtn.classList.add('muted');
      this._musicBtn.querySelector('svg').style.opacity = '0.35';
    }
  }

  _returnToLobby() {
    // Clean up tutorial state if active
    if (this._tutorialActive) {
      this._tutorialActive = false;
      this.input.suppressGamepadLean = !this.lobby.joystickActive;
    }
    this._musicBtn.style.display = 'none';
    if (!this.lobby.musicActive) {
      this._musicEl.pause();
      this._musicEl.currentTime = 0;
    }
    // Stop bike motion loop + restore music from its gameplay duck (St2/Sp3).
    this.audioEngine.stopBike();
    this.audioEngine.duckMusic(1.0, 0.8);
    this.audioEngine.detachRecorderDestination();
    this._hideGameOver();
    this._hideVictory();
    this._hideAllOverlays();
    this.raceManager = null;
    this.hud.raceManager = null;
    this.contributionTracker = null;
    if (this.collectibleManager) { this.collectibleManager.destroy(); this.collectibleManager = null; }
    if (this.obstacleManager) { this.obstacleManager.destroy(); this.obstacleManager = null; }
    this._contribBar.style.display = 'none';
    this.hud.hideCollectibles();
    this.hud.hideTimer();
    this.world.clearRaceMarkers();
    this.recorder.stopBuffer();
    this.recorder.stopSelfie();
    this.recorder.clearPartnerStream();
    updateBadgeDisplay('partner-badges', []);
    if (this.net) { this.net.destroy(); this.net = null; }
    // Local multiplayer teardown: release P2 InputManager + restore P1 keyboard
    if (this.inputP2) {
      this.inputP2 = null;
      this.balanceCtrlP2 = null;
      this._localP2Type = null;
      this._mpPrevUpP2 = false;
      this._mpPrevDownP2 = false;
      this._localP2Disconnected = false;
      // Re-enable P1 keyboard in case local MP had parked it (P2-keyboard case)
      this.input.keyboardActive = true;
    }
    document.body.classList.remove('mode-local');
    // Route haptics back to P1 only now that we're out of local MP.
    setHapticSources([this.input]);
    // Room stays in recent rooms list for 5 min so players can rejoin
    this.mode = 'solo';
    this._lobbyBtn.textContent = 'LOBBY';
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this._mpPrevUp = false;
    this._mpPrevDown = false;
    this._stokerWasFallen = false;
    this._stateSendTimer = 0;
    this._leanSendTimer = 0;
    document.getElementById('conn-badge').style.display = 'none';
    // Restore gamepad badge if controller is still connected
    this.input.suppressGamepadBadge = false;
    const gpBadge = document.getElementById('gamepad-badge');
    if (gpBadge && this.input.gamepadConnected) gpBadge.style.display = 'block';
    document.getElementById('side-buttons').style.display = '';
    const partnerTitle = document.querySelector('#partner-gauge .gauge-title');
    if (partnerTitle) partnerTitle.textContent = 'PARTNER';

    this.archIndicator.hide();
    this._partnerBikeColor = null;

    this.bike.fullReset();
    this.chaseCamera.initialized = false;
    this.pedalCtrl = new PedalController(this.input);

    this.state = 'lobby';
    this.lobby.show();
    analytics.setPage('lobby');
  }


  _returnToRoom() {
    this._musicBtn.style.display = 'none';
    if (!this.net) {
      // Fallback to full lobby return if no connection
      this._returnToLobby();
      return;
    }

    // Notify partner to return to room too (only if we're initiating,
    // not if we received EVT_RETURN_ROOM — prevents infinite loop)
    if (this.state !== 'lobby' && this.net.connected) {
      this.net.sendEvent(EVT_RETURN_ROOM);
    }

    if (!this.lobby.musicActive) {
      this._musicEl.pause();
      this._musicEl.currentTime = 0;
    }
    // Stop bike motion loop + restore music from its gameplay duck (St2/Sp3).
    this.audioEngine.stopBike();
    this.audioEngine.duckMusic(1.0, 0.8);
    this.audioEngine.detachRecorderDestination();
    this._hideGameOver();
    this._hideVictory();
    this._hideAllOverlays();

    // Partial cleanup: game state only (keep connection + media alive)
    this.countdownTimer = 0;
    this.raceManager = null;
    this.hud.raceManager = null;
    this.contributionTracker = null;
    if (this.collectibleManager) { this.collectibleManager.destroy(); this.collectibleManager = null; }
    if (this.obstacleManager) { this.obstacleManager.destroy(); this.obstacleManager = null; }
    this._contribBar.style.display = 'none';
    this.hud.hideCollectibles();
    this.hud.hideTimer();
    this.world.clearRaceMarkers();
    this.recorder.stopBuffer();
    // Don't stop selfie or clear partner stream — keep media alive
    this.archIndicator.hide();

    // Reset bike + camera
    this.bike.fullReset();
    this.chaseCamera.initialized = false;

    // Reset pedal state
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this._mpPrevUp = false;
    this._mpPrevDown = false;
    this._stokerWasFallen = false;
    this._stateSendTimer = 0;
    this._leanSendTimer = 0;

    // Hide side buttons for now (lobby will show them if needed)
    document.getElementById('side-buttons').style.display = '';

    // Transition to lobby room step
    this.state = 'lobby';
    this.lobby.showRoom(this.net, this._roomRole);
  }

  async _acquireLocalMedia() {
    if (this.net._localMediaStream) return;
    const constraints = {};
    if (this.lobby.cameraActive) constraints.video = { facingMode: 'user', width: 240, height: 240 };
    if (this.lobby.audioActive) constraints.audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (!constraints.video && !constraints.audio) return;
    try {
      this.net._localMediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Camera/mic denied — continue without media
    }
  }

  _initiateMediaCall() {
    if (!this.net || !this.net.peer) return;
    clearTimeout(this._mediaRetryTimeout);
    if (!this._mediaRetryCount) this._mediaRetryCount = 0;
    // Use network manager's initiateCall to properly track _mediaCall
    this.net.initiateCall();
    // Retry up to 3 times if partner stream doesn't arrive
    this._mediaRetryCount++;
    if (this._mediaRetryCount < 3) {
      this._mediaRetryTimeout = setTimeout(() => {
        if (!this.recorder.partnerActive) this._initiateMediaCall();
      }, 5000);
    }
  }

  _buildRecordState(pedalCtrl, remoteData) {
    const leftPressed = this.input.isPressed('ArrowLeft');
    const rightPressed = this.input.isPressed('ArrowRight');
    const braking = leftPressed && rightPressed;

    let pedalState = 'normal';
    if (braking || pedalCtrl.wasBrake) {
      pedalState = 'brake';
    } else if (pedalCtrl.wasWrong) {
      pedalState = 'wrong';
    }

    // Track partner pedal flash for recording (mirrors HUD logic)
    if (remoteData && remoteData.remoteLastTapTime && remoteData.remoteLastTapTime !== this._recLastTapTime) {
      const isWrong = this._recLastFoot !== null && remoteData.remoteLastFoot === this._recLastFoot;
      this._recLastTapTime = remoteData.remoteLastTapTime;
      this._recLastFoot = remoteData.remoteLastFoot;
      this._recFlashTimer = 0.3;
      this._recFlashFoot = remoteData.remoteLastFoot;
      this._recFlashWrong = isWrong;
    }
    if (this._recFlashTimer > 0) {
      this._recFlashTimer -= (1 / 60); // approximate dt
    }
    const flashing = this._recFlashTimer > 0;

    // YOU gauge angle (phone tilt / gamepad / keyboard)
    let youDeg = 0;
    if (isMobile) {
      youDeg = Math.max(-90, Math.min(90, this.input.motionRawRelative || 0));
    } else if (this.input.gamepadConnected) {
      youDeg = this.input.suppressGamepadLean ? 0 : this.input.gamepadLean * 90;
    } else {
      const aHeld = this.input.isPressed('KeyA');
      const dHeld = this.input.isPressed('KeyD');
      youDeg = aHeld ? -45 : (dHeld ? 45 : 0);
    }

    // BIKE gauge angle + danger level
    const bikeLeanRad = this.bike.lean;
    const bikeDeg = Math.max(-90, Math.min(90, bikeLeanRad * 180 / Math.PI));
    const bikeDanger = Math.abs(bikeLeanRad) / 1.35;

    // PARTNER gauge angle
    const partnerDeg = remoteData ? Math.max(-90, Math.min(90, remoteData.remoteLean * 90)) : 0;

    // Checkpoint flash progress (0..1 = animating, -1 = inactive)
    const cpElapsed = (performance.now() - this._checkpointFlashTime) / 1000;
    const cpFlash = this._checkpointFlashTime > 0 && cpElapsed < 1.6 ? cpElapsed / 1.6 : -1;

    // Segment timer
    const timerRemaining = this.raceManager ? this.raceManager.segmentTimeRemaining : -1;
    const timerTotal = this.raceManager ? this.raceManager.segmentTimeTotal : 0;

    // Progress bar
    const raceDistance = this.raceManager ? this.raceManager.raceDistance : 0;
    const checkpointPositions = this.raceManager ? this.raceManager.getCheckpointPositions() : [];
    const levelIcon = this.lobby.selectedLevel ? this.lobby.selectedLevel.icon : '';

    return {
      speed: this.bike.speed,
      distance: this.bike.distanceTraveled,
      timerRemaining,
      timerTotal,
      raceDistance,
      checkpointPositions,
      levelIcon,
      leftPressed,
      rightPressed,
      pedalState,
      partnerUpFlash: flashing && this._recFlashFoot === 'up',
      partnerDownFlash: flashing && this._recFlashFoot === 'down',
      partnerFlashWrong: flashing && this._recFlashWrong,
      mode: this.mode,
      youDeg,
      bikeDeg,
      bikeDanger,
      partnerDeg,
      hasPartner: !!remoteData,
      checkpointFlash: cpFlash
    };
  }

  // ============================================================
  // OPTIONS OVERLAY
  // ============================================================

  _initOptionsOverlay() {
    const overlay = document.getElementById('options-overlay');
    const closeBtn = document.getElementById('options-close-btn');
    const highBtn = document.getElementById('opt-high');
    const lowBtn = document.getElementById('opt-low');
    const autoBtn = document.getElementById('opt-auto');
    const perfBtn = document.getElementById('options-perf-btn');
    const perfResult = document.getElementById('options-perf-result');

    if (!overlay) return;

    const devToolsBtn = document.getElementById('options-devtools-btn');
    const browserDevBtn = document.getElementById('options-browserdev-btn');
    const browserDevHint = document.getElementById('options-browserdev-hint');
    const isElectron = !!window.electronApp;

    closeBtn.addEventListener('click', () => this._closeOptions());
    highBtn.addEventListener('click', () => this._setQuality('high'));
    lowBtn.addEventListener('click', () => this._setQuality('low'));
    autoBtn.addEventListener('click', () => this._setQuality('auto'));
    devToolsBtn.addEventListener('click', () => { window.location.href = 'test/index.html'; });

    const dsAutoBtn   = document.getElementById('opt-ds-auto');
    const dsSteamBtn  = document.getElementById('opt-ds-steam');
    const dsWebhidBtn = document.getElementById('opt-ds-webhid');
    if (dsAutoBtn)   dsAutoBtn.addEventListener('click',   () => this._setDualSenseSource('auto'));
    if (dsSteamBtn)  dsSteamBtn.addEventListener('click',  () => this._setDualSenseSource('steam-input'));
    if (dsWebhidBtn) dsWebhidBtn.addEventListener('click', () => this._setDualSenseSource('webhid'));

    const gyroEulerBtn   = document.getElementById('opt-gyro-euler');
    const gyroGravityBtn = document.getElementById('opt-gyro-gravity');
    if (gyroEulerBtn)   gyroEulerBtn.addEventListener('click',   () => this._setGyroRollMode('euler'));
    if (gyroGravityBtn) gyroGravityBtn.addEventListener('click', () => this._setGyroRollMode('gravity'));

    if (isElectron) {
      browserDevBtn.addEventListener('click', async () => {
        const opened = await window.electronApp.toggleDevTools();
        browserDevBtn.textContent = opened ? 'Close Dev Tools' : 'Open Dev Tools';
      });
    } else {
      browserDevBtn.addEventListener('click', () => {
        browserDevHint.textContent = 'Press F12 to open Dev Tools';
      });
    }

    perfBtn.addEventListener('click', async () => {
      perfBtn.disabled = true;
      perfBtn.textContent = 'Testing...';
      perfResult.textContent = '';
      perfResult.className = '';
      try {
        const result = await perfProbe();
        const gpu = result.gpuRenderer.length > 50 ? result.gpuRenderer.slice(0, 50) + '...' : result.gpuRenderer;
        perfResult.textContent = `GPU: ${gpu} | ${result.finalFps} fps — ${result.lowEnd ? 'LOW-END' : 'OK'}`;
        perfResult.className = result.lowEnd ? 'low' : 'ok';
      } catch (e) {
        perfResult.textContent = 'Error: ' + e.message;
      }
      perfBtn.disabled = false;
      perfBtn.textContent = 'Run Perf Test';
    });

    this._updateOptionsQualityUI();
    this._updateOptionsDualSenseSourceUI();
    this._updateOptionsGyroRollUI();
  }

  _updateOptionsDualSenseSourceUI() {
    const pref = readDualSenseSourcePref();
    const autoBtn   = document.getElementById('opt-ds-auto');
    const steamBtn  = document.getElementById('opt-ds-steam');
    const webhidBtn = document.getElementById('opt-ds-webhid');
    if (!autoBtn) return;
    autoBtn.classList.toggle('active',   pref === 'auto');
    steamBtn.classList.toggle('active',  pref === 'steam-input');
    webhidBtn.classList.toggle('active', pref === 'webhid');

    const stateEl = document.getElementById('opt-ds-state');
    if (!stateEl) return;
    const steamData = (window.steam && window.steam.input) ? (window.steam.input.getLatest() || []) : [];
    // Steam returns the SteamInputType enum as a numeric string ('13' = PS5Controller,
    // '5' = PS4Controller). Earlier code did .includes('ps5') which never matched.
    // Match the numeric enum AND the string forms for safety across SDK versions.
    const PS_TYPES = new Set(['5', '12', '13', 'ps5controller', 'ps4controller', 'ps3controller']);
    const steamHasPS5 = steamData.some(c => PS_TYPES.has(String(c.type || '').toLowerCase()));
    const hidDual = !!(this.input && this.input._slot && this.input._slot.driver
                       && this.input._slot.driver.entry?.protocol === 'dualsense');
    let status;
    if (steamHasPS5)      status = 'Steam Input active (DualSense intercepted)';
    else if (hidDual)     status = 'WebHID active (DualSense direct)';
    else                  status = 'No DualSense detected';
    stateEl.textContent = `Current: ${status} — applied on next launch`;
  }

  _setDualSenseSource(source) {
    try { localStorage.setItem('tandemonium_dualsense_source', source); } catch(e) {}
    this._updateOptionsDualSenseSourceUI();
  }

  _setGyroRollMode(mode) {
    const m = (mode === 'gravity') ? 'gravity' : 'euler';
    try { localStorage.setItem('tandemonium_gyro_roll_mode', m); } catch(e) {}
    // Apply live to both players' input managers so it can be felt immediately.
    if (this.input) this.input.setGyroRollMode(m);
    if (this.inputP2) this.inputP2.setGyroRollMode(m);
    this._updateOptionsGyroRollUI();
  }

  _updateOptionsGyroRollUI() {
    const mode = readGyroRollMode();
    const eulerBtn   = document.getElementById('opt-gyro-euler');
    const gravityBtn = document.getElementById('opt-gyro-gravity');
    if (!eulerBtn) return;
    eulerBtn.classList.toggle('active',   mode !== 'gravity');
    gravityBtn.classList.toggle('active', mode === 'gravity');
  }

  _updateOptionsQualityUI() {
    const pref = (() => { try { return localStorage.getItem('tandemonium_quality'); } catch(e) { return null; } })();
    const highBtn = document.getElementById('opt-high');
    const lowBtn = document.getElementById('opt-low');
    const autoBtn = document.getElementById('opt-auto');
    if (!highBtn) return;

    highBtn.classList.toggle('active', pref === 'high');
    lowBtn.classList.toggle('active', pref === 'low');
    autoBtn.classList.toggle('active', pref !== 'high' && pref !== 'low');
  }

  _setQuality(level) {
    try {
      if (level === 'auto') {
        localStorage.setItem('tandemonium_quality', 'auto');
        clearHardwareCache(); // re-detect on next load
      } else {
        localStorage.setItem('tandemonium_quality', level);
      }
    } catch(e) {}

    // Apply what we can live
    if (level === 'low') {
      this._lowQuality = true;
      this.renderer.setPixelRatio(0.5);
      this.renderer.shadowMap.enabled = false;
      this.recorder.supported = false;
      if (this.recorder.shareBtn) this.recorder.shareBtn.style.display = 'none';
    } else if (level === 'high') {
      this._lowQuality = false;
      this._autoLowEnd = false;
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      if (!isMobile) this.renderer.shadowMap.enabled = true;
    }
    // Auto: changes apply on next reload after hardware detect runs

    this._updateOptionsQualityUI();
  }

  _openOptions() {
    const overlay = document.getElementById('options-overlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    this._optionsOpen = true;
    this._updateOptionsQualityUI();

    // Set up gamepad navigation for overlay buttons
    const btns = [
      document.getElementById('opt-high'),
      document.getElementById('opt-low'),
      document.getElementById('opt-auto'),
      document.getElementById('opt-ds-auto'),
      document.getElementById('opt-ds-steam'),
      document.getElementById('opt-ds-webhid'),
      document.getElementById('opt-gyro-euler'),
      document.getElementById('opt-gyro-gravity'),
      document.getElementById('options-perf-btn'),
      document.getElementById('options-devtools-btn'),
      document.getElementById('options-browserdev-btn'),
      document.getElementById('options-close-btn'),
    ].filter(Boolean);
    this._updateOptionsDualSenseSourceUI();
    this._updateOptionsGyroRollUI();
    this._setOverlayButtons(btns, btns.length - 1); // focus Close by default
  }

  _closeOptions() {
    const overlay = document.getElementById('options-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    this._optionsOpen = false;
    this._clearOverlayButtons();
  }

  _pollStartButton() {
    if (!this.input.gamepadConnected) return;
    const gp = this.input.getGamepadState();
    if (!gp) return;

    const start = gp.buttons[9] && gp.buttons[9].pressed;
    const bIdx = this.input._gpSwapAB ? 0 : 1;
    const b = gp.buttons[bIdx] && gp.buttons[bIdx].pressed;

    if (start && !this._gpPrevStart) {
      if (this._optionsOpen) this._closeOptions();
      else this._openOptions();
    }
    if (b && !this._gpPrevB && this._optionsOpen) {
      this._closeOptions();
    }

    this._gpPrevStart = start;
    this._gpPrevB = b;
  }

  _pollDpad() {
    if (!this.input.gamepadConnected) return;
    // Don't process gameplay D-pad while clip preview modal is open
    if (this.recorder._previewPollId) return;
    // Don't process D-pad during calibration (tutorial)
    if (this.state === 'calibrating') return;
    const gp = this.input.getGamepadState();
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || false;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || false;
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || false;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || false;

    // Y button (button 3) — save clip
    const y = gp.buttons[3] && gp.buttons[3].pressed;
    // A button — recalibrate tilt (swapped for GameSir Cyclone)
    const aIdx = this.input._gpSwapAB ? 1 : 0;
    const a = gp.buttons[aIdx] && gp.buttons[aIdx].pressed;
    // L3 (button 10) — quick gyro recenter
    const l3 = gp.buttons[10] && gp.buttons[10].pressed;

    if (up && !this._dpadPrevUp) this.safetyBtn.click();
    if (down && !this._dpadPrevDown) this.speedBtn.click();
    if (right && !this._dpadPrevRight) document.getElementById('reset-btn').click();
    if (left && !this._dpadPrevLeft) this._lobbyBtn.click();
    if (y && !this._gpPrevY) this.recorder.saveClip();
    if (a && !this._gpPrevA && (this.input.motionEnabled || this.input.gyroConnected)) {
      this._recalibrateTilt();
    }
    if (l3 && !this._gpPrevL3 && this.input.gyroConnected) {
      this.input.recenterGyro();
      const flash = document.getElementById('calibrate-flash');
      if (flash) { flash.style.display = 'block'; setTimeout(() => { flash.style.display = 'none'; }, 400); }
    }

    this._dpadPrevUp = up;
    this._dpadPrevDown = down;
    this._dpadPrevLeft = left;
    this._dpadPrevRight = right;
    this._gpPrevY = y;
    this._gpPrevA = a;
    this._gpPrevL3 = l3;
  }

  _updateConnBadge() {
    if (!this.net) return;
    const typeEl = document.getElementById('conn-type');
    const pingEl = document.getElementById('conn-ping');
    const transport = this.net.transport === 'relay' ? 'RELAY' : 'P2P';
    if (typeEl) typeEl.textContent = transport;
    if (pingEl) pingEl.textContent = Math.round(this.net.pingMs) + 'ms';
  }

  // ============================================================
  // OVERLAY BUTTON TAP HELPER (touch + click for mobile)
  // ============================================================

  _onTap(id, handler) {
    const el = document.getElementById(id);
    // touchend fires reliably on mobile even when click doesn't
    // (body touch-action:none can suppress click synthesis in some browsers)
    el.addEventListener('touchend', (e) => {
      e.preventDefault();  // prevent subsequent click from double-firing
      handler();
    });
    el.addEventListener('click', handler);
  }

  // ============================================================
  // OVERLAY GAMEPAD NAVIGATION (game-over & victory)
  // ============================================================

  // Overlay gamepad nav now delegates to the shared FocusController (#318).
  // These wrappers keep the existing call sites unchanged.
  _setOverlayButtons(buttons, initialFocus = 0) {
    this._overlayFocus.setItems(buttons, initialFocus);
  }

  _clearOverlayButtons() {
    this._overlayFocus.clear();
  }

  _pollOverlayGamepad() {
    this._overlayFocus.poll();
  }

  // ============================================================
  // TREE COLLISION
  // ============================================================

  _getFpsStats() {
    const frames = this._fpsFrameTimes;
    if (frames.length === 0) return { avg_fps: null, min_fps: null };
    const avgDt = frames.reduce((s, d) => s + d, 0) / frames.length;
    return {
      avg_fps: Math.round(1 / avgDt),
      min_fps: this._fpsMaxDt > 0 ? Math.round(1 / this._fpsMaxDt) : null,
    };
  }

  _resetFpsStats() {
    this._fpsFrameTimes = [];
    this._fpsMinDt = Infinity;
    this._fpsMaxDt = 0;
  }

  _recordCrash(cause) {
    // Capture crash data at the moment of impact (speed/lean are still valid)
    this._lastCrashCause = cause;
    if (this.bike) {
      analytics.trackRideEvent('crash', this.bike.distanceTraveled, {
        lean_angle: this.bike.lean,
        speed: this.bike.speed,
        cause,
        input_method: analytics.getInputMethod(),
      });
      analytics.flushRideEvents();
    }
  }

  _checkTreeCollision() {
    if (this.bike.fallen || this.bike.speed < 0.5) return;
    // Skip tree collision when level config disables it — only pylons matter
    const level = this.lobby.selectedLevel;
    if (level && level.treeCollision === false) {
      // Still check pylon collision
      if (this.obstacleManager && this.obstacleManager.checkCollision(this.bike.position)) {
        this._recordCrash('obstacle');
        this.bike._fall();
        this.chaseCamera.shakeAmount = 0.25;
        this._playCrash(1.0);
        hapticTreeHit();
      }
      return;
    }
    const result = this.world.checkTreeCollision(
      this.bike.position, this.bike.roadD, this.bike.heading
    );
    if (result.hit) {
      this._recordCrash('tree');
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.2;
      this._playCrash(0.85);
      hapticTreeHit();
      return;
    }
    // Pylon obstacle collision
    if (this.obstacleManager && this.obstacleManager.checkCollision(this.bike.position)) {
      this._recordCrash('obstacle');
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.25;
      this._playCrash(1.0);
      hapticTreeHit();
    }
  }

  _hapticOffRoadCheck() {
    if (this.bike.fallen || this.bike.speed < 1) return;
    const frontOff = Math.max(0, Math.abs(this.bike._frontWheelOffset) - 2.5);
    const rearOff = Math.max(0, Math.abs(this.bike._rearWheelOffset) - 2.5);
    const intensity = Math.min(Math.max(frontOff, rearOff) / 3, 1);
    if (intensity > 0) hapticOffRoad(intensity);
  }

  // ============================================================
  // MAIN LOOP
  // ============================================================

  _loop(timestamp) {
    requestAnimationFrame((t) => this._loop(t));

    // Advance controller slot state machine once per frame — handles
    // Gamepad-API claim, HID-pool claim, release-ring, and orphan
    // transitions in one place. Must run before any input reads.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.controllerManager.ingestFrame(pads, performance.now());

    // Poll gamepad every frame before reading any input
    this.input.pollGamepad();
    if (this.inputP2) this.inputP2.pollGamepad();

    // Start button → options overlay (available in all states)
    this._pollStartButton();
    // If options overlay is open, only poll overlay navigation — skip game updates
    if (this._optionsOpen) {
      this._pollOverlayGamepad();
      this.input.consumeTaps(); // drain buffered input so it doesn't fire when overlay closes
      this.renderer.render(this.scene, this.camera);
      if (this.frontView) this.frontView.hide();
      return;
    }
    // Stoker input-choice overlay: allow gamepad selection while it's up.
    if (this._inputChoiceOpen) {
      this._pollOverlayGamepad();
      this.input.consumeTaps();
      this.renderer.render(this.scene, this.camera);
      if (this.frontView) this.frontView.hide();
      return;
    }

    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;

    const roadPath = this.world.roadPath;

    if (this.state === 'playing') {
      // FPS sampling — track frame times during gameplay only
      if (dt > 0) {
        this._fpsFrameTimes.push(dt);
        if (dt < this._fpsMinDt) this._fpsMinDt = dt;
        if (dt > this._fpsMaxDt) this._fpsMaxDt = dt;
      }

      // D-pad actions (safety/speed/reset/lobby)
      this._pollDpad();

      // Playing state — dispatch by mode
      if (this.mode === 'solo') {
        this._updateSolo(dt);
      } else if (this.mode === 'captain') {
        this._updateCaptain(dt);
      } else if (this.mode === 'stoker') {
        this._updateStoker(dt);
      } else if (this.mode === 'local') {
        this._updateLocal(dt);
      }
    } else if (this.state === 'finishCinematic') {
      // Cinematic finish camera owns its own world/bike updates and
      // render — bypass the chase cam so it doesn't fight the swing.
      this._updateFinishCinematic(dt);
    } else {
      // Lobby / countdown / instructions / victory / gameover: render static scene
      if (this.state === 'countdown') this._updateCountdown(dt);
      if (this.state === 'gameover' || this.state === 'victory' ||
          document.getElementById('disconnect-overlay').style.display !== 'none') this._pollOverlayGamepad();
      this.world.update(this.bike.position, this.bike.roadD, dt);
      this.chaseCamera.update(this.bike, dt, roadPath);
      if (this.archIndicator._visible) this.archIndicator.update(this.bike, 0, 0);

      this.renderer.render(this.scene, this.camera);
    }

    // Front-view PiP — composite a front-facing "selfie cam" of the bike
    // into the lower-right corner, on top of whatever was just rendered.
    // Only while a ride is on screen (not during the cinematic, which runs
    // its own camera choreography).
    if (this.frontView && this.frontView.enabled && this.bike &&
        (this.state === 'playing' || this.state === 'countdown')) {
      this.frontView.update(this.bike, dt);
      this.frontView.render(this.renderer, this.scene);
    } else if (this.frontView) {
      this.frontView.hide();
      this.frontView.reset();
    }

    // Sp3 — feed bike velocity to the procedural motion loop every frame.
    // When not actively playing (victory / gameover / lobby / countdown),
    // feed speed=0 so the loop fades to silence via the engine's internal
    // ramp instead of holding the last gain value indefinitely.
    if (this.bike) {
      const playing = this.state === 'playing';
      const frontOff = Math.abs(this.bike._frontWheelOffset || 0);
      const rearOff = Math.abs(this.bike._rearWheelOffset || 0);
      const offRoad = playing
        ? Math.min(1, Math.max(0, Math.max(frontOff, rearOff) - 2.5) / 3)
        : 0;
      this.audioEngine.updateBike(
        playing ? this.bike.speed : 0,
        TUNE.maxSpeed || 19,
        offRoad,
        !playing || this.bike.fallen
      );
    }

    // Clear buffered tap flags after all input has been read this frame
    this.input.consumeTaps();
    if (this.inputP2) this.inputP2.consumeTaps();
  }

  // ============================================================
  // SOLO UPDATE
  // ============================================================

  _updateSolo(dt) {
    // Feed bike speed to input manager for velocity-dependent sensitivity
    this.input.bikeSpeed = this.bike.speed;
    this.input.bikeMaxSpeed = TUNE.maxSpeed || 19;

    const pedalResult = this._calibSuppressPedals
      ? { acceleration: 0, braking: false, wobble: 0, crankAngle: this.pedalCtrl.crankAngle || 0 }
      : this.pedalCtrl.update(dt);
    const balanceResult = this.balanceCtrl.update(this.bike, this._assistWeight, this.collectibleManager, this.obstacleManager);

    // Sync balance assist to bike model
    this.bike._balanceAssist = this._assistWeight;

    const wasFallen = this.bike.fallen;
    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this._checkTreeCollision();

    this._recordBalanceCrashIfNew(wasFallen);

    // Race progress + contribution tracking
    if (this.raceManager) {
      const timerEnabled = !this.lobby.selectedLevel || this.lobby.selectedLevel.timerEnabled !== false;
      const raceEvent = this.raceManager.update(this.bike.distanceTraveled, timerEnabled ? dt : 0);
      if (raceEvent) {
        if (raceEvent.event === 'timeout' && timerEnabled) { this._onTimerExpired(); return; }
        this._handleRaceEvent(raceEvent);
      }
      this.hud.updateProgress(this.bike.distanceTraveled, this.raceManager.raceDistance, this.raceManager.passedCheckpoints);
      this.hud.updateTimer(this.raceManager.segmentTimeRemaining, this.raceManager.segmentTimeTotal);
    }
    if (this.contributionTracker) {
      this.contributionTracker.update(dt, this.bike, balanceResult.leanInput, 0, this.pedalCtrl.stats);
    }

    this._updateItems(dt);

    // Achievements
    this._checkAchievements(dt);

    // Background motion adaptation (skip when level config disables it)
    const adaptLevel = this.lobby.selectedLevel;
    if ((!adaptLevel || adaptLevel.motionAdaptation !== false) && (this.input.motionEnabled || this.input.gyroConnected)) {
      this._updateMotionAdaptation(dt);
    }

    // Tutorial: handle crash/completion internally instead of game-over screen
    if (this._tutorialActive) {
      this._updateTutorial(dt);
      // Skip normal game-over on crash during tutorial
    } else {
      // Show game over after crash recovery
      if (wasFallen && !this.bike.fallen) { this._showGameOver(); return; }
    }

    this.grassParticles.update(this.bike, dt);
    this._hapticOffRoadCheck();
    this._updateWorldAndCamera(dt);

    this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
    this.archIndicator.update(this.bike, balanceResult.leanInput);
    this.renderer.render(this.scene, this.camera);
    this.recorder.composite(this._buildRecordState(this.pedalCtrl));
  }

  // ============================================================
  // CAPTAIN UPDATE — runs physics, sends state
  // ============================================================

  _updateCaptain(dt) {
    // Feed bike speed to input manager for velocity-dependent sensitivity
    this.input.bikeSpeed = this.bike.speed;
    this.input.bikeMaxSpeed = TUNE.maxSpeed || 19;

    // Edge-detect pedals → shared pedal controller + send to stoker
    const upHeld = this.input.isPressed('ArrowLeft');
    const downHeld = this.input.isPressed('ArrowRight');
    if (upHeld && !this._mpPrevUp) {
      this.sharedPedal.receiveTap('captain', 'up');
      if (this.net) this.net.sendPedal('up');
    }
    if (downHeld && !this._mpPrevDown) {
      this.sharedPedal.receiveTap('captain', 'down');
      if (this.net) this.net.sendPedal('down');
    }
    this._mpPrevUp = upHeld;
    this._mpPrevDown = downHeld;

    // Use shared pedal controller
    const pedalResult = this.sharedPedal.update(dt);
    const balanceResult = this.balanceCtrl.update(this.bike, this._assistWeight, this.collectibleManager, this.obstacleManager);
    this.bike._balanceAssist = this._assistWeight;

    // Capture captain's own lean before merging
    const captainLean = balanceResult.leanInput;

    // Merge lean: captain + stoker averaged
    balanceResult.leanInput = Math.max(-1, Math.min(1,
      (balanceResult.leanInput + this.remoteLean) * 0.5
    ));

    const wasFallen = this.bike.fallen;
    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this._checkTreeCollision();

    this._recordBalanceCrashIfNew(wasFallen);

    // Race progress + contribution tracking (captain is authoritative).
    // The race clock keeps running during a partner reconnect (#316): a brief
    // phone-lock shouldn't pause the timer for both players. (#321 already
    // debounces the reconnect UI so quick blips don't even show.)
    if (this.raceManager) {
      const raceEvent = this.raceManager.update(this.bike.distanceTraveled, dt);
      if (raceEvent) {
        if (raceEvent.event === 'timeout') { this._onTimerExpired(); return; }
        this._handleRaceEvent(raceEvent);
      }
      this.hud.updateProgress(this.bike.distanceTraveled, this.raceManager.raceDistance, this.raceManager.passedCheckpoints);
      this.hud.updateTimer(this.raceManager.segmentTimeRemaining, this.raceManager.segmentTimeTotal);
    }
    if (this.contributionTracker) {
      this.contributionTracker.update(dt, this.bike, captainLean, this.remoteLean, this.sharedPedal.stats);
      // Update contribution bar
      const summary = this.contributionTracker.getSummary();
      if (summary.mode === 'multiplayer') {
        this._contribCaptain.style.width = summary.captain.overallPct + '%';
        this._contribStoker.style.width = summary.stoker.overallPct + '%';
      }
    }

    this._updateItems(dt);

    // Achievements
    this._checkAchievements(dt);

    // Tutorial: handle crash/completion internally instead of game-over screen
    if (this._tutorialActive) {
      this._updateTutorial(dt);
    } else {
      // Show game over after crash recovery
      if (wasFallen && !this.bike.fallen) { this._showGameOver(); return; }
    }

    this.grassParticles.update(this.bike, dt);
    this._hapticOffRoadCheck();

    // Send state + lean to stoker at 20Hz
    this._stateSendTimer += dt;
    if (this._stateSendTimer >= this._stateSendInterval && this.net && this.net.connected) {
      this._stateSendTimer = 0;
      const timerRemaining = this.raceManager ? this.raceManager.segmentTimeRemaining : -1;
      this.net.sendState(this.bike, timerRemaining);
      this.net.sendLean(captainLean);
    }

    this._updateWorldAndCamera(dt);

    this._updateConnBadge();
    const remoteData = this._remoteData;
    remoteData.remoteLean = this.remoteLean;
    remoteData.remoteLastFoot = this._remoteLastFoot;
    remoteData.remoteLastTapTime = this._remoteLastTapTime;
    this.hud.update(this.bike, this.input, this.sharedPedal, dt, remoteData);
    this.archIndicator.update(this.bike, captainLean, this.remoteLean);
    this.renderer.render(this.scene, this.camera);
    this.recorder.composite(this._buildRecordState(this.sharedPedal, remoteData));
  }

  // ============================================================
  // LOCAL UPDATE — same-screen co-op, no network
  // P1 drives `this.input`; P2 drives `this.inputP2`.
  // Reuses _updateCaptain for all physics/race/HUD logic by
  // pre-populating `this.remoteLean` and the _remoteLastFoot/Time
  // fields from P2's local inputs, so the captain path (which
  // already averages captain + remote lean and feeds stoker taps
  // into the shared pedal controller) works unchanged.
  // ============================================================

  _updateLocal(dt) {
    // Mid-ride disconnect: if P2 is on a gamepad that just dropped, pause the
    // ride and show a reconnect overlay. Physics + race timer freeze until the
    // gamepad comes back (or the player quits via the overlay's Return button).
    if (this._localP2Type === 'gamepad' && !this.inputP2.gamepadConnected) {
      if (!this._localP2Disconnected) {
        this._localP2Disconnected = true;
        this._reconnecting = true; // pauses local co-op (this fn early-returns below)
        this._showDisconnect('Player 2 controller disconnected');
      }
      // Render a still frame so the world doesn't look crashed, but skip
      // physics, race progress, input reads, and P2 polling entirely.
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this._localP2Disconnected) {
      // Gamepad came back — hide overlay and resume.
      this._localP2Disconnected = false;
      this._reconnecting = false;
      document.getElementById('disconnect-overlay').style.display = 'none';
      if (this._clearOverlayButtons) this._clearOverlayButtons();
    }

    // Feed bike speed to P2 input for velocity-dependent sensitivity
    this.inputP2.bikeSpeed = this.bike.speed;
    this.inputP2.bikeMaxSpeed = TUNE.maxSpeed || 19;

    // Compute P2's lean via their own balance controller. The captain path
    // will average (captainLean + this.remoteLean) * 0.5, so stashing P2's
    // lean into this.remoteLean makes the existing math Just Work. Pass the
    // same assist + item managers as the captain path so stoker gets
    // identical auto-steer when assist is engaged — without this, the back
    // seat felt "looser" than the front seat because DDA assist only
    // corrected captain's half of the merge.
    const balanceResultP2 = this.balanceCtrlP2.update(this.bike, this._assistWeight, this.collectibleManager, this.obstacleManager);
    // One-human local MP: if P2's controller is idle on the desk, its gyro
    // drifts (and gets rumble-shaken) and dragging that into the 50/50 lean
    // merge makes steering feel loose. Zero the contribution until the
    // player actually picks P2 up.
    this.remoteLean = this.inputP2.isActive() ? balanceResultP2.leanInput : 0;

    // Edge-detect P2 pedals → feed as the 'stoker' source into the shared
    // pedal controller. The captain path does the same for its own ('captain')
    // inputs, so offset pedaling emerges naturally.
    const upHeld2 = this.inputP2.isPressed('ArrowLeft');
    const downHeld2 = this.inputP2.isPressed('ArrowRight');
    const now = performance.now();
    if (upHeld2 && !this._mpPrevUpP2) {
      this.sharedPedal.receiveTap('stoker', 'up');
      this._remoteLastFoot = 'up';
      this._remoteLastTapTime = now;
    }
    if (downHeld2 && !this._mpPrevDownP2) {
      this.sharedPedal.receiveTap('stoker', 'down');
      this._remoteLastFoot = 'down';
      this._remoteLastTapTime = now;
    }
    this._mpPrevUpP2 = upHeld2;
    this._mpPrevDownP2 = downHeld2;

    // Delegate to the captain update path. It reads `this.input` for P1 pedals
    // + own lean, and `this.remoteLean` / `this._remoteLastFoot` / `this._remoteLastTapTime`
    // for P2's contribution (already populated above). All network sends in
    // _updateCaptain are guarded by `if (this.net)` which is null in local mode,
    // so they no-op safely.
    this._updateCaptain(dt);
  }

  // ============================================================
  // SHARED RIDE HELPERS
  // Extracted from _updateSolo / _updateCaptain to keep a single
  // source of truth for logic that both paths run identically.
  // ============================================================

  /** Record a balance-caused crash (fell from lean, not from collision). */
  _recordBalanceCrashIfNew(wasFallen) {
    if (!wasFallen && this.bike.fallen && !this._lastCrashCause) {
      this._recordCrash('balance');
    }
  }

  /** Advance collectibles + obstacles; trigger _onCollect for any picked up this frame. */
  _updateItems(dt) {
    if (this.collectibleManager) {
      const collected = this.collectibleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
      if (collected.length > 0) {
        this._onCollect(collected.length);
      }
    }
    if (this.obstacleManager) {
      this.obstacleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    }
  }

  /** Advance the world streaming, chase camera, and apply crash-recovery camera shake. */
  _updateWorldAndCamera(dt) {
    this.world.update(this.bike.position, this.bike.roadD, dt);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);
    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }
  }

  // ============================================================
  // STOKER UPDATE — receives state, interpolates, renders
  // ============================================================

  _updateStoker(dt) {
    // Edge-detect pedals → send over network
    const upHeld = this.input.isPressed('ArrowLeft');
    const downHeld = this.input.isPressed('ArrowRight');
    if (upHeld && !this._mpPrevUp && this.net) {
      this.net.sendPedal('up');
    }
    if (downHeld && !this._mpPrevDown && this.net) {
      this.net.sendPedal('down');
    }
    this._mpPrevUp = upHeld;
    this._mpPrevDown = downHeld;

    // Update local pedal controller for HUD button feedback only
    // (physics are handled by captain's shared pedal controller)
    this.pedalCtrl.update(dt);

    // Interpolate remote state
    const state = this.remoteBikeState ? this.remoteBikeState.getInterpolated() : null;
    if (state) {
      this.bike.applyRemoteState(state);
    }

    // Detect crash recovery (backup for EVT_GAMEOVER)
    if (this._stokerWasFallen && !this.bike.fallen) {
      this._stokerWasFallen = false;
      if (this.state === 'playing') this._showGameOver(true); // captain already sent EVT_GAMEOVER
      return;
    }
    this._stokerWasFallen = this.bike.fallen;

    this.grassParticles.update(this.bike, dt);
    this._hapticOffRoadCheck();

    // Send lean to captain at 20Hz
    this._leanSendTimer += dt;
    if (this._leanSendTimer >= this._leanSendInterval && this.net && this.net.connected) {
      this._leanSendTimer = 0;
      const balanceResult = this.balanceCtrl.update();
      this.net.sendLean(balanceResult.leanInput);
    }

    this.world.update(this.bike.position, this.bike.roadD, dt);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    // Race progress — display-only (captain is authoritative for timer + events)
    // Timer value is synced from captain via onStateReceived; stoker only
    // decrements locally between network updates to keep display smooth.
    if (this.raceManager) {
      // Keep the displayed clock ticking during reconnect (#316); captain's
      // authoritative timer resyncs it on the next state update.
      const raceDt = dt;
      // Local decrement for smooth display between 20Hz state updates
      if (raceDt > 0 && this.raceManager.segmentTimeRemaining > 0) {
        this.raceManager.segmentTimeRemaining -= raceDt;
      }
      // Update distance-based progress (checkpoints) without touching timer
      this.raceManager.updateProgressOnly(this.bike.distanceTraveled);
      if (this.raceManager.segmentTimeRemaining <= 0 && !this._stokerTimeoutShown && !this._reconnecting) {
        // Show TOO SLOW visual once — captain sends EVT_RESET to clear it
        this._stokerTimeoutShown = true;
        const flash = document.getElementById('timeout-flash');
        flash.classList.remove('visible');
        void flash.offsetWidth;
        flash.classList.add('visible');
        this._playBeep(200, 0.3);
        setTimeout(() => this._playBeep(150, 0.2), 300);
      }
      this.hud.updateProgress(this.bike.distanceTraveled, this.raceManager.raceDistance, this.raceManager.passedCheckpoints);
      this.hud.updateTimer(this.raceManager.segmentTimeRemaining, this.raceManager.segmentTimeTotal);
    }

    // Tutorial coaching UI for stoker (phase prompts, dodge arrows, collect indicators)
    if (this._tutorialActive) {
      this._updateStokerTutorialUI(dt);
    }

    // Collectibles (visual only — captain handles collection)
    if (this.collectibleManager) {
      this.collectibleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    }

    // Obstacles
    if (this.obstacleManager) {
      this.obstacleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    }

    if (this.bike.speed > 8) {
      this.chaseCamera.shakeAmount = Math.max(
        this.chaseCamera.shakeAmount, (this.bike.speed - 8) * 0.008);
    }
    if (this.bike.fallen) this.chaseCamera.shakeAmount = 0.15;

    this._updateConnBadge();
    const remoteData = this._remoteData;
    remoteData.remoteLean = this.remoteLean;
    remoteData.remoteLastFoot = this._remoteLastFoot;
    remoteData.remoteLastTapTime = this._remoteLastTapTime;
    this.hud.update(this.bike, this.input, this.pedalCtrl, dt, remoteData);
    const stokerLean = this.balanceCtrl.update().leanInput;
    this.archIndicator.update(this.bike, stokerLean, this.remoteLean);
    this.renderer.render(this.scene, this.camera);
    this.recorder.composite(this._buildRecordState(this.pedalCtrl, remoteData));
  }

  // ============================================================
  // BACKGROUND MOTION ADAPTATION — refines tuning during gameplay
  // ============================================================

  _updateMotionAdaptation(dt) {
    // Initialize adaptation state on first call
    if (!this._adaptState) {
      this._adaptState = {
        timer: 0,
        samples: [],        // raw relative tilt values
        interval: 30,       // seconds between adaptation updates
        blend: 0.08,        // conservative blend factor (8%)
        firstMinute: true,  // more aggressive during first minute
        elapsed: 0,
      };
    }
    const a = this._adaptState;
    a.elapsed += dt;
    a.timer += dt;

    // More aggressive adaptation during first 60s (20% blend, 10s interval)
    if (a.firstMinute && a.elapsed > 60) {
      a.firstMinute = false;
      a.blend = 0.08;
      a.interval = 30;
    }
    const blend = a.firstMinute ? 0.20 : a.blend;
    const interval = a.firstMinute ? 10 : a.interval;

    // Collect samples only when actively riding (not crashed, not stopped)
    if (!this.bike.fallen && this.bike.speed > 1) {
      const rel = this.input.motionRawRelative;
      if (rel !== undefined) a.samples.push(rel);
    }

    if (a.timer < interval || a.samples.length < 30) return;
    a.timer = 0;

    const isGyro = this.input.gyroConnected;
    const samples = a.samples;
    a.samples = [];

    // Compute observed parameters from this window
    const absSamples = samples.map(s => Math.abs(s));
    absSamples.sort((x, y) => x - y);

    // Observed noise floor (lower quartile when not steering)
    const lowQ = absSamples[Math.floor(absSamples.length * 0.1)];
    const observedDeadzone = Math.min(8, Math.max(2, Math.ceil(lowQ * 2)));

    // Observed max range (95th percentile, avoid outliers)
    const p95 = absSamples[Math.floor(absSamples.length * 0.95)];
    const observedSensitivity = Math.min(60, Math.max(15, p95 * 0.85));

    // Observed median lean for response curve
    const medianLean = absSamples[Math.floor(absSamples.length * 0.5)];

    // Blend toward observed values
    if (isGyro) {
      TUNE.gyroDeadzone += (observedDeadzone - TUNE.gyroDeadzone) * blend;
      TUNE.gyroSensitivity += (observedSensitivity - TUNE.gyroSensitivity) * blend;
      const targetCurve = Math.min(2.0, Math.max(1.0, 1.0 + (medianLean / observedSensitivity) * 0.5));
      TUNE.gyroResponseCurve += (targetCurve - TUNE.gyroResponseCurve) * blend;
    } else {
      TUNE.deadzone += (observedDeadzone - TUNE.deadzone) * blend;
      TUNE.sensitivity += (observedSensitivity - TUNE.sensitivity) * blend;
      const targetCurve = Math.min(2.5, Math.max(1.2, 1.5 + medianLean / observedSensitivity));
      TUNE.responseCurve += (targetCurve - TUNE.responseCurve) * blend;
    }

    // Update base snapshot so steering feel scaling stays relative
    snapshotTuningBase();

    // Re-apply current steering feel on top of the new base
    if (TUNE.steeringFeel != null && TUNE.steeringFeel !== 0.5) {
      applySteeringFeel(TUNE.steeringFeel);
    }

    // Persist updated values (throttled — only save every 30s)
    this._saveAdaptedTuning(isGyro);
  }

  _saveAdaptedTuning(isGyro) {
    try {
      const existing = localStorage.getItem(this._tuningKey());
      const data = existing ? JSON.parse(existing) : { version: 1 };
      data.inputType = isGyro ? 'gyro' : 'phone';
      data.platform = isAndroid ? 'android' : isIOS ? 'ios' : 'desktop';
      data.timestamp = Date.now();
      if (isGyro) {
        data.sensitivity = Math.round(TUNE.gyroSensitivity * 10) / 10;
        data.deadzone = Math.round(TUNE.gyroDeadzone * 10) / 10;
        data.responseCurve = Math.round(TUNE.gyroResponseCurve * 100) / 100;
      } else {
        data.sensitivity = Math.round(TUNE.sensitivity * 10) / 10;
        data.deadzone = Math.round(TUNE.deadzone * 10) / 10;
        data.responseCurve = Math.round(TUNE.responseCurve * 100) / 100;
      }
      // Preserve steeringFeel if set
      localStorage.setItem(this._tuningKey(), JSON.stringify(data));
    } catch {}
  }

  // ============================================================
  // TUTORIAL — motion learning ride
  // ============================================================

  /** Returns the per-user localStorage key for motion tuning. */
  _tuningKey() {
    const auth = this.lobby && this.lobby.auth;
    const userId = auth && auth.isLoggedIn() && auth.getUser() ? auth.getUser().id : null;
    return userId ? TUNING_KEY_PREFIX + '_' + userId : TUNING_KEY_PREFIX;
  }

  _shouldRunTutorial() {
    // Only for solo mode with motion input
    if (this.mode !== 'solo') return false;
    if (!this.input.motionEnabled && !this.input.gyroConnected) return false;
    if (this.lobby._forceWizard) return true;
    try {
      const saved = localStorage.getItem(this._tuningKey());
      if (!saved) return true;
      const data = JSON.parse(saved);
      // Re-run if platform changed (e.g., iPhone → Android)
      const curPlatform = isAndroid ? 'android' : isIOS ? 'ios' : 'desktop';
      if (data.platform && data.platform !== curPlatform) return true;
      // Re-run if input type changed
      const curType = this.input.gyroConnected ? 'gyro' : 'phone';
      return data.inputType !== curType;
    } catch { return true; }
  }

  _loadSavedTuning() {
    try {
      const saved = localStorage.getItem(this._tuningKey());
      if (!saved) return false;
      const data = JSON.parse(saved);
      if (data.version !== 1) return false;
      const curType = this.input.gyroConnected ? 'gyro' : 'phone';
      if (data.inputType !== curType) return false;
      // Apply saved tuning
      if (data.sensitivity != null) TUNE.sensitivity = data.sensitivity;
      if (data.deadzone != null) TUNE.deadzone = data.deadzone;
      if (data.outputSmoothing != null) TUNE.outputSmoothing = data.outputSmoothing;
      if (data.responseCurve != null) TUNE.responseCurve = data.responseCurve;
      if (data.gyroSensitivity != null) TUNE.gyroSensitivity = data.gyroSensitivity;
      if (data.gyroDeadzone != null) TUNE.gyroDeadzone = data.gyroDeadzone;
      if (data.gyroOutputSmoothing != null) TUNE.gyroOutputSmoothing = data.gyroOutputSmoothing;
      if (data.gyroResponseCurve != null) TUNE.gyroResponseCurve = data.gyroResponseCurve;
      // Snapshot base values, then apply feel on top
      snapshotTuningBase();
      if (data.steeringFeel != null) {
        applySteeringFeel(data.steeringFeel);
      }
      return true;
    } catch { return false; }
  }

  /**
   * Interactive tutorial teaching flow run before the tutorial countdown.
   * Walks the player through tilt-left / center / tilt-right so they get
   * a feel for steering before the actual ride begins.
   *
   * NOTE: This flow used to start with two explicit "hold still" rounds
   * that collected ~180 samples to set motionOffset + measure a deadzone.
   * Those were removed once PR #202 shipped sensor fusion and continuous
   * stillness calibration in InputManager — the welcome screen now just
   * kicks off the tilt pipeline's own warmup auto-calibration, which
   * completes invisibly within ~0.25 seconds (5 warmup frames + 10
   * TUNE.calibSamples frames at 60Hz) during the 2-second welcome pause.
   * Final tuning values (deadzone, sensitivity, response curve) are
   * computed later by _computeTuningParams from _tutPhase1/2/3 samples
   * collected during the actual tutorial ride, so the hold-still phase's
   * ephemeral TUNE.gyroDeadzone assignment wasn't serving any purpose.
   *
   * The game loop runs throughout (autoSpeed on, pedaling suppressed).
   * Returns a Promise that resolves when all phases complete.
   */
  async _runCalibrationFlow() {
    // Enable auto-speed so bike rolls forward during calibration
    const prevAutoSpeed = this.autoSpeed;
    this.autoSpeed = true;
    this._calibSuppressPedals = true;

    const isGyro = this.input.gyroConnected;
    const device = isGyro ? 'controller' : 'phone';
    const verb = isGyro ? 'Lean' : 'Tilt';
    const overlay = document.getElementById('calib-flow-overlay');
    const gauge = document.getElementById('calib-flow-gauge');
    const label = document.getElementById('calib-flow-label');
    const icon = document.getElementById('calib-flow-icon');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // Helper: wait for player to hit a lean target
    const waitForLean = (dir, threshold) => new Promise((resolve) => {
      let resolved = false;
      const check = () => {
        if (resolved) return;
        const lean = this.input.getMotionLean();
        const raw = isGyro ? -this.input._gyroRollAccum : this.input.rawGamma;
        const offset = this.input.motionOffset || 0;
        this._calibTiltSamples.push(raw - offset);

        let hit = false;
        if (dir === 'left') hit = lean < threshold;
        else if (dir === 'right') hit = lean > threshold;
        else if (dir === 'center') hit = Math.abs(lean) < 0.1;

        if (hit) { resolved = true; resolve(); }
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
      // Safety timeout
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 8000);
    });

    overlay.style.display = 'flex';
    this._calibTiltSamples = [];

    // Kick off the tilt pipeline's auto-calibration explicitly so it
    // completes during the welcome pause rather than when the user
    // starts the first lean. startTiltCalibration() flips _calibrating
    // and skips the 5-frame warmup counter, so _applyTilt will start
    // accumulating samples into _calibBuf on the very next report.
    // TUNE.calibSamples (10) at 60Hz → ~0.17s to complete; 2s welcome
    // gives a huge margin.
    if (this.input.motionEnabled || this.input.gyroConnected) {
      this.input.startTiltCalibration();
    }

    // ── Step 1: Welcome ──
    icon.textContent = isGyro ? '\uD83C\uDFAE' : '\uD83D\uDCF1';
    label.textContent = 'Let\'s set up your ' + device + '!';
    gauge.style.width = '0%';
    await wait(2000);

    // ── Step 2: Tilt Left ──
    icon.textContent = '\u2B05\uFE0F';
    label.textContent = verb + ' left...';
    gauge.style.width = '33%';
    await waitForLean('left', -0.25);
    label.textContent = '\u2713 Nice!';
    await wait(800);

    // ── Step 3: Return to Center ──
    icon.textContent = '\u2195\uFE0F';
    label.textContent = 'Back to center...';
    gauge.style.width = '44%';
    await waitForLean('center', 0);
    label.textContent = '\u2713 Centered!';
    await wait(800);

    // ── Step 4: Tilt Right ──
    icon.textContent = '\u27A1\uFE0F';
    label.textContent = verb + ' right...';
    gauge.style.width = '55%';
    await waitForLean('right', 0.25);
    label.textContent = '\u2713 Great!';
    await wait(800);

    // ── Step 5: Return to Center ──
    icon.textContent = '\u2195\uFE0F';
    label.textContent = 'Back to center...';
    gauge.style.width = '66%';
    await waitForLean('center', 0);
    await wait(600);

    // ── Step 6: Second round — faster ──
    label.textContent = 'Once more! ' + verb + ' left...';
    icon.textContent = '\u2B05\uFE0F';
    gauge.style.width = '72%';
    await waitForLean('left', -0.25);
    await wait(400);

    label.textContent = 'And right...';
    icon.textContent = '\u27A1\uFE0F';
    gauge.style.width = '83%';
    await waitForLean('right', 0.25);
    await wait(400);

    label.textContent = 'Back to center...';
    icon.textContent = '\u2195\uFE0F';
    gauge.style.width = '90%';
    await waitForLean('center', 0);
    await wait(400);

    // ── Step 7: Recalibrate practice ──
    icon.textContent = '\uD83D\uDCA1'; // 💡
    if (isGyro) {
      label.textContent = 'Press L3 (joystick click) to recalibrate \u2014 try it now!';
    } else {
      label.textContent = 'Tap the screen to recalibrate \u2014 try it now!';
    }
    gauge.style.width = '95%';
    // Wait for player to actually perform the recalibrate action
    await new Promise((resolve) => {
      let resolved = false;
      if (isGyro) {
        // Poll for L3 press (button 10)
        const pollL3 = () => {
          if (resolved) return;
          const gp = this.input.getGamepadState();
          if (gp && gp.buttons[10] && gp.buttons[10].pressed) {
            resolved = true;
            this._recalibrateTilt();
            resolve();
          } else {
            requestAnimationFrame(pollL3);
          }
        };
        requestAnimationFrame(pollL3);
      } else {
        // Listen for screen tap
        const onTap = () => {
          if (resolved) return;
          resolved = true;
          this._recalibrateTilt();
          overlay.removeEventListener('pointerdown', onTap);
          resolve();
        };
        // Temporarily enable pointer events on overlay for this step
        overlay.style.pointerEvents = 'auto';
        overlay.addEventListener('pointerdown', onTap);
      }
      // Safety timeout
      setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 10000);
    });
    // Restore pointer-events
    overlay.style.pointerEvents = 'none';
    label.textContent = '\u2713 Recalibrated! You can do this anytime during a ride.';
    await wait(2000);

    // ── Step 8: Done ──
    icon.textContent = '\uD83C\uDF89';
    label.textContent = 'You\'re ready to ride!';
    gauge.style.width = '100%';
    await wait(1500);

    overlay.style.display = 'none';

    // Restore state
    this.autoSpeed = prevAutoSpeed;
    this._calibSuppressPedals = false;
  }

  async _startTutorialRide() {
    this.lobby._forceWizard = false;
    this._tutorialActive = true;
    this._tutorialPhase = -1; // will show runway prompt on first update
    this._tutCompletedPhases = new Set(); // phases successfully passed
    this._tutFiredCheckpoints = new Set(); // phases that already showed checkpoint flash
    this._tutTargetPhase = 1; // which phase the player is working on
    this._tutorialAttempts = 0;
    this._tutorialCollected = 0;

    // Measurement buffers (cumulative across attempts)
    this._tutPhase1Samples = [];
    this._tutPhase2Samples = [];
    this._tutPhase2Speeds = [];
    this._tutPhase3Recovery = [];
    this._tutPrevTilt = null;
    this._tutPrevTiltTime = null;
    this._tutPeakLean = 0;
    this._tutPeakTime = 0;
    this._tutLastSign = 0;
    this._tutCrashPending = false;
    this._tutRetryPending = false;
    this._tutHoldStillShown = false;
    this._tutOffRoadTime = 0;

    // Per-phase auto-correction strength ramp
    this._tutPhaseAutoCorrectionStrengths = {
      1: 6.0,   // very strong self-righting
      2: 4.5,   // moderate
      3: 3.0    // standard Chill level
    };

    // Use tutorial level with dedicated tutorial difficulty
    const tutLevel = getLevelById('tutorial');
    this.lobby.selectedLevel = tutLevel;
    this.lobby.selectedDifficulty = 'tutorial';

    // Request iOS motion permission if needed
    if (this.input.needsMotionPermission) {
      await this.input.requestMotionPermission();
    }
    // Wait briefly for motion events on mobile
    if (isMobile && !this.input.motionEnabled && !this.input.gyroConnected) {
      await new Promise(r => {
        const check = () => { if (this.input.motionEnabled) return r(); };
        check();
        const iv = setInterval(check, 100);
        setTimeout(() => { clearInterval(iv); r(); }, 1500);
      });
    }

    // Suppress joystick steering so player must use gyro/tilt
    // (only when motion/gyro is active — joystick-only players keep joystick)
    if (this.input.motionEnabled || this.input.gyroConnected) {
      this.input.suppressGamepadLean = true;
    }

    // Show tutorial UI
    document.getElementById('btn-tutorial-continue').onclick = () => this._finishTutorial();

    // Analytics: tutorial start
    analytics.setPage('tutorial');
    analytics.trackEvent('tutorial_start', { input_method: analytics.getInputMethod() });
    this._tutorialStartTime = performance.now();

    // Flag to prevent _startCountdown from running its own tilt calibration
    // (the tutorial calibration flow will handle it)
    this._calibHoldSamples = true;

    // In multiplayer tutorial, defer EVT_COUNTDOWN to stoker until after
    // captain's calibration — otherwise stoker's countdown runs while captain
    // is still calibrating and the stoker starts riding too early.
    const isMPCaptain = this.mode === 'captain' && this.net;
    const isMPStoker = this.mode === 'stoker' && this.net;
    if (isMPCaptain) this._suppressCountdownEvent = true;

    // Start the ride setup (creates scene, collectibles, etc.)
    this._startCountdown();
    // Reset flag so actual calibration data replaces it
    this._calibHoldSamples = null;

    if (isMPCaptain) this._suppressCountdownEvent = false;

    // Stoker: pause countdown and show waiting message until captain
    // finishes calibration and sends EVT_COUNTDOWN
    if (isMPStoker) {
      this.state = 'waiting';
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.textContent = 'Waiting for captain...';
    }

    // Widen collection hitbox during tutorial (collectible manager exists after _startCountdown)
    if (this.collectibleManager) {
      this.collectibleManager._tutorialRadius = 2.8;
    }

    // Run calibration flow if player is using motion controls
    // Both captain and stoker calibrate — stoker's lean affects steering too
    if (this.input.motionEnabled || this.input.gyroConnected) {
      // Pause countdown during calibration — set state to 'calibrating' so
      // _updateCountdown doesn't tick, then run the interactive calibration flow.
      // Hide countdown number so it doesn't show through the calibration overlay.
      this.state = 'calibrating';
      const flavorNum = document.getElementById('countdown-flavor-num');
      if (flavorNum) flavorNum.style.visibility = 'hidden';
      await this._runCalibrationFlow();

      // Resume countdown from 3 seconds (captain starts immediately, stoker waits for EVT_COUNTDOWN)
      if (flavorNum) flavorNum.style.visibility = '';
      if (!isMPStoker) {
        this.state = 'countdown';
        this.countdownTimer = 3.0;
      } else {
        // Stoker done calibrating — wait for captain's EVT_COUNTDOWN
        this.state = 'waiting';
        const statusEl = document.getElementById('status');
        if (statusEl) statusEl.textContent = 'Waiting for captain...';
      }
    }

    // Now notify stoker to start countdown (after calibration is done)
    if (isMPCaptain) {
      this.net.sendEvent(EVT_COUNTDOWN);
    }

    // Hide timer (no time pressure in tutorial)
    this.hud.hideTimer();
  }

  _updateTutorial(dt) {
    if (!this._tutorialActive) return;
    if (this._tutRetryPending || this._tutCrashPending) return; // wait for restart

    const dist = this.bike.distanceTraveled;
    const isGyro = this.input.gyroConnected;
    const tp = this._tutTargetPhase;
    const pi = TUTORIAL_PHASES[tp];

    // Ramp auto-correction strength based on current target phase
    const acStrength = this._tutPhaseAutoCorrectionStrengths
      ? this._tutPhaseAutoCorrectionStrengths[tp] || 3.0
      : 3.0;
    TUNE.autoCorrectionStrength = acStrength;

    // Determine current phase: runway (before content) or active content
    const phase = dist < pi.contentStart ? 0 : tp;

    // Runway → Phase transition: show phase prompt when entering content zone
    if (phase > 0 && phase !== this._tutorialPhase) {
      this._tutorialPhase = phase;
      this._showTutorialPhase(phase);
    }
    // Show runway prompt when in the warmup zone
    if (phase === 0 && this._tutorialPhase !== 0) {
      this._tutorialPhase = 0;
      this._showTutorialPhase(0);
    }

    // Collect raw tilt sample
    const rawTilt = isGyro ? -this.input._gyroRollAccum : this.input.rawGamma;
    const now = performance.now();

    // Measurement collection based on target phase
    if (phase === 0 && tp === 1) {
      // First runway only: collect noise floor samples while pedaling
      if (rawTilt !== 0 || this._tutPhase1Samples.length > 0) {
        this._tutPhase1Samples.push(rawTilt);
      }
    } else if (tp === 1 && phase > 0) {
      // Phase 1: collect steering range samples
      const offset = this.input.motionOffset || 0;
      const relative = rawTilt - offset;
      this._tutPhase2Samples.push(relative);

      // Track tilt speed
      if (this._tutPrevTilt !== null && this._tutPrevTiltTime !== null) {
        const dtMs = now - this._tutPrevTiltTime;
        if (dtMs > 0) {
          this._tutPhase2Speeds.push(Math.abs(relative - this._tutPrevTilt) / (dtMs / 1000));
        }
      }
      this._tutPrevTilt = relative;
      this._tutPrevTiltTime = now;
    } else if (tp === 2 && phase > 0) {
      // Phase 2: detect direction changes and measure recovery
      const offset = this.input.motionOffset || 0;
      const relative = rawTilt - offset;
      const deadzone = isGyro ? TUNE.gyroDeadzone : TUNE.deadzone;
      const sign = relative > deadzone ? 1 : relative < -deadzone ? -1 : 0;

      if (sign !== 0 && Math.abs(relative) > Math.abs(this._tutPeakLean)) {
        this._tutPeakLean = relative;
        this._tutPeakTime = now;
      }

      if (sign !== 0 && this._tutLastSign !== 0 && sign !== this._tutLastSign) {
        if (this._tutPeakTime > 0) {
          const recoveryMs = now - this._tutPeakTime;
          if (recoveryMs > 50 && recoveryMs < 2000) {
            this._tutPhase3Recovery.push(recoveryMs);
          }
        }
        this._tutPeakLean = 0;
        this._tutPeakTime = now;
      }

      if (sign !== 0) this._tutLastSign = sign;
    }

    // Pylon tracking + dodge arrow
    // Show dodge arrow during Phase 2 runway too so player sees it early
    const showDodgeArrow = phase > 0 || (tp === 2 && phase === 0);
    if (this.obstacleManager && showDodgeArrow) {
      if (phase > 0) {
        const passResult = this.obstacleManager.updatePassTracking(dist, this.bike._lateralOffset);
        if (passResult) {
          if (!passResult.correct) {
            this._tutorialPhaseRetry(tp, 'Weave to the other side of the pylon!');
            return;
          } else {
            this._showPylonSuccess();
          }
        }
      }
      this._updateDodgeArrow(dist);
    } else {
      const arrow = document.getElementById('coaching-dodge-arrow');
      if (arrow) arrow.classList.remove('visible');
    }

    // Collect indicator
    if (this.collectibleManager && phase > 0) {
      this._updateCollectIndicator(dist);
    } else {
      const indicator = document.getElementById('coaching-collect-indicator');
      if (indicator) indicator.classList.remove('visible');
    }

    // Missed collectible check (only in current phase's content zone)
    if (this.collectibleManager && phase > 0 && TUTORIAL_ITEMS[tp].collectibles.length > 0) {
      if (dist > pi.contentStart && this.collectibleManager.hasMissedItem(dist, pi.contentStart, pi.contentEnd, 8)) {
        this._tutorialPhaseRetry(tp, 'Missed a present! Collect them all!');
        return;
      }
    }

    // Off-road check — wide tolerance during tutorial with countdown warning
    const tutOffRoadThreshold = 5.0;
    const tutOffRoadLimit = 6.0; // 1s grace + 5s countdown
    const offDist = Math.abs(this.bike._lateralOffset) - tutOffRoadThreshold;
    if (offDist > 0 && this.bike.speed > 0.5) {
      const depthWeight = Math.min(offDist / 2.0, 2.0);
      this._tutOffRoadTime += dt * depthWeight;

      // Show countdown warning after 1.0s off-road
      const warningEl = document.getElementById('coaching-offroad-warning');
      if (this._tutOffRoadTime > 1.0 && warningEl) {
        const remaining = Math.ceil(tutOffRoadLimit - this._tutOffRoadTime);
        warningEl.textContent = '\u2190 Stay on the road! ' + remaining + ' \u2192';
        if (!warningEl.classList.contains('visible')) {
          warningEl.classList.add('visible');
        }
      }

      // Force retry at limit
      if (this._tutOffRoadTime > tutOffRoadLimit) {
        this._tutOffRoadTime = 0;
        if (warningEl) {
          warningEl.classList.remove('visible');
          warningEl.textContent = '\u2190 Stay on the road! \u2192';
        }
        this._tutorialPhaseRetry(tp, 'Stay on the road!');
        return;
      }
    } else {
      this._tutOffRoadTime = Math.max(0, this._tutOffRoadTime - dt * 2);
      // Hide warning when back on road
      const warningEl = document.getElementById('coaching-offroad-warning');
      if (warningEl && warningEl.classList.contains('visible')) {
        warningEl.classList.remove('visible');
        warningEl.textContent = '\u2190 Stay on the road! \u2192';
      }
    }

    // Crash check
    if (this.bike.fallen && this.bike.fallTimer > 1.2 && !this._tutCrashPending) {
      this._tutCrashPending = true;
      this._tutorialCrash(tp);
      return;
    }

    // Phase completion check at contentEnd
    if (dist >= pi.contentEnd && !this.bike.fallen) {
      // Verify collectibles if this phase has them
      const phaseCollectibles = TUTORIAL_ITEMS[tp].collectibles;
      if (phaseCollectibles.length > 0 && this.collectibleManager) {
        const collected = this.collectibleManager.countCollectedInRange(pi.contentStart, pi.contentEnd);
        const total = this.collectibleManager.countTotalInRange(pi.contentStart, pi.contentEnd);
        if (collected < total) {
          this._tutorialPhaseRetry(tp, 'Collect all the presents! (' + collected + '/' + total + ')');
          return;
        }
      }

      // Verify pylons if this phase has them
      const phaseObstacles = TUTORIAL_ITEMS[tp].obstacles;
      if (phaseObstacles.length > 0 && this.obstacleManager) {
        const pylonResult = this.obstacleManager.getPassResults(pi.contentStart, pi.contentEnd);
        if (pylonResult.wrongSide > 0 || pylonResult.passed < phaseObstacles.length) {
          const hint = pylonResult.wrongSide > 0
            ? 'Stay on the correct side of each pylon!'
            : 'Navigate past all the pylons!';
          this._tutorialPhaseRetry(tp, hint);
          return;
        }
      }

      // Phase passed! Checkpoint flash + chime
      this._showCheckpointFlash();
      hapticCheckpoint();

      // Reset DDA adjustments and assist for next phase
      if (this.ddaManager) {
        this.ddaManager.onCheckpointPassed(tp);
      }
      this._assistWeight = 0;

      // Accumulate collected presents
      if (this.collectibleManager) {
        this._tutorialCollected += this.collectibleManager.countCollectedInRange(pi.contentStart, pi.contentEnd);
      }
      this._tutCompletedPhases.add(tp);
      if (tp < 3) {
        // Advance to next phase — keep riding forward
        this._tutTargetPhase = tp + 1;
        this._tutorialPhase = -1; // will show runway prompt
        this._tutOffRoadTime = 0;
      } else {
        // All 3 phases done
        this._tutorialComplete();
      }
    }
  }

  // Lightweight tutorial UI for stoker — shows prompts, dodge arrows, collect indicators
  // without running calibration, physics checks, or phase completion logic (captain handles those).
  _updateStokerTutorialUI(dt) {
    if (!this._tutorialActive) return;

    const dist = this.bike.distanceTraveled;
    const tp = this._tutTargetPhase;
    const pi = TUTORIAL_PHASES[tp];

    // Determine current phase based on distance
    const phase = dist < pi.contentStart ? 0 : tp;

    // Show phase prompt on transitions
    if (phase > 0 && phase !== this._tutorialPhase) {
      this._tutorialPhase = phase;
      this._showTutorialPhase(phase);
    }
    if (phase === 0 && this._tutorialPhase !== 0) {
      this._tutorialPhase = 0;
      this._showTutorialPhase(0);
    }

    // Dodge arrow (visual feedback only — captain checks pass results)
    const showDodgeArrow = phase > 0 || (tp === 2 && phase === 0);
    if (this.obstacleManager && showDodgeArrow) {
      this._updateDodgeArrow(dist);
    } else {
      const arrow = document.getElementById('coaching-dodge-arrow');
      if (arrow) arrow.classList.remove('visible');
    }

    // Collect indicator
    if (this.collectibleManager && phase > 0) {
      this._updateCollectIndicator(dist);
    } else {
      const indicator = document.getElementById('coaching-collect-indicator');
      if (indicator) indicator.classList.remove('visible');
    }
  }

  _showTutorialPhase(phase) {
    const prompt = document.getElementById('tutorial-prompt');
    const text = document.getElementById('tutorial-prompt-text');
    const dots = document.querySelectorAll('.tutorial-dot');

    const hasMotion = this.input.motionEnabled || this.input.gyroConnected;
    const steerVerb = this.input.gyroConnected ? 'Lean' : hasMotion ? 'Tilt' : 'Steer';
    const isCaptain = this.mode === 'captain';
    const isStoker = this.mode === 'stoker';
    let prompts;
    if (isCaptain) {
      prompts = {
        0: 'Pedal together to build speed!',
        1: 'Captain, ' + steerVerb.toLowerCase() + ' to collect the presents!',
        2: 'Captain, dodge the pylons!',
        3: 'Put it all together! Collect and dodge!'
      };
    } else if (isStoker) {
      prompts = {
        0: 'Pedal together to build speed!',
        1: 'Keep pedaling — captain is steering!',
        2: 'Keep pedaling — captain is dodging!',
        3: 'Great teamwork! Keep the rhythm going!'
      };
    } else {
      prompts = {
        0: 'Pedal to build speed!',
        1: steerVerb + ' to collect the presents!',
        2: 'Dodge the pylons!',
        3: 'Put it all together! Collect and dodge!'
      };
    }
    text.textContent = prompts[phase] || '';
    prompt.classList.add('visible');

    // Phase dots only show for content phases (1-3), not runway
    dots.forEach(d => {
      const p = parseInt(d.dataset.phase);
      d.classList.toggle('active', p === this._tutTargetPhase);
      d.classList.toggle('done', this._tutCompletedPhases && this._tutCompletedPhases.has(p));
    });
  }

  _initAllTutorialItems() {
    // Combine items from all phases into a single set so everything is visible ahead
    const allCollectibles = [];
    const allObstacles = [];
    for (let p = 1; p <= 3; p++) {
      allCollectibles.push(...TUTORIAL_ITEMS[p].collectibles);
      allObstacles.push(...TUTORIAL_ITEMS[p].obstacles);
    }
    if (this.collectibleManager) this.collectibleManager.replaceItems(allCollectibles);
    if (this.obstacleManager) this.obstacleManager.replaceItems(allObstacles);
  }

  _updateCollectIndicator(dist) {
    const indicator = document.getElementById('coaching-collect-indicator');
    if (!indicator || !this.collectibleManager) {
      if (indicator) indicator.classList.remove('visible');
      return;
    }

    // Find the next upcoming uncollected present
    let next = null;
    let aheadDist = Infinity;
    for (const item of this.collectibleManager._items) {
      if (item.collected) continue;
      const ahead = item.absoluteD - dist;
      if (ahead > 1 && ahead < aheadDist) {
        aheadDist = ahead;
        next = item;
      }
    }

    // Show indicator when present is within 15m ahead, hide within 2m
    if (next && aheadDist <= 15 && aheadDist > 2) {
      indicator.classList.add('visible');
      // Point toward the present: left present → indicator left, right → right
      if (next.lateralOffset < 0) {
        indicator.classList.add('collect-left');
        indicator.classList.remove('collect-right');
      } else {
        indicator.classList.remove('collect-left');
        indicator.classList.add('collect-right');
      }
    } else {
      indicator.classList.remove('visible');
    }
  }

  _updateDodgeArrow(dist) {
    const arrow = document.getElementById('coaching-dodge-arrow');
    if (!arrow || !this.obstacleManager) { if (arrow) arrow.classList.remove('visible'); return; }

    // Find the next upcoming pylon (not hidden, ahead of bike)
    let next = null;
    let aheadDist = Infinity;
    for (const item of this.obstacleManager._items) {
      if (item._hidden) continue;
      const ahead = item.absoluteD - dist;
      if (ahead > 1 && ahead < aheadDist) {
        aheadDist = ahead;
        next = item;
      }
    }

    // Show arrow when pylon is within range ahead, hide within 2m (already dodging)
    // Use longer range (25m) during tutorial for more reaction time
    const arrowRange = this._tutorialActive ? 25 : 15;
    if (next && aheadDist <= arrowRange && aheadDist > 2) {
      arrow.classList.add('visible');
      // Pylon on left (offset < 0) → arrow points right; pylon on right → arrow points left
      if (next.lateralOffset < 0) {
        arrow.classList.add('arrow-right');
      } else {
        arrow.classList.remove('arrow-right');
      }
    } else {
      arrow.classList.remove('visible');
    }
  }

  _showPylonSuccess() {
    const el = document.getElementById('coaching-pylon-success');
    if (!el) return;
    el.classList.add('visible');
    clearTimeout(this._pylonSuccessTimer);
    this._pylonSuccessTimer = setTimeout(() => el.classList.remove('visible'), 800);
  }

  _tutorialPhaseRetry(phase, hint) {
    // Guard against being called multiple frames in a row
    if (this._tutRetryPending) return;
    this._tutRetryPending = true;

    // Feed failure to DDA manager
    if (this.ddaManager) {
      this.ddaManager.recordFailure(this._tutTargetPhase);
      this.ddaManager.applyInvisibleAdjustments();
    }

    // Clear off-road warning
    const warningEl = document.getElementById('coaching-offroad-warning');
    if (warningEl) warningEl.classList.remove('visible');

    // Stop the bike immediately so player doesn't keep moving
    this.bike.speed = 0;

    // Hide pylon success indicator if showing
    clearTimeout(this._pylonSuccessTimer);
    const successEl = document.getElementById('coaching-pylon-success');
    if (successEl) successEl.classList.remove('visible');

    // Show a brief message and restart the phase
    const crashEl = document.getElementById('tutorial-crash');
    const hintEl = document.getElementById('tutorial-crash-hint');
    document.getElementById('tutorial-crash-text').textContent = 'Not quite!';
    hintEl.textContent = hint;
    crashEl.classList.add('visible');

    const pi = TUTORIAL_PHASES[phase];
    setTimeout(() => {
      crashEl.classList.remove('visible');
      document.getElementById('tutorial-crash-text').textContent = 'Oops! Try again';
      // Reset bike to start of this phase's runway
      this.bike.resetToDistance(pi.runwayStart);
      this.bike.distanceTraveled = pi.runwayStart;
      this.bike.speed = 0;
      // Reset input lean so bike doesn't inherit pre-crash tilt
      this.input.resetLeanState();
      // Reset this phase's collectibles (preserve earlier phases)
      if (this.collectibleManager) this.collectibleManager.resetInRange(pi.contentStart, pi.contentEnd);
      // Reset pylon tracking for retry
      if (this.obstacleManager) this.obstacleManager.resetPassTracking();
      // Reset phase state
      this._tutorialPhase = -1;
      this._tutOffRoadTime = 0;
      this._tutRetryPending = false;
      this._tutCrashPending = false;
    }, 1200);
  }

  _tutorialCrash(phase) {
    this._tutorialAttempts++;

    // Feed failure to DDA manager
    if (this.ddaManager) {
      this.ddaManager.recordFailure(this._tutTargetPhase);
      this.ddaManager.applyInvisibleAdjustments();
    }

    // After 3+ crashes on the same phase, activate progressive assistance
    const phaseCrashes = this.ddaManager ? this.ddaManager.getFailureCount(this._tutTargetPhase) : 0;
    if (phaseCrashes >= 3) {
      this._assistWeight = Math.min(0.3, (phaseCrashes - 2) * 0.1);
      if (this._tutPhaseAutoCorrectionStrengths) {
        this._tutPhaseAutoCorrectionStrengths[this._tutTargetPhase] = Math.min(8.0,
          (this._tutPhaseAutoCorrectionStrengths[this._tutTargetPhase] || 3.0) + 0.5);
      }
    }

    // Clear off-road warning
    const warningEl = document.getElementById('coaching-offroad-warning');
    if (warningEl) warningEl.classList.remove('visible');

    // Show crash hint
    const crashEl = document.getElementById('tutorial-crash');
    const hintEl = document.getElementById('tutorial-crash-hint');

    // Determine crash cause
    const absLean = Math.abs(this.bike.lean);
    if (absLean > 1.0) {
      const hasMotion = this.input.motionEnabled || this.input.gyroConnected;
      const action = this.input.gyroConnected ? 'leans' : hasMotion ? 'tilts' : 'moves';
      hintEl.textContent = 'Try smaller ' + action + ' \u2014 gentle corrections!';
    } else if (phase === 3) {
      hintEl.textContent = 'Watch ahead and steer early!';
    } else {
      hintEl.textContent = 'Keep pedaling to stay stable!';
    }
    crashEl.classList.add('visible');

    // Hide gameover overlay if it would show
    document.getElementById('gameover-overlay').style.display = 'none';

    const pi = TUTORIAL_PHASES[phase];
    setTimeout(() => {
      crashEl.classList.remove('visible');
      // Reset bike to start of this phase's runway
      this.bike.resetToDistance(pi.runwayStart);
      this.bike.distanceTraveled = pi.runwayStart;
      this.bike.speed = 0;
      this.state = 'playing';
      // Reset input lean so bike doesn't inherit pre-crash tilt
      this.input.resetLeanState();
      // Reset this phase's collectibles
      if (this.collectibleManager) this.collectibleManager.resetInRange(pi.contentStart, pi.contentEnd);
      // Reset pylon tracking
      if (this.obstacleManager) this.obstacleManager.resetPassTracking();
      this._tutorialPhase = -1;
      this._tutOffRoadTime = 0;
      this._tutCrashPending = false;
      this._tutRetryPending = false;
      this._tutPeakLean = 0;
      this._tutPeakTime = 0;
      this._tutLastSign = 0;
    }, 1200);
  }

  _tutorialComplete() {
    this._tutorialAttempts++;

    // Analytics: tutorial complete
    const durationSec = this._tutorialStartTime ? (performance.now() - this._tutorialStartTime) / 1000 : 0;
    analytics.trackEvent('tutorial_complete', {
      duration_sec: Math.round(durationSec),
      total_attempts: this._tutorialAttempts,
    });
    if (analytics.getCurrentRideId()) {
      analytics.endRide({
        completed: true,
        duration_ms: Math.round(durationSec * 1000),
        distance: this.bike ? this.bike.distanceTraveled : 0,
      });
    }

    // Compute tuning parameters from measurements
    const isGyro = this.input.gyroConnected;
    const params = this._computeTuningParams(isGyro);

    // Apply to TUNE
    if (isGyro) {
      TUNE.gyroSensitivity = params.sensitivity;
      TUNE.gyroDeadzone = params.deadzone;
      TUNE.gyroOutputSmoothing = params.outputSmoothing;
      TUNE.gyroResponseCurve = params.responseCurve;
    } else {
      TUNE.sensitivity = params.sensitivity;
      TUNE.deadzone = params.deadzone;
      TUNE.outputSmoothing = params.outputSmoothing;
      TUNE.responseCurve = params.responseCurve;
    }

    // Snapshot calibrated values as the base for feel scaling
    snapshotTuningBase();

    // Save to localStorage
    const saveData = {
      version: 1,
      inputType: isGyro ? 'gyro' : 'phone',
      platform: isAndroid ? 'android' : isIOS ? 'ios' : 'desktop',
      sensitivity: params.sensitivity,
      deadzone: params.deadzone,
      outputSmoothing: params.outputSmoothing,
      responseCurve: params.responseCurve,
      steeringFeel: 0.5,
      timestamp: Date.now()
    };
    try { localStorage.setItem(this._tuningKey(), JSON.stringify(saveData)); } catch {}

    // Notify stoker that tutorial is complete (multiplayer)
    if (this.mode === 'captain' && this.net && this.net.connected) {
      this.net.sendEventReliable(EVT_FINISH);
    }

    // Stop the game loop for this ride
    this.state = 'gameover'; // pause updates

    // Hide tutorial prompt, show completion screen
    document.getElementById('tutorial-prompt').classList.remove('visible');
    const statsEl = document.getElementById('tutorial-complete-stats');
    let html = '';
    if (this._tutorialAttempts > 1) {
      html += 'Attempts: ' + this._tutorialAttempts + ' \u2014 Practice makes perfect!<br>';
    }
    const totalPresents = TUTORIAL_ITEMS[1].collectibles.length + TUTORIAL_ITEMS[2].collectibles.length + TUTORIAL_ITEMS[3].collectibles.length;
    html += 'Presents collected: ' + this._tutorialCollected + '/' + totalPresents + '<br>';
    html += '<span class="calibrated">Steering calibrated to your style!</span>';
    statsEl.innerHTML = html;

    // Set up steering feel slider
    const slider = document.getElementById('steering-feel-slider');
    slider.value = 50;
    slider.oninput = () => {
      const feel = slider.value / 100;
      applySteeringFeel(feel);
    };

    // Show Steam Wishlist widget (hide if user already owns via Steam)
    const steamCta = document.getElementById('steam-cta');
    if (steamCta && !window.steam) {
      steamCta.style.display = '';
    }

    document.getElementById('tutorial-complete').classList.add('visible');

    // Register buttons for gamepad navigation (Steam Store link + continue)
    const steamStoreBtn = document.getElementById('btn-steam-store');
    const continueBtn = document.getElementById('btn-tutorial-continue');
    const overlayBtns = [];
    if (steamStoreBtn) overlayBtns.push(steamStoreBtn);
    overlayBtns.push(continueBtn);
    this._setOverlayButtons(overlayBtns, overlayBtns.length - 1);
    this._overlayFocus.setSlider(slider);

    if (isMobile) {
      this._overlayCooldownUntil = performance.now() + 3000;
      overlayBtns.forEach(b => b.style.pointerEvents = 'none');
      setTimeout(() => overlayBtns.forEach(b => b.style.pointerEvents = ''), 3000);
    }
  }

  _showStokerTutorialComplete() {
    this._tutorialActive = false;
    this.state = 'gameover'; // pause updates

    // Reuse tutorial-complete overlay with stoker-appropriate content
    document.getElementById('tutorial-prompt').classList.remove('visible');
    const statsEl = document.getElementById('tutorial-complete-stats');
    statsEl.innerHTML = '<span class="calibrated">Great teamwork! Steering calibrated.</span>';

    // Show steering feel slider for stoker too (their lean input matters)
    const slider = document.getElementById('steering-feel-slider');
    slider.value = 50;
    slider.oninput = () => {
      const feel = slider.value / 100;
      applySteeringFeel(feel);
    };

    // Hide Steam CTA (captain handles that)
    const steamCta = document.getElementById('steam-cta');
    if (steamCta) steamCta.style.display = 'none';

    // Change button to return to room (captain controls next action)
    const continueBtn = document.getElementById('btn-tutorial-continue');
    continueBtn.textContent = 'Continue';
    continueBtn.onclick = () => {
      document.getElementById('tutorial-complete').classList.remove('visible');
      continueBtn.textContent = "Let's RIDE!"; // restore for next time
      this._endTutorialRide();
    };

    document.getElementById('tutorial-complete').classList.add('visible');

    const overlayBtns = [continueBtn];
    this._setOverlayButtons(overlayBtns, 0);
    this._overlayFocus.setSlider(slider);

    if (isMobile) {
      this._overlayCooldownUntil = performance.now() + 3000;
      overlayBtns.forEach(b => b.style.pointerEvents = 'none');
      setTimeout(() => overlayBtns.forEach(b => b.style.pointerEvents = ''), 3000);
    }
  }

  _computeTuningParams(isGyro) {
    const defaults = BALANCE_DEFAULTS;

    // Phase 1 → Deadzone + rest offset
    let deadzone, restOffset;
    if (this._tutPhase1Samples.length >= 5) {
      const samples = this._tutPhase1Samples;
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
      const stdDev = Math.sqrt(variance);
      deadzone = Math.min(8, Math.max(2, Math.ceil(stdDev * 3)));
      restOffset = mean;
      // Update input manager offset
      this.input.motionOffset = restOffset;
    } else {
      deadzone = isGyro ? defaults.gyroDeadzone : defaults.deadzone;
    }

    // Phase 2 → Sensitivity
    let sensitivity;
    if (this._tutPhase2Samples.length >= 5) {
      const samples = this._tutPhase2Samples;
      let tiltMin = Infinity, tiltMax = -Infinity;
      for (const s of samples) {
        if (s < tiltMin) tiltMin = s;
        if (s > tiltMax) tiltMax = s;
      }
      const maxRange = Math.max(Math.abs(tiltMin), Math.abs(tiltMax));
      sensitivity = Math.min(60, Math.max(15, maxRange * 0.85));
    } else {
      sensitivity = isGyro ? defaults.gyroSensitivity : defaults.sensitivity;
    }

    // Phase 3 → Smoothing
    let outputSmoothing;
    if (this._tutPhase3Recovery.length >= 1) {
      const recoveries = this._tutPhase3Recovery;
      const avgRecovery = recoveries.reduce((a, b) => a + b, 0) / recoveries.length;
      const t = Math.min(1, Math.max(0, (avgRecovery - 200) / 400));
      outputSmoothing = 0.6 + (0.25 - 0.6) * t; // lerp(0.6, 0.25, t)
    } else {
      outputSmoothing = isGyro ? defaults.gyroOutputSmoothing : defaults.outputSmoothing;
    }

    // Response curve from Phase 2 lean distribution
    let responseCurve;
    if (this._tutPhase2Samples.length >= 5 && sensitivity > deadzone) {
      const absSamples = this._tutPhase2Samples.map(s => Math.abs(s));
      absSamples.sort((a, b) => a - b);
      const medianLean = absSamples[Math.floor(absSamples.length / 2)] / sensitivity;
      if (isGyro) {
        responseCurve = Math.min(2.0, Math.max(1.0, 1.0 + medianLean * 0.5));
      } else {
        responseCurve = Math.min(2.5, Math.max(1.2, 1.5 + medianLean));
      }
    } else {
      responseCurve = isGyro ? defaults.gyroResponseCurve : defaults.responseCurve;
    }

    return { sensitivity, deadzone, outputSmoothing, responseCurve };
  }

  _finishTutorial() {
    // Save the final steering feel value
    const slider = document.getElementById('steering-feel-slider');
    const feel = (slider ? slider.value : 50) / 100;
    try {
      const saved = localStorage.getItem(this._tuningKey());
      if (saved) {
        const data = JSON.parse(saved);
        data.steeringFeel = feel;
        localStorage.setItem(this._tuningKey(), JSON.stringify(data));
      }
    } catch {}

    document.getElementById('tutorial-complete').classList.remove('visible');
    this._endTutorialRide();
  }

  _endTutorialRide() {
    this._tutorialActive = false;
    this._calibHoldSamples = null;

    // Reset tutorial collection radius
    if (this.collectibleManager) {
      this.collectibleManager._tutorialRadius = null;
    }

    // Hide off-road warning
    const warningEl = document.getElementById('coaching-offroad-warning');
    if (warningEl) warningEl.classList.remove('visible');

    // Hide all tutorial UI
    document.getElementById('tutorial-prompt').classList.remove('visible');
    document.getElementById('tutorial-crash').classList.remove('visible');
    document.getElementById('tutorial-complete').classList.remove('visible');

    // Restore difficulty to lobby default (tutorial may have overridden it)
    this.lobby.selectedDifficulty = 'chill';

    // Restore joystick steering to lobby toggle state
    this.input.suppressGamepadLean = !this.lobby.joystickActive;

    // Multiplayer: return to room (keep connection alive for second ride)
    if (this.net) {
      this._returnToRoom();
      return;
    }

    // Solo: full cleanup and return to lobby
    this._musicBtn.style.display = 'none';
    this._hideGameOver();
    this._hideVictory();
    this._hideAllOverlays();
    if (this.collectibleManager) { this.collectibleManager.destroy(); this.collectibleManager = null; }
    if (this.obstacleManager) { this.obstacleManager.destroy(); this.obstacleManager = null; }
    this.raceManager = null;
    this.hud.raceManager = null;
    this.hud.hideCollectibles();
    this.hud.hideTimer();
    this.world.clearRaceMarkers();
    this.archIndicator.hide();

    // Reset bike
    this.bike.fullReset();
    this.chaseCamera.initialized = false;
    this.pedalCtrl = new PedalController(this.input);

    // Return to lobby
    this.state = 'lobby';
    this.lobby.show();
    if (this._isDemo) {
      this.lobby._showStep(this.lobby.modeStep);
    } else {
      this.lobby._pendingMode = 'solo';
      this.lobby._showStep(this.lobby.levelStep);
    }
  }

  // ============================================================
  // RESIZE
  // ============================================================

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}

// ============================================================
// BOOT
// ============================================================
const game = new Game();
window._game = game;
window.perfProbe = perfProbe;

