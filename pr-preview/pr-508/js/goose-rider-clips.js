// ============================================================
// GOOSE RIDER CLIPS — the clip contract of the goose riders (pure, no three.js)
// ============================================================
//
// The goose tandem (tandem-3d/goose/, built in petegordon/tandemonium-claude-3d):
//   goose_tandem.glb   rigged bike: clips Pedal (one crank turn) + WheelSpin (one wheel turn),
//                      socket bones Seat_Captain / Seat_Stoker (identity rotation in bike space)
//   goose_captain.glb  male goose, goose_stoker.glb  female goose; each carries, per seat:
//     Pedal_<seat>               one crank turn, time = crank angle / 2pi (same crank as the bike's
//                                Pedal clip; the stoker's half turn is in the bike, D15) -> legs + cloth chains
//     Ride_<seat>                seated upper body, hands on the grips
//     Lean_L_<seat> / Lean_R_<seat>  torso rolled to the rider's left / right, hands still on the grips
//
// Each goose leans by ITS OWN rider's input (captainLean / stokerLean), exactly like the old fused
// riders model; the bike tilts by the aggregate this.lean as before. The glTF exporter samples every
// bone into every clip, so each clip is cut down to the bones it owns before it is played -- the bike's
// two clips too: uncut, WheelSpin's resting cranks averaged with Pedal and the cranks turned half as far
// as the geese's legs.

export const SEATS = ['Captain', 'Stoker'];

// Hip joints sit this far above the saddle-top socket (ride_fit.py HIP_UP), in bike metres.
// #505: 0.11 (a human's) -> 0.03: the saddles came up 8 cm in the frame spec while the geese stayed
// where the clips were baked, so the seat sits up by the hips and disappears into the breeches.
export const HIP_UP = 0.03;

const UPPER = new Set(['Spine', 'Spine1', 'Spine2', 'Neck', 'Neck1', 'Neck2', 'Neck3', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']);
const LOWER_RE = /^(Left|Right)(UpLeg|Leg|Foot|ToeBase)$|^Cloth_/;
const CRANK_RE = /^(Crank|Pedal)_/;      // the bike's Pedal clip: cranks + pedals (+ their PedalPin sockets ride along)
const WHEEL_RE = /^Wheel_/;

/** Bone (node) name a three.js track targets: "LeftLeg.quaternion" -> "LeftLeg". */
export function trackBone(trackName) {
  const i = trackName.lastIndexOf('.');
  return i < 0 ? trackName : trackName.slice(0, i);
}

/** Upper-body bones: driven by Ride / Lean. */
export function isUpperBone(name) { return UPPER.has(name); }

/** Lower-body bones + cloth chains: driven by Pedal (cloth scale = the stoker's riding hem). */
export function isLowerBone(name) { return LOWER_RE.test(name); }

/** The bike's crank / pedal bones (its Pedal clip) and wheel bones (its WheelSpin clip). */
export function isCrankBone(name) { return CRANK_RE.test(name); }
export function isWheelBone(name) { return WHEEL_RE.test(name); }

/** Which bones a clip may drive, by its name; null = not a clip of the goose tandem. */
export function boneFilterFor(clipName) {
  if (clipName === 'Pedal') return isCrankBone;
  if (clipName === 'WheelSpin') return isWheelBone;
  if (/^Pedal_/.test(clipName)) return isLowerBone;
  if (/^(Ride|Lean_L|Lean_R)_/.test(clipName)) return isUpperBone;
  return null;
}

/**
 * Upper-body weights for one rider's lean l in [-1, 1] (+ = the rider's right, the same sign as
 * the bike's lean): Ride fades out as the lean grows, the matching Lean clip fades in. Sum = 1.
 */
export function leanWeights(l) {
  const x = Math.max(-1, Math.min(1, Number.isFinite(l) ? l : 0));
  return { ride: 1 - Math.abs(x), left: Math.max(0, -x), right: Math.max(0, x) };
}

/** Clip time for an angle in radians (any sign, any number of turns) on a one-turn clip. */
export function turnTime(angle, duration) {
  if (!(duration > 0) || !Number.isFinite(angle)) return 0;
  const f = angle / (2 * Math.PI);
  return (f - Math.floor(f)) * duration;
}

/**
 * Where a goose's root goes inside its seat socket (bike metres, glTF axes): hip joints HIP_UP above
 * the saddle top. hipMid = the goose's rest hip-joint midpoint {x, y, z} in its own model space.
 */
export function seatOffset(hipMid, hipUp = HIP_UP) {
  return { x: -hipMid.x, y: hipUp - hipMid.y, z: -hipMid.z };
}
