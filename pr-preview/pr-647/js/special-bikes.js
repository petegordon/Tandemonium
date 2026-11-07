// ============================================================
// SPECIAL BIKES — reward bikes that replace the whole model, not just its paint (#611)
// ============================================================
//
// The bike chooser cycles paint presets on the one goose tandem. A special bike is its own GLB
// built on the SAME rig (claude-3d make_time_warp.py on bike_rigged_goosefit26), so every goose
// rider, socket and Pedal / WheelSpin clip fits it unchanged.
//   solo_flight  the Penny-Farthing tandem (claude-3d make_pf_tandem.py), the player-bots reward: any 80
//                of the 81 solo achievements (rewards.js playerBotsProgress). In the chooser only for now:
//                a locked silhouette, and "coming soon" once earned. Riding it (its own rig, Pedal_PF clips,
//                the Canada Goose bot on the back) is #644.
//   time_warp    Pete's steampunk time-travel tandem: four rockets, a fast clock, blue flames with
//                orange pops (its TimeWarpFX clip). Unlocks at any 90 of the 95 non-calendar
//                achievements (rewards.js timeWarpProgress).
// It rides only with Show Riders on: the plain frame model (riders off) has no rig to swap onto.
// Versus keeps the paint presets (the team colours), so it rides the goose tandem.

import { BIKE_MODEL_PATH, GOOSE_BIKE_MODEL_PATH, CHOOSER_MODEL_PATH } from './config.js';

export const TIME_WARP_BIKE_KEY = 'time_warp';
export const TIME_WARP_BIKE_MODEL_PATH = 'tandem-3d/goose/time_warp_tandem.glb';
export const SOLO_FLIGHT_BIKE_KEY = 'solo_flight';
export const SOLO_FLIGHT_BIKE_MODEL_PATH = 'tandem-3d/goose/solo_flight_tandem.glb';

/**
 * The special bikes, in carousel order (after the paint presets): the reward ladder (#611).
 *   reward    rewards.js rewardProgress key      unit      what the "n of N" counts
 *   rideable  false = shown in the chooser, not ridden yet ("coming soon" once earned)
 *   fx        the bike's own looping clip, if any
 */
export const SPECIAL_BIKES = Object.freeze({
  [SOLO_FLIGHT_BIKE_KEY]: Object.freeze({ name: 'Solo Flight', model: SOLO_FLIGHT_BIKE_MODEL_PATH, reward: 'playerBots',
    unit: 'solo achievements', rideable: false, icon: '\uD83E\uDEB6', color: '#9fd8ff', fx: null }),
  [TIME_WARP_BIKE_KEY]: Object.freeze({ name: 'Time Warp', model: TIME_WARP_BIKE_MODEL_PATH, reward: 'timeWarp',
    unit: 'achievements', rideable: true, icon: '\u23F3', color: '#f0b860', fx: 'TimeWarpFX' }),
});

/** Chooser keys of the special bikes, in carousel order. */
export const SPECIAL_BIKE_KEYS = Object.freeze(Object.keys(SPECIAL_BIKES));

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
