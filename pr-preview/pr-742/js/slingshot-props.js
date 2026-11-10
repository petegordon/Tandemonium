// ============================================================
// SLINGSHOT PROPS — the things in the lanes worth aiming at (or around)
// ============================================================
//
// Built from planCourse() in js/slingshot.js. Offsets use the road's own
// lateral convention — the same as the collectibles and bike._lateralOffset —
// so what you see is what you hit.
//   hay     — a round bale: soft, funny, bleeds speed (HAY_KEEP), run goes on
//   pot     — a pot of gold (#546): ride through it to collect a flat bonus;
//             the run goes on. Left out once cashed (js/slingshot.js · potCashed).
//             Its sign, a half-size tutorial board (js/tutorial-board.js), stands
//             over the lane just past it: decoration only, it never collides.
//   ramp    — a wooden kicker: hit it on the ground and the bike takes off
// Contact is height-aware: a bike in the air sails over hay, ramps and the pot.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { HAY_CLEAR_H } from './slingshot.js';
import { buildTutorialBoard, BOARD_TEXTURE } from './tutorial-board.js';

export const HAY_KEEP = 0.6;           // speed kept after a hay bale
const HAY_HALF = 0.75;                 // lateral half-width of a bale
const POT_HALF = 0.75;                 // lateral half-width of the pot of gold
const POT_SCALE = 1.1;                 // the model is ~1.5 m across the handles; this makes it ~1.65 m
const POT_CLEAR_H = 1.8;               // fly higher than this and you sail over the pot
/** The pot's sign: metres past the pot, half size, the face's bottom high over the riders. */
export const POT_SIGN = { after: 2.5, scale: 0.5, bottom: 2.7 };
const BIKE_HALF = 0.45;                // lateral half-width of the tandem
const HIT_ALONG = 2.0;                 // metres along the road that count as contact

// The sign's face texture, loaded once and shared by every course (each
// relaunch rebuilds the props; this texture is never disposed with them).
let _potSignTex = null;
function potSignTexture() {
  if (!_potSignTex) {
    _potSignTex = new THREE.TextureLoader().load(BOARD_TEXTURE.pot);
    _potSignTex.colorSpace = THREE.SRGBColorSpace;
    _potSignTex.anisotropy = 8;
  }
  return _potSignTex;
}

export class SlingshotProps {
  /** opts.potCashed: this stage's (or today's) pot already paid out, so build its sign but not the pot. */
  constructor(scene, roadPath, course, { potCashed = false } = {}) {
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

    this.potSign = null;
    if (course.pot) {
      const p = course.pot;
      // The sign: a half-size tutorial board over the pot's lane; the riders
      // pass beneath it. Not an item: there is nothing to hit.
      const sign = buildTutorialBoard('pot', { texture: potSignTexture(), scale: POT_SIGN.scale, bottom: POT_SIGN.bottom, overhead: true });
      sign.traverse(o => { if (o.isMesh) { this._keep(o.geometry); this._keep(o.material); } });
      this._place(sign, p.d + POT_SIGN.after, p.offset, 0, true);
      this.potSign = { mesh: sign, d: p.d };
      if (!potCashed) {
        const pot = this._buildPot();
        this._place(pot, p.d, p.offset, 0, true);
        this.items.push({ kind: 'pot', d: p.d, offset: p.offset, half: POT_HALF, hit: false, mesh: pot });
      }
    }
    scene.add(this.group);
  }

  /** The pot of gold on the road (null when the stage has none, or it is already cashed). */
  get pot() { return this.items.find(i => i.kind === 'pot') || null; }

  /**
   * A black iron cauldron on three stubby legs, heaped over the rim with gold
   * coins, a few spilled in front. About 1.65 m across the handles and 1.7 m
 * to the top of the heap (with POT_SCALE); three
   * draw calls (iron, gold heap, loose coins).
   */
  _buildPot() {
    const pot = new THREE.Group();
    pot.name = 'pot-of-gold';
    const iron = this._keep(new THREE.MeshStandardMaterial({ color: 0x2b2a30, roughness: 0.55, metalness: 0.5 }));
    const gold = this._keep(new THREE.MeshStandardMaterial({ color: 0xffc928, emissive: 0x9a6a00, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.75 }));
    this._potGold = gold;
    // The cauldron: a lathed bowl (outer wall, rolled rim, inner wall), three legs, two ring handles.
    const prof = [[0.0, 0.18], [0.36, 0.2], [0.6, 0.36], [0.72, 0.6], [0.7, 0.86], [0.6, 1.0],
                  [0.64, 1.06], [0.68, 1.08], [0.64, 1.12], [0.56, 1.06], [0.5, 0.9]]
      .map(([x, y]) => new THREE.Vector2(x, y));
    const parts = [new THREE.LatheGeometry(prof, 20)];
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3 + Math.PI / 6;
      const leg = new THREE.CylinderGeometry(0.07, 0.05, 0.36, 6);
      leg.translate(Math.cos(a) * 0.42, 0.18, Math.sin(a) * 0.42);
      parts.push(leg);
    }
    for (const x of [-0.74, 0.74]) {
      const h = new THREE.TorusGeometry(0.1, 0.025, 5, 10);
      h.rotateY(Math.PI / 2); h.translate(x, 0.92, 0);
      parts.push(h);
    }
    for (const g of parts) g.deleteAttribute('uv');
    pot.add(new THREE.Mesh(this._keep(mergeGeometries(parts.map(g => (g.index ? g.toNonIndexed() : g)), false)), iron));
    // The heap: a squashed dome of gold standing proud of the rim.
    const heap = new THREE.SphereGeometry(0.62, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    heap.scale(1, 0.85, 1); heap.translate(0, 0.98, 0);
    pot.add(new THREE.Mesh(this._keep(heap), gold));
    // Loose coins: tilted discs on the heap, and a few spilled in front of the
    // pot (local +z faces back down the road, towards the riders, once placed).
    const coins = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const disc = (x, y, z, tilt, spin) => {
      const c = new THREE.CylinderGeometry(0.13, 0.13, 0.035, 10);
      c.rotateX(tilt); c.rotateY(spin); c.translate(x, y, z);
      coins.push(c.toNonIndexed());
    };
    for (let i = 0; i < 28; i++) {
      const r = Math.sqrt(rnd()) * 0.55, a = rnd() * Math.PI * 2;
      const y = 0.98 + 0.527 * Math.sqrt(Math.max(0, 1 - (r / 0.62) ** 2)) + 0.01;
      disc(Math.cos(a) * r, y, Math.sin(a) * r, (rnd() - 0.5) * 1.4, rnd() * Math.PI);
    }
    for (let i = 0; i < 7; i++) {
      const a = (rnd() - 0.5) * 2.2, r = 0.82 + rnd() * 0.35;
      disc(Math.sin(a) * r, 0.02, Math.cos(a) * r, (rnd() - 0.5) * 0.3, rnd() * Math.PI);
    }
    pot.add(new THREE.Mesh(this._keep(mergeGeometries(coins, false)), gold));
    for (const m of pot.children) { m.castShadow = true; m.receiveShadow = true; }
    pot.scale.setScalar(POT_SCALE);
    return pot;
  }

  /**
   * Contact test for this frame. `distance` is bike.distanceTraveled (road
   * distance), `lateral` is bike._lateralOffset, `height` how high the bike
   * is off the road. Returns the items hit now.
   */
  update(distance, lateral, height = 0) {
    const t = performance.now() / 1000;
    if (this.potSign) this.potSign.mesh.userData.board.update(t, distance, this.potSign.d);   // the board's shimmer + pass glint
    // The gold glints: a slow pulse, so the heap catches the eye from far off.
    if (this._potGold) this._potGold.emissiveIntensity = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 4));
    const hits = [];
    for (const it of this.items) {
      if (it.hit) continue;
      if (Math.abs(distance - it.d) > HIT_ALONG) continue;
      if (Math.abs(lateral - it.offset) > it.half + BIKE_HALF) continue;
      // Over the top: sailing over a bale clears it for good; ramps only
      // launch from the ground.
      if (it.kind === 'hay' && height > HAY_CLEAR_H) { it.hit = true; it.cleared = true; continue; }
      if (it.kind === 'ramp' && height > 0.05) continue;
      if (it.kind === 'pot' && height > POT_CLEAR_H) continue;
      it.hit = true;
      if (it.kind === 'hay') it.mesh.rotation.y += 0.6;   // knocked askew
      if (it.kind === 'pot') it.mesh.visible = false;    // collected: the gold is in the riders' pockets
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

  _keep(x) { this._disposables.push(x); return x; }
}
