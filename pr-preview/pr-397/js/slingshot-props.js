// ============================================================
// SLINGSHOT PROPS — the things in the lanes worth aiming at (or around)
// ============================================================
//
// Built from planCourse() in js/slingshot.js. Offsets use the road's own
// lateral convention — the same as the collectibles and bike._lateralOffset —
// so what you see is what you hit.
//   hay     — a round bale: soft, funny, bleeds speed (HAY_KEEP), run goes on
//   jackpot — a billboard: hit it and the run ends at double pay
//   ramp    — a wooden kicker: hit it on the ground and the bike takes off
// Contact is height-aware: a bike in the air sails over hay (and ramps).

import * as THREE from 'three';
import { HAY_CLEAR_H } from './slingshot.js';

export const HAY_KEEP = 0.6;           // speed kept after a hay bale
const HAY_HALF = 0.75;                 // lateral half-width of a bale
const JACKPOT_HALF = 1.1;              // lateral half-width of the board
const BIKE_HALF = 0.45;                // lateral half-width of the tandem
const HIT_ALONG = 2.0;                 // metres along the road that count as contact

export class SlingshotProps {
  constructor(scene, roadPath, course) {
    this.scene = scene;
    this.roadPath = roadPath;
    this.group = new THREE.Group();
    this._disposables = [];
    this.items = [];

    const hayMat = this._keep(new THREE.MeshLambertMaterial({ color: 0xd9b44a }));
    const hayGeo = this._keep(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 16));
    hayGeo.rotateZ(Math.PI / 2);                     // lying on its side, across the road
    for (const h of course.hay || []) {
      const mesh = new THREE.Mesh(hayGeo, hayMat);
      this._place(mesh, h.d, h.offset, 0.75);
      this.items.push({ kind: 'hay', d: h.d, offset: h.offset, half: HAY_HALF, hit: false, mesh });
    }

    const rampWood = this._keep(new THREE.MeshLambertMaterial({ color: 0xa0703c }));
    const rampStripe = this._keep(new THREE.MeshBasicMaterial({ color: 0xffd23f }));
    const RAMP_LEN = 3.2, RAMP_H = 0.9, pitch = Math.atan2(RAMP_H, RAMP_LEN);
    const deckGeo = this._keep(new THREE.BoxGeometry(1.4, 0.12, Math.hypot(RAMP_LEN, RAMP_H)));
    const lipGeo = this._keep(new THREE.BoxGeometry(1.42, 0.02, 0.25));
    const sideGeo = this._keep(new THREE.BoxGeometry(0.08, RAMP_H, 0.08));
    for (const r of course.ramps || []) {
      const ramp = new THREE.Group();
      const deck = new THREE.Mesh(deckGeo, rampWood);
      deck.rotation.x = -pitch;                       // the far (+z) end is the high lip
      deck.position.y = RAMP_H / 2;
      ramp.add(deck);
      const lip = new THREE.Mesh(lipGeo, rampStripe);
      lip.position.set(0, RAMP_H + 0.07, RAMP_LEN / 2 - 0.15);
      ramp.add(lip);
      for (const x of [-0.65, 0.65]) {
        const post = new THREE.Mesh(sideGeo, rampWood);
        post.position.set(x, RAMP_H / 2, RAMP_LEN / 2 - 0.1);
        ramp.add(post);
      }
      this._place(ramp, r.d, r.offset, 0);
      this.items.push({ kind: 'ramp', d: r.d, offset: r.offset, half: 0.7, hit: false, mesh: ramp });
    }

    if (course.jackpot) {
      const j = course.jackpot;
      const board = new THREE.Group();
      const post = this._keep(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 8));
      const wood = this._keep(new THREE.MeshLambertMaterial({ color: 0x6b4423 }));
      for (const x of [-0.9, 0.9]) {
        const m = new THREE.Mesh(post, wood); m.position.set(x, 1.1, 0); board.add(m);
      }
      const face = new THREE.Mesh(
        this._keep(new THREE.PlaneGeometry(2.2, 1.1)),
        this._keep(new THREE.MeshBasicMaterial({ map: this._keep(this._jackpotTexture()), side: THREE.DoubleSide }))
      );
      face.position.set(0, 2.0, 0);
      board.add(face);
      this._place(board, j.d, j.offset, 0, true);
      this.items.push({ kind: 'jackpot', d: j.d, offset: j.offset, half: JACKPOT_HALF, hit: false, mesh: board });
    }
    scene.add(this.group);
  }

  /**
   * Contact test for this frame. `distance` is bike.distanceTraveled (road
   * distance), `lateral` is bike._lateralOffset, `height` how high the bike
   * is off the road. Returns the items hit now.
   */
  update(distance, lateral, height = 0) {
    const hits = [];
    for (const it of this.items) {
      if (it.hit) continue;
      if (Math.abs(distance - it.d) > HIT_ALONG) continue;
      if (Math.abs(lateral - it.offset) > it.half + BIKE_HALF) continue;
      // Over the top: sailing over a bale clears it for good; ramps only
      // launch from the ground.
      if (it.kind === 'hay' && height > HAY_CLEAR_H) { it.hit = true; it.cleared = true; continue; }
      if (it.kind === 'ramp' && height > 0.05) continue;
      it.hit = true;
      if (it.kind === 'hay') it.mesh.rotation.y += 0.6;   // knocked askew
      hits.push(it);
    }
    return hits;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  _place(obj, d, offset, y, faceBack = false) {
    const pt = this.roadPath.getPointAtDistance(d % this.roadPath.loopLength);
    // Same right vector as the collectibles: (cos h, −sin h).
    obj.position.set(pt.x + Math.cos(pt.heading) * offset, pt.y + y, pt.z - Math.sin(pt.heading) * offset);
    obj.rotation.y = pt.heading + (faceBack ? Math.PI : 0);
    this.group.add(obj);
  }

  _jackpotTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#ffd23f'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#c0392b'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 118);
    g.fillStyle = '#c0392b'; g.font = 'bold 46px sans-serif'; g.textAlign = 'center';
    g.fillText('JACKPOT', 128, 62);
    g.font = 'bold 34px sans-serif'; g.fillText('×2', 128, 104);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  _keep(x) { this._disposables.push(x); return x; }
}
