// ============================================================
// SYNC GATE — two poles + arch.  Rewards in-phase pedaling between
// Captain and Stoker (uses sharedPedal.offsetScore) when the bike
// crosses.  Pulses green when synced, red when off.
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow, pointInRoadRect } from './artifact-base.js';

const POLE_HEIGHT = 3.0;
const POLE_RADIUS = 0.08;
const ARCH_RADIUS = 0.18;

export class SyncGate {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;

    this.group = new THREE.Group();

    const archMat = new THREE.MeshBasicMaterial({ color: 0xff5050 });
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const poleGeo = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 8);

    const left = new THREE.Mesh(poleGeo, poleMat);
    left.position.set(-2.4, POLE_HEIGHT / 2, 0);
    this.group.add(left);

    const right = new THREE.Mesh(poleGeo, poleMat);
    right.position.set(2.4, POLE_HEIGHT / 2, 0);
    this.group.add(right);

    // Arch: a torus segment (half-circle) connecting the two pole tops.
    // Half-torus is built in the XY plane spanning x = ±radius through y = +radius,
    // which lines up directly with the poles at x = ±2.4 — no extra rotation needed.
    const archGeo = new THREE.TorusGeometry(2.4, ARCH_RADIUS, 8, 24, Math.PI);
    this.archMesh = new THREE.Mesh(archGeo, archMat);
    this.archMesh.position.set(0, POLE_HEIGHT, 0);
    this.group.add(this.archMesh);

    // Banner across the top
    const bannerGeo = new THREE.PlaneGeometry(4.0, 0.3);
    this.bannerMat = new THREE.MeshBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.8 });
    this.bannerMesh = new THREE.Mesh(bannerGeo, this.bannerMat);
    this.bannerMesh.position.set(0, POLE_HEIGHT - 0.5, 0);
    this.group.add(this.bannerMesh);

    this.group.visible = false;
    scene.add(this.group);

    this._inside = false;
    this._minSyncWhileInside = 1.0;   // tracks worst (lowest) offsetScore mid-crossing
    this._resolved = false;
    this._lastResetD = -Infinity;
    this._rewardRemaining = 0;
  }

  /**
   * @param {object} sharedPedal — must expose `offsetScore` (0–1).  May be null in solo
   *                              (we then read a synthetic phase via bike.pedalPower).
   */
  update(dt, bikeDistanceTraveled, bikePos, bike, sharedPedal) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.group.visible = visible;
    if (visible) {
      const f = roadFrame(this.roadPath, this.p.d, 0);
      this.group.position.set(f.x, f.y, f.z);
      this.group.rotation.y = f.heading;

      // Live sync indicator color — green when synced, red when off
      const liveSync = sharedPedal ? sharedPedal.offsetScore : 0.7;
      const c = new THREE.Color().setHSL(liveSync * 0.35, 1.0, 0.55);
      this.archMesh.material.color.copy(c);
      this.bannerMat.color.copy(c);
    }

    if (bike.fallen) return;

    // Checkpoint/respawn reset — re-arm so a second pass can score the gate.
    if (bikeDistanceTraveled < this._lastResetD) {
      this._lastResetD = -Infinity;
      this._resolved = false;
      this._minSyncWhileInside = 1.0;
      this._inside = false;
      this._rewardRemaining = 0;
    }

    const r = pointInRoadRect(this.roadPath, this.p.d, 0, 5.0, 1.2, bikePos);

    // Re-arm only after the bike has moved on
    if (!r && this._resolved && bikeDistanceTraveled > this._lastResetD + 50) {
      this._resolved = false;
      this._minSyncWhileInside = 1.0;
      this._inside = false;
    }

    if (r && !this._resolved) {
      this._inside = true;
      const sync = sharedPedal ? sharedPedal.offsetScore : 0.7; // solo: assume reasonable
      if (sync < this._minSyncWhileInside) this._minSyncWhileInside = sync;
    } else if (!r && this._inside && !this._resolved) {
      // Just exited — score the crossing
      this._resolved = true;
      this._lastResetD = bikeDistanceTraveled;
      // phaseTolerance is in degrees of pedal phase; map to offsetScore threshold.
      // offsetScore=1 means perfectly offset; tolerance=30deg -> require >=0.6.
      const reqScore = 1 - (this.p.phaseTolerance / 90);
      if (this._minSyncWhileInside >= reqScore) {
        this._rewardRemaining = this.p.rewardDuration;
      }
    }

    if (this._rewardRemaining > 0) {
      const bonus = (this.p.rewardStrength - 1) * 4.0 * (this._rewardRemaining / this.p.rewardDuration);
      bike.speed = Math.min(bike.maxSpeed, bike.speed + bonus * dt);
      this._rewardRemaining -= dt;
    }
  }

  destroy() {
    this.scene.remove(this.group);
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}
