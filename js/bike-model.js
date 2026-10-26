// ============================================================
// BIKE MODEL — GLB visuals + physics + remote state
// ============================================================

import * as THREE from 'three';
import { COBBLES_SHAKE, COBBLES_DRAG } from './disruptions.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { BIKE_MODEL_PATH, getGooseRiderPaths, getGooseOutfit, getGooseColourway, TUNE } from './config.js';
import { colourwayParams, applyColourway } from './goose-colourways.js';
import { GooseRiders } from './goose-riders.js';
import { CrankMotion } from './crank-motion.js';
import { fallLean } from './crash-tumble.js';
import { rebatch } from './bike-batch.js';
import { dracoDecoderPath } from './draco-path.js';

/** #441 · seconds over which a stroke's speed gain eases in (time constant). */
const ACCEL_EASE_S = 0.1;

// A-5 · where the safety clamp starts to be felt. The clamp itself is at ±1.0.
export const EDGE_BAND_START = 0.8;

// The riders GLB ships Draco-compressed geometry to keep it small; the plain
// frame GLB isn't compressed, so the decoder is only fetched when a Draco mesh
// is actually encountered. The decoder comes from wherever three/addons resolves
// (CDN on web, node_modules on desktop — #353). Shared across all BikeModel loads.
let _dracoLoader = null;
function getDracoLoader() {
  if (!_dracoLoader) {
    _dracoLoader = new DRACOLoader();
    _dracoLoader.setDecoderPath(dracoDecoderPath('libs/draco/'));
  }
  return _dracoLoader;
}

export class BikeModel {
  /**
   * @param {THREE.Scene} scene
   * @param {string} [modelPath]
   * @param {BikeModel} [cloneSource] an already-loaded BikeModel to deep-
   *   clone instead of re-fetching the GLB. The tandem GLB is ~7MB and its
   *   load path does a per-vertex bounds scan — versus spawns two extra
   *   bikes at once, and re-loading made Player 2's bike pop in seconds
   *   late (after the countdown). Cloning is instant and shares geometry.
   */
  constructor(scene, modelPath, cloneSource = null) {
    this.scene = scene;
    this._modelPath = modelPath || BIKE_MODEL_PATH;
    this._sharedGeometry = false; // true when cloned — never dispose shared geo
    this.group = new THREE.Group();
    scene.add(this.group);

    // Physics state
    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.lean = 0;
    this.leanVelocity = 0;
    this._roughness = 0;   // E-2 cobbles, 0..1
    this.speed = 0;
    this.distanceTraveled = 0;
    this.crankAngle = 0;

    // A-3 · the crank follows YOUR taps: crankAngle gains a quarter turn per
    // stroke (pedal controllers own it). #441 · CrankMotion turns that into a
    // smooth circle at the riders' cadence; when they stop pedaling the feet
    // run on and slow quickly to rest, like a freewheel.
    this._crankMotion = new CrankMotion();
    this._crankDisplay = 0;
    // #441 · each stroke's speed gain eases in over ~0.3 s instead of landing
    // in one frame, so speed climbs smoothly while the riders pedal.
    this._pendingAccel = 0;

    // Fall state
    this.fallen = false;
    this.fallTimer = 0;
    this._braking = false;
    this.boostTimer = 0;

    // Slingshot mode: when set, { decel(v, centerDist) → m/s², maxSpeed }
    // replaces the arcade friction, the centre-strip push and the edge/grass
    // drag, so a launched bike coasts and the surface costs a little per second
    // instead of a share of the speed.
    this.coast = null;
    // Airborne (Slingshot ramps): { vy, h, t } while off the ground, else null.
    // Height rides on top of the road; gravity brings it back; nothing else
    // in the game sets it, so every other ride stays road-locked.
    this.air = null;

    // Optional crash-tumble hooks (issue #388). The physics sidecar is wired in
    // by the game, not imported here — this model stays a pure arcade balance
    // model that knows nothing about Rapier, and plays identically when the
    // hooks are left null.
    //
    // onFall fires at the TOP of _fall(), before the canned crash pose
    // overwrites lean/speed, so a listener can still read the attitude and
    // velocity the bike crashed at. While transformOverride is set, this model
    // stops writing group.position/quaternion and something else drives them;
    // every other piece of state carries on exactly as before, so the netcode,
    // the HUD, the race logic and the cameras never see a difference.
    this.onFall = null;
    this.onReset = null;
    // #484 crash scene (physics/crash-scene.js): rag dolls + hats; the slow-mo clock; the crash cause
    this.crashScene = null;
    this._slowMoStart = 0;
    this._crashDownSim = 0;
    this._crashCause = null;
    this.transformOverride = false;
    this._tumbleHandle = null;

    // Balance assist (0 = off, 0-1 = graduated assist strength)
    this._balanceAssist = 0;

    // Road path reference (set externally after construction)
    this.roadPath = null;
    this.roadD = 0;          // distance along road centerline
    this._lateralOffset = 0; // distance from road center (for off-road wobble)
    this._frontWheelOffset = 0; // front wheel lateral offset
    this._rearWheelOffset = 0;  // rear wheel lateral offset
    this._smoothPitch = 0;   // smoothed pitch angle for rendering

    // GLB data
    this.modelLoaded = false;
    this.spokeMeshes = [];
    this.pedalNodes = [];
    this.smoothSpokeFade = 0;
    this._prevSpokeOpacity = NaN;
    this.maxSpeed = TUNE.maxSpeed || 16;

    // Preset support
    this._pendingPreset = null;
    this._originalMats = null; // Map<meshName, clonedMaterial>
    // #395 · marks the merged frame meshes this bike made (see _rebatch)
    this._batchId = 'bike-' + Math.random().toString(36).slice(2);
    // #456 · lean riders lighting: reflections on this bike only (setEnvMap)
    this._envMap = null;
    this._envApplied = false;

    // Reusable temporaries for _applyTransform (avoid per-frame allocations)
    this._tmpQYaw = new THREE.Quaternion();
    this._tmpQLean = new THREE.Quaternion();
    this._tmpQPitch = new THREE.Quaternion();
    this._tmpQ = new THREE.Quaternion();
    this._tmpAxisY = new THREE.Vector3(0, 1, 0);
    this._tmpAxisZ = new THREE.Vector3(0, 0, 1);
    this._tmpAxisX = new THREE.Vector3(1, 0, 0);

    // Rider-lean: the captain and stoker sway their torsos INDEPENDENTLY — each
    // by their own gyro/lean input — while the whole bike still tilts by this.lean
    // (the aggregate) in _applyTransform. Only set up when the loaded GLB carries
    // the skinned rider armature + the two lean clips. See _setupRiderLean.
    this.riderMixer = null;
    this.captainAction = null;
    this.stokerAction = null;
    this.riderClipDuration = 0;
    this._captainLeanTarget = 0; // [-1, 1] this frame's captain input
    this._stokerLeanTarget = 0;  // [-1, 1] this frame's stoker input
    this._captainLeanNorm = 0;   // smoothed
    this._stokerLeanNorm = 0;    // smoothed
    // The goose tandem (rigged bike + two separate goose riders, js/goose-riders.js):
    // cranks / wheels from the bike's clips, each goose pedals with the crank and
    // leans by its own rider's input. null on the other models.
    this.goose = null;
    this.riderViewScale = 1;     // rider height vs the fused riders model (front view)
    this._soloRider = false;     // Show Solo: only the captain goose is shown

    // Versus spawns extra bikes by cloning an already-loaded one (instant, shares
    // geometry — no re-fetch/decode). A SKINNED riders model needs SkeletonUtils
    // so the clone gets its OWN Skeleton (a plain clone() shares the source's, so
    // every bike would pose/lean together); the plain frame uses the fast clone.
    if (cloneSource && cloneSource.modelLoaded) {
      if (cloneSource.goose) this._initFromCloneGoose(cloneSource);
      else if (cloneSource.riderMixer) this._initFromCloneSkinned(cloneSource);
      else this._initFromClone(cloneSource);
    } else {
      this._loadModel();
    }
  }

  /**
   * Clone a skinned riders bike for versus. SkeletonUtils.clone gives the clone
   * its own Skeleton (independent posing) while still sharing geometry + textures,
   * so it's ~instant and cheap on VRAM. Each clone gets its own AnimationMixer
   * bound to the source's already-bone-stripped lean clips, so it leans by its
   * own team's input (set via setRiderLeans / balanceResult in _stepTeam).
   */
  _initFromCloneSkinned(source) {
    const model = cloneSkinned(source.group.children[0]);
    this.group.add(model);
    this.group.updateMatrixWorld(true);
    this._sharedGeometry = true;
    this.modelLoaded = true;

    this.riderMixer = new THREE.AnimationMixer(model);
    this.riderClipDuration = source.riderClipDuration;
    const capClip = source.captainAction && source.captainAction.getClip();
    const stoClip = source.stokerAction && source.stokerAction.getClip();
    if (capClip) this.captainAction = this._makeScrubAction(capClip);
    if (stoClip) this.stokerAction = this._makeScrubAction(stoClip);

    if (this._pendingPreset) {
      this.applyPreset(this._pendingPreset);
      this._pendingPreset = null;
    }
  }

  /**
   * Clone the goose tandem for versus: SkeletonUtils gives the clone's geese their
   * own skeletons (geometry + textures shared); the clone gets its own mixers on the
   * source's clips, so it pedals and leans by its own team's input.
   */
  _initFromCloneGoose(source) {
    const model = cloneSkinned(source.group.children[0]);
    this.group.add(model);
    this.group.updateMatrixWorld(true);
    this._sharedGeometry = true;
    this.goose = GooseRiders.cloneFrom(source.goose, model);
    this.riderViewScale = source.riderViewScale;
    this.modelLoaded = true;
    if (this._pendingPreset) {
      this.applyPreset(this._pendingPreset);
      this._pendingPreset = null;
    }
    this._rebatch();
  }

  /**
   * Deep-clone another BikeModel's loaded scene graph. Geometry is shared
   * (clone() reuses BufferGeometry); materials start shared too, but every
   * versus bike immediately runs applyPreset(), which replaces them with
   * per-instance clones — and spoke materials are cloned here regardless
   * because their opacity animates per bike. Only for the non-skinned frame
   * model; skinned riders bikes fresh-load (see the constructor guard).
   */
  _initFromClone(source) {
    const model = source.group.children[0].clone(true);
    model.traverse((child) => {
      const n = (child.name || '').toLowerCase();
      if (child.isMesh && (n === 'cylinder035_cycle_0' || n === 'cylinder024_cycle_0')) {
        child.material = child.material.clone();
        child.material.transparent = true;
        this.spokeMeshes.push(child);
      }
      if (n.includes('pedal')) this.pedalNodes.push(child);
    });
    this.group.add(model);
    this.group.updateMatrixWorld(true);
    this._sharedGeometry = true;
    this.modelLoaded = true;
    if (this._pendingPreset) {
      this.applyPreset(this._pendingPreset);
      this._pendingPreset = null;
    }
    this._rebatch();   // drops the source's merged meshes it copied, and merges its own
  }

  /**
   * Swap this bike's GLB in place (Show Riders toggled at runtime). The
   * BikeModel object itself survives — physics state and every external
   * reference (chase camera, world, versus clone source) stay valid. The old
   * model keeps rendering until the new GLB lands, then is removed; visual
   * state (spokes, pedals, rider rig, preset originals) is rebuilt for the
   * new model. applyPreset calls during the load queue via _pendingPreset.
   * @param {string} modelPath
   * @param {boolean} [disposeOld] false when live clones may share the old
   *   model's geometry (e.g. a versus session cloned from this bike).
   */
  swapModel(modelPath, disposeOld = true) {
    if (modelPath === this._modelPath) return;
    this._modelPath = modelPath;
    const oldChildren = this.group.children.slice();
    const oldShared = this._sharedGeometry;
    this._sharedGeometry = false;
    this.modelLoaded = false;
    this.spokeMeshes = [];
    this.pedalNodes = [];
    this.smoothSpokeFade = 0;
    this._prevSpokeOpacity = NaN;
    this.riderMixer = null;
    this.captainAction = null;
    this.stokerAction = null;
    this.riderClipDuration = 0;
    this.goose = null;
    this.riderViewScale = 1;
    this._originalMats = null;
    this._loadModel(() => {
      for (const c of oldChildren) {
        this.group.remove(c);
        if (disposeOld && !oldShared) {
          c.traverse((child) => {
            if (child.isMesh) {
              if (child.geometry) child.geometry.dispose();
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              for (const m of mats) if (m) m.dispose();
            }
          });
        }
      }
    });
  }

  // Torso lean (radians) at the ends of the exported clip — matches LEAN_AMP_DEG
  // in export_riders_lean_glb.py, so |normalized lean| = 1 maps to the clip peak.
  static RIDER_LEAN_AMP = 45 * Math.PI / 180;
  // Yaw applied to the riders GLB so its authored forward (Blender -X) faces the
  // travel direction. Tuned against the road in _loadModel.
  static RIDER_MODEL_YAW = Math.PI / 2;

  /** @param {Function} [onAttached] runs once the new model is in the group
   *    and recentered, before it becomes children[0]-addressable state. */
  _loadModel(onAttached) {
    const modelPath = this._modelPath;
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDracoLoader());
    loader.load(this._modelPath, (gltf) => {
      const model = gltf.scene;
      // The goose tandem drives its cranks from its Pedal clip, so none of its
      // nodes join pedalNodes (its pedal bones / sockets must not be spun).
      const isGoose = GooseRiders.isGooseBike(gltf);
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }

        const n = (child.name || '').toLowerCase();

        if (child.isMesh && (n === 'cylinder035_cycle_0' || n === 'cylinder024_cycle_0')) {
          child.material = child.material.clone();
          child.material.transparent = true;
          this.spokeMeshes.push(child);
        }

        if (n.includes('pedal') && !isGoose) {
          this.pedalNodes.push(child);
        }
      });

      // The fused riders GLB ships a skinned armature + a lean clip; the plain frame
      // GLB ships neither. Detect it here to drive rider lean and orient it.
      const isRiders = !isGoose && !!(gltf.animations && gltf.animations.length > 0);

      // Scale to ~4.4m long (the goose tandem by its precise bounds: its nodes are
      // baked, so the loose box is already exact, but say so; geese ride along).
      const targetLength = 4.4;
      const preBox = new THREE.Box3().setFromObject(model, isGoose);
      const preSize = preBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(preSize.x, preSize.y, preSize.z);
      const scale = targetLength / maxDim;
      model.scale.setScalar(scale);

      // Face the riders model down the road. Applied before the bounds scan so
      // recentering happens in the final orientation.
      if (isRiders) model.rotation.y = BikeModel.RIDER_MODEL_YAW;

      this.group.add(model);
      this.group.updateMatrixWorld(true);

      // Find true bounds
      let minY = Infinity, maxY = -Infinity;
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      const v = new THREE.Vector3();

      model.traverse((child) => {
        if (child.isMesh && child.geometry && child.geometry.attributes.position) {
          const pos = child.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            child.localToWorld(v);
            if (v.y < minY) minY = v.y;
            if (v.y > maxY) maxY = v.y;
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
          }
        }
      });

      const centerX = (minX + maxX) / 2;
      const centerZ = (minZ + maxZ) / 2;
      model.position.y -= minY;
      model.position.x -= centerX;
      model.position.z -= centerZ;

      const finish = () => {
        // Swap path: retire the previous model now, so the new one is
        // children[0] before applyPreset / _initFromClone can address it.
        if (onAttached) onAttached(model);

        this.modelLoaded = true;
        if (isRiders) this._setupRiderLean(model, gltf.animations);
        console.log('Bike loaded. Spokes:', this.spokeMeshes.length,
          'Pedals:', this.pedalNodes.length, 'Riders:', isRiders, 'Geese:', isGoose);

        if (this._pendingPreset) {
          this.applyPreset(this._pendingPreset);
          this._pendingPreset = null;
        }
        this._rebatch();
      };
      if (!isGoose) { finish(); return; }

      // The goose tandem: seat both geese before the bike counts as loaded, so a
      // versus clone (taken once modelLoaded) carries them too.
      const goose = new GooseRiders(model, gltf.animations);
      goose.measureWheel();
      const riderPaths = getGooseRiderPaths();
      this._gooseRiderPaths = riderPaths;
      goose.loadRiders(loader, riderPaths).catch((err) => {
        console.warn('Goose riders failed to load; riding the bare bike:', err);
      }).then(() => {
        if (this._modelPath !== modelPath) return; // swapped away while loading
        this.goose = goose;
        this.setSoloRider(this._soloRider);
        this.applyGooseColours();
        goose.update();
        model.updateMatrixWorld(true);
        const top = new THREE.Box3().setFromObject(model).max.y - model.position.y;
        // the fused riders model stood 3.24 m tall on its 4.4 m bike
        this.riderViewScale = Math.max(0.5, Math.min(2, top / 3.24));
        finish();
        // An outfit picked while these geese were loading (#472): seat it now.
        const want = this._pendingGooseRiders || getGooseRiderPaths();
        this._pendingGooseRiders = null;
        if (want && (want.Captain !== riderPaths.Captain || want.Stoker !== riderPaths.Stoker)) this.setGooseRiders(want);
      });
    }, undefined, (err) => {
      console.error('Failed to load bike model:', this._modelPath, err);
    });
  }

  /**
   * Wire the two exported rider-lean clips for independent scrubbing. Each clip
   * is a MONOTONIC sweep (frame 1 = full lean one way, last = full lean the
   * other): CaptainLean moves only the captain's spine/chest (his arm IK baked
   * so gloves stay on the bars); StokerLean only the stoker's. We don't play
   * them — each frame we scrub each to the time matching THAT rider's own lean.
   *
   * The exporter samples every bone into both clips (constant for the still
   * rider), so the raw clips would fight over shared bones. We strip each clip
   * down to just its rider's bones (M_* / F_*) so the two play together without
   * interfering; the Bike_* bones stay in neither, so the frame keeps its bind
   * pose and the whole-bike tilt is left to _applyTransform (this.lean).
   */
  _setupRiderLean(model, animations) {
    this.riderMixer = new THREE.AnimationMixer(model);
    const byName = (n) => animations.find(c => c.name === n);
    const cap = byName('CaptainLean') || animations[0];
    const sto = byName('StokerLean') || animations[1];
    if (cap) {
      this._keepTracksWithPrefix(cap, 'M_');
      this.riderClipDuration = cap.duration;
      this.captainAction = this._makeScrubAction(cap);
    }
    if (sto) {
      this._keepTracksWithPrefix(sto, 'F_');
      this.riderClipDuration = this.riderClipDuration || sto.duration;
      this.stokerAction = this._makeScrubAction(sto);
    }
  }

  // Drop every track whose target bone isn't this rider's, so two clips that
  // were each sampled over the full skeleton no longer collide.
  _keepTracksWithPrefix(clip, prefix) {
    clip.tracks = clip.tracks.filter(t => t.name.startsWith(prefix));
  }

  _makeScrubAction(clip) {
    const action = this.riderMixer.clipAction(clip);
    action.play();
    action.paused = true; // we drive .time ourselves, never let it advance
    return action;
  }

  /**
   * Scrub each rider's lean clip to that rider's own input. _captainLeanTarget /
   * _stokerLeanTarget are the two gyro/lean inputs in [-1, 1] (set from
   * balanceResult in update()); the bike's own tilt still comes from this.lean
   * (the aggregate) in _applyTransform. Map [-1, 1] -> the monotonic clip
   * [0, duration].
   */
  _updateRiderLean(dt) {
    if (!this.riderMixer && !this.goose) return;
    // Light smoothing so wobble/danger-shake doesn't make the riders twitch.
    const k = Math.min(1, 12 * (dt || 1 / 60));
    this._captainLeanNorm += (this._captainLeanTarget - this._captainLeanNorm) * k;
    this._stokerLeanNorm += (this._stokerLeanTarget - this._stokerLeanNorm) * k;
    if (this.goose) {
      // Each goose by its own rider's lean; + = the rider's right, the same sign as
      // this.lean (the bike's tilt), so a rider leans into the side the bike tilts.
      this.goose.setLeans(this._captainLeanNorm, this._stokerLeanNorm);
      this.goose.setDistance(this.distanceTraveled);
      this.goose.setCrank(this._crankDisplay);
      this.goose.update();
      return;
    }
    // Map [-1, 1] -> the monotonic clip [0, duration], NEGATED so the riders
    // lean into the same side the bike tilts. (After the model's RIDER_MODEL_YAW,
    // the baked torso roll composes with the group's Z-tilt such that matching
    // signs read as opposite in the full scene, so we flip here.)
    if (this.captainAction) {
      this.captainAction.time = (0.5 - this._captainLeanNorm * 0.5) * this.riderClipDuration;
    }
    if (this.stokerAction) {
      this.stokerAction.time = (0.5 - this._stokerLeanNorm * 0.5) * this.riderClipDuration;
    }
    this.riderMixer.update(0); // apply the posed times without advancing them
  }

  /**
   * Set this frame's rider lean inputs (each in [-1, 1]). Call before/within
   * update(). captain = the captain's own lean, stoker = the stoker's own lean.
   * In solo play pass the single lean for both so the pair sways together.
   */
  /**
   * Goose Outfits: seat another pair of geese on the goose tandem (no-op on the other models,
   * or when the pair is already riding). The bike, its physics and every reference stay.
   * @param {{Captain: string, Stoker: string}} paths
   * @param {boolean} [disposeOld] false while live versus clones share the current geese
   * @returns {Promise|undefined} settles once the new geese are seated
   */
  setGooseRiders(paths, disposeOld = true) {
    // Still loading the first geese: remember the choice; the load seats it.
    if (!this.goose) { this._pendingGooseRiders = paths; return; }
    const cur = this._gooseRiderPaths;
    if (cur && cur.Captain === paths.Captain && cur.Stoker === paths.Stoker) return;
    this._gooseRiderPaths = paths;
    const goose = this.goose;
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDracoLoader());
    this._gooseSwap = goose.swapRiders(loader, paths, disposeOld && !this._sharedGeometry).then(() => {
      if (this.goose !== goose) return; // the bike model was swapped meanwhile
      this.setSoloRider(this._soloRider);
      this.applyGooseColours();
      this._applyEnvMap();
    }).catch((err) => console.warn('Goose outfit failed to load; keeping the current geese:', err));
    return this._gooseSwap;
  }

  /** Goose Colours: the saved colourway of the current outfit pair on both geese (goose tandem only). */
  applyGooseColours() {
    if (!this.goose) return;
    const outfit = getGooseOutfit();
    const params = colourwayParams(outfit, getGooseColourway(outfit));
    for (const [seat, r] of Object.entries(this.goose.riders)) applyColourway(r.root, params[seat] || {});
  }

  /** Show Solo: true shows only the captain goose (goose tandem only; kept until the geese load). */
  setSoloRider(on) {
    this._soloRider = !!on;
    const st = this.goose && this.goose.riders.Stoker;
    if (st && st.root.visible === this._soloRider) st.root.visible = !this._soloRider;
  }

  setRiderLeans(captain, stoker) {
    this._captainLeanTarget = Math.max(-1, Math.min(1, captain));
    this._stokerLeanTarget = Math.max(-1, Math.min(1, stoker));
  }

  applyPreset(presetData) {
    if (!this.modelLoaded) {
      this._pendingPreset = presetData;
      return;
    }

    const model = this.group.children[0];
    if (!model) return;

    // The bike's own meshes only: the goose riders sit in the model (on the seat sockets) but keep their
    // materials -- cloning them dropped the Goose Colours shader hook (and the presets don't style the geese)
    const bikeMeshes = (fn) => {
      const walk = (o) => {
        if (o.userData && o.userData.gooseSeat) return;
        if (o.isMesh && !(o.userData && o.userData.bikeBatch)) fn(o);
        for (const c of o.children) walk(c);
      };
      walk(model);
    };

    // Store originals on first call
    if (!this._originalMats) {
      this._originalMats = new Map();
      bikeMeshes(child => this._originalMats.set(child.name, child.material.clone()));
    }

    // Reset all materials to original (dispose old material to prevent leak)
    bikeMeshes(child => {
      const orig = this._originalMats.get(child.name);
      if (orig) {
        if (child.material && child.material !== orig) child.material.dispose();
        child.material = orig.clone();
        if (this.spokeMeshes.includes(child)) {
          child.material.transparent = true;
        }
      }
    });

    if (!presetData) { this._rebatch(); return; } // null = default, just reset

    // Apply preset overrides
    bikeMeshes(child => {
      const entry = presetData[child.name];
      if (!entry) return;
      const mat = child.material;
      if (entry.color && mat.color) mat.color.set(entry.color);
      if (entry.emissive && mat.emissive) mat.emissive.set(entry.emissive);
      if (entry.metalness !== undefined) mat.metalness = entry.metalness;
      if (entry.roughness !== undefined) mat.roughness = entry.roughness;
      if (entry.opacity !== undefined) {
        mat.opacity = entry.opacity;
        mat.transparent = entry.opacity < 1;
      }
      if (entry.wireframe !== undefined) mat.wireframe = entry.wireframe;
      if (entry.side !== undefined) mat.side = entry.side;
      if (entry.disabledTextures) {
        for (const tk of entry.disabledTextures) mat[tk] = null;
        mat.needsUpdate = true;
      }
      if (this.spokeMeshes.includes(child)) {
        mat.transparent = true;
      }
    });
    this._rebatch();
  }

  /**
   * #395 · draw the goose tandem's frame as a few merged meshes instead of
   * 69 (see bike-batch.js). Re-run whenever the frame's materials change.
   * #456 · the plain bike too (65 meshes): its pedals turn by themselves, so
   * they count as bones. The fused riders model is left alone.
   */
  _rebatch() {
    if (!this.modelLoaded || this.riderMixer) return;
    const model = this.group.children[0];
    if (!model) return;
    this.batchStats = rebatch(model, { keep: this.spokeMeshes, movers: this.pedalNodes, batchId: this._batchId });
    this._applyEnvMap();
  }

  /**
   * #456 · lean riders lighting: the environment reflections go on this bike's
   * own materials (frame + geese) instead of the whole scene. null takes them
   * off again. Re-applied after anything that replaces materials (presets,
   * a new model, new geese).
   * @param {THREE.Texture|null} tex  marked userData.riderEnv, so a geese swap never disposes it
   */
  setEnvMap(tex) {
    this._envMap = tex || null;
    this._applyEnvMap();
  }

  _applyEnvMap() {
    if (!this._envMap && !this._envApplied) return;   // never set: leave shared materials alone
    const tex = this._envMap;
    this.group.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !m.isMeshStandardMaterial) continue;
        const ours = !m.envMap || (m.envMap.userData && m.envMap.userData.riderEnv);
        if (ours && m.envMap !== tex) m.envMap = tex;
      }
    });
    this._envApplied = !!tex;
  }

  update(pedalResult, balanceResult, dt, safetyMode, autoSpeed) {
    this.crankAngle = pedalResult.crankAngle;

    // Rider torso lean. Each rider leans by their OWN input when the caller
    // provides it (coop: captainLean / stokerLean on balanceResult); otherwise
    // both sway with the single aggregate lean (solo). The bike's tilt itself is
    // unaffected — that still comes from this.lean in _applyTransform.
    if (this.riderMixer || this.goose) {
      // Coop provides each rider's own lean; solo provides only the aggregate
      // leanInput, in which case the captain leans with it and the stoker (who
      // has no second input in solo) stays upright.
      // visualLean: the rider's own tilt before the steering gain, so the look
      // matches the player's body even when the steering is gentler.
      const cap = (balanceResult.captainLean != null) ? balanceResult.captainLean
        : (balanceResult.visualLean != null ? balanceResult.visualLean : balanceResult.leanInput);
      const sto = (balanceResult.stokerLean != null) ? balanceResult.stokerLean : 0;
      this.setRiderLeans(cap, sto);
    }

    if (this.fallen) {
      this.fallTimer -= dt;
      this.fallElapsed = (this.fallElapsed || 0) + dt;
      // B-2 · the tumble: ease over to the fallen side in 0.4 s with a small
      // bounce at the end, instead of snapping flat on the impact frame.
      // #483: from the lean it crashed at, not from upright (crash-tumble.js).
      this.lean = fallLean(this._fallLeanStart || 0, this._fallLeanTarget || 0, this.fallElapsed);
      if (this.fallTimer <= 0) this._reset();
      else if (this.crashScene) this.crashScene.step(dt);   // #484: rag dolls + hats + the bike
      this._applyTransform(dt);
      return;
    }

    // Auto-speed
    if (autoSpeed && !pedalResult.braking) {
      const cruiseSpeed = 3.0;
      if (this.speed < cruiseSpeed) {
        this.speed += 2.0 * dt;
      }
    }

    // Braking
    this._braking = pedalResult.braking;
    if (pedalResult.braking) {
      this.speed *= (1 - 2.5 * dt);
      if (this.speed < 0.05) this.speed = 0;
      this._pendingAccel = 0;
    }

    // Acceleration, eased in (#441). Same total per stroke, about 95% of it
    // within 0.3 s, and the first frame still gets a share so a press is felt.
    this._pendingAccel += pedalResult.acceleration || 0;
    const accelNow = this._pendingAccel * Math.min(1, dt / ACCEL_EASE_S);
    this._pendingAccel -= accelNow;
    if (this._pendingAccel < 1e-4) this._pendingAccel = 0;
    this.speed += accelNow;

    // Collectible speed boost
    if (this.boostTimer > 0) {
      this.boostTimer -= dt;
      this.speed += 4.0 * dt; // sustained push
    }

    // Center-strip bonus: compacted dirt in the middle 20% of road is faster.
    // B-4: this has always been here and has never been visible, so nobody has
    // ever chosen to ride the middle. `onCenterStrip` lets the HUD say so.
    const centerDist = Math.abs(this._lateralOffset);
    this.onCenterStrip = centerDist < 0.5 && this.speed > 0.5;

    if (this.coast) {
      // Slingshot: rolling + air drag, with the rolling part set by the surface.
      this.speed = Math.max(0, this.speed - this.coast.decel(this.speed, centerDist, !!this.air) * dt);
    } else {
      // Friction — reduced at low speeds so startup isn't brutally hard
      const frictionBase = 0.6;
      const frictionMin = 0.15;
      const frictionRamp = Math.min(1, this.speed / 4); // full friction at ~4 m/s (~14 km/h)
      this.speed *= (1 - (frictionMin + (frictionBase - frictionMin) * frictionRamp) * dt);
    }

    if (this.onCenterStrip && !this.coast) {
      this.speed *= (1 + 0.3 * (1 - centerDist / 0.5) * dt); // gentle boost
    }

    // Road-edge drag: drifting toward the edges of the dirt path slows you
    if (!this.coast && centerDist > 0.5 && centerDist <= 2.5 && this.speed > 0) {
      const edgeFrac = (centerDist - 0.5) / 2.0; // 0→1 across road width
      this.speed *= (1 - edgeFrac * 0.8 * dt);    // moderate drag near edges
    }

    // Grass drag: off-road surface slows you down significantly
    const offRoadDrag = Math.max(0, centerDist - 2.5);
    if (!this.coast && offRoadDrag > 0 && this.speed > 0) {
      const dragIntensity = Math.min(offRoadDrag / 3, 1); // 0→1 over 3 units
      this.speed *= (1 - dragIntensity * 1.5 * dt);       // strong off-road friction
    }

    this.maxSpeed = (this.coast && this.coast.maxSpeed) || TUNE.maxSpeed || 16;
    this.speed = Math.max(0, Math.min(this.speed, this.maxSpeed));

    // Balance physics (portrait-tuned: softer response, more damping)
    const gravity = Math.sin(this.lean) * TUNE.gravityForce;
    const playerLean = balanceResult.leanInput * TUNE.leanForce;
    const gyro = -this.lean * Math.min(this.speed * 0.8, 6.0);
    const damping = -this.leanVelocity * TUNE.damping;

    const t = performance.now() / 1000;
    const wobbleMul = TUNE.wobbleMultiplier != null ? TUNE.wobbleMultiplier : 1.0;
    const pedalWobble = pedalResult.wobble * (Math.random() - 0.5) * 2 * wobbleMul;
    const lowSpeedWobble = Math.max(0, 1 - this.speed * 0.3) *
      (Math.sin(t * 2.7) * 0.3 + Math.sin(t * 4.3) * 0.15) * wobbleMul;

    let pedalLeanKick = 0;
    if (pedalResult.acceleration > 0 && !pedalResult.braking) {
      const kickScale = TUNE.pedalLeanKickScale != null ? TUNE.pedalLeanKickScale : 1.0;
      pedalLeanKick = (Math.random() - 0.5) * 0.2 * kickScale;
    }

    // Danger-zone wobble: progressive shake as lean approaches crash
    let dangerWobble = 0;
    const crashThreshold = TUNE.crashThreshold || 1.35;
    const dangerOnset = TUNE.dangerOnset || 0.55;
    const dangerRatio = Math.abs(this.lean) / crashThreshold;
    if (dangerRatio > dangerOnset) {
      const intensity = (dangerRatio - dangerOnset) / (1 - dangerOnset); // 0→1 from onset to crash
      dangerWobble = intensity * (Math.sin(t * 11) * 0.4 + Math.sin(t * 17) * 0.25);
    }

    // A-5 · the edge band. On the presets that cannot fall (tutorial, chill —
    // and on any preset while SAFETY is on) the lean is clamped at ±1.0, so
    // the danger wobble above never fires and the rider never learns that an
    // edge exists. Past 0.8 the bike shivers at 30% amplitude: you can feel
    // the limit without ever being punished by it.
    if (safetyMode && Math.abs(this.lean) > EDGE_BAND_START) {
      const edge = Math.min(1, (Math.abs(this.lean) - EDGE_BAND_START) / (1.0 - EDGE_BAND_START));
      dangerWobble += edge * 0.3 * (Math.sin(t * 11) * 0.4 + Math.sin(t * 17) * 0.25);
      this._edgeIntensity = edge;
    } else {
      this._edgeIntensity = 0;
    }

    // Grass wobble: rough terrain when off-road (scaled by wobbleMultiplier)
    let grassWobble = 0;
    const offRoad = Math.max(0, Math.abs(this._lateralOffset) - 2.5);
    if (offRoad > 0 && this.speed > 0.1 && wobbleMul > 0) {
      const grassIntensity = Math.min(offRoad / 3, 1); // ramps up over 3 units off-road
      grassWobble = grassIntensity * this.speed * 0.15 * wobbleMul *
        (Math.sin(t * 13.7) * 0.5 + Math.sin(t * 23.1) * 0.3 + (Math.random() - 0.5) * 0.4);
    }

    // E-2 · cobbles. A rough surface shakes the bike and scrubs speed, so the
    // stretch is something you ride differently rather than a number that
    // changes out of sight. `_roughness` is 0..1, set by the disruption path.
    let cobbleShake = 0;
    if (this._roughness > 0) {
      cobbleShake = this._roughness * COBBLES_SHAKE *
        // A low lurch under a fast rattle. A purely high-frequency force is
        // swallowed by the damping term and moves the bike barely a degree.
        (Math.sin(t * 9.1) * 0.6 + Math.sin(t * 31.3) * 0.3 + (Math.random() - 0.5) * 0.7);
      this.speed *= (1 - COBBLES_DRAG * this._roughness * dt);
    }

    this.leanVelocity += (gravity + playerLean + gyro + damping +
      pedalWobble + lowSpeedWobble + pedalLeanKick + dangerWobble + grassWobble +
      cobbleShake) * dt;
    this.lean += this.leanVelocity * dt;

    // Balance assist: proportional restoring force toward upright
    if (this._balanceAssist > 0 && Math.abs(this.lean) > 0.3) {
      this.leanVelocity -= this.lean * this._balanceAssist * 3.0 * dt;
    }

    // Auto-correction (Chill/Tutorial mode): configurable return-to-center force
    if (TUNE.autoCorrection && Math.abs(this.lean) > 0.3) {
      const strength = TUNE.autoCorrectionStrength || 3.0;
      this.leanVelocity -= this.lean * strength * dt;
    }

    // Gyro centering: when controller is centered but bike is leaned, pull upright
    if (balanceResult.gyroActive && Math.abs(balanceResult.leanInput) < 0.15) {
      this.leanVelocity -= this.lean * 5.0 * dt;
    }

    // Safety mode
    if (safetyMode) {
      this.lean = Math.max(-1.0, Math.min(1.0, this.lean));
    }

    // Steering from lean
    const turnRate = -this.lean * this.speed * TUNE.turnRate;
    this.heading += turnRate * dt;

    // Slope physics — uphill decelerates, downhill accelerates
    // Reduced at low speeds so hills don't stall startup
    if (this.roadPath && this.speed > 0.01) {
      const slope = this.roadPath.getSlopeAtDistance(this.roadD);
      const slopeRamp = Math.min(1, this.speed / 4);
      this.speed -= slope * 9.8 * dt * 0.3 * slopeRamp;
      this.speed = Math.max(0, Math.min(this.speed, this.maxSpeed));
    }

    // Position
    this.position.x += Math.sin(this.heading) * this.speed * dt;
    this.position.z += Math.cos(this.heading) * this.speed * dt;

    // Track road distance (smoothed, wrap-aware) and set terrain height
    if (this.roadPath) {
      const info = this.roadPath.getClosestRoadInfo(this.position.x, this.position.z, this.roadD);
      if (info) {
        const prevRoadD = this.roadD;
        let diff = info.d - this.roadD;
        const L = this.roadPath.loopLength;
        if (diff > L / 2) diff -= L;
        if (diff < -L / 2) diff += L;
        this.roadD += diff * Math.min(1, 15 * dt);
        this.roadD = ((this.roadD % L) + L) % L;

        // Update distanceTraveled from road progress, not path length.
        // Going sideways or in circles doesn't count; going backward subtracts.
        let roadDelta = this.roadD - prevRoadD;
        if (roadDelta > L / 2) roadDelta -= L;
        if (roadDelta < -L / 2) roadDelta += L;
        this.distanceTraveled = Math.max(0, this.distanceTraveled + roadDelta);

        this._lateralOffset = info.lateralOffset;

        // Per-wheel lateral offsets — approximate from road center at ±2m along road
        // Uses cheap getPointAtDistance instead of full getClosestRoadInfo search
        const sinH = Math.sin(this.heading);
        const cosH = Math.cos(this.heading);
        const frontPt = this.roadPath.getPointAtDistance(this.roadD + 2);
        const frontDx = (this.position.x + sinH * 2.0) - frontPt.x;
        const frontDz = (this.position.z + cosH * 2.0) - frontPt.z;
        const frontRightX = Math.cos(frontPt.heading);
        const frontRightZ = -Math.sin(frontPt.heading);
        this._frontWheelOffset = frontDx * frontRightX + frontDz * frontRightZ;

        const rearPt = this.roadPath.getPointAtDistance(this.roadD - 2);
        const rearDx = (this.position.x - sinH * 2.0) - rearPt.x;
        const rearDz = (this.position.z - cosH * 2.0) - rearPt.z;
        const rearRightX = Math.cos(rearPt.heading);
        const rearRightZ = -Math.sin(rearPt.heading);
        this._rearWheelOffset = rearDx * rearRightX + rearDz * rearRightZ;

        this.position.y = this.roadPath.getPointAtDistance(this.roadD).y;
        if (this.air) {
          this.air.vy -= 9.8 * dt;
          this.air.h += this.air.vy * dt;
          this.air.t += dt;
          if (this.air.h <= 0) {                 // touchdown
            this.lastAirTime = this.air.t;
            this.air = null;
          } else {
            this.position.y += this.air.h;
          }
        }
      }
    }

    // Fall detection
    if (!this.air && Math.abs(this.lean) > (TUNE.crashThreshold || 1.35)) {
      this._fall();
    }

    // Spoke fade (asymmetric: 8x out, 1.2x in)
    if (this.spokeMeshes.length > 0) {
      const targetFade = Math.min(this.speed / (this.maxSpeed * 0.2), 1);
      const rate = targetFade > this.smoothSpokeFade ? 8 : 1.2;
      this.smoothSpokeFade += (targetFade - this.smoothSpokeFade) * Math.min(1, rate * dt);
      const opacity = Math.round((1 - this.smoothSpokeFade) * 100) / 100;
      if (opacity !== this._prevSpokeOpacity) {
        this._prevSpokeOpacity = opacity;
        for (const spoke of this.spokeMeshes) {
          spoke.material.opacity = opacity;
          spoke.visible = opacity > 0.02;
        }
      }
    }

    this._updateCrank(dt);

    this._applyTransform(dt);
  }

  // Apply remote state from network (stoker-side, no physics)
  applyRemoteState(state) {
    this.position.set(state.x, state.y, state.z);
    this.heading = state.heading;
    this.lean = state.lean;
    this.leanVelocity = state.leanVelocity;
    this.speed = state.speed;
    this.distanceTraveled = state.distanceTraveled;
    this.crankAngle = state.crankAngle || 0;
    this.fallen = !!(state.flags & 1);
    this._braking = !!(state.flags & 2);

    // Use captain's authoritative roadD (smoothed, wrap-aware, with snap for large jumps)
    if (state.roadD !== undefined) {
      let diff = state.roadD - this.roadD;
      const L = this.roadPath ? this.roadPath.loopLength : 0;
      if (L) {
        if (diff > L / 2) diff -= L;
        if (diff < -L / 2) diff += L;
      }
      if (Math.abs(diff) > 10) {
        this.roadD = state.roadD;
      } else {
        this.roadD += diff * Math.min(1, 15 * (1 / 60));
      }
      if (L) {
        this.roadD = ((this.roadD % L) + L) % L;
      }
    }

    // Compute lateral offsets for particles (stoker-side)
    if (this.roadPath) {
      const info = this.roadPath.getClosestRoadInfo(this.position.x, this.position.z, this.roadD);
      if (info) {
        this._lateralOffset = info.lateralOffset;
        this.onCenterStrip = Math.abs(info.lateralOffset) < 0.5 && this.speed > 0.5;   // same rule as update()
        const sinH = Math.sin(this.heading);
        const cosH = Math.cos(this.heading);
        const frontPt = this.roadPath.getPointAtDistance(this.roadD + 2);
        const frontDx = (this.position.x + sinH * 2.0) - frontPt.x;
        const frontDz = (this.position.z + cosH * 2.0) - frontPt.z;
        this._frontWheelOffset = frontDx * Math.cos(frontPt.heading) + frontDz * -Math.sin(frontPt.heading);
        const rearPt = this.roadPath.getPointAtDistance(this.roadD - 2);
        const rearDx = (this.position.x - sinH * 2.0) - rearPt.x;
        const rearDz = (this.position.z - cosH * 2.0) - rearPt.z;
        this._rearWheelOffset = rearDx * Math.cos(rearPt.heading) + rearDz * -Math.sin(rearPt.heading);
      }
    }

    // Spoke fade
    if (this.spokeMeshes.length > 0) {
      const targetFade = Math.min(this.speed / (this.maxSpeed * 0.2), 1);
      const dt = 1 / 60;
      const rate = targetFade > this.smoothSpokeFade ? 8 : 1.2;
      this.smoothSpokeFade += (targetFade - this.smoothSpokeFade) * Math.min(1, rate * dt);
      const opacity = Math.round((1 - this.smoothSpokeFade) * 100) / 100;
      if (opacity !== this._prevSpokeOpacity) {
        this._prevSpokeOpacity = opacity;
        for (const spoke of this.spokeMeshes) {
          spoke.material.opacity = opacity;
          spoke.visible = opacity > 0.02;
        }
      }
    }

    this._updateCrank(1 / 60);

    this._applyTransform(1 / 60);
  }

  // A-3 · drive the visible cranks from crankAngle, not from speed.
  _updateCrank(dt) {
    if ((!this.pedalNodes || this.pedalNodes.length === 0) && !this.goose) return;
    const now = performance.now() / 1000;
    this._crankDisplay = this._crankMotion.update(this.crankAngle, dt, now);

    for (const node of this.pedalNodes) {
      if (node.userData._crankBase === undefined) node.userData._crankBase = node.rotation.z;
      node.rotation.z = node.userData._crankBase + this._crankDisplay;
    }
  }

  _applyTransform(dt) {
    // Something else owns the group's transform this frame (the crash tumble).
    // The riders still get posed — freezing them mid-sway looks like a dropped
    // frame, not a crash.
    if (this.transformOverride) {
      this._updateRiderLean(dt);
      return;
    }
    this.group.position.copy(this.position);
    this._tmpQYaw.setFromAxisAngle(this._tmpAxisY, this.heading);
    this._tmpQLean.setFromAxisAngle(this._tmpAxisZ, this.lean);

    // Pitch from road slope (smoothed)
    if (this.roadPath) {
      const slope = this.roadPath.getSlopeAtDistance(this.roadD);
      const targetPitch = -Math.atan(slope);
      const t = dt ? Math.min(1, 20 * dt) : 1;
      this._smoothPitch += (targetPitch - this._smoothPitch) * t;
      this._tmpQPitch.setFromAxisAngle(this._tmpAxisX, this._smoothPitch);
    } else {
      this._tmpQPitch.identity();
    }

    this._tmpQ.multiplyQuaternions(this._tmpQYaw, this._tmpQPitch);
    this._tmpQ.multiply(this._tmpQLean);
    this.group.quaternion.copy(this._tmpQ);

    // Sway the riders to match the balance (no-op on the rider-less frame GLB).
    this._updateRiderLean(dt);
  }

  // B-2 · how long the bike lies on its side. A crash should read as a beat in
  // the ride, not an interruption of it: 2.0 s of lying still (then a modal, then
  // a 3 s countdown) was 6-9 s of dead air for one mistake.
  _fall() {
    // Before the canned pose lands — the listener needs the speed and lean the
    // bike actually crashed at, and the next four lines destroy both.
    if (this.onFall) this.onFall(this);
    this.fallen = true;
    // #484: a slow-mo crash scene asks for longer, in simulated seconds (crash-slowmo.js)
    this.fallTimer = this._crashDownSim || 1.2;
    this._crashDownSim = 0;
    this.fallElapsed = 0;
    this.speed = 0;
    this._fallLeanStart = this.lean || 0;
    this._fallLeanTarget = Math.sign(this.lean || 1) * Math.PI / 2.2;
    this.leanVelocity = 0;
    const terrainY = this.roadPath
      ? this.roadPath.getHeightAtWorld(this.position.x, this.position.z, this.roadD)
      : 0;
    this.position.y = terrainY - 0.15;
  }

  /** Leave the ground at vertical speed vy (m/s). */
  launchAir(vy) {
    this.air = { vy, h: 0.01, t: 0 };
    this.lastAirTime = 0;
  }

  _reset() {
    this._pendingAccel = 0;   // #441 · a crash drops any stroke still easing in
    this.air = null;
    // Hand the visual group back before restoring the upright pose, or the
    // tumble keeps driving it and the reset is invisible.
    if (this.onReset) this.onReset(this);
    this.fallen = false;
    this._crashCause = null;
    this._slowMoStart = 0;
    this.lean = 0;
    this.leanVelocity = 0;
    this.speed = 0;
    const terrainY = this.roadPath
      ? this.roadPath.getHeightAtWorld(this.position.x, this.position.z, this.roadD)
      : 0;
    this.position.y = terrainY;
  }

  fullReset() {
    this.resetToDistance(0);
  }

  resetToDistance(distance) {
    this._pendingAccel = 0;
    this.air = null;
    if (this.onReset) this.onReset(this);
    this.fallen = false;
    this._crashCause = null;
    this._slowMoStart = 0;
    this.lean = 0;
    this.leanVelocity = 0;
    this.speed = 0;
    this._smoothPitch = 0;

    const roadD = this.roadPath ? (distance % this.roadPath.loopLength) : 0;
    this.roadD = roadD;

    if (this.roadPath) {
      const pt = this.roadPath.getPointAtDistance(roadD);
      this.position.set(pt.x, pt.y, pt.z);
      this.heading = pt.heading;
    } else {
      this.position.set(0, 0, 0);
      // #400: a Map Tourist route faces its destination from the first reset.
      this.heading = this.startHeading || 0;
    }

    this.distanceTraveled = distance;
    this.crankAngle = 0;
    this.smoothSpokeFade = 0;
    for (const spoke of this.spokeMeshes) {
      spoke.material.opacity = 1;
      spoke.visible = true;
    }
    this._applyTransform();
  }
}
