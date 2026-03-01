// ============================================================
// GAME — orchestrator + boot (entry point)
// ============================================================

import * as THREE from 'three';
import { isMobile, EVT_COUNTDOWN, EVT_START, EVT_RESET, EVT_GAMEOVER, EVT_CHECKPOINT, EVT_FINISH, MSG_PROFILE } from './config.js';
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

class Game {
  constructor() {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.prepend(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x7ec8e3);
    this.scene.fog = new THREE.FogExp2(0x7ec8e3, 0.006);

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
    this.recorder = new GameRecorder(this.renderer.domElement, this.input);

    // Mode
    this.mode = 'solo'; // 'solo' | 'captain' | 'stoker'
    this.net = null;
    this.sharedPedal = null;
    this.remoteBikeState = null;
    this.remoteLean = 0;
    this._remoteLastFoot = null;
    this._remoteLastTapTime = 0;
    this._stateSendTimer = 0;
    this._stateSendInterval = 1 / 20; // 20Hz
    this._leanSendTimer = 0;
    this._leanSendInterval = 1 / 20; // 20Hz
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

    // Reset button
    document.getElementById('reset-btn').addEventListener('click', () => {
      this._resetGame();
    });

    // Lobby button
    document.getElementById('lobby-btn').addEventListener('click', () => {
      this._returnToLobby();
    });

    // Try Again from disconnect overlay
    document.getElementById('btn-try-reconnect').addEventListener('click', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      if (this.net) this.net.retryConnection();
    });

    // Return to lobby from disconnect overlay
    document.getElementById('btn-return-lobby').addEventListener('click', () => {
      document.getElementById('disconnect-overlay').style.display = 'none';
      this._returnToLobby();
    });

    // Game Over: save clip
    document.getElementById('btn-gameover-clip').addEventListener('click', () => {
      if (this.recorder) this.recorder.saveClip();
    });

    // Game Over: restart
    document.getElementById('btn-restart').addEventListener('click', () => {
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

    // Game Over: return to lobby
    document.getElementById('btn-gameover-lobby').addEventListener('click', () => {
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
    document.getElementById('btn-play-again').addEventListener('click', () => {
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
    document.getElementById('btn-next-level').addEventListener('click', () => {
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
    document.getElementById('btn-victory-lobby').addEventListener('click', () => {
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
    this._musicEl.volume = 0.35;
    this._musicSourceNode = null; // created once via createMediaElementSource
    this.lobby.onMusicChanged = (on) => {
      if (on) {
        this._musicEl.play().catch(() => {});
      } else {
        this._musicEl.pause();
      }
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

    // Resize
    window.addEventListener('resize', () => this._onResize());

    // Start loop
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this._loop(t));
  }

  // ============================================================
  // LOBBY CALLBACKS
  // ============================================================

  _onSolo() {
    this.mode = 'solo';
    this.state = 'instructions';
    this.instructionsEl.classList.remove('hidden');
    this._setupStartHandler();
  }

  _onMultiplayerReady(net, mode) {
    this.mode = mode;
    this.net = net;

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
        // Stoker receives GO from captain
        this.state = 'playing';
        if (this.raceManager) this.raceManager.start();
        const statusEl = document.getElementById('status');
        statusEl.textContent = 'GO!';
        statusEl.style.color = '#44ff66';
        this._playBeep(800, 0.4);
        setTimeout(() => {
          if (this.state === 'playing') {
            statusEl.textContent = '';
            statusEl.style.fontSize = '';
          }
        }, 800);
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
      // Re-establish media call after data reconnection
      if (this.mode === 'captain' && this.net._localMediaStream) {
        this._initiateMediaCall();
      }
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
      // Mix remote audio into clip recording (stoker side)
      if (this.net._localMediaStream) {
        this.recorder.addAudioStreams(this.net._localMediaStream, remoteStream);
      } else {
        this.recorder.addAudioStreams(null, remoteStream);
      }
    };

    // Partner profile: avatar + achievements
    this.net.onProfileReceived = (profile) => {
      // Show partner avatar if no active video stream
      if (profile.avatar && !this.recorder.partnerActive) {
        this.recorder.showPartnerAvatar(profile.avatar);
      }
      // Render partner achievement badges
      if (profile.achievements) {
        updateBadgeDisplay('partner-badges', profile.achievements);
      }
    };

    // Pre-acquire local media stream so calls connect instantly on both sides.
    // Captain then initiates the media call; stoker holds the stream ready for
    // _handleIncomingCall to answer without an async getUserMedia delay.
    if (this.lobby.cameraActive || this.lobby.audioActive) {
      this._acquireLocalMedia().then(() => {
        if (mode === 'captain') this._initiateMediaCall();
      });
    }

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
    this.instructionsEl.classList.add('hidden');

    const statusEl = document.getElementById('status');
    statusEl.style.color = '#ffffff';
    statusEl.style.fontSize = '48px';
    statusEl.textContent = '3';
    this._lastCountNum = 3;

    // Create race manager + contribution tracker + collectibles from selected level
    const level = this.lobby.selectedLevel;
    this.raceManager = new RaceManager(level);
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
    this.recorder.startBuffer(this.audioCtx);
    if (this.lobby.cameraActive) {
      this.recorder.startSelfie();
    } else if (this.lobby.auth && this.lobby.auth.isLoggedIn()) {
      const user = this.lobby.auth.getUser();
      if (user && user.avatar) this.recorder.showAvatarPip(user.avatar);
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
  }

  _updateCountdown(dt) {
    this.countdownTimer -= dt;
    const statusEl = document.getElementById('status');

    if (this.countdownTimer <= 0) {
      statusEl.textContent = 'GO!';
      statusEl.style.color = '#44ff66';
      this.state = 'playing';
      if (this.raceManager) this.raceManager.start();
      this._playBeep(800, 0.4);

      // Captain sends EVT_START to stoker
      if (this.mode === 'captain' && this.net) {
        this.net.sendEvent(EVT_START);
      }

      setTimeout(() => {
        if (this.state === 'playing') {
          statusEl.textContent = '';
          statusEl.style.fontSize = '';
        }
      }, 800);
      return;
    }

    const num = Math.ceil(this.countdownTimer);
    if (num !== this._lastCountNum) {
      statusEl.textContent = '' + num;
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
      this.raceManager.resetSegmentTimer(checkpointD);
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

    if (this.mode === 'solo') {
      this.pedalCtrl = new PedalController(this.input);
    } else if (this.sharedPedal) {
      this.sharedPedal = new SharedPedalController();
    }

    this.chaseCamera.initialized = false;

    if (this.input.motionEnabled) {
      this.input.motionOffset = this.input.rawGamma;
    }

    if (!fromRemote && this.net) {
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
    statusEl.style.color = '#ffffff';
    statusEl.style.fontSize = '48px';
    statusEl.textContent = '3';
    this._lastCountNum = 3;

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

  _showDisconnect(reason) {
    const overlay = document.getElementById('disconnect-overlay');
    const msg = document.getElementById('disconnect-msg');
    overlay.style.display = 'flex';
    msg.textContent = reason || 'Partner disconnected';
  }

  _showGameOver(fromRemote = false) {
    this.state = 'gameover';
    this.hud.hideTimer();
    if (this.raceManager) this.raceManager.crashCount++;
    // Clear HUD status text so "CRASHED! Resetting..." doesn't bleed through
    document.getElementById('status').textContent = '';
    document.getElementById('gameover-overlay').style.display = 'flex';

    // Show clip button only when recording is active
    const clipBtn = document.getElementById('btn-gameover-clip');
    if (clipBtn) {
      clipBtn.style.display = (this.recorder && this.recorder.buffering) ? '' : 'none';
    }

    const btns = [clipBtn, document.getElementById('btn-restart'), document.getElementById('btn-gameover-lobby')]
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

  _handleRaceEvent(raceEvent) {
    if (raceEvent.event === 'checkpoint') {
      this._showCheckpointFlash();

      // Notify stoker
      if (this.mode === 'captain' && this.net) {
        this.net.sendEvent(EVT_CHECKPOINT);
      }
    } else if (raceEvent.event === 'finish') {
      this._showVictory();

      // Notify stoker
      if (this.mode === 'captain' && this.net) {
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
      raceDistance: level.distance,
      crashes: this.raceManager ? this.raceManager.crashCount : 0,
      isMultiplayer: this.mode !== 'solo',
      safePct: 0,
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

  _sendProfile() {
    if (!this.net || !this.net.connected) return;
    const profile = { achievements: this.achievements.getEarned() };
    if (this.lobby.auth && this.lobby.auth.isLoggedIn()) {
      const user = this.lobby.auth.getUser();
      if (user) {
        if (user.avatar) profile.avatar = user.avatar;
        if (user.name) profile.name = user.name;
      }
    }
    this.net.sendProfile(profile);
  }

  _showVictory(fromRemote = false) {
    this.state = 'victory';
    this.hud.hideTimer();
    const overlay = document.getElementById('victory-overlay');
    overlay.style.display = 'flex';

    const level = this.lobby.selectedLevel;
    document.getElementById('victory-destination').textContent =
      level.icon + ' ' + level.name;

    // Animated chromakey destination video at top of victory screen
    this._startVictoryVideo(level);

    // Build stats
    const statsEl = document.getElementById('victory-stats');
    statsEl.innerHTML = '';

    if (this.raceManager) {
      const summary = this.raceManager.getSummary(this.bike.distanceTraveled);
      const collectIcon = level.collectibles === 'gems' ? '\uD83D\uDC8E' : '\uD83C\uDF81'; // 💎 or 🎁
      const distStr = summary.distance >= 1000 ? (summary.distance / 1000).toFixed(2) + ' km' : summary.distance + ' m';

      // Build left and right column stats
      const left = [
        { icon: '\u23F1\uFE0F', value: summary.timeFormatted },          // ⏱️ Time
        { icon: '\uD83D\uDEB4', value: distStr },                         // 🚴 Distance
      ];
      const right = [
        { icon: '\u2601\uFE0F', value: summary.checkpointsPassed + '/' + summary.checkpointsTotal }, // ☁️ Checkpoints
      ];
      if (summary.collectibles > 0) {
        right.push({ icon: collectIcon, value: '' + summary.collectibles });
      }

      // Solo performance stats
      let soloStats = null;
      if (this.contributionTracker) {
        const contrib = this.contributionTracker.getSummary();
        if (contrib.mode !== 'multiplayer') {
          const solo = contrib.solo;
          const pedalPct = solo.totalTaps > 0 ? Math.round((solo.correctTaps / solo.totalTaps) * 100) : 0;
          left.push({ icon: '\uD83E\uDDB6', value: pedalPct + '%' });       // 🦶 Pedal accuracy
          right.push({ icon: '\u2696\uFE0F', value: solo.safePct + '%' });   // ⚖️ Balance
        } else {
          soloStats = contrib;
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
        html += '<div class="victory-stat victory-perfect">\u2B50 Perfect Ride! \u2B50</div>';
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

    // Gamepad navigation for victory buttons
    const victoryBtns = [playAgainBtn, document.getElementById('btn-victory-lobby')];
    // Include "next level" if visible, and default-focus it
    if (hasNext) {
      victoryBtns.splice(1, 0, nextBtn);
    }
    this._setOverlayButtons(victoryBtns, hasNext ? 1 : 0);

    this._playBeep(800, 0.3);
    setTimeout(() => this._playBeep(1000, 0.3), 200);
    setTimeout(() => this._playBeep(1200, 0.5), 400);
  }

  async _submitScore() {
    const auth = this.lobby.auth;
    if (!auth || !auth.isLoggedIn()) return;

    const level = this.lobby.selectedLevel;
    const raceSummary = this.raceManager ? this.raceManager.getSummary(this.bike.distanceTraveled) : null;
    if (!raceSummary) return;

    const data = {
      levelId: level.id,
      distance: raceSummary.distance,
      timeMs: raceSummary.timeMs,
      mode: this.mode,
      collectiblesCount: this.collectibleManager ? this.collectibleManager.collected : 0,
      newAchievements: this.achievements.getNewThisSession().map(a => a.id),
    };

    if (this.contributionTracker) {
      const contrib = this.contributionTracker.getSummary();
      if (contrib.mode === 'multiplayer') {
        data.contributions = { captain: contrib.captain, stoker: contrib.stoker };
      } else {
        data.contributions = { solo: contrib.solo };
      }
    }

    try {
      await auth.submitScore(data);
      await auth.syncAchievements(this.achievements.getEarnedIds());
    } catch (e) {}
  }

  _hideVictory() {
    document.getElementById('victory-overlay').style.display = 'none';
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

    // 1x1 transparent fallback mask
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

    this._victoryVideo = { video, renderer, videoTexture, mat, animId };
  }

  _stopVictoryVideo() {
    if (!this._victoryVideo) return;
    const v = this._victoryVideo;
    cancelAnimationFrame(v.animId);
    v.video.pause();
    v.video.src = '';
    v.videoTexture.dispose();
    v.mat.dispose();
    v.renderer.dispose();
    this._victoryVideo = null;
  }

  _returnToLobby() {
    if (!this.lobby.musicActive) {
      this._musicEl.pause();
      this._musicEl.currentTime = 0;
    }
    this._hideGameOver();
    this._hideVictory();
    this.raceManager = null;
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
    this.mode = 'solo';
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

    this.bike.fullReset();
    this.chaseCamera.initialized = false;
    this.pedalCtrl = new PedalController(this.input);

    this.state = 'lobby';
    this.lobby.show();
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
    const localStream = this.net._localMediaStream;
    if (!localStream) return;
    const remotePeerId = this.net.conn && this.net.conn.peer;
    if (!remotePeerId) return;
    clearTimeout(this._mediaRetryTimeout);
    const call = this.net.peer.call(remotePeerId, localStream);
    if (call) {
      call.on('stream', (remoteStream) => {
        clearTimeout(this._mediaRetryTimeout);
        this.recorder.setPartnerStream(remoteStream);
        this.net._playRemoteAudio(remoteStream);
        this.recorder.addAudioStreams(localStream, remoteStream);
      });
      // Retry once if partner stream doesn't arrive within 3s
      this._mediaRetryTimeout = setTimeout(() => {
        if (!this.recorder.partnerActive) this._initiateMediaCall();
      }, 3000);
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
      youDeg = this.input.gamepadLean * 90;
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

    if (up && !this._dpadPrevUp) this.safetyBtn.click();
    if (down && !this._dpadPrevDown) this.speedBtn.click();
    if (right && !this._dpadPrevRight) document.getElementById('reset-btn').click();
    if (left && !this._dpadPrevLeft) this._returnToLobby();
    if (y && !this._gpPrevY) this.recorder.saveClip();

    this._dpadPrevUp = up;
    this._dpadPrevDown = down;
    this._dpadPrevLeft = left;
    this._dpadPrevRight = right;
    this._gpPrevY = y;
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
  // OVERLAY GAMEPAD NAVIGATION (game-over & victory)
  // ============================================================

  _setOverlayButtons(buttons, initialFocus = 0) {
    this._overlayButtons = buttons.filter(Boolean);
    this._overlayFocusIdx = Math.min(initialFocus, this._overlayButtons.length - 1);
    this._olPrevUp = false;
    this._olPrevDown = false;
    this._olPrevA = false;
    if (this._overlayButtons.length > 0) {
      this._overlayButtons[this._overlayFocusIdx].classList.add('gamepad-focus');
    }
  }

  _clearOverlayButtons() {
    for (const btn of this._overlayButtons) btn.classList.remove('gamepad-focus');
    this._overlayButtons = [];
  }

  _pollOverlayGamepad() {
    if (this._overlayButtons.length === 0) return;
    if (!this.input.gamepadConnected) return;
    const gamepads = navigator.getGamepads();
    const gp = gamepads[this.input.gamepadIndex];
    if (!gp) return;

    const up = (gp.buttons[12] && gp.buttons[12].pressed) || gp.axes[1] < -0.5;
    const down = (gp.buttons[13] && gp.buttons[13].pressed) || gp.axes[1] > 0.5;
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
    if (a && !this._olPrevA) {
      this._overlayButtons[this._overlayFocusIdx].click();
    }

    this._olPrevUp = up;
    this._olPrevDown = down;
    this._olPrevA = a;
  }

  // ============================================================
  // TREE COLLISION
  // ============================================================

  _checkTreeCollision() {
    if (this.bike.fallen || this.bike.speed < 0.5) return;
    const result = this.world.checkTreeCollision(
      this.bike.position, this.bike.roadD, this.bike.heading
    );
    if (result.hit) {
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.2;
      this._playBeep(200, 0.3);
      return;
    }
    // Pylon obstacle collision
    if (this.obstacleManager && this.obstacleManager.checkCollision(this.bike.position)) {
      this.bike._fall();
      this.chaseCamera.shakeAmount = 0.25;
      this._playBeep(150, 0.4);
    }
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
      if (this.state === 'gameover' || this.state === 'victory') this._pollOverlayGamepad();
      this.world.update(this.bike.position, this.bike.roadD);
      this.chaseCamera.update(this.bike, dt, roadPath);
      this.renderer.render(this.scene, this.camera);
    }

    // Clear buffered tap flags after all input has been read this frame
    this.input.consumeTaps();
  }

  // ============================================================
  // SOLO UPDATE
  // ============================================================

  _updateSolo(dt) {
    const pedalResult = this.pedalCtrl.update(dt);
    const balanceResult = this.balanceCtrl.update();

    const wasFallen = this.bike.fallen;
    this.bike.update(pedalResult, balanceResult, dt, this.safetyMode, this.autoSpeed);
    this._checkTreeCollision();

    // Race progress + contribution tracking
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

    // Show game over after crash recovery
    if (wasFallen && !this.bike.fallen) { this._showGameOver(); return; }

    this.grassParticles.update(this.bike, dt);
    this.world.update(this.bike.position, this.bike.roadD);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    // Camera shake on crash
    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

    this.hud.update(this.bike, this.input, this.pedalCtrl, dt);
    this.renderer.render(this.scene, this.camera);
    this.recorder.composite(this._buildRecordState(this.pedalCtrl));
  }

  // ============================================================
  // CAPTAIN UPDATE — runs physics, sends state
  // ============================================================

  _updateCaptain(dt) {
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
    const balanceResult = this.balanceCtrl.update();

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

    // Send state + lean to stoker at 20Hz
    this._stateSendTimer += dt;
    if (this._stateSendTimer >= this._stateSendInterval && this.net && this.net.connected) {
      this._stateSendTimer = 0;
      const timerRemaining = this.raceManager ? this.raceManager.segmentTimeRemaining : -1;
      this.net.sendState(this.bike, timerRemaining);
      this.net.sendLean(captainLean);
    }

    this.world.update(this.bike.position, this.bike.roadD);
    this.chaseCamera.update(this.bike, dt, this.world.roadPath);

    if (this.bike.fallen && this.bike.fallTimer > 1.8) {
      this.chaseCamera.shakeAmount = 0.15;
    }

    this._updateConnBadge();
    const remoteData = { remoteLean: this.remoteLean, remoteLastFoot: this._remoteLastFoot, remoteLastTapTime: this._remoteLastTapTime };
    this.hud.update(this.bike, this.input, this.sharedPedal, dt, remoteData);
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

    // Send lean to captain at 20Hz
    this._leanSendTimer += dt;
    if (this._leanSendTimer >= this._leanSendInterval && this.net && this.net.connected) {
      this._leanSendTimer = 0;
      const balanceResult = this.balanceCtrl.update();
      this.net.sendLean(balanceResult.leanInput);
    }

    this.world.update(this.bike.position, this.bike.roadD);
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
    const remoteData = { remoteLean: this.remoteLean, remoteLastFoot: this._remoteLastFoot, remoteLastTapTime: this._remoteLastTapTime };
    this.hud.update(this.bike, this.input, this.pedalCtrl, dt, remoteData);
    this.renderer.render(this.scene, this.camera);
    this.recorder.composite(this._buildRecordState(this.pedalCtrl, remoteData));
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
