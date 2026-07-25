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
4. ~~**`getMotionData()` needs no IGA and no binding.**~~ **FALSIFIED
   2026-07-25 on the 2026 Puck.** Steam returned a *degenerate* struct —
   `quat=[0,0,0,0]`, accel and rotVel all zero. An all-zero quaternion is not a
   valid orientation (identity is `w=1`), so this is "no data", not "not
   moving". Whatever earlier observation motivated this claim did not come from
   this controller in this configuration. Re-test on a real appid before
   trusting design B at all.
5. **Steam capture freezes the IMU inside our WebHID stream — it does not
   block it.** Under a Steam launch the driver still opens the Puck, disables
   lizard mode, and streams 53-byte STATE reports (8000+ accepted, accel
   verified ~16489). Only the IMU *fields* stop changing. Everything looks
   healthy right up to the sensor data, which is why this reads as a driver or
   axis bug for hours. Proven by A/B: identical build, Steam closed →
   gyro works perfectly; Steam running → frozen.
6. **A non-Steam shortcut cannot test ANY Steam-side path.** Steam keys
   controller config to the *running* appid. A shortcut gets a Steam-generated
   id, never 4510250, so neither `game_actions_4510250.vdf` nor
   `controller_neptune.vdf` is ever applied — confirmed live: IGA present and
   ASCII-clean at the expected path, `setInputActionManifestFilePath` still
   returned `false` and handles still resolved to `0`. Steam-side testing
   requires a real depot build (see the `dev-private` branch).
7. **The snapshot carries the enum, not the name.** `getInputTypeForHandle`
   returns `ESteamInputType` and `main.js` stringifies it, so entries arrive as
   `"14"`. The 2026 Puck reports **14 = SteamDeckController** (not
   `1 = SteamController`). Any code matching on type names silently never
   fires.

## How it actually works today (VERIFIED on hardware 2026-07-25)

**The Steam Controller already steers by gyro on a real depot build, and none
of our fusion code is involved.** Measured end to end on the `dev-private`
branch of 4510250:

```
Steam layout: Gyro Behavior = Gyro To Joystick Deflection
  → Steam maps gyro onto the virtual XInput pad's Left Stick X
  → navigator.getGamepads()[0].axes[0] swings the full -1 … +1
  → InputManager.gamepadLean → BalanceController → bike
```

A/B proof, same build, only the Steam layout changed:

| Gyro Behavior | `axes[0]` while tilting |
|---|---|
| Gyro To Joystick Deflection | `-0.999 … +1.0` |
| None | `0.011 – 0.015` (static stick bias, below our 0.08 deadzone → lean 0) |

This is **emulation mode**, which `forge.config.js` deliberately preserves by
NOT shipping the IGA: with no manifest, Steam emits a normal virtual XInput pad
that `getGamepads()` can see. `getConnectedControllers()` returns `[]` the whole
session (heartbeat: `0 captured pad(s)`) — Steam never hands the pad to our SDK
session at all.

**Gotcha: layout changes apply on game RESTART.** Changing Gyro Behavior while
the game runs affects the *next* launch, which reads as the setting doing the
opposite of what you set. Exit fully between A/B legs.

**Gotcha: layouts are per-appid, not per-branch.** `default` and `dev-private`
share appid 4510250 and therefore share one layout. Switching depot branch
cannot change controller behavior.

## Three ways to get gyro from a Steam controller

| | **A · Action binding** | **B · Raw motion + our fusion** | **C · Emulation mode** |
|---|---|---|---|
| Gyro source | `getAnalogActionData(Steer)` | `getMotionData(handle)` | Steam layout → virtual pad `axes[0]` |
| Needs IGA shipped | Yes | No | **No — must NOT ship it** |
| Needs Big-Picture layout | Yes, per type | No | Yes, one published official layout |
| Works today | Untested | **No — returns `quat=[0,0,0,0]`** | **YES, verified** |
| Gyro feel | Steam's modes | Our validated fusion | Steam's, raw into `gamepadLean` |

**Recommendation: C.** It is the only one demonstrated to work on this
hardware, it needs no new code, and it is what the shipped build already does.
~~Recommendation: B~~ — superseded: B's premise (fact 4) was falsified, and
shipping the IGA that A needs would suppress the virtual pad that C depends on.
Keep B only as the fallback for pads Steam captures outright and which emit no
virtual pad (Steam Deck built-in controls).

## The open shipping risk

Steam reports **"This game does not have controller support"** (no IGA), so it
applies a *layout*, and which layout decides whether players get gyro at all.
An **Official Layout for Tandemonium Playtest** does exist under RECOMMENDED
("Layouts selected by the game's developer"), but its description is Steam's
stock `Gamepad With Joystick Trackpad` template blurb, and the layout observed
working was `pete / Gamepad With Joystick Trackpad` — a *personal* layout.

**RESOLVED 2026-07-25 — this is the root cause.** The Official Layout has
**Gyro Behavior = None**. Players get no tilt steering with a Steam Controller.
Pete's machine worked only because his personal layout had Gyro To Joystick
Deflection set by hand months earlier. The original "gyro doesn't work in the
Steam deployment" report was never a code bug — not driver, axis, fusion,
arbitration, or IGA. The shipped layout simply has gyro switched off.

**Fix:** author a layout with Gyro → Joystick Deflection against the real Puck
and publish it as the game's official layout. The working personal layout
(`pete / Gamepad With Joystick Trackpad`) is the artifact to export. Requires
the controller in hand — cannot be automated.

**Telling the two apart:** the small grey **author** line above the name in
Current Button Layout. `pete` = personal; the official one shows no personal
attribution and reads "Official Layout for Tandemonium Playtest". Both use the
same underlying template name, which makes them very easy to confuse. Do not
change Quick Settings while an official layout is active — Steam forks it into a
personal copy, which both destroys the reading and adds another near-identically
named layout.

Note the depot ships `controller_neptune.vdf` / `controller_ps5.vdf`, but those
map physical inputs to **actions declared in the IGA** — with no IGA there are
no actions to bind, so they cannot be what is driving this.

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

## Work plan (revised 2026-07-25 after the hardware session)

**Phase 0 — get a testable Steam-side build. Nothing else can proceed first.**
Every Steam path is currently untested, not broken: the dev shortcut can't
exercise any of them (fact 6). Package and push to the **`dev-private`** branch
of the Playtest depot (4510250) — the private dev-testing version already exists
in Steam's Game Versions & Betas and was used for exactly this before. Then the
`tandemonium-diag.log` heartbeat and `motion on <handle>` lines answer the open
questions directly, with no guessing.

Do **not** ship the IGA in this first build. `forge.config.js` deliberately
withholds it so Steam keeps emitting a virtual XInput pad, and
`controller_neptune.vdf` (authored gyro→Joystick Deflection→Left Stick X) is
already shipped. That means the build's *intended* Steam path is neither the
action layer nor `getMotionData` — it is **Steam mapping gyro onto the virtual
pad's left stick, read through the ordinary Gamepad API as `gamepadLean`**.
Test that first; it needs no new code at all.

**Phase 0 acceptance test**, in order, from the depot build:
1. `navigator.getGamepads()` — is a virtual XInput pad present?
2. Tilt the Puck — does `axes[0]` move? If yes, steering already works via
   `gamepadLean` and none of the fusion work is involved.
3. `tandemonium-diag.log` — do the action handles resolve now that the appid is
   real? Does `motion on <handle>` show a non-degenerate quaternion?

Only if (2) fails does the binding need re-authoring in Big Picture against the
actual 2026 Puck — `controller_neptune.vdf` was exported 2026-05-18 for the "v2
family" and may not match the profile Steam picks for this hardware. That step
needs the controller in hand and cannot be automated.

**Phase 0b — per-controller source setting.** Generalize the existing
`tandemonium_dualsense_source` (auto | steam-input | webhid) pref from
DualSense-only to per-controller, and plumb it to the main process so
"Steam Input off" actually gates `steam.input.init()` rather than only changing
what the renderer does with the snapshot. Both sources must remain usable —
WebHID is the only one that works today, Steam Input is the only one available
for a fully captured pad, and the choice belongs to the user. A debug
Gamepad/Steam-Input window (cf. `npm run gamepadtest` / `npm run steamtest`)
showing both sources side by side makes this diagnosable instead of inferred.

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

1. ~~Does gyro arrive as virtual-pad `axes[0]`?~~ **ANSWERED: yes**, full
   ±1 range, via the Steam layout's Gyro To Joystick Deflection. The remaining
   question is only *which layout* carries that setting (see shipping risk).
2. ~~Does `getMotionData` return real values once the appid is real?~~
   **ANSWERED: no.** On the real depot build `getConnectedControllers()` returns
   `[]` entirely, so there is no handle to read motion from. Design B has no
   input on this controller in emulation mode.
3. Does the Steam Controller emit a virtual gamepad our Gamepad API nav sees, or
   must buttons go through Steam Input digital actions? (Decides Phase 2 scope.)
4. Can WebHID and Steam Input coexist on the Puck at all, or does capture always
   freeze the IMU (fact 5)? If it always freezes, the per-controller source
   setting must hard-disable one side rather than arbitrate between them.

5. **Feel.** `axes[0]` saturates to ±1 easily, and `gamepadLean` passes the raw
   stick through with only a 0.08 deadzone — no sensitivity, response curve, or
   drift compensation, unlike the WebHID gyro path that was tuned over months.
   Gyro-through-Steam will feel twitchier. Tunable from Steam's sensitivity /
   "Gyro to Joystick Minimum Stick Output" sliders, or by applying a curve on
   our side once the stick is known to be gyro-driven (see below).
6. **Double-drive risk.** `BalanceController` SUMS both sources:
   `leanInput += getMotionLean()` then `leanInput += getGamepadLean()`. Today
   this is harmless only because Steam capture freezes the WebHID IMU so the
   first term is ~0. If WebHID gyro ever works while Steam gyro-as-stick is
   live, steering doubles. This is the real argument for the per-controller
   source setting (Phase 0b) — correctness, not polish.

**Detection hook (verified):** `getConnectedControllers()` returns `[]` in
emulation mode, but `getControllerForGamepadIndex(0)` DOES return a live handle
(`275536649660275`). So the game *can* tell that a virtual pad is a Steam
Controller, which is what is needed to (a) show the lobby gyro toggle —
currently hidden because `gyroConnected` is false — and (b) stop analytics
attributing gyro runs to `steerFrames.gamepad` instead of `gamepad-gyro`.

**Answered 2026-07-25:** the axis mapping is correct (gravity swings out of Y
into X on tilt, `lean` saturates at ±0.96) — a suspected axis-remap bug was
measured and disproved. The full chain fusion → `_applyTilt` → `motionLean` →
`getMotionLean()` → `leanInput` → bike is intact and verified working with Steam
closed. No fix is needed anywhere in the WebHID gyro pipeline.

## Debug handles (DevTools, dev build)

`__scReportStats` per-HID-interface accept/reject tallies · `__whyNotHid()`
WebHID-first arbitration decision with each condition broken out ·
`__leanReport()` every InputManager's slot/fusion/motionLean (several exist;
only one is read by the balance controller) · `__gyroDebug = true` per-frame
`[gyro]` line incl. the gravity vector · `__webhidFirst = false` force the Steam
Input path · `__steamMotionTune` live axis/scale remap for design B.

## Related issues

#293 (turn-key bindings · Phase 0/2) · #294 (audit) · #295 #296 (Steam gyro bugs
we avoid via B) · #306 #307 (per-type bindings · only if we choose A) · #347 (two
Steam Controllers) · #348 (adapter epic · Phase 1) · #305 (WebHID verification).
