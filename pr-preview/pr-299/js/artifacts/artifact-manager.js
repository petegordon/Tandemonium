// ============================================================
// ARTIFACT MANAGER — owns all artifact instances for a race.
// Dispatches per-frame update() and one checkCollision() pass.
// ============================================================

import { BoostPad } from './boost-pad.js';
import { MudPatch } from './mud-patch.js';
import { ChokePoint } from './choke-point.js';
import { Drawbridge } from './drawbridge.js';
import { Ramp } from './ramp.js';
import { SyncGate } from './sync-gate.js';
import { loadManifest, emptyManifest, validateManifest } from './track-manifest.js';

const TYPE_CTORS = {
  boost:      BoostPad,
  mud:        MudPatch,
  choke:      ChokePoint,
  drawbridge: Drawbridge,
  ramp:       Ramp,
  sync:       SyncGate
};

export class ArtifactManager {
  constructor(scene, roadPath, level, camera) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.level = level;
    this.camera = camera;
    this._artifacts = [];
    this._raceStartTime = 0;
    this._ready = false;
  }

  /** Load + spawn artifacts for this level. Returns a promise. */
  async load() {
    const manifest = await this._loadManifest();
    if (!manifest || !Array.isArray(manifest.artifacts)) {
      this._ready = true;
      return;
    }
    for (const art of manifest.artifacts) {
      const Ctor = TYPE_CTORS[art.type];
      if (!Ctor) {
        console.warn(`[ArtifactManager] unknown artifact type: ${art.type}`);
        continue;
      }
      try {
        const inst = new Ctor(this.scene, this.roadPath, art);
        if (inst.setRaceStart) inst.setRaceStart(this._raceStartTime);
        this._artifacts.push({ type: art.type, inst });
      } catch (err) {
        console.warn(`[ArtifactManager] failed to spawn ${art.type}:`, err);
      }
    }
    this._ready = true;
  }

  async _loadManifest() {
    if (!this.level.track) return emptyManifest(this.level.id);
    try {
      const checkpoints = [];
      for (let d = this.level.checkpointInterval; d < this.level.distance; d += this.level.checkpointInterval) {
        checkpoints.push(d);
      }
      return await loadManifest(this.level.track, this.level.distance, checkpoints);
    } catch (err) {
      console.warn(`[ArtifactManager] failed to load track manifest:`, err);
      return emptyManifest(this.level.id);
    }
  }

  /** Tell time-based artifacts when the race started (epoch in performance.now()/1000). */
  setRaceStart(t) {
    this._raceStartTime = t;
    for (const { inst } of this._artifacts) {
      if (inst.setRaceStart) inst.setRaceStart(t);
    }
  }

  update(dt, bikeDistanceTraveled, bikePos, bike, sharedPedal) {
    if (!this._ready) return;
    for (const { inst } of this._artifacts) {
      inst.update(dt, bikeDistanceTraveled, bikePos, bike, sharedPedal);
    }
  }

  /**
   * Returns the first artifact-collision cause ('choke_point' | 'drawbridge'),
   * or null. Handles 'scrape' mode on choke points by applying drag rather
   * than returning a crash.
   */
  checkCollision(bikePos, bike, dt) {
    if (!this._ready) return null;
    for (const { type, inst } of this._artifacts) {
      if (type === 'choke') {
        const result = inst.checkCollision(bikePos);
        if (result === 'crash') return 'choke_point';
        if (result === 'scrape') inst.applyScrape(bike, bikePos, dt);
      } else if (type === 'drawbridge') {
        if (inst.checkCollision(bikePos)) return 'drawbridge';
      }
    }
    return null;
  }

  destroy() {
    for (const { inst } of this._artifacts) {
      try { inst.destroy(); } catch {}
    }
    this._artifacts = [];
    this._ready = false;
  }
}
