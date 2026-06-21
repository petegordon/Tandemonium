// ============================================================
// MUD PATCH — slows the bike while it's on the patch.
// ============================================================

import * as THREE from 'three';
import { roadFrame, inVisibilityWindow, pointInRoadRect } from './artifact-base.js';

function makeMudTexture(skin) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const base = skin === 'sand' ? [220, 190, 130]
            : skin === 'ice'  ? [200, 230, 245]
            : /* mud */         [85, 55, 30];
  g.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
  g.fillRect(0, 0, 128, 128);
  // splotch noise
  const img = g.getImageData(0, 0, 128, 128);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 40;
    d[i]     = Math.max(0, Math.min(255, d[i]     + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
  // dark blobs
  for (let i = 0; i < 25; i++) {
    g.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.2})`;
    g.beginPath();
    g.arc(Math.random() * 128, Math.random() * 128, 4 + Math.random() * 12, 0, Math.PI * 2);
    g.fill();
  }
  return new THREE.CanvasTexture(c);
}

export class MudPatch {
  constructor(scene, roadPath, params) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.p = params;

    const tex = makeMudTexture(params.skin);
    const geo = new THREE.PlaneGeometry(params.width, params.length);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0.95,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._tex = tex;
  }

  update(dt, bikeDistanceTraveled, bikePos, bike) {
    const visible = inVisibilityWindow(this.p.d, bikeDistanceTraveled);
    this.mesh.visible = visible;
    if (visible) {
      const f = roadFrame(this.roadPath, this.p.d, this.p.offset || 0);
      this.mesh.position.set(f.x, f.y + 0.025, f.z);
      this.mesh.rotation.set(-Math.PI / 2, 0, -f.heading);
    }

    if (bike.fallen) return;

    const r = pointInRoadRect(this.roadPath, this.p.d, this.p.offset || 0, this.p.width, this.p.length, bikePos);
    if (r) {
      // Multiplicative slow: friction=0.55 means speed *= 0.55 per crossing window of ~1s
      // Apply as continuous drag: speed *= (1 - (1-friction) * dt * 4)
      const drag = (1 - this.p.friction) * 4.0;
      bike.speed *= Math.max(0, 1 - drag * dt);
    }
  }

  destroy() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this._tex.dispose();
  }
}
