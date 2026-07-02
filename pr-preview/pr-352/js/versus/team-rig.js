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
  constructor({ id, members, scene, world, lateralOffset = 0 }) {
    this.id = id;
    this.color = TEAM_COLORS[id];
    this.members = members.map((m) => ({ ...m, prevUp: false, prevDown: false }));
    this.lateralOffset = lateralOffset;

    this.bike = new BikeModel(scene);
    this.bike.roadPath = world.roadPath;

    // Aspect is owned by the game's versus resize handler (half-width viewport).
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
    this.chaseCamera = new ChaseCamera(this.camera);

    this.grassParticles = new GrassParticles(scene);

    this.pedalCtrl = null;
    this._buildPedalController();
    this.balanceCtrls = this.members.map((m) => new BalanceController(m.input));

    // Race state (raceManager assigned when the countdown builds them)
    this.raceManager = null;
    this.finished = false;
    this.finishMs = 0;
    this.crashCount = 0;
    this.collectibles = 0;
  }

  get isDuo() { return this.members.length > 1; }

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
  }

  /** Remove this rig's scene objects and free GPU resources. */
  dispose(scene) {
    scene.remove(this.bike.group);
    this.bike.group.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if (!m) continue;
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
    if (this.grassParticles) {
      scene.remove(this.grassParticles.points);
      this.grassParticles.geometry.dispose();
      this.grassParticles.material.dispose();
    }
  }
}
