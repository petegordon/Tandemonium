// ============================================================
// IMU CAPTURE QUALITY — make a Test Report conclusive at capture time
// ============================================================
//
// Pure analysis used by the capture wizard to gate each IMU step on data
// quality, so a sloppy capture (weak rotation, multi-axis wobble, hands
// not off during at-rest) is caught and re-done BEFORE saving — instead
// of discovering it's inconclusive during offline analysis later.
//
// Input is already-parsed samples (raw signed-16 gyro/accel from the
// driver's parseReport), so this stays vendor-agnostic and offset-aware
// for free. Output is a {ok, level, message, detail} verdict the wizard
// renders and decides redo/keep on.

const AT_REST_GYRO_STD_MAX = 40;     // raw σ; above this the pad wasn't still
const AT_REST_ACCEL_MIN = 6500;      // raw |accel| window around 1g (8192)
const AT_REST_ACCEL_MAX = 10000;
const ROT_MIN_STD = 80;              // raw σ on the dominant axis = clear rotation
const ROT_DOMINANCE_RATIO = 2.0;     // top axis σ / 2nd axis σ = isolated to one axis
const YAW_ACCEL_STD_MAX = 200;       // raw σ; above this the "yaw" wasn't level
const MIN_SAMPLES = 5;

const AXES = ['X', 'Y', 'Z'];
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };

/**
 * Score one IMU capture step.
 * @param {string} stepId — 'at-rest' | 'pitch' | 'roll' | 'yaw'
 * @param {Array<{gyro:{x,y,z}, accel:{x,y,z}}>} samples — parsed, raw units
 * @returns {{ok:boolean, level:'pass'|'warn'|'fail', message:string, detail:object|null}}
 */
export function analyzeImuStep(stepId, samples) {
  if (!samples || samples.length < MIN_SAMPLES) {
    return { ok: false, level: 'fail', detail: null,
      message: `Only ${samples?.length || 0} IMU reports parsed — is the controller actually streaming gyro?` };
  }

  const gStd = [std(samples.map((s) => s.gyro.x)), std(samples.map((s) => s.gyro.y)), std(samples.map((s) => s.gyro.z))];
  const aStd = [std(samples.map((s) => s.accel.x)), std(samples.map((s) => s.accel.y)), std(samples.map((s) => s.accel.z))];
  const accelMag = mean(samples.map((s) => Math.hypot(s.accel.x, s.accel.y, s.accel.z)));
  const gBias = [mean(samples.map((s) => s.gyro.x)), mean(samples.map((s) => s.gyro.y)), mean(samples.map((s) => s.gyro.z))];
  const round = (a) => a.map((v) => Math.round(v));
  const detail = { gyroStd: round(gStd), accelStd: round(aStd), accelMag: Math.round(accelMag), gyroBias: round(gBias) };

  if (stepId === 'at-rest') {
    const maxG = Math.max(...gStd);
    if (maxG > AT_REST_GYRO_STD_MAX) {
      return { ok: false, level: 'fail', detail,
        message: `Not still — gyro σ ${maxG.toFixed(0)} (raw). Set it down, hands fully off, and redo.` };
    }
    if (accelMag < AT_REST_ACCEL_MIN || accelMag > AT_REST_ACCEL_MAX) {
      return { ok: false, level: 'warn', detail,
        message: `At-rest |accel| ${accelMag.toFixed(0)} isn't ~8192 (1g) — IMU offset/scale looks wrong.` };
    }
    return { ok: true, level: 'pass', detail,
      message: `Still ✓  gyro σ ${maxG.toFixed(0)}, |accel| ${accelMag.toFixed(0)}≈1g, bias (${round(gBias).join(',')})` };
  }

  // Rotation steps (pitch / roll / yaw).
  const order = [0, 1, 2].sort((i, j) => gStd[j] - gStd[i]);
  const top = order[0], second = order[1];
  const topStd = gStd[top], secondStd = gStd[second];
  const ratio = secondStd > 1e-6 ? topStd / secondStd : Infinity;
  const axis = AXES[top];
  detail.dominantAxis = `gyro ${axis}`;
  detail.ratio = Number(ratio.toFixed(1));

  if (topStd < ROT_MIN_STD) {
    return { ok: false, level: 'fail', detail,
      message: `Too little rotation — strongest gyro axis σ only ${topStd.toFixed(0)} (need ≥${ROT_MIN_STD}). Tilt further and more deliberately, then redo.` };
  }
  if (ratio < ROT_DOMINANCE_RATIO) {
    return { ok: false, level: 'fail', detail,
      message: `Not isolated — gyro ${axis} σ ${topStd.toFixed(0)} vs ${AXES[second]} σ ${secondStd.toFixed(0)} (ratio ${ratio.toFixed(1)}, need ≥${ROT_DOMINANCE_RATIO}). Rotate around ONE axis only, then redo.` };
  }

  // Accel cross-check — reported, not gated (a clean capture revealing a
  // frame mismatch is a real finding, not a reason to reject the data).
  let frameNote = '';
  if (stepId === 'yaw') {
    const aMax = Math.max(...aStd);
    frameNote = aMax > YAW_ACCEL_STD_MAX ? ` — note: accel moved σ ${aMax.toFixed(0)}, keep it flatter for a pure yaw` : ' — accel stayed flat ✓';
  } else {
    const aMinIdx = aStd.indexOf(Math.min(...aStd));
    frameNote = aMinIdx === top
      ? ' — accel frame consistent ✓'
      : ` — ⚠ accel-flat axis is ${AXES[aMinIdx]} but gyro axis is ${axis} (possible gyro/accel frame mismatch)`;
  }
  return { ok: true, level: 'pass', detail,
    message: `Clean ✓  rotation on gyro ${axis} (σ ${topStd.toFixed(0)}, ratio ${ratio.toFixed(1)})${frameNote}` };
}
