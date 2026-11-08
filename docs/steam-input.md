# Steam Input — how Tandemonium uses it

The whole model in one page. `steam-input-design.md` is the history (the
hardware session that settled this); it is not the plan.

## The rule

**A controller Steam captures is just a gamepad the Gamepad API sees. Everything
else is WebHID.**

- **WebHID first.** Our drivers (`shared/drivers/`) open the pad over USB or
  Bluetooth, read buttons and the raw IMU, and run our own sensor fusion: our
  steering feel, our drift handling, our recenter (L3 / R3). This is the path
  for the DualSense, DualShock 4, Switch Pro and GameSir — and for the Steam
  Controller whenever Steam is not holding it.
- **Steam's virtual pad as the fallback.** When Steam *captures* a controller
  it takes the HID device exclusively (our driver can no longer open it) and
  re-emits it as a virtual Xbox 360 XInput pad. The game reads that pad through
  the ordinary Gamepad API. Its gyro, if any, is Steam's: the player's layout
  maps gyro onto the left stick, with Steam's processing and Steam's recenter.
  The game controls that feel only through the official layout.

Launching through Steam changes nothing by itself. Capture does, and capture is
decided by Steam's controller settings per type (PlayStation / Xbox / Switch /
generic support, plus the per-game override). The Steam Controller is always
captured under a Steam launch — it is the one pad with no choice.

## Emulation mode, on purpose

Steam runs a game in one of two modes, decided by whether an action manifest
(the IGA, `game_actions_<appid>.vdf`) is present:

| | API mode | **Emulation mode (ours)** |
|---|---|---|
| Action manifest shipped | yes | **no** |
| Captured pads reach the game as | Steamworks actions only | a virtual XInput pad |
| `getConnectedControllers()` | the captured pads | **`[]` all session** |
| Who maps the physical inputs | our per-type binding files | the player's layout |

`forge.config.js` ships no `controller_config/` at all. Shipping the IGA would
switch Steam to API mode and take the virtual pad away, which is the path that
actually works on hardware. The old layout exports (`steam/controller_ps5.vdf`,
`steam/controller_neptune.vdf`) and IGAs stay in `steam/` as reference only.

What the game keeps from Steam Input (`electron/main.js`):

- `steam.input.init(true)` + `runFrame()` each tick, so that
- `getControllerForGamepadIndex(i)` / `getInputTypeForHandle` can say which
  physical controller sits behind each virtual XInput pad (#362). The renderer
  feeds that map (`window.steam.input.getXInputMap()`) to the ControllerManager
  each frame (`setSteamInputMap`). Since controller-core 0.7 (#607) core folds a
  virtual pad into the controller it echoes (one unit, one seat; the twin is
  never listed or seated), names a virtual pad by its real type in the
  controller overlay (`unit.steamSlot`), and tells the game when a seat's stick
  is a Steam-only Steam Controller's gyro (#499: Stick steering Off keeps it).
  See the lab's `docs/controller-units.md`.
- A heartbeat in `tandemonium-diag.log`: `[SteamInput diag] heartbeat: N
  captured pad(s)`. In emulation mode N is normally **0** even while virtual
  pads exist. Non-zero means Steam is treating the game as an API-mode game —
  look for a stray `game_actions_<appid>.vdf` in `<Steam>/controller_config/`.

Everything else that once read Steam Input (the per-frame snapshot, digital
actions, `getMotionData` fusion, the DualSense Input Source option, Steam join
candidates and handle pinning in the lobby) was deleted in #581.

## Steamworks settings (the part that is not code)

1. **Official layout.** Author a layout in Big Picture against the real Steam
   Controller with **Gyro Behavior = Gyro To Joystick Deflection** (left stick),
   and publish it as the game's official layout. This is what gives every Steam
   Controller player tilt steering; the July 2026 session found the official
   layout had gyro off and only Pete's personal layout worked. Layouts apply on
   the next launch and are per appid, not per depot branch.
2. **Per-type Steam Input defaults** (Steamworks → Application → Steam Input):
   PlayStation and Switch support **off** by default so those pads stay on
   WebHID and keep our gyro. Xbox either way (no gyro); off means fewer virtual
   twins to dedupe.
3. Players can still override per game. A DualSense with PlayStation support
   turned on is captured, loses our gyro, and plays as a virtual pad with
   whatever gyro the layout gives it.

## Known gap

On the virtual-pad fallback the game cannot tell a gyro-driven left stick from
a thumb on a stick, so **Stick steering: Off** silently kills gyro steering for
a captured pad. The XInput-slot map already says when a pad is a Steam twin;
that case should count as gyro, not stick (#499).

## Diagnosing a Steam launch

| Symptom | Look at |
|---|---|
| A pad is missing from the lobby | `__whyNotHid()` in DevTools: which WebHID Steam Controllers are live, so whether the twin filter fired |
| Gyro dead on a Steam Controller | the heartbeat (0 expected); then the active layout's Gyro Behavior; then whether Stick steering is Off |
| Gyro dead on a DualSense | Steam's PlayStation support for this game (it should be off); the Controls dialog shows the pad's source |
| `[SteamInput diag] XInput slots:` | which virtual pad is which physical controller |

## References

- Steam Input overview: https://partner.steamgames.com/doc/features/steam_controller
- Steamworks Steam Input settings: https://partner.steamgames.com/doc/features/steam_controller/getting_started_for_devs
