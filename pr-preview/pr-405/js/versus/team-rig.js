// ============================================================
// TEAM RIG — per-team state for local versus mode (issue #351)
// One rig = one tandem bike + its riders' inputs + camera + race
// progress. Two rigs race side by side in split-screen.
// ============================================================

import * as THREE from 'three';
import { BikeModel } from '../bike-model.js';
import { ChaseCamera } from '../chase-camera.js';
import { BalanceController } from '../balance-controller.js';
import { PedalController } from '../pedal-controller.js';
import { SharedPedalController } from '../shared-pedal-controller.js';
import { GrassParticles } from '../grass-particles.js';
import { ArchIndicator } from '../arch-indicator.js';

// Team identity. Colors line up with the lobby's versus screen CSS and,
// roughly, with the ControllerManager's P1/P2 lightbar colors.
export const TEAM_COLORS = {
  A: { name: 'TEAM BLUE', hex: '#4c7dff', presetKey: 'bike_blue' },
  B: { name: 'TEAM RED', hex: '#ff4560', presetKey: 'bike_red' },
};

export class TeamRig {
  /**
   * @param {Object} opts
   * @param {'A'|'B'} opts.id
   * @param {Array<{input, type, slotId, name, isP1}>} opts.members 1-2 riders;
   *   first member is the captain on duo teams
   * @param {THREE.Scene} opts.scene
   * @param {World} opts.world shared world (roadPath source)
   * @param {number} [opts.lateralOffset] sideways start offset in meters so
   *   the two bikes don't overlap on the start line
   */
  constructor({ id, members, scene, world, lateralOffset = 0, bikeCloneSource = null }) {
    this.id = id;
    this.color = TEAM_COLORS[id];
    this.members = members.map((m) => ({ ...m, prevUp: false, prevDown: false }));
    this.lateralOffset = lateralOffset;

    // Clone the boot bike's loaded GLB when available — re-fetching the
    // ~7MB model made the second team's bike appear seconds late.
    this.bike = new BikeModel(scene, null, bikeCloneSource);
    this.bike.roadPath = world.roadPath;

    // Aspect is owned by the game's versus resize handler (half-width viewport).
    // Layer 1 (team A) / layer 2 (team B) show that team's own deformable
    // floor only — overlapping floors deformed to different anchors
    // z-fight badly (each is only accurate near its own bike).
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
    this.camera.layers.enable(id === 'A' ? 1 : 2);
    this.chaseCamera = new ChaseCamera(this.camera);

    this.grassParticles = new GrassParticles(scene);

    // Radial tilt dial floating over this team's bike (same gauge as
    // solo/co-op). Kept on this team's render layer so each viewport
    // shows only its own dial — at the start line the bikes are 1.6m
    // apart and two overlapping 3m arches would be unreadable.
    this.archIndicator = new ArchIndicator(scene);

    this.pedalCtrl = null;
    this._buildPedalController();
    this.balanceCtrls = this.members.map((m) => new BalanceController(m.input));

    // Race state (raceManager assigned when the countdown builds them)
    this.raceManager = null;
    this.finished = false;
    this.finishMs = 0;
    this.crashCount = 0;
    this.collectibles = 0;
    // Per-member steering input (-1..1), pre-merge — written each frame by
    // _stepTeam and rendered by VersusHud's tilt gauge.
    this.hudLeans = [0, 0];
  }

  get isDuo() { return this.members.length > 1; }

  /**
   * Pin every arch part to this team's render layer. Called each frame
   * after archIndicator.update() — the arch rebuilds its parts (on the
   * default layer) whenever TUNE.sensitivity changes, and re-traversing
   * ~25 objects per frame is effectively free.
   */
  applyArchLayer() {
    const layer = this.id === 'A' ? 1 : 2;
    this.archIndicator.group.traverse((o) => o.layers.set(layer));
  }

  /** First member's InputManager — the team's "primary" pad for haptics etc. */
  get inputs() { return this.members.map((m) => m.input); }

  _buildPedalController() {
    // Solo team: PedalController does its own edge detection off the input.
    // Duo team: SharedPedalController consumes edge-detected taps (captain =
    // first member, stoker = second) and rewards 180°-offset pedaling.
    this.pedalCtrl = this.isDuo
      ? new SharedPedalController()
      : new PedalController(this.members[0].input);
  }

  /** Reset for a fresh race (initial start and rematch). */
  resetForRace() {
    this.finished = false;
    this.finishMs = 0;
    this.crashCount = 0;
    this.collectibles = 0;
    this.bike.resetToDistance(0);
    this._applyStartOffset();
    this.chaseCamera.initialized = false;
    this._buildPedalController();
    for (const m of this.members) { m.prevUp = false; m.prevDown = false; }
  }

  /** Nudge the bike sideways (road-right) so the teams stagger at the line. */
  _applyStartOffset() {
    if (!this.lateralOffset || !this.bike.roadPath) return;
    const pt = this.bike.roadPath.getPointAtDistance(this.bike.roadD);
    const rightX = Math.cos(pt.heading);
    const rightZ = -Math.sin(pt.heading);
    this.bike.position.x += rightX * this.lateralOffset;
    this.bike.position.z += rightZ * this.lateralOffset;
    // Re-apply the visual transform NOW: resetToDistance() already synced
    // the model to the pre-offset position, and nothing else applies it
    // until bike.update() runs when the race starts. Without this, both
    // bikes render overlapped at road center through instructions +
    // countdown — which read as "Player 2's bike doesn't appear until
    // after the countdown" (the last-drawn bike hid the other).
    this.bike._applyTransform();
  }

  /** Remove this rig's scene objects and free GPU resources. */
  dispose(scene) {
    scene.remove(this.bike.group);
    this.bike.group.traverse((child) => {
      if (child.isMesh) {
        // Cloned bikes share geometry (and textures) with the boot bike —
        // disposing them would corrupt the singleton used by solo/co-op.
        if (child.geometry && !this.bike._sharedGeometry) child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (!m) continue;
          if (m.map && !this.bike._sharedGeometry) m.map.dispose();
          m.dispose();
        }
      }
    });
    if (this.grassParticles) {
      scene.remove(this.grassParticles.points);
      this.grassParticles.geometry.dispose();
      this.grassParticles.material.dispose();
    }
    if (this.archIndicator) this.archIndicator.destroy();
  }
}
