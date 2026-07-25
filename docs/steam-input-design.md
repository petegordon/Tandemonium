# Steam Input — Full Controller Design

Companion to `steam-input.md` (the mechanics quick-reference). This doc is the
*architecture*: which controller takes which path, why, and the work to get
there. Written 2026-07-25 after the deployed-playtest gyro debug.

## The problem this solves

Gyro tilt-steering must work in the **Steam-launched build** for every
controller we support. The blocker: Steam Input **captures** some controllers
(removing them from WebHID/Gamepad API), and our shipped build neither ships
the action manifest (IGA) nor authors real gyro bindings — so captured pads get
nothing.

## Non-negotiable platform facts (learned the hard way)

1. **The Steam Controller 2026 is *always* captured by Steam Input.** The
   per-game Controller override disables Xbox/PlayStation/Switch/Generic but
   shows **"Steam Controller: Enabled, always required."** You cannot route it
   through WebHID under a Steam launch. Steam Input is its *only* path.
2. **A pad is on WebHID XOR Steam Input, never both.** They take exclusive HID
   ownership. So "DualSense on Steam Input" means "DualSense *removed* from
   WebHID."
3. **WebHID gyro is better than Steam Input gyro for pads we control.** Our
   SensorFusion (gravity-roll, drift-EMA, recenter, per-controller IMU offset)
   beats Steam's `gyro_to_joystick_deflection`, which is dead unless the stick
   also moves (#295) and whose recalibration is a no-op when Steam is the source
   (#296).
4. **`getMotionData()` needs no IGA and no binding.** Steam hands back raw
   `rotQuat/accel/rotVel` for any captured controller regardless of manifest
   state (proven live: motion flowed while every action handle was still `0`).

## Two ways to get gyro from a Steam-captured controller

| | **A · Action binding** | **B · Raw motion + our fusion** |
|---|---|---|
| Gyro source | `getAnalogActionData(Steer)` | `getMotionData(handle)` → SensorFusion |
| Needs IGA shipped | Yes | No (only if we also want digital actions) |
| Needs per-type Big-Picture binding | Yes — author + export gyro→`Steer` for **each** controller type | No |
| Gyro quality | Steam's modes; inherits #295/#296 | Our validated fusion (same as WebHID) |
| Reuses existing work | No (new steering feel per Steam config) | Yes (identical to WebHID lean) |
| Aligns with | #293/#306/#307 | #348 `@usersfirst/controller-steam` adapter |

**Recommendation: B for gyro.** It sidesteps the Steam gyro bugs, reuses the
pipeline we just validated end-to-end on the DualSense, and needs zero
per-controller binding authoring. The action layer (A) is only worth it for
**digital actions** (menu nav / pedals) on captured pads that don't emit a
usable virtual gamepad.

## Target architecture — one fusion, two sources

```
        native pads (DualSense, DualShock, Switch Pro, GameSir)
            │  raw HID reports (navigator.hid)
            ▼
   ┌──────────────────┐
   │   SensorFusion   │──► gravity-roll ──► _applyTilt ──► lean/steer
   └──────────────────┘
            ▲
            │  getMotionData() rotQuat/accel   ◄── the adapter (#348)
        captured pads (Steam Controller 2026 — always; anything Steam grabs)
```

- **Gyro** is unified behind `SensorFusion`. WebHID feeds native pads; a thin
  Steam Input adapter feeds captured pads via `getMotionData`. The renderer
  stops caring which source a slot uses — it just gets orientation.
- **Buttons / menu nav**: native pads via the Gamepad API (unchanged). Steam
  Controller buttons via Steam Input **digital actions** *iff* it doesn't emit a
  usable virtual pad (open question below) — this is the one place the IGA earns
  its keep.

## Per-controller matrix

| Controller | Transport | Gyro path | Buttons/nav | Status |
|---|---|---|---|---|
| **Steam Controller 2026** | Steam Input (forced) | **B** — `getMotionData`→fusion | digital actions or virtual pad | ❌ to build |
| DualSense (USB + BT) | WebHID | fusion | Gamepad API | ✅ working |
| DualShock 4 | WebHID | fusion | Gamepad API | ✅ (driver ready) |
| Switch Pro | WebHID | fusion | Gamepad API | ✅ (driver ready) |
| GameSir SuperNova | WebHID | fusion | Gamepad API | 🚧 #301 |
| Xbox / generic | Gamepad API | (no gyro) | Gamepad API | ✅ |

The DualSense/Switch/GameSir rows deliberately **stay on WebHID** — moving them
to Steam Input would only regress them (facts 2 & 3).

## Work plan

**Phase 0 — unblock the deployed build (small, do first).**
Ship the IGAs so *something* resolves and we can read digital actions on the
Steam Controller. `forge.config.js`: uncomment `game_actions_4510250.vdf` /
`game_actions_4482940.vdf`. Rebuild → confirm `set/steer` handles go non-zero in
`tandemonium-diag.log`, and **verify Xbox/DualSense nav didn't regress** (IGA
presence may suppress the virtual XInput pad — test, don't assume).

**Phase 1 — Steam Controller gyro via `getMotionData` (design B).**
Add `getMotionData(handle)` to the production Steam Input snapshot in
`electron/main.js` (currently only in the diagnostic `getFullDiag`). In the
renderer, feed a captured slot's `rotQuat/accel` into its `SensorFusion` instead
of reading the `Steer` action. Gyro now works identically to WebHID. (This is
the `@usersfirst/controller-steam` adapter, #348.)

**Phase 2 — Steam Controller buttons.**
Determine whether the SC emits a virtual gamepad our Gamepad API nav can use
(open question). If not, author its digital-action bindings in Big Picture and
read `getDigitalActionData` (already wired in `main.js`).

**Phase 3 — naming / branding (`Steer` → House Roll Lean).**
Only after Phase 0-1 resolve. Rename the IGA analog action key `Steer` →
`RollLean` (brand-free, reused in the strudel.cc gyro-music project), display
title **"House Roll Lean"**. Requires: edit IGA, update
`getAnalogActionHandle('Steer')` in `main.js`, and **re-author/re-export any
`Steer`-bound binding in Big Picture** (Steam rejects hand-edited configs).
Future breakout: `PitchLean` / `YawLean` for the other gyro axes. Studio name:
**House Tandem**.

## Open questions to verify before committing

1. Does shipping the IGA suppress the virtual XInput pad that Xbox/generic pads
   rely on for nav? (Test with Phase 0.)
2. Does the Steam Controller emit a virtual gamepad our Gamepad API nav sees, or
   must buttons go through Steam Input digital actions? (Decides Phase 2 scope.)
3. Is `getMotionData` orientation in a frame our `SensorFusion` can consume
   directly, or does it need an axis remap vs the WebHID IMU frame?
   (Cf. steam-controller-driver.js body-frame notes, and the yaw-drift capture.)

## Related issues

#293 (turn-key bindings · Phase 0/2) · #294 (audit) · #295 #296 (Steam gyro bugs
we avoid via B) · #306 #307 (per-type bindings · only if we choose A) · #347 (two
Steam Controllers) · #348 (adapter epic · Phase 1) · #305 (WebHID verification).
