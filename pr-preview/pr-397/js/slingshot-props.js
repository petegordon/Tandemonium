// ============================================================
// SLINGSHOT PROPS — the things in the lanes worth aiming at (or around)
// ============================================================
//
// Built from planCourse() in js/slingshot.js. Offsets use the road's own
// lateral convention — the same as the collectibles and bike._lateralOffset —
// so what you see is what you hit.
//   hay     — a round bale: soft, funny, bleeds speed (HAY_KEEP), run goes on
//   jackpot — a billboard: hit it and the run ends at double pay

import * as THREE from 'three';

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
   * distance), `lateral` is bike._lateralOffset. Returns the items hit now.
   */
  update(distance, lateral) {
    const hits = [];
    for (const it of this.items) {
      if (it.hit) continue;
      if (Math.abs(distance - it.d) > HIT_ALONG) continue;
      if (Math.abs(lateral - it.offset) > it.half + BIKE_HALF) continue;
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
