// ============================================================
// SPECIAL BIKES — reward bikes that replace the whole model, not just its paint (#611)
// ============================================================
//
// The bike chooser cycles paint presets on the one goose tandem. A special bike is its own GLB
// built on the SAME rig (claude-3d make_time_warp.py on bike_rigged_goosefit26), so every goose
// rider, socket and Pedal / WheelSpin clip fits it unchanged.
//   time_warp  Pete's steampunk time-travel tandem: four rockets, a fast clock, blue flames with
//              orange pops (its TimeWarpFX clip). Unlocks at any 90 of the 95 non-calendar
//              achievements (js/rewards.js timeWarpProgress).
// It rides only with Show Riders on: the plain frame model (riders off) has no rig to swap onto.
// Versus keeps the paint presets (the team colours), so it rides the goose tandem.

import { BIKE_MODEL_PATH, GOOSE_BIKE_MODEL_PATH, CHOOSER_MODEL_PATH } from './config.js';

export const TIME_WARP_BIKE_KEY = 'time_warp';
export const TIME_WARP_BIKE_MODEL_PATH = 'tandem-3d/goose/time_warp_tandem.glb';

/** Chooser keys of the special bikes, in carousel order (after the paint presets). */
export const SPECIAL_BIKE_KEYS = Object.freeze([TIME_WARP_BIKE_KEY]);

export function isSpecialBike(key) { return SPECIAL_BIKE_KEYS.includes(key); }

/**
 * The GLB the ride loads for a chooser pick.
 * @param {boolean} showRiders  the Show Riders setting
 * @param {string|null} bikeKey the chooser's selectedPresetKey
 * @param {string} [ridersPath] BIKE_MODEL_PATH (the goose tandem, or ?riders=fused)
 */
export function bikeModelPathFor(showRiders, bikeKey, ridersPath = BIKE_MODEL_PATH) {
  if (!showRiders) return CHOOSER_MODEL_PATH;
  if (bikeKey === TIME_WARP_BIKE_KEY && ridersPath === GOOSE_BIKE_MODEL_PATH) return TIME_WARP_BIKE_MODEL_PATH;
  return ridersPath;
}

/** Is this the goose tandem or a special bike on its rig (sized like the tandem, see bike-model.js)? */
export function isRigTwin(modelPath) { return modelPath === TIME_WARP_BIKE_MODEL_PATH; }
