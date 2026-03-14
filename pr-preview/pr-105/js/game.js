// ============================================================
// GAME — orchestrator + boot (entry point)
// ============================================================

import * as THREE from 'three';
import { isMobile, EVT_COUNTDOWN, EVT_START, EVT_RESET, EVT_GAMEOVER, EVT_CHECKPOINT, EVT_FINISH, EVT_RETURN_ROOM, MSG_PROFILE, TUNE, BALANCE_DEFAULTS, applyDifficulty, applySteeringFeel, snapshotTuningBase } from './config.js';
import { RaceManager } from './race-manager.js';
import { getLevelById, LEVELS } from './race-config.js';
import { ContributionTracker } from './contribution-tracker.js';
import { CollectibleManager } from './collectibles.js';
import { ObstacleManager } from './obstacles.js';
import { AchievementManager, showAchievementToast, updateBadgeDisplay } from './achievements.js';
import { InputManager } from './input-manager.js';
import { PedalController } from './pedal-controller.js';
import { SharedPedalController } from './shared-pedal-controller.js';
import { BalanceController } from './balance-controller.js';
import { BikeModel } from './bike-model.js';
import { RemoteBikeState } from './remote-bike-state.js';
import { ChaseCamera } from './chase-camera.js';
import { World } from './world.js';
import { HUD } from './hud.js';
import { GrassParticles } from './grass-particles.js';
import { Lobby } from './lobby.js';
import { GameRecorder } from './game-recorder.js';
import { ArchIndicator } from './arch-indicator.js';
import { hapticCrash, hapticTreeHit, hapticCheckpoint, hapticFinish, hapticOffRoad } from './haptics.js';
import { DDAManager } from './dda-manager.js';

const DEMO_CHECKPOINT_LIMIT = 2; // Demo ends after 2 checkpoints
const TUNING_KEY_PREFIX = 'tandemonium_motion_tuning';

// Tutorial phase boundaries (meters)
const PHASE_1_END = 30;
const PHASE_2_END = 70;
const PHASE_3_END = 105;
const PHASE_4_END = 130;

class Game {
  constructor() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile, preserveDrawingBuffer: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

    // Components
    this.input = new InputManager();
    this.pedalCtrl = new PedalController(this.input);
    this.balanceCtrl = new BalanceController(this.input);
    this.world = new World(this.scene);
    this.bike = new BikeModel(this.scene);
    this.bike.roadPath = this.world.roadPath;
    this.chaseCamera = new ChaseCamera(this.camera);
    this.hud = new HUD(this.input);
    this.grassParticles = new GrassParticles(this.scene);
    this.archIndicator = new ArchIndicator(this.scene);
    this._partnerBikeColor = null;
    this.recorder = new GameRecorder(this.renderer.domElement, this.input);

    // Mode
    this.mode = 'solo'; // 'solo' | 'captain' | 'stoker'
    this.net = null;
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._partnerHasTilt = undefined; // undefined = unknown, true/false = received
    this._onPartnerTiltStatus = null;
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

    // Recording partner pedal flash tracking
    this._recLastTapTime = 0;
    this._recLastFoot = null;
    this._recFlashTimer = 0;
    this._recFlashFoot = null;
    this._recFlashWrong = false;

    // Recording checkpoint flash tracking
    this._checkpointFlashTime = 0;

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
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    });

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
      this._returnToLobby();
    });

    // Overlay gamepad navigation (game-over & victory)
    this._overlayButtons = [];
    this._overlayFocusIdx = 0;
    this._olPrevUp = false;
    this._olPrevDown = false;
    this._olPrevA = false;

    // Game state
    this.state = 'lobby'; // 'lobby' | 'instructions' | 'countdown' | 'playing' | 'gameover' | 'victory'
    this.countdownTimer = 0;
    this._lastCountNum = 3;
    this.instructionsEl = document.getElementById('instructions');
    this.audioCtx = null;

    // Lobby
    this.lobby = new Lobby({
      onSolo: () => this._onSolo(),
      onMultiplayerReady: (net, mode) => this._onMultiplayerReady(net, mode),
      input: this.input
    });

    // Background music
    this._musicEl = new Audio('assets/Krampus Workshop.mp3');
    this._musicEl.loop = true;
    this._musicEl.volume = this.lobby.musicVolume;
    this._musicSourceNode = null; // created once via createMediaElementSource

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
        // Reconnect source node to AudioContext destination before playing
        if (this._musicSourceNode && this.audioCtx) {
          try { this._musicSourceNode.connect(this.audioCtx.destination); } catch (e) {}
          // Also reconnect to recording destination if actively recording
          if (this.recorder && this.recorder._audioDestination) {
            try { this._musicSourceNode.connect(this.recorder._audioDestination); } catch (e) {}
          }
        }
        this._musicEl.play().catch(() => {});
      } else {
        this._musicEl.pause();
        // Disconnect source node so iOS doesn't produce glitchy looping artifacts
        if (this._musicSourceNode) {
          try { this._musicSourceNode.disconnect(); } catch (e) {}
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

    // Start loop
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ============================================================
  // LOBBY CALLBACKS
  // ============================================================

  /** True when the player is in demo mode (unlicensed solo). */
  get _isDemo() {
    return this.mode === 'solo' && !this.lobby.license.isLicensed;
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
        this._startCountdown();
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
        this._showGameOver(true);
      } else if (eventType === EVT_CHECKPOINT) {
        this._showCheckpointFlash();
      } else if (eventType === EVT_FINISH) {
        this._showVictory(true);
      } else if (eventType === EVT_RETURN_ROOM) {
        this._returnToRoom();
      }
    };

    this.net.onReconnecting = (attempt, max) => {
      if (this.state !== 'lobby') {
        this._showReconnecting();
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
    };

    this.net.onDisconnected = (reason) => {
      this._hideReconnecting();
      this.recorder.clearPartnerStream();
      updateBadgeDisplay('partner-badges', []);
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
      // Handle tilt status from partner
      if (profile && profile.type === 'tiltStatus') {
        this._partnerHasTilt = profile.hasTilt;
        if (this._onPartnerTiltStatus) this._onPartnerTiltStatus(profile.hasTilt);
        return;
      }
      // Handle camera toggle from partner during gameplay
      if (profile && profile.type === 'cameraToggle') {
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

    // Pre-acquire local media stream so calls connect instantly on both sides.
    // If lobby already acquired media (room step), reuse it.
    // Captain then initiates the media call; stoker holds the stream ready for
    // _handleIncomingCall to answer without an async getUserMedia delay.
    if (this.lobby.cameraActive || this.lobby.audioActive) {
      this._acquireLocalMedia().then(() => {
        if (mode === 'captain') this._initiateMediaCall();
      });
    } else if (mode === 'captain') {
      // Even without local media, initiate call so we can receive partner's stream
      this._initiateMediaCall();
    }

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

    // Show instructions
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  // ============================================================
  // START / COUNTDOWN
  // ============================================================

  _setupStartHandler() {
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

      // In multiplayer, only captain initiates countdown
      // Stoker waits for EVT_COUNTDOWN from captain
      if (this.mode === 'stoker') {
        // Stoker just dismisses instructions and waits
        this.instructionsEl.classList.add('hidden');
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'Waiting for captain...';
        statusEl.style.color = '#ffffff';
        statusEl.style.fontSize = '';
        return;
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
        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        const gp = gamepads[this.input.gamepadIndex];
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
    const difficultyName = this.lobby.selectedDifficulty || 'normal';
    applyDifficulty(difficultyName);
    this.ddaManager = new DDAManager(difficultyName);
    this._assistWeight = 0;

    // Reset background adaptation state for fresh ride
    this._adaptState = null;

    // Fresh tilt calibration for new ride (player may be holding phone differently)
    if (this.input.motionEnabled) {
      this.input.startTiltCalibration();
    }

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
    this.contributionTracker = new ContributionTracker(this.mode);
    if (this.collectibleManager) this.collectibleManager.destroy();
    this.collectibleManager = new CollectibleManager(this.scene, this.world.roadPath, level, this.camera);
    if (this.obstacleManager) this.obstacleManager.destroy();
    this.obstacleManager = new ObstacleManager(this.scene, this.world.roadPath, level, this.camera);
    this.hud.initProgress(level);
    this.hud.initTimer();
    // Show initial segment budget during countdown
    const firstTarget = this.raceManager.checkpoints.length > 0 ? this.raceManager.checkpoints[0] : this.raceManager.raceDistance;
    const initialBudget = this.raceManager._segmentBudget(firstTarget);
    this.hud.updateTimer(initialBudget, initialBudget);
    this.hud.showCollectibles(level);
    this.world.setRaceMarkers(level, this.camera);

    // Place "DEMO END" sprite on the last demo checkpoint arch from the start
    if (this._isDemo) {
      this._addDemoEndSprite(DEMO_CHECKPOINT_LIMIT - 1);
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

    // Init audio before recording so beeps are captured
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
    } catch (e) {}

    // Start recording + selfie immediately so they're visible during countdown
    this.recorder.setLabels(this.mode);
    this.recorder.startBuffer(this.audioCtx, this.lobby.audioActive);
    if (this.lobby.cameraActive) {
      this.recorder.startSelfie();
    } else if (this.lobby.auth && this.lobby.auth.isLoggedIn()) {
      const user = this.lobby.auth.getUser();
      if (user && user.avatar) this.recorder.showAvatarPip(this.lobby._avatarCache.get(user.avatar) || user.avatar);
    }

    // Route background music through AudioContext so it's captured in recordings
    if (this.audioCtx && !this._musicSourceNode) {
      try {
        this._musicSourceNode = this.audioCtx.createMediaElementSource(this._musicEl);
        this._musicSourceNode.connect(this.audioCtx.destination);
      } catch (e) {}
    }
    // Also route music to recording destination
    if (this._musicSourceNode && this.recorder && this.recorder._audioDestination) {
      try { this._musicSourceNode.connect(this.recorder._audioDestination); } catch (e) {}
    }
    // Play music if enabled
    if (this.lobby.musicActive) {
      this._musicEl.play().catch(() => {});
    }

    this._playBeep(400, 0.15);

    // Captain notifies stoker
    if (this.mode === 'captain' && this.net) {
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

  _playBeep(freq, duration) {
    try {
      if (!this.audioCtx) return;
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      // Also route to recording audio destination (captures beeps in clips)
      if (this.recorder && this.recorder._audioDestination) {
        gain.connect(this.recorder._audioDestination);
      }
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (e) {}
  }

  _playChime(freq, duration) {
    try {
      if (!this.audioCtx) return;
      const ctx = this.audioCtx;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (this.recorder && this.recorder._audioDestination) {
        gain.connect(this.recorder._audioDestination);
      }
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch (e) {}
  }

  _onTimerExpired() {
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
    this._playBeep(200, 0.3);
    setTimeout(() => this._playBeep(150, 0.2), 300);

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
    // Rising chime: three ascending sine tones
    this._playChime(523, 0.25);  // C5
    setTimeout(() => this._playChime(659, 0.25), 100);  // E5
    setTimeout(() => this._playChime(784, 0.35), 200);  // G5
  }

  // ============================================================
  // RESET / DISCONNECT / RETURN TO LOBBY
  // ============================================================

  _resetGame(fromRemote = false, fromBeginning = false) {
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

    // Only tilt calibration (10 samples, ~167ms) — NOT gyro calibration
    // (150 samples, ~1.5s) which would conflict with the 3s countdown.
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

  _showReconnecting() {
    this._reconnecting = true;
    document.getElementById('conn-badge').classList.add('reconnecting');
  }

  _hideReconnecting() {
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

    if (!fromRemote && this.net) {
      this.net.sendEvent(EVT_GAMEOVER);
    }
  }

  _hideGameOver() {
    document.getElementById('gameover-overlay').style.display = 'none';
    this._clearOverlayButtons();
  }

  /** Dismiss any stray full-screen overlays that sit above the lobby (z-index 60)
   *  and cancel pending timers that would re-show them. */
  _hideAllOverlays() {
    for (const id of ['demo-end-overlay', 'stoker-cta-overlay', 'disconnect-overlay']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    // Tutorial overlays
    const tutPrompt = document.getElementById('tutorial-prompt');
    if (tutPrompt) tutPrompt.classList.remove('visible');
    const tutSkip = document.getElementById('tutorial-skip');
    if (tutSkip) tutSkip.style.display = 'none';
    const tutCrash = document.getElementById('tutorial-crash');
    if (tutCrash) tutCrash.classList.remove('visible');
    const tutComplete = document.getElementById('tutorial-complete');
    if (tutComplete) tutComplete.classList.remove('visible');
    if (this._demoEndTimer) { clearTimeout(this._demoEndTimer); this._demoEndTimer = null; }
    if (this._stokerCTATimer) { clearTimeout(this._stokerCTATimer); this._stokerCTATimer = null; }
    this._clearOverlayButtons();
  }

  /** Show the demo-end overlay with purchase CTA. */
  _showDemoEnd() {
    this.state = 'gameover';
    this.bike.speed = 0;
    document.getElementById('status').textContent = '';

    // Brief pause so the player sees the arch, then show overlay
    this._demoEndTimer = setTimeout(() => {
      this._demoEndTimer = null;
      if (this.state === 'lobby') return;
      this._removeDemoEndSprite();
      const overlay = document.getElementById('demo-end-overlay');
      overlay.style.display = 'flex';

      const buyBtn = document.getElementById('btn-demo-buy');
      const togetherBtn = document.getElementById('btn-demo-together');
      const lobbyBtn = document.getElementById('btn-demo-lobby');
      const btns = [buyBtn, togetherBtn, lobbyBtn].filter(Boolean);
      this._setOverlayButtons(btns);

      if (buyBtn) {
        buyBtn.onclick = async () => {
          try {
            const url = await this.lobby.license.startCheckout('tandemonium-web-early');
            window.location.href = url;
          } catch (e) {
            console.error('Checkout error', e);
          }
        };
      }
      if (togetherBtn) {
        togetherBtn.onclick = () => {
          overlay.style.display = 'none';
          this._clearOverlayButtons();
          if (!this.lobby.auth.isLoggedIn()) {
            this.lobby.auth.login();
          }
          this._returnToLobby();
        };
      }
      if (lobbyBtn) {
        lobbyBtn.onclick = () => {
          overlay.style.display = 'none';
          this._clearOverlayButtons();
          this._returnToLobby();
        };
      }
    }, 2500);
  }

  /**
   * Add "DEMO END" canvas sprite inside a checkpoint arch, gently swaying.
   * @param {number} cpIndex — 0-based index of the checkpoint arch to target
   */
  _addDemoEndSprite(cpIndex) {
    const markers = this.world._raceMarkers;
    if (!markers) return;

    const checkpoints = markers.filter(m => m.type === 'checkpoint');
    if (cpIndex >= checkpoints.length) return;
    const arch = checkpoints[cpIndex].mesh;

    // Canvas texture — fast, no font loading
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    ctx.strokeText('DEMO', 128, 38);
    ctx.strokeText('END', 128, 90);
    ctx.fillStyle = '#ff6600';
    ctx.fillText('DEMO', 128, 38);
    ctx.fillText('END', 128, 90);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.0, 1.0, 1);
    sprite.position.set(0, 1.6, 0);
    sprite.name = 'demo-end-sprite';

    arch.add(sprite);
    this._demoEndArch = arch;
    this._demoEndSprite = sprite;
    this._demoEndTime = performance.now();
  }

  /** Called each frame from the render loop to animate the sway. */
  _updateDemoEndSprite() {
    if (!this._demoEndSprite) return;
    const t = (performance.now() - this._demoEndTime) / 1000;
    this._demoEndSprite.position.x = Math.sin(t * 1.5) * 0.4;
    this._demoEndSprite.position.y = 1.6 + Math.sin(t * 2.0) * 0.1;
  }

  _removeDemoEndSprite() {
    if (this._demoEndArch && this._demoEndSprite) {
      this._demoEndArch.remove(this._demoEndSprite);
      if (this._demoEndSprite.material.map) this._demoEndSprite.material.map.dispose();
      this._demoEndSprite.material.dispose();
      this._demoEndSprite = null;
      this._demoEndArch = null;
    }
  }

  /** Show purchase CTA after riding together as unlicensed stoker. */
  _showStokerCTA() {
    const overlay = document.getElementById('stoker-cta-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const buyBtn = document.getElementById('btn-stoker-cta-buy');
    const contBtn = document.getElementById('btn-stoker-cta-continue');
    const btns = [buyBtn, contBtn].filter(Boolean);
    this._setOverlayButtons(btns);

    if (buyBtn) {
      buyBtn.onclick = async () => {
        try {
          const url = await this.lobby.license.startCheckout('tandemonium-web-early');
          window.location.href = url;
        } catch (e) {
          console.error('Checkout error', e);
        }
      };
    }
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

      // Demo mode: end ride after DEMO_CHECKPOINT_LIMIT checkpoints
      if (this._isDemo && raceEvent.passed >= DEMO_CHECKPOINT_LIMIT) {
        this._showDemoEnd();
        return;
      }



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
      this._showVictory();
      hapticFinish();

      // Send authoritative finish stats to stoker before the finish event
      if (this.mode === 'captain' && this.net) {
        this.raceManager.inputSource = this.balanceCtrl.getSteerSource();
        this.net.sendProfile({
          type: 'finishStats',
          raceSummary: this.raceManager.getSummary(this.bike.distanceTraveled),
          contribSummary: this.contributionTracker ? this.contributionTracker.getSummary() : null,
        });
        this.net.sendEvent(EVT_FINISH);
      }
    }
  }

  _onCollect(count) {
    if (this.raceManager) this.raceManager.collectiblesCount += count;
    this.hud.updateCollectibles(this.collectibleManager.collected, this.collectibleManager.getTotalItems());
    this.bike.boostTimer = 3; // 3-second speed boost
    this._playBeep(1200, 0.1);
    setTimeout(() => this._playBeep(1600, 0.08), 80);
  }

  _checkAchievements(dt) {
    const state = {
      distance: this.bike.distanceTraveled,
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
    });
  }

  _checkFinishAchievements() {
    const level = this.lobby.selectedLevel;
    const state = {
      distance: this.bike.distanceTraveled,
      speed: 0,
      dt: 0,
      offsetScore: 0,
      collectibles: this.collectibleManager ? this.collectibleManager.collected : 0,
      totalCollectibles: this.collectibleManager ? this.collectibleManager.getTotalItems() : 0,
      finishedLevel: level.id,
      bikeKey: this.lobby.selectedPresetKey,
      raceDistance: level.distance,
      crashes: this.raceManager ? this.raceManager.crashCount : 0,
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
    profile.bikeColor = this._getFrameColor(this.lobby.selectedPreset);
    this.net.sendProfile(profile);
  }

  _showVictory(fromRemote = false) {
    this.state = 'victory';
    this.hud.hideTimer();
    const overlay = document.getElementById('victory-overlay');
    overlay.style.display = 'flex';

    const level = this.lobby.selectedLevel;
    // Victory title includes role in multiplayer
    const victoryTitle = document.getElementById('victory-title');
    if (this.mode === 'captain' || this.mode === 'stoker') {
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
      const right = [
        { icon: '\u2601\uFE0F', value: summary.checkpointsPassed + '/' + summary.checkpointsTotal }, // ☁️ Checkpoints
      ];
      if (summary.collectibles > 0) {
        right.push({ icon: collectIcon, value: '' + summary.collectibles });
      }
      if (summary.inputSource && summary.inputSource !== 'none') {
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

      // Multiplayer contribution breakdown
      if (soloStats && soloStats.mode === 'multiplayer') {
        const contrib = soloStats;
        const contribDiv = document.createElement('div');
        contribDiv.className = 'victory-contrib';
        contribDiv.innerHTML =
          '<div class="victory-contrib-header">' +
            '<span class="contrib-label captain-label">CAPTAIN ' + contrib.captain.overallPct + '%</span>' +
            '<span class="contrib-label stoker-label">STOKER ' + contrib.stoker.overallPct + '%</span>' +
          '</div>' +
          '<div class="victory-contrib-bar">' +
            '<div class="contrib-fill-captain" style="width:' + contrib.captain.overallPct + '%"></div>' +
            '<div class="contrib-fill-stoker" style="width:' + contrib.stoker.overallPct + '%"></div>' +
          '</div>' +
          '<div class="victory-contrib-detail">' +
            '<div class="contrib-col">' +
              '<div>\uD83E\uDDB6 <strong>' + contrib.captain.totalTaps + '</strong></div>' +
              '<div>\u2696\uFE0F <strong>' + contrib.captain.safePct + '%</strong></div>' +
              '<div>\uD83D\uDEE3\uFE0F <strong>' + contrib.captain.onRoadPct + '%</strong></div>' +
            '</div>' +
            '<div class="contrib-col">' +
              '<div>\uD83E\uDDB6 <strong>' + contrib.stoker.totalTaps + '</strong></div>' +
              '<div>\u2696\uFE0F <strong>' + contrib.stoker.safePct + '%</strong></div>' +
              '<div>\uD83D\uDEE3\uFE0F <strong>' + contrib.stoker.onRoadPct + '%</strong></div>' +
            '</div>' +
          '</div>';
        statsEl.appendChild(contribDiv);
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

    this._playBeep(800, 0.3);
    setTimeout(() => this._playBeep(1000, 0.3), 200);
    setTimeout(() => this._playBeep(1200, 0.5), 400);

    // 5-second input cooldown to prevent accidental taps
    this._overlayCooldownUntil = performance.now() + 5000;
    victoryBtns.forEach(b => b.style.pointerEvents = 'none');
    setTimeout(() => victoryBtns.forEach(b => b.style.pointerEvents = ''), 5000);

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

    const difficulty = this.lobby.selectedDifficulty || 'normal';
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
      if (contrib.mode === 'multiplayer') {
        const myRole = this.mode; // 'captain' or 'stoker'
        const partnerRole = myRole === 'captain' ? 'stoker' : 'captain';
        contrib[myRole].userId = myServerId;
        contrib[partnerRole].userId = this._partnerServerId;
        data.contributions = { captain: contrib.captain, stoker: contrib.stoker };
      } else {
        contrib.solo.userId = myServerId;
        data.contributions = { solo: contrib.solo };
      }
    }

    try {
      await auth.submitScore(data);
      const syncResult = await auth.syncAchievements(this.achievements.getEarnedIds());
      if (syncResult && syncResult.achievements) {
        this.achievements.mergeFromServer(
          syncResult.achievements.map(a => ({ id: a.achievement_id, earnedAt: a.earned_at }))
        );
      }
    } catch (e) {}
  }

  _hideVictory() {
    document.getElementById('victory-overlay').style.display = 'none';
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
    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
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

    this._victoryVideo = { video, animId };
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
      if (this._musicSourceNode) {
        try { this._musicSourceNode.disconnect(); } catch (e) {}
      }
    }
    this._hideGameOver();
    this._hideVictory();
    this._removeDemoEndSprite();
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
    try { localStorage.removeItem('tandemonium-room'); } catch (e) {}
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
  }

  _returnToRoom() {
    this._musicBtn.style.display = 'none';
    if (!this.net) {
      // Fallback to full lobby return if no connection
      this._returnToLobby();
      return;
    }

    // Captain tells stoker to return to room too
    if (this.mode === 'captain') {
      this.net.sendEvent(EVT_RETURN_ROOM);
    }

    if (!this.lobby.musicActive) {
      this._musicEl.pause();
      this._musicEl.currentTime = 0;
      if (this._musicSourceNode) {
        try { this._musicSourceNode.disconnect(); } catch (e) {}
      }
    }
    this._hideGameOver();
    this._hideVictory();
    this._hideAllOverlays();

    // Partial cleanup: game state only (keep connection + media alive)
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
    const localStream = this.net._localMediaStream || new MediaStream();
    const remotePeerId = this.net.conn && this.net.conn.peer;
    if (!remotePeerId) return;
    clearTimeout(this._mediaRetryTimeout);
    if (!this._mediaRetryCount) this._mediaRetryCount = 0;
    const call = this.net.peer.call(remotePeerId, localStream);
    if (call) {
      call.on('stream', (remoteStream) => {
        clearTimeout(this._mediaRetryTimeout);
        this._mediaRetryCount = 0;
        this.recorder.setPartnerStream(remoteStream);
        this.net._playRemoteAudio(remoteStream);
        this.recorder.addAudioStreams(this.net._localMediaStream || null, remoteStream);
      });
      // Retry up to 10 times if partner stream doesn't arrive
      this._mediaRetryCount++;
      if (this._mediaRetryCount < 10) {
        this._mediaRetryTimeout = setTimeout(() => {
          if (!this.recorder.partnerActive) this._initiateMediaCall();
        }, 3000);
      }
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

  _pollDpad() {
    if (!this.input.gamepadConnected) return;
    // Don't process gameplay D-pad while clip preview modal is open
    if (this.recorder._previewPollId) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || false;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || false;
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || false;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || false;

    // Y button (button 3) — save clip
    const y = gp.buttons[3] && gp.buttons[3].pressed;
    // A button (button 0) — recalibrate tilt
    const a = gp.buttons[0] && gp.buttons[0].pressed;
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

  _setOverlayButtons(buttons, initialFocus = 0) {
    this._overlayButtons = buttons.filter(Boolean);
    this._overlayFocusIdx = Math.min(initialFocus, this._overlayButtons.length - 1);
    this._olPrevUp = false;
    this._olPrevDown = false;
    this._olPrevLeft = false;
    this._olPrevRight = false;
    this._olPrevA = false;
    if (this._overlayButtons.length > 0) {
      this._overlayButtons[this._overlayFocusIdx].classList.add('gamepad-focus');
    }
  }

  _clearOverlayButtons() {
    for (const btn of this._overlayButtons) btn.classList.remove('gamepad-focus');
    this._overlayButtons = [];
    this._overlaySlider = null;
  }

  _pollOverlayGamepad() {
    if (this._overlayButtons.length === 0) return;
    if (!this.input.gamepadConnected) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
    const left = (gp.buttons[14] && gp.buttons[14].pressed) || gp.axes[0] < -0.5;
    const right = (gp.buttons[15] && gp.buttons[15].pressed) || gp.axes[0] > 0.5;
    const a = gp.buttons[0] && gp.buttons[0].pressed;

    if (up && !this._olPrevUp) {
      this._overlayButtons[this._overlayFocusIdx].classList.remove('gamepad-focus');
      this._overlayFocusIdx = Math.max(0, this._overlayFocusIdx - 1);
      this._overlayButtons[this._overlayFocusIdx].classList.add('gamepad-focus');
    }
    if (down && !this._olPrevDown) {
      this._overlayButtons[this._overlayFocusIdx].classList.remove('gamepad-focus');
      this._overlayFocusIdx = Math.min(this._overlayButtons.length - 1, this._overlayFocusIdx + 1);
      this._overlayButtons[this._overlayFocusIdx].classList.add('gamepad-focus');
    }

    // Left/right: always drive the overlay slider if one is registered
    const slider = this._overlaySlider;
    if (slider) {
      const rawX = gp.axes[0] || 0;
      const deadzone = 0.12;
      let changed = false;

      // Analog stick: continuous proportional movement
      if (Math.abs(rawX) > deadzone) {
        const speed = rawX * 1.5; // ~1.5 units/frame at full deflection (60fps = full sweep in ~1s)
        slider.value = Math.min(Number(slider.max), Math.max(Number(slider.min), Number(slider.value) + speed));
        changed = true;
      }

      // D-pad: repeating discrete steps (fires on press, then repeats while held)
      if (left) {
        if (!this._olPrevLeft) {
          slider.value = Math.max(Number(slider.min), Number(slider.value) - 3);
          changed = true;
          this._olDpadRepeatTime = performance.now() + 400; // initial delay
        } else if (performance.now() > this._olDpadRepeatTime) {
          slider.value = Math.max(Number(slider.min), Number(slider.value) - 2);
          changed = true;
          this._olDpadRepeatTime = performance.now() + 80; // repeat rate
        }
      }
      if (right) {
        if (!this._olPrevRight) {
          slider.value = Math.min(Number(slider.max), Number(slider.value) + 3);
          changed = true;
          this._olDpadRepeatTime = performance.now() + 400;
        } else if (performance.now() > this._olDpadRepeatTime) {
          slider.value = Math.min(Number(slider.max), Number(slider.value) + 2);
          changed = true;
          this._olDpadRepeatTime = performance.now() + 80;
        }
      }

      if (changed) slider.dispatchEvent(new Event('input'));
    }

    if (a && !this._olPrevA && performance.now() >= this._overlayCooldownUntil) {
      this._overlayButtons[this._overlayFocusIdx].click();
    }

    this._olPrevUp = up;
    this._olPrevDown = down;
    this._olPrevLeft = left;
    this._olPrevRight = right;
    this._olPrevA = a;
  }

  // ============================================================
  // TREE COLLISION
  // ============================================================

  _checkTreeCollision() {
    if (this.bike.fallen || this.bike.speed < 0.5) return;
    // Skip tree collision during tutorial — only pylons matter
    if (this._tutorialActive) {
      // Still check pylon collision
      if (this.obstacleManager && this.obstacleManager.checkCollision(this.bike.position)) {
        this.bike._fall();
        this.chaseCamera.shakeAmount = 0.25;
        this._playBeep(150, 0.4);
        hapticTreeHit();
      }
      return;
    }
    const result = this.world.checkTreeCollision(
      this.bike.position, this.bike.roadD, this.bike.heading
    );
    if (result.hit) {
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.2;
      this._playBeep(200, 0.3);
      hapticTreeHit();
      return;
    }
    // Pylon obstacle collision
    if (this.obstacleManager && this.obstacleManager.checkCollision(this.bike.position)) {
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.25;
      this._playBeep(150, 0.4);
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

    // Poll gamepad every frame before reading any input
    this.input.pollGamepad();

    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
    this.lastTime = timestamp;

    const roadPath = this.world.roadPath;

    if (this.state === 'playing') {
      // D-pad actions (safety/speed/reset/lobby)
      this._pollDpad();

      // Playing state — dispatch by mode
      if (this.mode === 'solo') {
        this._updateSolo(dt);
      } else if (this.mode === 'captain') {
        this._updateCaptain(dt);
      } else if (this.mode === 'stoker') {
        this._updateStoker(dt);
      }
    } else {
      // Lobby / countdown / instructions / victory / gameover: render static scene
      if (this.state === 'countdown') this._updateCountdown(dt);
      if (this.state === 'gameover' || this.state === 'victory' ||
          document.getElementById('disconnect-overlay').style.display !== 'none') this._pollOverlayGamepad();
      this.world.update(this.bike.position, this.bike.roadD, dt);
      this.chaseCamera.update(this.bike, dt, roadPath);
      if (this.archIndicator._visible) this.archIndicator.update(this.bike, 0, 0);
      this._updateDemoEndSprite();
      this.renderer.render(this.scene, this.camera);
    }

    // Clear buffered tap flags after all input has been read this frame
    this.input.consumeTaps();
  }

  // ============================================================
  // SOLO UPDATE
  // ============================================================

  _updateSolo(dt) {
    // Feed bike speed to input manager for velocity-dependent sensitivity
    this.input.bikeSpeed = this.bike.speed;
    this.input.bikeMaxSpeed = TUNE.maxSpeed || 19;

    const pedalResult = this.pedalCtrl.update(dt);
    const balanceResult = this.balanceCtrl.update(this.bike, this._assistWeight, this.collectibleManager, this.obstacleManager);

    // Sync balance assist to bike model
    this.bike._balanceAssist = this._assistWeight;

    const wasFallen = this.bike.fallen;
    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this._checkTreeCollision();

    // Race progress + contribution tracking
    if (this.raceManager) {
      const raceEvent = this.raceManager.update(this.bike.distanceTraveled, this._tutorialActive ? 0 : dt);
      if (raceEvent) {
        if (raceEvent.event === 'timeout' && !this._tutorialActive) { this._onTimerExpired(); return; }
        this._handleRaceEvent(raceEvent);
      }
      this.hud.updateProgress(this.bike.distanceTraveled, this.raceManager.raceDistance, this.raceManager.passedCheckpoints);
      this.hud.updateTimer(this.raceManager.segmentTimeRemaining, this.raceManager.segmentTimeTotal);
    }
    if (this.contributionTracker) {
      this.contributionTracker.update(dt, this.bike, balanceResult.leanInput, 0, this.pedalCtrl.stats);
    }

    // Collectibles
    if (this.collectibleManager) {
      const collected = this.collectibleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
      if (collected.length > 0) {
        this._onCollect(collected.length);
      }
    }

    // Obstacles
    if (this.obstacleManager) {
      this.obstacleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    }

    // Achievements
    this._checkAchievements(dt);

    // Background motion adaptation (not during tutorial)
    if (!this._tutorialActive && (this.input.motionEnabled || this.input.gyroConnected)) {
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
    this.world.update(this.bike.position, this.bike.roadD, dt);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    // Camera shake on crash
    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

    this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
    this.archIndicator.update(this.bike, balanceResult.leanInput);
    this._updateDemoEndSprite();
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

    // Race progress + contribution tracking (captain is authoritative)
    // Freeze race timer while reconnecting
    if (this.raceManager) {
      const raceDt = this._reconnecting ? 0 : dt;
      const raceEvent = this.raceManager.update(this.bike.distanceTraveled, raceDt);
      if (raceEvent && !this._reconnecting) {
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

    // Collectibles (captain is authoritative)
    if (this.collectibleManager) {
      const collected = this.collectibleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
      if (collected.length > 0) {
        this._onCollect(collected.length);
      }
    }

    // Obstacles
    if (this.obstacleManager) {
      this.obstacleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    }

    // Achievements
    this._checkAchievements(dt);

    // Show game over after crash recovery
    if (wasFallen && !this.bike.fallen) { this._showGameOver(); return; }

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

    this.world.update(this.bike.position, this.bike.roadD, dt);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

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
      this._showGameOver(true); // captain already sent EVT_GAMEOVER
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
      const raceDt = this._reconnecting ? 0 : dt;
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

  async _startTutorialRide() {
    this.lobby._forceWizard = false;
    this._tutorialActive = true;
    this._tutorialPhase = 0; // will advance to 1 on first update
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
    this._tutHoldStillShown = false;
    this._tutOffRoadTime = 0;

    // Use tutorial level with Chill difficulty
    const tutLevel = getLevelById('tutorial');
    this.lobby.selectedLevel = tutLevel;
    this.lobby.selectedDifficulty = 'chill';

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
    this.input.suppressGamepadLean = true;

    // Show tutorial UI
    document.getElementById('tutorial-skip').style.display = 'block';
    document.getElementById('tutorial-skip').onclick = () => this._skipTutorial();
    document.getElementById('btn-tutorial-continue').onclick = () => this._finishTutorial();

    // Start the ride via normal countdown flow
    this._startCountdown();

    // Hide timer (no time pressure in tutorial)
    this.hud.hideTimer();
  }

  _updateTutorial(dt) {
    if (!this._tutorialActive) return;

    const dist = this.bike.distanceTraveled;
    const isGyro = this.input.gyroConnected;

    // Determine current phase
    let phase;
    if (dist < PHASE_1_END) phase = 1;
    else if (dist < PHASE_2_END) phase = 2;
    else if (dist < PHASE_3_END) phase = 3;
    else phase = 4;

    // Phase transition checks
    if (phase !== this._tutorialPhase) {
      // Phase 2 → 3: must have collected all Phase 2 presents (first 4)
      if (this._tutorialPhase === 2 && phase === 3) {
        const collected = this.collectibleManager ? this.collectibleManager.collected : 0;
        if (collected < 4) {
          this._tutorialPhaseRetry(2, 'Collect all the presents! (' + collected + '/4)');
          return;
        }
      }
      // Phase 3 → 4: verify pylons navigated correctly
      if (this._tutorialPhase === 3 && phase === 4) {
        if (this.obstacleManager) {
          const pylonResult = this.obstacleManager.getTutorialResults();
          // Only check the first 4 pylons (Phase 3 pylons)
          if (pylonResult.wrongSide > 0 || pylonResult.passed < 4) {
            const hint = pylonResult.wrongSide > 0
              ? 'Stay on the correct side of each pylon!'
              : 'Navigate past all the pylons!';
            this._tutorialPhaseRetry(3, hint);
            if (this.obstacleManager) this.obstacleManager.resetTutorialTracking();
            return;
          }
        }
      }
      this._tutorialPhase = phase;
      this._showTutorialPhase(phase);
    }

    // Collect raw tilt sample
    const rawTilt = isGyro ? -this.input._gyroRollAccum : this.input.rawGamma;
    const now = performance.now();

    if (phase === 1) {
      // Phase 1: collect noise floor samples while player pedals
      if (rawTilt !== 0 || this._tutPhase1Samples.length > 0) {
        this._tutPhase1Samples.push(rawTilt);
      }
      // Show "hold phone steady" hint after first few meters
      if (dist > 5 && !this._tutHoldStillShown) {
        this._tutHoldStillShown = true;
        const text = document.getElementById('tutorial-prompt-text');
        text.textContent = 'Keep pedaling \u2014 hold your phone steady!';
      }
    } else if (phase === 2) {
      // Phase 2: collect steering range samples
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
    } else if (phase === 3) {
      // Phase 3: detect direction changes and measure recovery
      const offset = this.input.motionOffset || 0;
      const relative = rawTilt - offset;
      const deadzone = isGyro ? TUNE.gyroDeadzone : TUNE.deadzone;
      const sign = relative > deadzone ? 1 : relative < -deadzone ? -1 : 0;

      if (sign !== 0 && Math.abs(relative) > Math.abs(this._tutPeakLean)) {
        this._tutPeakLean = relative;
        this._tutPeakTime = now;
      }

      // Direction change: sign flipped (non-zero to non-zero)
      if (sign !== 0 && this._tutLastSign !== 0 && sign !== this._tutLastSign) {
        // Recovery = time from peak to now (crossing back through center)
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

      // Track which side the bike passes each pylon
      if (this.obstacleManager) {
        this.obstacleManager.updateTutorialTracking(dist, this.bike._lateralOffset);
      }
    } else if (phase === 4) {
      // Phase 4: combination — continue pylon tracking and recovery measurement
      if (this.obstacleManager) {
        this.obstacleManager.updateTutorialTracking(dist, this.bike._lateralOffset);
      }
    }

    // Off-road check: restart phase if player goes too far into the grass.
    // The dirt path extends to ~2.5m; grass starts beyond that. Allow the
    // shoulder and a bit of grass — only penalize deep off-road (>3.5m).
    const offDist = Math.abs(this.bike._lateralOffset) - 3.5; // <0 = on road/shoulder
    if (offDist > 0 && this.bike.speed > 0.5) {
      // Deeper off-road accumulates faster: weight by how far past the edge
      const depthWeight = Math.min(offDist / 2.0, 2.0); // 1× at 2m off, caps at 2×
      this._tutOffRoadTime += dt * depthWeight;
      if (this._tutOffRoadTime > 2.0) { // ~2s at edge, ~1s at 2m deep
        this._tutOffRoadTime = 0;
        this._tutorialPhaseRetry(phase, 'Stay on the road!');
        if (this.obstacleManager) this.obstacleManager.resetTutorialTracking();
        return;
      }
    } else {
      // Drain off-road time when back on the road (forgive brief clips)
      this._tutOffRoadTime = Math.max(0, this._tutOffRoadTime - dt * 2);
    }

    // Check for crash → tutorial retry (guard against repeated calls)
    if (this.bike.fallen && this.bike.fallTimer > 1.2 && !this._tutCrashPending) {
      this._tutCrashPending = true;
      this._tutorialCrash(phase);
      return;
    }

    // Check for completion
    if (dist >= PHASE_4_END && !this.bike.fallen) {
      // Verify Phase 4 collectibles gathered (only check Phase 4 zone)
      if (this.collectibleManager) {
        const p4Collected = this.collectibleManager.countCollectedInRange(PHASE_3_END, PHASE_4_END);
        const p4Total = this.collectibleManager.countTotalInRange(PHASE_3_END, PHASE_4_END);
        if (p4Collected < p4Total) {
          this._tutorialPhaseRetry(4, 'Collect the presents! (' + p4Collected + '/' + p4Total + ')');
          return;
        }
      }
      // Verify Phase 4 pylons navigated correctly
      if (this.obstacleManager) {
        const pylonResult = this.obstacleManager.getTutorialResults();
        if (pylonResult.wrongSide > 0 || pylonResult.passed < pylonResult.total) {
          const hint = pylonResult.wrongSide > 0
            ? 'Stay on the correct side of the pylons!'
            : 'Navigate past all the pylons!';
          this._tutorialPhaseRetry(4, hint);
          if (this.obstacleManager) this.obstacleManager.resetTutorialTracking();
          return;
        }
      }
      this._tutorialComplete();
    }
  }

  _showTutorialPhase(phase) {
    const prompt = document.getElementById('tutorial-prompt');
    const text = document.getElementById('tutorial-prompt-text');
    const dots = document.querySelectorAll('.tutorial-dot');

    const prompts = {
      1: 'Tap LEFT pedal... Now RIGHT pedal... Keep alternating!',
      2: 'Tilt to steer! Collect the presents!',
      3: 'Dodge the pylons!',
      4: 'Put it all together! Collect and dodge!'
    };
    text.textContent = prompts[phase] || '';
    prompt.classList.add('visible');

    dots.forEach(d => {
      const p = parseInt(d.dataset.phase);
      d.classList.toggle('active', p === phase);
      d.classList.toggle('done', p < phase);
    });
  }

  _tutorialPhaseRetry(phase, hint) {
    // Show a brief message and restart the phase
    const crashEl = document.getElementById('tutorial-crash');
    const hintEl = document.getElementById('tutorial-crash-hint');
    document.getElementById('tutorial-crash-text').textContent = 'Not quite!';
    hintEl.textContent = hint;
    crashEl.classList.add('visible');

    // Restart at the beginning of the current phase (not before it)
    const phaseStart = phase === 1 ? 0 : phase === 2 ? PHASE_1_END : phase === 3 ? PHASE_2_END : PHASE_3_END;
    const phaseEnd = phase === 1 ? PHASE_1_END : phase === 2 ? PHASE_2_END : phase === 3 ? PHASE_3_END : PHASE_4_END;
    setTimeout(() => {
      crashEl.classList.remove('visible');
      document.getElementById('tutorial-crash-text').textContent = 'Oops! Try again';
      this.bike.resetToDistance(phaseStart);
      this.bike.distanceTraveled = phaseStart;
      this.bike.speed = 4; // give a running start so player doesn't stall
      // Reset only this phase's collectibles (preserve earlier phases)
      if (this.collectibleManager) this.collectibleManager.resetInRange(phaseStart, phaseEnd);
      // Reset pylon tracking for retry
      if (this.obstacleManager) this.obstacleManager.resetTutorialTracking();
      // Reset off-road timer
      this._tutOffRoadTime = 0;
      // Stay in same phase (don't reset to 0 which would re-detect Phase 1)
      this._tutorialPhase = phase;
    }, 1200);
  }

  _tutorialCrash(phase) {
    this._tutorialAttempts++;

    // Track collectibles gathered this attempt
    if (this.collectibleManager) {
      this._tutorialCollected = Math.max(this._tutorialCollected, this.collectibleManager.collected);
    }

    // Show crash hint
    const crashEl = document.getElementById('tutorial-crash');
    const hintEl = document.getElementById('tutorial-crash-hint');

    // Determine crash cause
    const absLean = Math.abs(this.bike.lean);
    if (absLean > 1.0) {
      hintEl.textContent = 'Try smaller tilts \u2014 gentle corrections!';
    } else if (phase === 3) {
      hintEl.textContent = 'Watch ahead and steer early!';
    } else {
      hintEl.textContent = 'Keep pedaling to stay stable!';
    }
    crashEl.classList.add('visible');

    // Hide gameover overlay if it would show
    document.getElementById('gameover-overlay').style.display = 'none';

    // Restart at the beginning of the current phase
    const phaseStart = phase === 1 ? 0 : phase === 2 ? PHASE_1_END : phase === 3 ? PHASE_2_END : PHASE_3_END;
    const phaseEnd = phase === 1 ? PHASE_1_END : phase === 2 ? PHASE_2_END : phase === 3 ? PHASE_3_END : PHASE_4_END;
    setTimeout(() => {
      crashEl.classList.remove('visible');
      this.bike.resetToDistance(phaseStart);
      this.bike.distanceTraveled = phaseStart;
      this.bike.speed = 4; // give a running start
      this.state = 'playing';
      this._tutCrashPending = false;
      // Reset only this phase's collectibles
      if (this.collectibleManager) this.collectibleManager.resetInRange(phaseStart, phaseEnd);
      // Reset pylon tracking for retry
      if (this.obstacleManager) this.obstacleManager.resetTutorialTracking();
      // Reset off-road timer
      this._tutOffRoadTime = 0;
      // Stay in same phase
      this._tutorialPhase = phase;
      this._tutPeakLean = 0;
      this._tutPeakTime = 0;
      this._tutLastSign = 0;
    }, 1200);
  }

  _tutorialComplete() {
    this._tutorialAttempts++;

    if (this.collectibleManager) {
      this._tutorialCollected = Math.max(this._tutorialCollected, this.collectibleManager.collected);
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
      sensitivity: params.sensitivity,
      deadzone: params.deadzone,
      outputSmoothing: params.outputSmoothing,
      responseCurve: params.responseCurve,
      steeringFeel: 0.5,
      timestamp: Date.now()
    };
    try { localStorage.setItem(this._tuningKey(), JSON.stringify(saveData)); } catch {}

    // Stop the game loop for this ride
    this.state = 'gameover'; // pause updates

    // Hide tutorial prompt, show completion screen
    document.getElementById('tutorial-prompt').classList.remove('visible');
    document.getElementById('tutorial-skip').style.display = 'none';

    const statsEl = document.getElementById('tutorial-complete-stats');
    let html = '';
    if (this._tutorialAttempts > 1) {
      html += 'Attempts: ' + this._tutorialAttempts + ' \u2014 Practice makes perfect!<br>';
    }
    html += 'Presents collected: ' + this._tutorialCollected + '/6<br>';
    html += '<span class="calibrated">Steering calibrated to your style!</span>';
    statsEl.innerHTML = html;

    // Set up steering feel slider
    const slider = document.getElementById('steering-feel-slider');
    slider.value = 50;
    slider.oninput = () => {
      const feel = slider.value / 100;
      applySteeringFeel(feel);
    };

    document.getElementById('tutorial-complete').classList.add('visible');

    // Register continue button for gamepad (always focused) + slider driven by stick/dpad
    const continueBtn = document.getElementById('btn-tutorial-continue');
    this._setOverlayButtons([continueBtn], 0);
    this._overlaySlider = slider;
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

  _skipTutorial() {
    // Apply defaults and save so tutorial doesn't re-run
    const isGyro = this.input.gyroConnected;
    const saveData = {
      version: 1,
      inputType: isGyro ? 'gyro' : 'phone',
      sensitivity: isGyro ? BALANCE_DEFAULTS.gyroSensitivity : BALANCE_DEFAULTS.sensitivity,
      deadzone: isGyro ? BALANCE_DEFAULTS.gyroDeadzone : BALANCE_DEFAULTS.deadzone,
      outputSmoothing: isGyro ? BALANCE_DEFAULTS.gyroOutputSmoothing : BALANCE_DEFAULTS.outputSmoothing,
      responseCurve: isGyro ? BALANCE_DEFAULTS.gyroResponseCurve : BALANCE_DEFAULTS.responseCurve,
      timestamp: Date.now()
    };
    try { localStorage.setItem(this._tuningKey(), JSON.stringify(saveData)); } catch {}
    this._endTutorialRide();
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

    // Hide all tutorial UI
    document.getElementById('tutorial-prompt').classList.remove('visible');
    document.getElementById('tutorial-skip').style.display = 'none';
    document.getElementById('tutorial-crash').classList.remove('visible');
    document.getElementById('tutorial-complete').classList.remove('visible');

    // Restore joystick steering to lobby toggle state
    this.input.suppressGamepadLean = !this.lobby.joystickActive;

    // Clean up (subset of _returnToLobby)
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

    // Return to lobby for level select
    this.state = 'lobby';
    this.lobby.show();
    this.lobby._pendingMode = 'solo';
    this.lobby._showStep(this.lobby.levelStep);
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
