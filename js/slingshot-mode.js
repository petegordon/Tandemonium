// ============================================================
// SLINGSHOT MODE — the mode's flow, installed onto Game
// ============================================================
//
// Garage → aim ('slingAim') → flight ('playing') → tally ('slingTally') →
// results ('slingResults'), plus the hooks Game calls: _onSlingCoin,
// _rideSystemOn, _resetToSling (from _resetGame), _endSlingRun('goal') (from
// _showVictory), _leaveSlingMode (every exit). These are Game methods — they
// use the game's bike, world, camera and HUD directly — kept here so game.js
// only holds the hooks. Pure rules live in js/slingshot.js, DOM in
// js/slingshot-ui.js, 3D in js/slingshot-rig.js / -props.js / -fx.js.

import * as analytics from './analytics.js';
import * as sling from './slingshot.js';
import * as slingUI from './slingshot-ui.js';
import { RaceManager } from './race-manager.js';
import { SlingshotRig } from './slingshot-rig.js';
import { SlingshotProps, HAY_KEEP } from './slingshot-props.js';
import { SparkleBurst, DistanceFlag } from './slingshot-fx.js';
import { hapticCheckpoint, hapticBump } from './haptics.js';

// A fully upgraded sling launches at ~26 m/s; normal rides cap near 19.
const SLING_MAX_SPEED = 34;

class SlingshotMode {
  //
  // A solo pseudo-level, like Tourist: the stage goal is the finish line and
  // the Chaos Coins are collectibles, so the race manager, HUD and finish
  // cinematic run unchanged. There are no checkpoints. What differs:
  // - a real slingshot (js/slingshot-rig.js) holds the bike on the start line
  //   instead of a countdown, in its own 'slingAim' state with a fixed camera:
  //   drag back to stretch the bands, left/right to shift and aim, let go to
  //   fire (keyboard and gamepad too);
  // - the ride systems that don't belong (achievements, ghost, disruptions,
  //   DDA, coach card, cruise control, per-ride analytics) stay off;
  // - no pedaling: after launch the riders only steer, and the bike coasts on
  //   low drag until it stalls, crashes or reaches the goal;
  // - any reset puts the bike back in the slingshot for a fresh launch.
  // Scoring and the economy live in js/slingshot.js, the DOM in js/slingshot-ui.js.

  /** A Chaos Coin grabbed: count it, burst sparkles, pop the HUD. */
  _onSlingCoin(count) {
    this._slingRun.coins += count;
    if (!this._slingFx) this._slingFx = new SparkleBurst(this.scene);
    const b = this.bike, h = b.heading;
    this._slingFx.burst({ x: b.position.x + Math.sin(h) * 1.5, y: b.position.y + 1.1, z: b.position.z + Math.cos(h) * 1.5 });
    slingUI.coinPop(count * sling.PAY.perCoin);
  }

  /**
   * Which normal-ride systems run. One table (SLING_SYSTEMS_OFF) instead of an
   * `isSlingshot` check at each call site; every other mode gets them all.
   */
  _rideSystemOn(name) {
    return !(this.isSlingshot && sling.SLING_SYSTEMS_OFF.has(name));
  }

  _slingStore() {
    if (!this._slingStoreRef) this._slingStoreRef = sling.browserStore();
    return this._slingStoreRef;
  }

  _openSlingGarage(focus = 0) {
    this._slingSave = sling.loadSave(this._slingStore());
    this.state = 'slingGarage';
    this.quickMenu.setVisible(false);
    slingUI.hideResults();
    slingUI.hideHud();
    slingUI.hidePull();
    const render = (focusIdx) => {
      const buttons = slingUI.renderGarage(this._slingSave, {
        onBuy: (id) => {
          const r = sling.buyUpgrade(this._slingSave, id);
          if (!r.ok) return;
          this._slingSave = r.save;
          sling.writeSave(this._slingStore(), r.save);
          this._playBeep(1200, 0.08);
          setTimeout(() => this._playBeep(1600, 0.1), 70);
          analytics.trackEvent('slingshot_upgrade', { id, level: r.save.lv[id] });
          // Keep focus on the row just bought (launch button is index 0).
          render(2 + sling.UPGRADES.findIndex(u => u.id === id));
        },
        onLaunch: () => this._startSlingRun(),
        onToggleCoop: () => {
          this._slingSave = { ...this._slingSave, coop: !this._slingSave.coop };
          if (!this._slingSave.coop) delete this._slingSave.coop;
          sling.writeSave(this._slingStore(), this._slingSave);
          analytics.trackEvent('slingshot_coop', { on: !!this._slingSave.coop });
          render(1);
        },
        onLobby: () => { this._clearOverlayButtons(); this._returnToLobby(); },
      });
      this._setOverlayButtons(buttons, focusIdx);
    };
    render(focus);
    this._overlayCooldownUntil = performance.now() + 400;
  }

  _startSlingRun() {
    this._clearOverlayButtons();
    slingUI.hideGarage();
    slingUI.hideResults();
    const save = this._slingSave || sling.loadSave(this._slingStore());
    this._slingSave = save;
    // Remember what the lobby had selected, so leaving the mode gives it back
    // instead of leaving the pseudo-level and a forced difficulty behind.
    if (!this._slingPrevLobby && !(this.lobby.selectedLevel && this.lobby.selectedLevel.isSlingshot)) {
      this._slingPrevLobby = { level: this.lobby.selectedLevel, difficulty: this.lobby.selectedDifficulty };
    }
    this.mode = 'solo';
    this.isSlingshot = true;
    document.body.classList.add('sling-mode');   // hides the pedal pads
    this.hud.suppressRidePrompts = true;         // no "Tap pedals to ride!"
    this.isTourist = false;
    this._touristRoute = null;
    this.hud.setSeat('captain', false);
    this.bike.applyPreset(this.lobby.selectedPreset);
    this._lobbyBtn.textContent = 'LOBBY';
    this._loadSavedTuning();

    // Road distances are measured from the start line; the run is measured
    // from the slingshot's rest point, so the finish sits that much further on.
    const finishD = sling.stageGoal(save.stage) + sling.SLING_REST_D;
    this.lobby.selectedLevel = {
      id: 'slingshot',
      name: `Slingshot · Stage ${save.stage}`,
      distance: finishD,
      checkpointInterval: finishD,   // the only "checkpoint" is the finish: no gates
      collectibles: 'coins',
      icon: '🎯',
      description: '',
      isSlingshot: true,
      timerEnabled: false,       // the run ends when the bike stops, not on a clock
      motionAdaptation: false
    };
    // Early stages keep the road forgiving; later ones bring the obstacles.
    this.lobby.selectedDifficulty = save.stage >= 4 ? 'adventurous' : 'chill';

    // No instructions screen: the drag is the instruction. The LAUNCH tap is
    // still a user gesture, so ask for tilt (steering after launch) here.
    if (this.input.needsMotionPermission) {
      Promise.resolve(this.input.requestMotionPermission()).catch(() => {});
    }
    this.instructionsEl.classList.add('hidden');
    if (this._slingArmedFor === finishD) this._armSlingRun();
    else this._startCountdown();
  }

  /**
   * Relaunch on the same stage without rebuilding the ride: the world, geese,
   * recorder, audio graph and managers stay; the race, the bike, the course
   * and the slingshot are re-armed. (_startCountdown rebuilt all of it on
   * every launch — a hitch on phones, and every system had to opt out again.)
   */
  _armSlingRun() {
    const level = this.lobby.selectedLevel;
    this._hideGameOver();
    this._hideVictory();
    this.quickMenu.setVisible(true);
    this.raceManager = new RaceManager(level);
    this.hud.raceManager = this.raceManager;
    this.bike.fullReset();
    if (this.physicsFx) this.physicsFx.clear();
    if (this.chaseCamera) this.chaseCamera.initialized = false;
    this.hud.initProgress(level);
    this.audioEngine.startBike();
    this._setupSlingRun(level);
  }

  /** Called from _startCountdown once the race machinery for the level exists. */
  _setupSlingRun(level) {
    const stats = sling.slingStats(this._slingSave.lv);
    this._slingStats = stats;
    this._slingArmedFor = level.distance;   // this ride is built for this goal
    this._slingRun = {
      pull: 0, side: 0, launched: false, dragReleased: false, bigAirs: 0, wasAir: false,
      coop: !!this._slingSave.coop, lastStrokeAt: null, sinceStroke: 99, perfect: false,
      coins: 0, topSpeed: 0, stillT: 0, crashDistance: null, over: false,
    };
    // Co-op: the stoker's pedal pads come back, for winding the bands only.
    document.body.classList.toggle('sling-coop-aim', !!this._slingSave.coop);
    const hint = document.querySelector('#sling-pull .sling-hint');
    if (hint) hint.textContent = this._slingSave.coop
      ? 'Captain: drag to aim · Stoker: pedal to pull · let go together'
      : 'Pull back · aim · let go';
    // Not a countdown: the aim phase is its own state, with its own camera.
    this.state = 'slingAim';
    for (const id of ['countdown-flavor-icon', 'countdown-flavor-text', 'countdown-flavor-num']) {
      const el = document.getElementById(id);
      if (el) { el.textContent = ''; el.className = ''; }
    }
    this.autoSpeed = false;             // cruise control would never let it stall
    this._slingDrag = null;
    this._slingKb = { pull: 0, side: 0, held: false };
    this._slingPadA = true;             // a held A from the garage is not a fire
    this._slingStickHist = [];          // left-stick samples, for the let-go
    this._initSlingDrag();
    this.bike.coast = {
      decel: (v, centerDist, airborne) => sling.coastDecel(stats, v, sling.surfaceAt(centerDist), airborne),
      maxSpeed: SLING_MAX_SPEED,
    };

    if (this._slingFlag) { this._slingFlag.dispose(); this._slingFlag = null; }
    if (this._slingFx) this._slingFx.clear();   // bursts from a run cut short
    slingUI.hideTally();
    // The slingshot itself, rebuilt with the road it stands on.
    if (this._slingRig) this._slingRig.dispose();
    this._slingRig = new SlingshotRig(this.scene, this.world.roadPath);
    this._poseSlingBike(0, 0);
    this._placeSlingCamera();

    // The stage's fixed course: lanes of coins, hay bales and (from stage 2) the
    // jackpot billboard. It replaces the level's scattered pickups and the
    // random cones — nothing in the way should be a surprise crash.
    const course = sling.planCourse(this._slingSave.stage, level.distance);
    this.collectibleManager.replaceItems(course.coins);
    if (this.obstacleManager) this.obstacleManager.replaceItems([]);
    if (this._slingProps) this._slingProps.dispose();
    this._slingProps = new SlingshotProps(this.scene, this.world.roadPath, course);
    this.raceManager.setCollectiblesTotal(this.collectibleManager.getTotalItems());
    this.hud.showCollectibles(level, this.collectibleManager.getTotalItems());
    this.hud.hideTimer();
    slingUI.showPull(0);
    this._updateSlingHud();
  }

  /** Put the bike in the drawn slingshot: back by the pull, aside and aimed by the drag. */
  _poseSlingBike(pull, side) {
    const pose = sling.aimPose(pull, side);
    const b = this.bike;
    b.resetToDistance(pose.d);
    const h = b.heading;
    // Forward is (sin h, cos h). Seen from behind, the rider's RIGHT (screen
    // right) is (-cos h, sin h), and turning right DEcreases the heading.
    // (Getting this backwards mirrored the whole aim on screen.)
    b.position.x -= Math.cos(h) * pose.lateral;
    b.position.z += Math.sin(h) * pose.lateral;
    b.heading = h - pose.angle;
    b._applyTransform();
    // The preview: how far this pull rolls (on dirt, steering to stay on the
    // road), and where the aimed line leaves the road if nobody steers.
    const predicted = sling.predictCoast(this._slingStats, pull, 'dirt');
    const exitAt = sling.roadExitDistance(pose.lateral, pose.angle);
    this._slingRig.hold(b, pull, { length: Math.min(60, 3 + predicted * 0.15), exitAt });
    slingUI.showPull(pull, { predicted, best: this._slingSave.best });
  }

  /**
   * The aim camera: fixed behind the slingshot on the ROAD's line, so the
   * forks, the stretched bands and the bike's aim all read on screen. (The
   * chase camera follows the bike's heading, which cancels the aim out.)
   */
  _placeSlingCamera() {
    if (!this._slingRig) return;
    if (this._slingBaseFov == null) this._slingBaseFov = this.camera.fov;
    const { pos, look, fov } = this._slingRig.cameraPose(this.camera.aspect);
    const want = fov || this._slingBaseFov;
    if (this.camera.fov !== want) { this.camera.fov = want; this.camera.updateProjectionMatrix(); }
    this.camera.position.copy(pos);
    this.camera.lookAt(look);
    this._slingLook = look;
  }

  /** After launch, ease a landscape aim zoom back to the game's own FOV. */
  _easeSlingFov(dt) {
    const base = this._slingBaseFov;
    if (base == null || this.camera.fov === base) return;
    const next = this.camera.fov + (base - this.camera.fov) * Math.min(1, dt * 4);
    this.camera.fov = Math.abs(next - base) < 0.05 ? base : next;
    this.camera.updateProjectionMatrix();
  }

  _slingAiming() {
    return this.isSlingshot && this.state === 'slingAim' && this._slingRun && !this._slingRun.launched;
  }

  /**
   * One aim, three inputs. Touch/mouse: drag back to pull, sideways to aim,
   * lift to fire. Keyboard: hold ↓/S to draw (full in 1.2 s), ←/→ or A/D to
   * aim, release ↓/S to fire, Esc to cancel. Gamepad: left stick is the pouch
   * (down = pull, sideways = aim) — let it go to fire, or press A while holding;
   * easing it back slowly cancels. With nothing held the bands go slack.
   */
  _updateSlingAimState(dt) {
    const run = this._slingRun;
    if (!run || run.launched) return;
    // Place and animate the course's coins while aiming, so the lanes can be
    // read before the shot. (The nearest are ~40 m out: nothing is collected.)
    if (this.collectibleManager) this.collectibleManager.update(dt, this.bike.distanceTraveled, this.bike.position);
    let aim = null;
    let fire = run.dragReleased;

    if (run.coop) return this._updateCoopAim(dt);

    // Touch / mouse
    const drag = this._slingDrag && this._slingDrag.active ? this._slingDrag : null;
    if (drag) aim = sling.dragToAim(drag.dx, drag.dy, window.innerWidth, window.innerHeight);
    if (fire) aim = { pull: run.pull, side: run.side };

    // Keyboard
    const k = (this.input && this.input.keys) || {};
    const kb = this._slingKb;
    if (k.Escape && kb.held) { kb.held = false; kb.pull = 0; slingUI.toast('Cancelled'); }
    if (!aim) {
      const pullKey = !!(k.ArrowDown || k.KeyS);
      if (k.ArrowLeft || k.KeyA) kb.side = Math.max(-1, kb.side - dt);
      if (k.ArrowRight || k.KeyD) kb.side = Math.min(1, kb.side + dt);
      if (pullKey) { kb.held = true; kb.pull = Math.min(1, kb.pull + dt / 1.2); }
      if (kb.held) {
        aim = { pull: kb.pull, side: kb.side };
        if (!pullKey) {                     // let go of the key: fire (or cancel)
          kb.held = false;
          if (kb.pull >= sling.MIN_LAUNCH_PULL) fire = true;
          else aim = { pull: 0, side: 0 };
          kb.pull = 0;
        }
      }
    }

    // Gamepad / Steam Deck
    const gp = !aim && this.input && this.input.getGamepadState ? this.input.getGamepadState() : null;
    if (gp) {
      const DZ = 0.15;
      const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
      const pull = ay > DZ ? Math.min(1, (ay - DZ) / 0.8) : 0;
      const side = Math.abs(ax) > DZ ? Math.max(-1, Math.min(1, ax)) : 0;
      const a = !!(gp.buttons[0] && gp.buttons[0].pressed);
      if (pull > 0 || side !== 0) aim = { pull, side };
      // Fire by pressing A while holding the pull…
      if (a && !this._slingPadA && pull >= sling.MIN_LAUNCH_PULL) fire = true;
      this._slingPadA = a;
      // …or just let the stick go: it snaps home and the shot flies with the
      // aim held a moment before (js/slingshot.js · stickLetGo).
      sling.stickSample(this._slingStickHist, performance.now(), pull, side);
      if (!fire) {
        const shot = sling.stickLetGo(this._slingStickHist);
        if (shot) { aim = shot; fire = true; }
      }
    }

    if (!aim) aim = { pull: 0, side: 0 };
    if (this._slingRig) this._slingRig.tickAim(dt, aim.pull);
    if (aim.pull !== run.pull || aim.side !== run.side) {
      this._slingFeel(run.pull, aim.pull);
      if (aim.pull >= 1 && run.pull < 1) this._playChime(880, 0.2);
      run.pull = aim.pull;
      run.side = aim.side;
      this._poseSlingBike(run.pull, run.side);
    }
    const d = this._slingDrag && this._slingDrag.active ? this._slingDrag : null;
    if (d && run.pull > 0) {
      const predicted = sling.predictCoast(this._slingStats, run.pull, 'dirt');
      slingUI.showFinger(d.x0 + d.dx, d.y0 + d.dy, run.pull, predicted);
    } else {
      slingUI.hideFinger();
    }
    if (fire && run.pull >= sling.MIN_LAUNCH_PULL) this._slingGo();
  }

  /**
   * Co-op aim. Stoker: the pedals wind the bands (the pedal controller, so
   * touch pads, ←/→ and LB/RB/triggers all work). Captain: the drag's
   * sideways part aims (or A/D, or the left stick) and letting go fires (or
   * Space, or A). In sync — the stoker's last stroke within 150 ms of the
   * release — is a perfect launch.
   */
  _updateCoopAim(dt) {
    const run = this._slingRun;
    const r = this.pedalCtrl.update(dt);
    this._playPedalTaps(this.pedalCtrl);
    run.sinceStroke += dt;
    if (r.acceleration > 0) { run.lastStrokeAt = performance.now(); run.sinceStroke = 0; }
    const pull = sling.coopPull(run.pull, r.acceleration, run.sinceStroke, dt);

    let side = run.side;
    const drag = this._slingDrag && this._slingDrag.active ? this._slingDrag : null;
    if (drag) side = sling.dragToAim(drag.dx, 0, window.innerWidth, window.innerHeight).side;
    const k = (this.input && this.input.keys) || {};
    if (k.KeyA) side = Math.max(-1, side - dt);
    if (k.KeyD) side = Math.min(1, side + dt);
    let fire = run.dragReleased || (!!k.Space && !this._slingSpace);
    this._slingSpace = !!k.Space;
    const gp = this.input && this.input.getGamepadState ? this.input.getGamepadState() : null;
    if (gp) {
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.15) side = Math.max(-1, Math.min(1, ax));
      const a = !!(gp.buttons[0] && gp.buttons[0].pressed);
      if (a && !this._slingPadA) fire = true;
      this._slingPadA = a;
    }
    run.dragReleased = false;

    if (this._slingRig) this._slingRig.tickAim(dt, pull);
    if (pull !== run.pull || side !== run.side) {
      this._slingFeel(run.pull, pull);
      if (pull >= 1 && run.pull < 1) this._playChime(880, 0.2);
      run.pull = pull;
      run.side = side;
      this._poseSlingBike(run.pull, run.side);
    }
    if (drag && run.pull > 0) {
      slingUI.showFinger(drag.x0 + drag.dx, drag.y0 + drag.dy, run.pull, sling.predictCoast(this._slingStats, run.pull, 'dirt'));
    } else {
      slingUI.hideFinger();
    }
    if (fire && run.pull >= sling.MIN_LAUNCH_PULL) {
      run.perfect = sling.isPerfectLaunch(run.lastStrokeAt, run.releaseAt != null ? run.releaseAt : performance.now());
      this._slingGo();
    }
  }

  /**
   * Pull feel: a ratchet creak every 10% of draw, rising in pitch, and a
   * haptic tick (phone vibrate + controller rumble) at 25/50/75/100%.
   */
  _slingFeel(from, to) {
    if (to <= from) return;
    if (Math.floor(to * 10) > Math.floor(from * 10)) this._playBeep(160 + 380 * to, 0.035);
    if (Math.floor(to * 4) > Math.floor(from * 4)) {
      try { if (navigator.vibrate) navigator.vibrate(to >= 1 ? 30 : 12); } catch (_) { /* not allowed */ }
      hapticBump();
    }
  }

  /**
   * Touch / mouse: press anywhere (not a button, not a screen edge), drag
   * back to stretch the bands, left/right to shift and aim the bike, lift to
   * let go. A drag that ends without enough pull is a cancel, not a shot; a
   * system gesture that steals the finger (pointercancel) says so.
   */
  _initSlingDrag() {
    if (this._slingDragWired) return;
    this._slingDragWired = true;
    const DEAD_ZONE_PX = 12;
    const EDGE_PX = 24;                   // iOS back-swipe / Android edge gestures
    window.addEventListener('pointerdown', (e) => {
      if (!this._slingAiming() || this._slingDrag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.clientX < EDGE_PX || e.clientX > window.innerWidth - EDGE_PX) return;
      if (e.target && e.target.closest && e.target.closest('button, a, input, #quick-menu-overlay, #quick-menu-btn')) return;
      this._slingDrag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, active: false };
      try { if (e.target && e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    });
    window.addEventListener('pointermove', (e) => {
      const d = this._slingDrag;
      if (!d || e.pointerId !== d.id || !this._slingAiming()) return;
      d.dx = e.clientX - d.x0;
      d.dy = e.clientY - d.y0;
      if (!d.active && Math.hypot(d.dx, d.dy) > DEAD_ZONE_PX) d.active = true;
      if (d.active && e.cancelable) e.preventDefault();
    }, { passive: false });
    window.addEventListener('contextmenu', (e) => { if (this._slingAiming()) e.preventDefault(); });
    const end = (e) => {
      const d = this._slingDrag;
      if (!d || e.pointerId !== d.id) return;
      this._slingDrag = null;
      if (!d.active || !this._slingAiming()) return;
      if (e.type === 'pointercancel') { slingUI.toast('Cancelled'); return; }
      // Co-op: stamp the release now, not at the next rendered frame — frame
      // lag must not cost a pair their 150 ms sync window.
      if (this._slingRun.coop) { this._slingRun.releaseAt = performance.now(); this._slingRun.dragReleased = true; return; }
      const aim = sling.dragToAim(d.dx, d.dy, window.innerWidth, window.innerHeight);
      if (aim.pull >= sling.MIN_LAUNCH_PULL) {
        // Freeze the aim the finger let go at, then fire on the next frame.
        const run = this._slingRun;
        run.pull = aim.pull;
        run.side = aim.side;
        this._poseSlingBike(run.pull, run.side);
        run.dragReleased = true;
      }
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Fire: start the ride and hand the aim camera to the chase camera. */
  _slingGo() {
    this.state = 'playing';
    if (this.raceManager) this.raceManager.start();
    // Seed the chase camera from the aim pose, so launch is a blend, not a cut.
    this.chaseCamera.currentPos.copy(this.camera.position);
    if (this._slingLook) this.chaseCamera.currentLook.copy(this._slingLook);
    this.chaseCamera.initialized = true;
    this._launchSling();
  }

  /** Let go of the bands: the bike flies the way it is aimed. */
  _launchSling() {
    const run = this._slingRun;
    if (!run || run.launched) return;
    run.launched = true;
    this.bike.speed = sling.coopLaunchSpeed(this._slingStats, run.pull, run.coop && run.perfect);
    if (run.coop && run.perfect) slingUI.toast('PERFECT LAUNCH! +15%');
    document.body.classList.remove('sling-coop-aim');   // pedals are for winding only
    // The snap: a crack of rubber, a jolt of the camera, dust off the pouch.
    const pouch = this._slingRig ? this._slingRig.pouch.position.clone() : null;
    if (this._slingRig) this._slingRig.release();
    slingUI.hideFinger();
    this._playBeep(2200, 0.03);
    setTimeout(() => this._playBeep(140, 0.12), 25);
    if (this.chaseCamera) this.chaseCamera.shakeAmount = 0.25 + 0.35 * run.pull;
    if (pouch) {
      if (!this._slingFx) this._slingFx = new SparkleBurst(this.scene);
      this._slingFx.burst(pouch, { color: 0xb89a6a, size: 0.6, additive: false });
    }
    slingUI.hidePull();
    slingUI.markLearned();
    hapticCheckpoint();
    this._playChime(1320, 0.15);
    analytics.trackEvent('slingshot_launch', {
      pull: Math.round(run.pull * 100), aim: Math.round(run.side * 100), stage: this._slingSave.stage,
    });
  }

  /** No pedaling in this mode: the slingshot is the only push. */
  _slingPedal(r) {
    return { acceleration: 0, braking: false, wobble: 0, crankAngle: r.crankAngle };
  }

  /** Per ride frame. Returns true when the run ended this frame. */
  _updateSlingRun(dt) {
    const run = this._slingRun;
    if (!run || run.over) return true;
    if (this._slingRig) this._slingRig.update(dt);
    if (this._slingFx) this._slingFx.update(dt);
    this._easeSlingFov(dt);
    const b = this.bike;
    run.topSpeed = Math.max(run.topSpeed, b.speed);
    if (b.fallen && run.crashDistance == null) run.crashDistance = b.distanceTraveled;
    if (this._slingProps && !b.fallen) {
      for (const hit of this._slingProps.update(b.distanceTraveled, b._lateralOffset || 0, b.air ? b.air.h : 0)) {
        if (hit.kind === 'ramp') {
          b.launchAir(sling.rampLaunch(b.speed));
          this._playBeep(520, 0.08);
          setTimeout(() => this._playBeep(880, 0.1), 60);
        } else if (hit.kind === 'hay') {
          b.speed *= HAY_KEEP;
          this._playBeep(220, 0.12);
          slingUI.toast('Hay bale!');
        } else if (hit.kind === 'jackpot') {
          run.jackpot = true;
          hapticCheckpoint();
          this._playChime(1760, 0.3);
          this._endSlingRun('jackpot');
          return true;
        }
      }
    }
    // Touchdown: long enough in the air is Big Air, and pays.
    if (run.wasAir && !b.air) {
      const t = b.lastAirTime || 0;
      if (t >= sling.BIG_AIR_S) {
        run.bigAirs++;
        slingUI.toast(`Big air! ${t.toFixed(1)} s · +${sling.BIG_AIR_PAY} 🪙`);
        if (!this._slingFx) this._slingFx = new SparkleBurst(this.scene);
        this._slingFx.burst({ x: b.position.x, y: b.position.y + 0.8, z: b.position.z });
        this._playChime(1320, 0.2);
      }
      if (this.chaseCamera) this.chaseCamera.shakeAmount = Math.max(this.chaseCamera.shakeAmount, 0.3);
      hapticBump();
    }
    run.wasAir = !!b.air;
    if (!b.fallen && !b.air && b.speed < 0.3) {
      run.stillT += dt;
      if (run.stillT > 1.2) { this._endSlingRun('stall'); return true; }
    } else {
      run.stillT = 0;
    }
    this._updateSlingHud();
    return false;
  }

  _updateSlingHud() {
    const run = this._slingRun;
    if (!run) return;
    slingUI.updateHud({
      coins: run.coins,
      distance: sling.runDistance(this.bike.distanceTraveled),
      goal: sling.stageGoal(this._slingSave.stage),
    });
  }

  /**
   * Every reset in the mode (quick menu, D-pad, results) puts the bike back in
   * the slingshot. A run still rolling is abandoned, unpaid.
   */
  _resetToSling() {
    const run = this._slingRun;
    if (run && run.launched && !run.over) {
      run.over = true;
      analytics.trackEvent('slingshot_result', {
        cause: 'reset', distance: Math.round(sling.runDistance(this.bike.distanceTraveled)),
        coins: run.coins, stage: this._slingSave.stage, earned: 0,
      });
    }
    if (this._finishCinematic) {
      this._finishCinematic.cleanup();
      this._finishCinematic = null;
      if (this.chaseCamera) this.chaseCamera.initialized = false;
    }
    this._clearOverlayButtons();
    slingUI.hideResults();
    slingUI.hideGarage();
    slingUI.hideTally();
    if (this.obstacleManager) this.obstacleManager.restoreKnocked();
    if (this.physicsFx) this.physicsFx.clear();
    if (this._slingArmedFor === (this.lobby.selectedLevel && this.lobby.selectedLevel.distance)) this._armSlingRun();
    else this._startCountdown();
  }

  _endSlingRun(cause) {
    const run = this._slingRun;
    if (!run || run.over) return;
    run.over = true;
    const distance = sling.runDistance(cause === 'crash' && run.crashDistance != null
      ? run.crashDistance : this.bike.distanceTraveled);
    const runData = { distance, coins: run.coins, stageCleared: cause === 'goal', jackpot: !!run.jackpot, bigAirs: run.bigAirs };
    const score = sling.scoreRun(runData, this._slingSave);
    this._slingSave = sling.applyRun(this._slingSave, runData, score);
    sling.writeSave(this._slingStore(), this._slingSave);

    analytics.trackEvent('slingshot_result', {
      cause, distance: score.distance, coins: run.coins, earned: score.total,
      stage: this._slingSave.stage, record: score.isRecord,
    });

    // The end-of-ride signal: plant a flag where the bike stopped, count the
    // metres up, turn them into the coins they pay — then the full results.
    this.state = 'slingTally';
    this.quickMenu.setVisible(false);
    this.hud.hideTimer();
    this.audioEngine.stopBike();
    this._lastCrashCause = null;     // the crash latch is only cleared by the game-over modal
    slingUI.hideHud();
    slingUI.hidePull();
    if (this._slingFlag) this._slingFlag.dispose();
    this._slingFlag = new DistanceFlag(this.scene, this.bike.position, this.bike.heading, `${score.distance} m`);
    const label = { jackpot: 'JACKPOT!', goal: 'STAGE GOAL!', crash: 'CRASH!' }[cause] || '';
    slingUI.showTally(
      { distance: score.distance, coins: Math.floor(score.distPay * score.multiplier), label },
      {
        onTick: (kind) => (kind === 'coin' ? this._playBeep(1500, 0.05) : this._playBeep(700, 0.03)),
        onDone: () => this._showSlingResults(cause, score, runData, run),
      });
  }

  /** Per frame while the tally counts: the flag springs up, the sparkles settle. */
  _updateSlingTally(dt) {
    if (this._slingFlag) this._slingFlag.update(dt);
    if (this._slingFx) this._slingFx.update(dt);
    if (this._slingRig) this._slingRig.update(dt);
  }

  _showSlingResults(cause, score, runData, run) {
    if (this.state !== 'slingTally') return;
    slingUI.hideTally();
    this.state = 'slingResults';
    const buttons = slingUI.renderResults(
      { cause, score, run: { ...runData, topSpeed: run.topSpeed }, save: this._slingSave, stageCleared: runData.stageCleared },
      {
        onAgain: () => this._startSlingRun(),
        onGarage: () => this._openSlingGarage(),
        onLobby: () => { this._clearOverlayButtons(); this._returnToLobby(); },
      });
    this._setOverlayButtons(buttons);
    this._overlayCooldownUntil = performance.now() + 1200;
  }

  /** Every exit from the mode: lobby, a normal solo ride, Tourist. */
  _leaveSlingMode() {
    this.isSlingshot = false;
    this._slingArmedFor = null;
    document.body.classList.remove('sling-coop-aim');
    document.body.classList.remove('sling-mode');
    this.hud.suppressRidePrompts = false;
    if (this._slingFx) { this._slingFx.dispose(); this._slingFx = null; }
    if (this._slingPrevLobby && this.lobby.selectedLevel && this.lobby.selectedLevel.isSlingshot) {
      this.lobby.selectedLevel = this._slingPrevLobby.level;
      this.lobby.selectedDifficulty = this._slingPrevLobby.difficulty;
    }
    this._slingPrevLobby = null;
    this._slingRun = null;
    if (this._slingRig) { this._slingRig.dispose(); this._slingRig = null; }
    if (this._slingProps) { this._slingProps.dispose(); this._slingProps = null; }
    if (this._slingFlag) { this._slingFlag.dispose(); this._slingFlag = null; }
    slingUI.hideTally();
    slingUI.hideFinger();
    if (this._slingBaseFov != null && this.camera.fov !== this._slingBaseFov) {
      this.camera.fov = this._slingBaseFov;
      this.camera.updateProjectionMatrix();
    }
    if (this.bike) this.bike.coast = null;
    slingUI.hideGarage();
    slingUI.hideResults();
    slingUI.hideHud();
    slingUI.hidePull();
  }
}

/** Copy the mode's methods onto Game's prototype (they run as Game methods). */
export function installSlingshotMode(GameClass) {
  for (const key of Object.getOwnPropertyNames(SlingshotMode.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(GameClass.prototype, key)) {
      throw new Error(`slingshot-mode: Game already has ${key}`);
    }
    Object.defineProperty(GameClass.prototype, key, Object.getOwnPropertyDescriptor(SlingshotMode.prototype, key));
  }
}
