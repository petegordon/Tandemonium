# Steam Input — Quick Reference

The 1-page guide to what's actually required. Skips theory; covers what bit us during the 2026-05-16 debug session.

## Mental model

Steam Input has **two separate files**, often confused:

| File | What it is | Authored by |
|---|---|---|
| **IGA** (`game_actions_<appid>.vdf`) | *Schema*. Declares what actions exist (`Steer`, `Confirm`) and what action sets group them (`InGameControls`, `MenuControls`). No bindings inside. | Developer, in source repo |
| **Binding config** (`controller_<type>.vdf`) | *Mapping*. Declares which physical input on which controller invokes which action. References action sets from the IGA. | **Authored in Steam Big Picture UI, then exported.** Don't hand-write. |

You need **both** for Steam Input to work. The IGA alone produces `empty.vdf` fallback (Steam loads the schema but has nothing to bind to it).

## File locations

| Location | Purpose | Required? |
|---|---|---|
| `steam/game_actions_<appid>.vdf` in repo | Source of truth, edited by hand | Yes |
| `<game install>/controller_config/game_actions_<appid>.vdf` | Shipped via depot for game-runtime action lookup | Yes — Forge `postPackage` hook copies it |
| `C:\Program Files (x86)\Steam\controller_config\game_actions_<appid>.vdf` | **Steam's root controller_config dir** — Big Picture configurator reads from here, NOT the game's install dir | **Yes for dev iteration** — create dir if missing; copy IGA here whenever you change it locally |
| `<game install>/controller_config/<exported-name>.vdf` | Exported binding shipped via depot | Yes — once authored |

## Author-export-ship workflow (per Valve docs)

1. Edit IGA in `steam/game_actions_<appid>.vdf`. Match Valve's example structure:
    - Root `"In Game Actions"`
    - `"actions"` block with one entry per action set
    - Each action set: `"title"` + `"Button"`/`"StickPadGyro"`/`"AnalogTrigger"` (omit categories you don't use; don't ship empty ones)
    - `"localization"` block with at least `"english"`
2. Copy the IGA to BOTH game-install and Steam-root controller_config dirs (script this in dev).
3. Launch the game from Steam Library (not `npm start`, not Non-Steam Game — must be a proper Steam-library launch under the registered AppID).
4. Open Big Picture → game's Controller Configuration → Action Sets. Each action set from the IGA should appear by its localized title.
5. Bind physical controls to actions (Joysticks, Buttons, Gyro, Trackpads). Bind for **every** action set, not just the first.
6. Export the configuration. Steam writes it to `C:\Program Files (x86)\Steam\steamapps\common\Steam Controller Configs\<userid>\config\<appid>\<name>.vdf`.
7. Copy the exported file into source repo (e.g. `steam/controller_ps5.vdf`). Update Forge `postPackage` to ship it to `<install>/controller_config/`.
8. Steamworks Partner UI → App → Steam Input → **Custom Configuration** → point at the *exported* binding (NOT the raw IGA).
9. Publish on Steamworks. Push depot.

Repeat steps 4-8 for each controller type you support (`controller_ps5`, `controller_xbox360`, `controller_neptune`, etc).

## Code requirements

In `electron/main.js`:
- `SteamworksSDK.init({appId})` — required, before anything Steam-Input-related
- `steam.input.setInputActionManifestFilePath(absPath)` — **MUST come BEFORE** `input.init()`. Post-init call is a silent no-op.
- `steam.input.init(true)` — `true` means we drive `runFrame()` each tick
- `steam.input.runFrame()` — every frame
- `steam.input.getActionSetHandle('InGameControls')` — cache once at startup
- `steam.input.getAnalogActionHandle('Steer')` — cache once
- Per tick: iterate `getConnectedControllers()`, call `activateActionSet(handle, setHandle)`, read `getAnalogActionData(handle, steerHandle)`

## Tandemonium current state (2026-05-16)

**Scope decision (firm):** Steam Input owns ONLY the `Steer` analog action — gyro→steering for gyro-capable controllers. All other inputs (buttons, sticks, dpad, triggers) stay on the existing Gamepad API path. Per `project_steam_controller_v2.md`, this minimizes the surface area handed to Steam Input and keeps cross-controller feel consistency in our own code.

✅ Working: IGA structure matches Valve's example exactly; controller enumeration via `getConnectedControllers()`; PS5 controller intercepted by Steam Input; action set "Gameplay" visible in Big Picture configurator (after putting IGA at Steam-root path)
✅ Shipping: `steam/controller_ps5.vdf` best-guess binding for DualSense, mapping Gyro+Left Stick → `InGameControls.Steer`. Forge `postPackage` hook copies to depot.
🚧 Pending verification: dev-private CI build, install, in-game test — confirm action handles resolve and gyro drives steering.
🚧 Steamworks Partner UI step still requires manual user action — `Custom Configuration` field must point at the new binding file path.

## Steam Controller v2 — deferred until hardware ships

Per `project_steam_controller_v2.md` the v2 must work by May 2026. Hand-authoring its `controller_steamcontroller2.vdf` (or whatever the controller_type identifier turns out to be) is blocked on:

- Unknown `controller_type` string — Valve hasn't published this yet
- Unknown physical input names — v2's button/stick/trackpad/gyro labels in Steam's VDF schema aren't documented
- No hardware to test feel against

When v2 hardware is in hand, the workflow is identical to PS5:
1. Plug in v2, confirm Steam sees it
2. Open Big Picture → Tandemonium controller config
3. Bind Gyro → "Steer (via Joystick)" and any other physical-input pass-throughs
4. Export config — the resulting filename reveals the canonical controller_type for v2
5. Copy exported file to `steam/controller_<type>.vdf`, add to the `filesToShip` list in `forge.config.js`
6. CI deploy, register on Steamworks if Steam wants a separate per-controller-type registration

Until then: the v2 will fall back to Steam's default templates (matching how DualSense behaved before we authored controller_ps5.vdf — buttons work as XInput emulation, but gyro→Steer doesn't fire).

## Common pitfalls

| Symptom | Cause |
|---|---|
| Action handles stay `0` forever | Binding not authored/shipped; Steam falls back to `controller_base/empty.vdf` |
| `setInputActionManifestFilePath` returns `false` | Called after `input.init()`, or pointed at a non-trusted path. Order matters. |
| Action set not visible in Big Picture | IGA missing from `C:\Program Files (x86)\Steam\controller_config\`. The game-install copy is not enough. |
| Steam logs "Loaded Config for Local Override Path: empty.vdf" | Steamworks "Custom Configuration" field is pointing at the IGA instead of an exported binding |
| Menu navigation broken on controller | No `MenuControls` action set in IGA — bindings only exist for gameplay context |
| `getConnectedControllers()` returns `[]` | Either Steam isn't running, or app launched outside Steam library (Non-Steam Game shortcut won't get proper bindings) |
| Pad works in `gamepadtest` but not steamtest | Steam Input only attaches bindings to Steam-launched processes |

## References

- Valve IGA spec: https://partner.steamgames.com/doc/features/steam_controller/iga_file
- Valve IGA examples: https://partner.steamgames.com/doc/features/steam_controller/iga_examples
- Valve dev workflow: https://partner.steamgames.com/doc/features/steam_controller/getting_started_for_devs
- ISteamInput API: https://partner.steamgames.com/doc/api/ISteamInput
