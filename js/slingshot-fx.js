// ============================================================
// SLINGSHOT FX — a burst of gold sparkles when a Chaos Coin is grabbed
// ============================================================

import * as THREE from 'three';

const PARTICLES = 28;
const LIFE = 0.7;          // seconds

export class SparkleBurst {
  constructor(scene) {
    this.scene = scene;
    this.bursts = [];
    this._tex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 32;
      const g = c.getContext('2d');
      const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.4, 'rgba(255,215,80,0.9)'); r.addColorStop(1, 'rgba(255,200,40,0)');
      g.fillStyle = r; g.fillRect(0, 0, 32, 32);
      return new THREE.CanvasTexture(c);
    })();
  }

  /** Throw a burst of sparkles out from a world position. */
  burst(pos) {
    const geo = new THREE.BufferGeometry();
    const p = new Float32Array(PARTICLES * 3);
    const v = [];
    for (let i = 0; i < PARTICLES; i++) {
      p[i * 3] = pos.x; p[i * 3 + 1] = pos.y; p[i * 3 + 2] = pos.z;
      const a = Math.random() * Math.PI * 2, up = 1.5 + Math.random() * 3.5, out = 1 + Math.random() * 2.5;
      v.push(Math.cos(a) * out, up, Math.sin(a) * out);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const mat = new THREE.PointsMaterial({
      map: this._tex, size: 0.45, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0xffe27a,
    });
    const points = new THREE.Points(geo, mat);
    this.scene.add(points);
    this.bursts.push({ points, v, age: 0 });
  }

  update(dt) {
    for (let b = this.bursts.length - 1; b >= 0; b--) {
      const it = this.bursts[b];
      it.age += dt;
      const arr = it.points.geometry.attributes.position.array;
      for (let i = 0; i < PARTICLES; i++) {
        it.v[i * 3 + 1] -= 6 * dt;                    // a little gravity
        arr[i * 3] += it.v[i * 3] * dt;
        arr[i * 3 + 1] += it.v[i * 3 + 1] * dt;
        arr[i * 3 + 2] += it.v[i * 3 + 2] * dt;
      }
      it.points.geometry.attributes.position.needsUpdate = true;
      it.points.material.opacity = Math.max(0, 1 - it.age / LIFE);
      if (it.age >= LIFE) this._drop(b);
    }
  }

  dispose() {
    while (this.bursts.length) this._drop(this.bursts.length - 1);
    this._tex.dispose();
  }

  _drop(b) {
    const it = this.bursts[b];
    this.scene.remove(it.points);
    it.points.geometry.dispose();
    it.points.material.dispose();
    this.bursts.splice(b, 1);
  }
}
