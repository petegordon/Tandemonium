// ============================================================
// BOOST PAD — flat decal on the road; speed bonus while crossing,
// decaying boost for `decay` seconds after exit.
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow, pointInRoadRect, VISIBLE_BEHIND } from './artifact-base.js';

function makeChevronTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1a1a1a';
  g.fillRect(0, 0, 64, 128);
  // Forward-pointing chevrons
  g.fillStyle = '#ffd33d';
  for (let y = 0; y < 128; y += 32) {
    g.beginPath();
    g.moveTo(0, y + 8);
    g.lineTo(32, y);
    g.lineTo(64, y + 8);
    g.lineTo(64, y + 20);
    g.lineTo(32, y + 12);
    g.lineTo(0, y + 20);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

let sharedTexture = null;

export class BoostPad {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;

    if (!sharedTexture) sharedTexture = makeChevronTexture();
    const tex = sharedTexture.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, Math.max(1, params.length / 1.5));

    const geo = new THREE.PlaneGeometry(params.width, params.length);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.92,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this._tex = tex;
    this._scrollOffset = 0;

    // Per-bike runtime state
    this._inside = false;
    this._boostRemaining = 0;
  }

  update(dt, bikeDistanceTraveled, bikePos, bike) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.mesh.visible = visible;
    if (visible) {
      const f = roadFrame(this.roadPath, this.p.d, this.p.offset || 0);
      this.mesh.position.set(f.x, f.y + 0.03, f.z);
      this.mesh.rotation.set(-Math.PI / 2, 0, -f.heading);
      // Scroll chevrons toward the bike to suggest forward push
      this._scrollOffset = (this._scrollOffset + dt * 0.6) % 1;
      this._tex.offset.y = -this._scrollOffset;
    }

    if (bike.fallen) return;

    // Test bike inside the pad
    const r = pointInRoadRect(this.roadPath, this.p.d, this.p.offset || 0, this.p.width, this.p.length, bikePos);
    if (r) {
      if (!this._inside) {
        this._inside = true;
        this._boostRemaining = this.p.decay;
      }
      // Apply peak boost while crossing
      const peakBonus = (this.p.strength - 1) * 6.0; // tuned: 0.35x strength gives ~2.1 m/s of bonus over the pad
      bike.speed = Math.min(bike.maxSpeed, bike.speed + peakBonus * dt);
    } else if (this._inside) {
      this._inside = false;
      // _boostRemaining was set at entry; leave it ticking down via update path
    }

    // Decaying after-glow once we've left the pad
    if (!this._inside && this._boostRemaining > 0) {
      const decayBonus = (this.p.strength - 1) * 3.0 * (this._boostRemaining / this.p.decay);
      bike.speed = Math.min(bike.maxSpeed, bike.speed + decayBonus * dt);
      this._boostRemaining -= dt;
    }
  }

  /** Called by ArtifactManager on a checkpoint/game-over reset. */
  reset() {
    this._inside = false;
    this._boostRemaining = 0;
  }

  destroy() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._tex.dispose();
  }
}
