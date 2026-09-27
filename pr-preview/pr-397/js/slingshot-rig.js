// ============================================================
// SLINGSHOT RIG — the giant slingshot on the start line
// ============================================================
//
// Two wooden Y-forks straddle the road at SLING_POST_D. Two rubber bands run
// from the fork tips to a leather pouch behind the bike's rear wheel. As the
// player drags, the bike (and the pouch) is drawn back and aside, the bands
// stretch, and a guide on the road shows where it will fly; on release the
// pouch whips forward past the fork and wobbles to rest while the bike flies.

import * as THREE from 'three';
import { SLING_POST_D } from './slingshot.js';

const POST_LATERAL = 3.1;      // just off the 2.5 m half-width road
const POST_HEIGHT = 1.4;       // trunk height; the fork tips sit above it
const FORK_RISE = 0.9;
const BAND_Y = 0.75;           // pouch height: the bike's rear hub, roughly
const REAR_OFFSET = 2.3;       // bike centre → just behind its rear wheel
const WOOD = 0x8a5a2b;
const BAND = 0xc0392b;
const LEATHER = 0x5a3a1e;

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

export class SlingshotRig {
  constructor(scene, roadPath) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.group = new THREE.Group();
    this._disposables = [];
    this._released = false;
    this._releaseT = 0;
    this._releaseFrom = new THREE.Vector3();

    const pt = roadPath.getPointAtDistance(SLING_POST_D);
    this._fwd = new THREE.Vector3(Math.sin(pt.heading), 0, Math.cos(pt.heading));
    const right = new THREE.Vector3(Math.cos(pt.heading), 0, -Math.sin(pt.heading));
    this._center = new THREE.Vector3(pt.x, pt.y, pt.z);

    const wood = this._mat(new THREE.MeshLambertMaterial({ color: WOOD }));
    const trunkGeo = this._geo(new THREE.CylinderGeometry(0.16, 0.22, POST_HEIGHT, 10));
    const prongGeo = this._geo(new THREE.CylinderGeometry(0.1, 0.14, FORK_RISE * 1.15, 8));

    // Fork tips, where the bands attach (world space).
    this.tips = [];
    for (const side of [-1, 1]) {
      const base = this._center.clone().addScaledVector(right, side * POST_LATERAL);
      const trunk = new THREE.Mesh(trunkGeo, wood);
      trunk.position.copy(base).add(new THREE.Vector3(0, POST_HEIGHT / 2, 0));
      this.group.add(trunk);
      // The Y: two prongs leaning out along the road, so the bands pass between.
      for (const lean of [-1, 1]) {
        const prong = new THREE.Mesh(prongGeo, wood);
        const tip = base.clone().add(new THREE.Vector3(0, POST_HEIGHT + FORK_RISE, 0)).addScaledVector(this._fwd, lean * 0.35);
        const root = base.clone().add(new THREE.Vector3(0, POST_HEIGHT, 0));
        this._placeBetween(prong, root, tip);
        this.group.add(prong);
      }
      this.tips.push(base.clone().add(new THREE.Vector3(0, POST_HEIGHT + FORK_RISE * 0.55, 0)));
    }

    const bandMat = this._mat(new THREE.MeshLambertMaterial({ color: BAND }));
    const bandGeo = this._geo(new THREE.CylinderGeometry(0.06, 0.06, 1, 6));
    this.bands = this.tips.map(() => {
      const m = new THREE.Mesh(bandGeo, bandMat);
      this.group.add(m);
      return m;
    });
    this.pouch = new THREE.Mesh(
      this._geo(new THREE.BoxGeometry(0.9, 0.35, 0.25)),
      this._mat(new THREE.MeshLambertMaterial({ color: LEATHER }))
    );
    this.pouch.rotation.y = pt.heading;
    this.group.add(this.pouch);

    this._pouchRest = this._center.clone().add(new THREE.Vector3(0, BAND_Y, 0));
    this._setPouch(this._pouchRest);

    // Aim guide: a flat strip on the road ahead of the bike, longer with more pull.
    const guideGeo = this._geo(new THREE.PlaneGeometry(0.35, 1));
    guideGeo.rotateX(-Math.PI / 2);        // lie flat; length runs along local Z
    guideGeo.translate(0, 0, 0.5);         // grow forward from its origin
    this.guide = new THREE.Mesh(guideGeo, this._mat(new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide,
    })));
    this.guide.visible = false;
    this.group.add(this.guide);
    scene.add(this.group);
  }

  /**
   * While aiming: the pouch sits behind the bike's rear wheel along the bike's
   * own heading, and the guide points where it will fly.
   */
  hold(bike, pull = 0) {
    this._released = false;
    const fwd = new THREE.Vector3(Math.sin(bike.heading), 0, Math.cos(bike.heading));
    const p = bike.position.clone().addScaledVector(fwd, -REAR_OFFSET);
    p.y = bike.position.y + BAND_Y;
    this._setPouch(p);
    this.pouch.rotation.y = bike.heading;

    this.guide.visible = pull > 0.02;
    if (this.guide.visible) {
      this.guide.position.copy(bike.position).addScaledVector(fwd, REAR_OFFSET + 0.2);
      this.guide.position.y = bike.position.y + 0.06;
      this.guide.rotation.y = bike.heading;
      this.guide.scale.z = 3 + 22 * pull;
    }
  }

  /** Let go: the pouch springs forward from where it was held. */
  release() {
    this._released = true;
    this._releaseT = 0;
    this._releaseFrom.copy(this.pouch.position);
    this.guide.visible = false;
  }

  /** Back to slack, ready for the next pull. */
  reset() {
    this._released = false;
    this.guide.visible = false;
    this._setPouch(this._pouchRest);
  }

  /** Per frame after release: a damped overshoot past the fork, then rest. */
  update(dt) {
    if (!this._released) return;
    this._releaseT += dt;
    const t = this._releaseT;
    // 1 → overshoots negative → settles at 0, in about a second.
    const k = Math.exp(-4.5 * t) * Math.cos(14 * t);
    const p = this._pouchRest.clone().lerp(this._releaseFrom, k);
    this._setPouch(p);
    if (t > 1.5) { this._released = false; this._setPouch(this._pouchRest); }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  _setPouch(p) {
    this.pouch.position.copy(p);
    this.tips.forEach((tip, i) => this._placeBetween(this.bands[i], tip, p));
  }

  /** Stretch a unit-height, Y-aligned cylinder between two points. */
  _placeBetween(mesh, a, b) {
    _dir.subVectors(b, a);
    const len = _dir.length() || 0.001;
    mesh.position.copy(a).addScaledVector(_dir, 0.5);
    mesh.quaternion.setFromUnitVectors(_up, _dir.divideScalar(len));
    const h = mesh.geometry.parameters.height || 1;
    mesh.scale.set(1, len / h, 1);
  }

  _geo(g) { this._disposables.push(g); return g; }
  _mat(m) { this._disposables.push(m); return m; }
}
