// ============================================================
// GOOSE RIDERS — the rigged goose tandem + its two goose riders
// ============================================================
//
// The bike GLB (goose_tandem.glb) carries an armature with socket bones; each goose GLB is loaded
// separately and parented to its seat socket, so the geese scale and tilt with the bike. Every frame
// BikeModel hands over the crank angle, the distance ridden and each rider's OWN lean:
//   bike   Pedal clip  <- crank angle          WheelSpin <- distance / wheel circumference
//   goose  Pedal_<seat> <- the same crank angle (legs, cloth chains)
//          Ride_<seat> / Lean_L_<seat> / Lean_R_<seat> <- that rider's lean (upper body)
// The clip contract (bones per clip, weights, times) lives in goose-rider-clips.js.

import * as THREE from 'three';
import { SEATS, trackBone, boneFilterFor, leanWeights, turnTime, seatOffset } from './goose-rider-clips.js';

function scrub(mixer, clip) {
  const a = mixer.clipAction(clip);
  a.play();
  a.paused = true; // we drive .time ourselves
  return a;
}

export function disposeTree(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry) o.geometry.dispose();
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      // not the shared riders environment map (#456), which outlives any one pair of geese
      for (const v of Object.values(m)) if (v && v.isTexture && !(v.userData && v.userData.riderEnv)) v.dispose();
      m.dispose();
    }
  });
}

function cutClip(clip) {
  const keep = boneFilterFor(clip.name);
  const c = clip.clone();
  if (keep) c.tracks = c.tracks.filter(t => keep(trackBone(t.name)));
  return c;
}

export class GooseRiders {
  /** The rigged goose tandem: a Pedal clip and seat sockets. */
  static isGooseBike(gltf) {
    const anims = gltf.animations || [];
    let socket = false;
    gltf.scene.traverse(o => { if (o.name === 'Seat_Captain') socket = true; });
    return socket && anims.some(c => c.name === 'Pedal');
  }

  /** @param {THREE.Object3D} model the bike scene; @param {THREE.AnimationClip[]} animations its clips */
  constructor(model, animations) {
    this.model = model;
    this.bikeClips = animations;
    this.bikeMixer = new THREE.AnimationMixer(model);
    const byName = n => animations.find(c => c.name === n);
    // cut to their own bones: both clips carry every bone, and two full-skeleton actions
    // on one mixer average out (the cranks turned half as far as the geese's legs)
    this.pedal = byName('Pedal') ? scrub(this.bikeMixer, cutClip(byName('Pedal'))) : null;
    this.wheels = byName('WheelSpin') ? scrub(this.bikeMixer, cutClip(byName('WheelSpin'))) : null;
    this.wheelCircumference = 0;   // world units; set by BikeModel once the model is scaled
    this.riderClips = {};          // seat -> { pedal, ride, leanL, leanR } (already cut to their bones)
    this.riders = {};              // seat -> { root, mixer, pedal, ride, leanL, leanR }
    this._crank = 0;
    this._dist = 0;
    this._lean = { Captain: 0, Stoker: 0 };
  }

  /** Measure the wheel in world units (call after the model is scaled and placed). */
  measureWheel() {
    const tyre = this.model.getObjectByName('Cylinder008_cycle_0') || this.model.getObjectByName('tyre_rear_low_cycle_0');
    if (!tyre) return;
    this.model.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(tyre, true).getSize(new THREE.Vector3());
    this.wheelCircumference = Math.PI * Math.max(size.y, size.z);
  }

  /**
   * Load both geese and seat them on their sockets.
   * @param {GLTFLoader} loader
   * @param {{Captain?: string, Stoker?: string}} paths
   */
  async loadRiders(loader, paths) {
    const loaded = await GooseRiders._fetch(loader, paths);
    for (const [seat, l] of Object.entries(loaded)) {
      this.riderClips[seat] = l.clips;
      this._seat(seat, l.scene);
    }
  }

  static async _fetch(loader, paths) {
    const out = {};
    await Promise.all(SEATS.filter(s => paths[s]).map(async (seat) => {
      const gltf = await loader.loadAsync(paths[seat]);
      const clips = {};
      for (const [key, prefix] of [['pedal', 'Pedal_'], ['ride', 'Ride_'], ['leanL', 'Lean_L_'], ['leanR', 'Lean_R_']]) {
        const c = gltf.animations.find(a => a.name === prefix + seat);
        if (c) clips[key] = cutClip(c);
      }
      out[seat] = { scene: gltf.scene, clips };
    }));
    return out;
  }

  /**
   * Goose Outfits: replace both geese with another pair. The old geese keep riding until the
   * new ones have loaded; then they leave their sockets (disposed unless a live versus clone
   * still shares their geometry) and the new ones are seated and posed at the current crank.
   * @param {GLTFLoader} loader
   * @param {{Captain?: string, Stoker?: string}} paths
   * @param {boolean} [disposeOld]
   */
  async swapRiders(loader, paths, disposeOld = true) {
    const loaded = await GooseRiders._fetch(loader, paths);
    for (const seat of Object.keys(loaded)) {
      const old = this.riders[seat];
      if (old) {
        old.mixer.stopAllAction();
        if (old.root.parent) old.root.parent.remove(old.root);
        if (disposeOld) disposeTree(old.root);
        delete this.riders[seat];
      }
      this.riderClips[seat] = loaded[seat].clips;
      this._seat(seat, loaded[seat].scene);
    }
    this.update();
  }

  _seat(seat, root) {
    const socket = this.model.getObjectByName('Seat_' + seat);
    if (!socket) { console.warn('goose bike has no socket Seat_' + seat); return; }
    root.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.isSkinnedMesh) o.frustumCulled = false; // bind-pose bounds don't follow the riding pose
        if (o.name.includes('__')) o.visible = false;  // layered body pieces: hidden while everything is worn
      }
    });
    root.updateMatrixWorld(true);
    const hl = new THREE.Vector3(), hr = new THREE.Vector3();
    const l = root.getObjectByName('LeftUpLeg'), r = root.getObjectByName('RightUpLeg');
    if (l && r) {
      l.getWorldPosition(hl);
      r.getWorldPosition(hr);
      const o = seatOffset(hl.add(hr).multiplyScalar(0.5));
      root.position.set(o.x, o.y, o.z);
    }
    root.userData.gooseSeat = seat;
    if (GooseRiders.hatToSocket(root)) root.userData.hatOnSocket = true;
    socket.add(root);
    this._bindRider(seat, root);
  }

  /**
   * #484: skin the hat to the HatSocket bone instead of Head (as the Goose Studio does), so a crash can
   * throw the hat off the head. HatSocket is a child of Head that no clip animates, so the hat looks the
   * same until something moves the socket. Returns true when the goose has a hat on its socket.
   */
  static hatToSocket(root) {
    let ok = false;
    root.traverse((m) => {
      if (!m.isSkinnedMesh || !/^hat/i.test(m.name)) return;
      const bones = m.skeleton.bones;
      const hi = bones.findIndex(b => b.name === 'Head'), si = bones.findIndex(b => b.name === 'HatSocket');
      if (hi < 0 || si < 0) return;
      const g = m.geometry;
      if (!g.userData.hatOnSocket) {
        const a = g.attributes.skinIndex;
        for (let i = 0; i < a.array.length; i++) if (a.array[i] === hi) a.array[i] = si;
        a.needsUpdate = true;
        g.userData.hatOnSocket = true;
      }
      ok = true;
    });
    return ok;
  }

  _bindRider(seat, root) {
    const clips = this.riderClips[seat] || {};
    const mixer = new THREE.AnimationMixer(root);
    const r = { root, mixer, pedal: null, ride: null, leanL: null, leanR: null };
    for (const k of ['pedal', 'ride', 'leanL', 'leanR']) if (clips[k]) r[k] = scrub(mixer, clips[k]);
    this.riders[seat] = r;
  }

  /** A versus clone: same clips, the cloned model's own geese (found by their seat tag). */
  static cloneFrom(source, model) {
    const g = new GooseRiders(model, source.bikeClips);
    g.wheelCircumference = source.wheelCircumference;
    g.riderClips = source.riderClips;
    model.traverse(o => { if (o.userData && o.userData.gooseSeat) g._bindRider(o.userData.gooseSeat, o); });
    return g;
  }

  setCrank(angle) { this._crank = angle || 0; }
  setDistance(d) { this._dist = d || 0; }
  /** Each rider's own lean in [-1, 1], + = the rider's right (the same sign as the bike's lean). */
  setLeans(captain, stoker) { this._lean.Captain = captain || 0; this._lean.Stoker = stoker || 0; }

  update() {
    if (this.pedal) this.pedal.time = turnTime(this._crank, this.pedal.getClip().duration);
    if (this.wheels && this.wheelCircumference > 0) {
      this.wheels.time = turnTime(2 * Math.PI * this._dist / this.wheelCircumference, this.wheels.getClip().duration);
    }
    this.bikeMixer.update(0);
    for (const [seat, r] of Object.entries(this.riders)) {
      if (r.ragdoll) continue;   // #484: a crash's rag doll owns this goose's bones (physics/crash-scene.js)
      if (r.pedal) r.pedal.time = turnTime(this._crank, r.pedal.getClip().duration);
      const w = leanWeights(this._lean[seat]);
      if (r.ride) r.ride.setEffectiveWeight(w.ride);
      if (r.leanL) r.leanL.setEffectiveWeight(w.left);
      if (r.leanR) r.leanR.setEffectiveWeight(w.right);
      r.mixer.update(0);
    }
  }
}
