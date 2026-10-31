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

  /** Throw a burst out from a world position: gold sparkles by default, or dust. */
  burst(pos, { color = 0xffe27a, size = 0.45, additive = true } = {}) {
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
      map: this._tex, size, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, color,
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

  /** Drop every burst still in the air (a relaunch mid-burst). */
  clear() {
    while (this.bursts.length) this._drop(this.bursts.length - 1);
  }

  dispose() {
    this.clear();
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

// ============================================================
// DISTANCE FLAG — planted where the run stopped: "387 m"
// ============================================================

export class DistanceFlag {
  /** `pos`/`heading` of the stopped bike; the flag stands just to its side. */
  constructor(scene, pos, heading, text) {
    this.scene = scene;
    this.group = new THREE.Group();
    this._keep = [];
    const keep = (x) => { this._keep.push(x); return x; };

    const pole = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8)),
      keep(new THREE.MeshLambertMaterial({ color: 0xf5f5f5 })));
    pole.position.y = 1.6;
    this.group.add(pole);

    const pennant = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.9, 0.55)),
      keep(new THREE.MeshLambertMaterial({ color: 0xff4a3c, side: THREE.DoubleSide })));
    pennant.position.set(0.45, 2.9, 0);
    this.pennant = pennant;
    this.group.add(pennant);

    const c = document.createElement('canvas'); c.width = 256; c.height = 112;
    const g = c.getContext('2d');
    g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, 256, 112);
    g.strokeStyle = '#ffd23f'; g.lineWidth = 8; g.strokeRect(4, 4, 248, 104);
    g.fillStyle = '#ffd23f'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 128, 58);
    const sign = new THREE.Mesh(keep(new THREE.PlaneGeometry(1.6, 0.7)),
      keep(new THREE.MeshBasicMaterial({ map: keep(new THREE.CanvasTexture(c)), side: THREE.DoubleSide })));
    sign.position.y = 1.9;
    this.group.add(sign);

    // Beside the bike (rider's right from behind is (-cos h, sin h)), facing back down the road.
    this.group.position.set(pos.x - Math.cos(heading) * 1.8, pos.y, pos.z + Math.sin(heading) * 1.8);
    this.group.rotation.y = heading + Math.PI;
    this._t = 0;
    this.group.scale.setScalar(0.01);
    scene.add(this.group);
  }

  /** Springs up out of the ground, then the pennant flutters. */
  update(dt) {
    this._t += dt;
    const t = Math.min(1, this._t / 0.35);
    const s = t < 1 ? 1.15 * Math.sin(t * Math.PI / 2) : 1 + 0.15 * Math.exp(-(this._t - 0.35) * 6) * Math.cos((this._t - 0.35) * 18);
    this.group.scale.setScalar(Math.max(0.01, s));
    this.pennant.rotation.y = Math.sin(this._t * 7) * 0.25;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const x of this._keep) x.dispose();
    this._keep = [];
  }
}
