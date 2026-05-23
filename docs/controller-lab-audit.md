# Tandemonium Controller Lab — Code Audit

Pre-work for extracting controller code out of Tandemonium into a new
open-source repo under the **UsersFirst** GitHub org. This document is
the file-by-file disposition plan and the public API sketch — no code
moves yet.

## TL;DR

- The driver layer in `shared/controllers/` is the gem — clean, well-
  documented, already supports DualSense / Switch Pro / Xbox detection,
  and has quirk hooks the GameSir variants already use.
- The Electron overlay app is mostly a thin Three.js visualization on
  top of that driver layer — it ports cleanly.
- The `feature/steam-input-gyro` branch (already on origin) contains a
  ready-made `tools/steam-controller-test/` Electron harness and a
  Steam Input integration. That's the seed for the companion repo.
- Three demo-shaped HTML pages already exist (`controller/index.html`,
  `controller/dualsense.html`, `controller-overlay-web/index.html`) —
  these become the lab's GitHub Pages site.
- Real gap: the new controllers you want to support (Cyclone 2,
  Steam Controller 2026, GameSir SuperNova as a first-class driver
  rather than a Switch-Pro-with-quirks) need new driver files.

## Proposed repo layout

### `UsersFirst/tandemonium-controller-lab` (npm workspaces monorepo)

```
tandemonium-controller-lab/
├── packages/
│   ├── core/                    # @usersfirst/controller-core
│   │   ├── src/
│   │   │   ├── drivers/         # base + per-controller drivers
│   │   │   ├── registry.js
│   │   │   ├── manager.js       # slot/claim system (optional, opt-in)
│   │   │   ├── sensor-fusion.js
│   │   │   └── index.js
│   │   └── package.json
│   ├── visualizer/              # @usersfirst/controller-visualizer
│   │   ├── src/
│   │   │   ├── overlay.js       # Three.js scene + animation
│   │   │   ├── profiles/        # per-controller 3D model config
│   │   │   ├── gyro-gimbal.js
│   │   │   └── index.js
│   │   ├── assets/controllers/  # GLB models
│   │   └── package.json
│   └── web-demo/                # GitHub Pages site (no publish)
│       ├── index.html           # landing + demo selector
│       ├── pages/
│       │   ├── dualsense.html
│       │   ├── visualizer.html
│       │   ├── gamepad-test.html
│       │   └── webhid-probe.html
│       └── package.json
├── apps/
│   └── overlay/                 # the Electron transparent overlay
│       ├── electron/
│       ├── src/
│       ├── forge.config.js
│       └── package.json
├── .github/workflows/
│   ├── pages-deploy.yml
│   ├── overlay-release.yml      # tag overlay-vX.Y.Z to release installers
│   └── ci.yml
├── README.md
├── package.json                 # workspaces root
└── LICENSE
```

### `UsersFirst/tandemonium-controller-steam` (separate)

```
tandemonium-controller-steam/
├── src/
│   ├── steam-input-adapter.js   # bridges Steam Input → core's input bus
│   └── index.js
├── tools/
│   └── steam-controller-test/   # full Electron diagnostic bench
├── steam/
│   ├── controller_ps5.vdf
│   ├── controller_neptune.vdf
│   └── game_actions_template.vdf
└── docs/steam-input.md
```

Depends on `@usersfirst/controller-core` from npm.

`steamworks_sdk/` binaries do **not** ship in the public repo. Each
developer downloads the SDK themselves from the Steamworks Partner
site and drops the `redistributable_bin/` folder into `steamworks_sdk/`
(matching the path `steamworks-ffi-node` expects). The repo
`.gitignore`s the directory; the test harness prints a clear error
when the SDK is missing. No postinstall auto-download — Valve's
license forbids it and `steamworks-ffi-node` itself takes the same
stance.

## File-by-file disposition

### → `packages/core/src/` (the reusable library)

| Current path | Lines | Notes |
|---|---|---|
| `shared/controllers/base-driver.js` | 106 | Move as-is. Public abstract class. |
| `shared/controllers/controller-registry.js` | 161 | Move as-is. Becomes the public driver registry. |
| `shared/controllers/dualsense-driver.js` | 443 | Move as-is. |
| `shared/controllers/switch-pro-driver.js` | 320 | Move, **then** split the GameSir Cyclone / SuperNova quirks out into proper sibling drivers (see "New drivers" below) rather than living as Switch-Pro special cases. |
| `shared/controllers/xbox-driver.js` | 22 | Move as-is. Stub for detection. |
| `shared/sensor-fusion.js` | 554 | Move as-is. Pure math, no Tandemonium refs. |
| `shared/controller-manager.js` | 864 | Move, but flag as **opt-in** — it's an opinionated slot/claim system with UX defaults (PS-button hold-to-release, 2-player default). Many lab consumers will want just registry + driver and run their own pairing. Document that. |

**Renames during move:** I'd drop the `controller-` prefix from
filenames inside `packages/core/src/` (`drivers/dualsense.js`,
`drivers/switch-pro.js`, `registry.js`, `manager.js`) — current names
read awkwardly when imported as `import { DualSenseDriver } from
'./controllers/dualsense-driver.js'`.

### → `packages/visualizer/src/` (Three.js scene)

| Current path | Lines | Notes |
|---|---|---|
| `controller-overlay/src/js/controller-overlay.js` | 980 | Move. Rename class to `Visualizer3D`. Strip Electron-specific assumptions (it already accepts a canvas via constructor — clean). |
| `controller-overlay/src/js/controller-profiles.js` | 189 | Move to `packages/visualizer/src/profiles/`. Pure metadata. |
| `controller-overlay/src/js/gyro-gimbal.js` | 170 | Move. |
| `controller-overlay/src/assets/controllers/*.glb` | binary | Move to `packages/visualizer/assets/`. Confirm license terms (README says OBJ→GLB conversions of larfingshnew's models — already MIT'd in the overlay's LICENSE, but let's re-verify before mirroring). |
| `controller-overlay/scripts/convert-controller.js` | — | Move to `packages/visualizer/scripts/`. |
| `controller-overlay/scripts/convert-dualsense.js` | — | Same. |

### → `packages/web-demo/` (GitHub Pages)

| Current path | Lines | Notes |
|---|---|---|
| `controller-overlay-web/index.html` | 272 | Becomes the lab landing page. Re-skin: drop "Tandemonium download" copy, add "open source controller library" framing. |
| `controller/index.html` | 763 | Move as `pages/visualizer.html`. The interactive 3D demo. |
| `controller/dualsense.html` | 556 | Move as `pages/dualsense.html`. DualSense-specific deep-dive. |
| (from `feature/steam-input-gyro`) `tools/gamepad-test/index.html` + `main.js` | 201 | Move as `pages/gamepad-test.html`. The isolated Gamepad API probe — useful diagnostic page. |
| **new** | — | `pages/webhid-probe.html` — raw HID report viewer with vid/pid hex dump. Useful for adding new controllers. |

### → `apps/overlay/` (Electron app, mostly verbatim)

| Current path | Lines | Notes |
|---|---|---|
| `controller-overlay/electron/main.js` + `preload.js` | — | Move. |
| `controller-overlay/src/js/app.js` | 1310 | Move — this is the app shell (settings panel, button combos, color customization). Update imports to consume the workspace packages. |
| `controller-overlay/src/js/multi-app.js` | 367 | Move. Multi-controller variant. |
| `controller-overlay/src/index.html` + `multi.html` | — | Move. |
| `controller-overlay/forge.config.js` | — | Move. |
| `controller-overlay/scripts/copy-shared.js` | 41 | **Delete** — workspace symlinks replace this. |
| `controller-overlay/scripts/copy-three.js` | — | Probably still needed; verify. |
| `controller-overlay/scripts/make-dmg.sh` | — | Move. |

### → `UsersFirst/tandemonium-controller-steam` (separate repo)

From `feature/steam-input-gyro` branch:

| Branch path | Lines | Notes |
|---|---|---|
| `tools/steam-controller-test/` (whole dir) | ~1100 | Move as `tools/steam-controller-test/`. The Electron diagnostic harness — already designed to be standalone. |
| `steam/controller_ps5.vdf` | 680 | Move. |
| `steam/controller_neptune.vdf` | 872 | Move. |
| `steam/game_actions_*.vdf` | 94 | Move as `steam/game_actions_template.vdf` (single file). |
| `docs/steam-input.md` | 98 | Move. |
| `steamworks_sdk/` binaries | binary | **Do not commit** — handle via postinstall download. |
| `electron/main.js` Steam Input wiring | +478 | Extract the Steam Input bridge into a standalone `steam-input-adapter.js` module that exposes the same parsed-report shape as `@usersfirst/controller-core` drivers. |
| `js/input-manager.js` game wiring | +170 | **Leave in Tandemonium** — Tandemonium-specific. |

### Stay in Tandemonium (game-specific, never move)

| Path | Why |
|---|---|
| `js/pedal-controller.js` | Bike cadence sensor — game input device. |
| `js/balance-controller.js` | Balance board — game input device. |
| `js/shared-pedal-controller.js` | Same. |
| `js/game.js`, `js/input-manager.js` | Game logic. |
| `tandem-3d/`, `bike-customizer/`, `model-viewer/`, etc. | All Tandemonium-specific. |
| Everything under `worker/`, `dashboard/`, `peerjs-server/`, `steam/builds/` | Backend / publishing. |

### New drivers to write (not in current code)

| Controller | Approach | Existing hooks |
|---|---|---|
| **GameSir SuperNova** | Promote from "DS4-pretending" quirk to a real driver. It exposes both DS4 + raw HID interfaces. Needs its own button parser since it's mis-parsed by the DualSense driver today. | `controller-manager.js:672-697` already has dedupe logic for the multi-interface case. |
| **GameSir Cyclone 2** | New driver. Cyclone 1 currently piggybacks Switch Pro driver via the `swapAB` quirk — figure out if Cyclone 2 shares the protocol or is its own thing. | `switch-pro-driver.js:15` has the quirk hook. |
| **Steam Controller 2026** | New driver. Likely needs both a WebHID driver and a Steam Input driver — the Steam Input one lives in the steam companion repo. | `tools/steam-controller-test/README.md` already calls out the future `0x28de` vid:pid placeholder. |

## Public API sketch — `@usersfirst/controller-core`

```js
// Minimal "give me normalized events" path
import { ControllerBus } from '@usersfirst/controller-core';

const bus = new ControllerBus();
await bus.start();                       // requests WebHID, polls Gamepad API
bus.on('controller-connected', (c) => { /* { id, driverName, capabilities } */ });
bus.on('input', (c, parsed) => {         // unified ParsedReport
  // parsed.buttons.cross, parsed.sticks.lx, parsed.gyro.x, etc.
});

// Lower-level path: bring your own driver registry / pairing flow
import { ControllerRegistry, DualSenseDriver } from '@usersfirst/controller-core';

const driver = await ControllerRegistry.connect(hidDevice);
driver.parseReport(reportId, dataView); // → ParsedReport | null

// Opt-in slot manager (for multi-player apps)
import { ControllerManager } from '@usersfirst/controller-core/manager';

const mgr = new ControllerManager({ slotIds: ['P1', 'P2'] });
mgr.wireHidHotplug();
mgr.slots[0].on(handleSlotEvent);
```

Three layers — driver, registry, manager — each independently usable.
That's the shape that lets the lab serve both "I just want to read my
SuperNova in a browser tab" hackers and "I need full multi-player
pairing" game devs.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | GLB model licensing | Source repo (`larfingshnew/3d-controller-overlay`) is MIT. Copy the upstream LICENSE into `packages/visualizer/assets/controllers/LICENSE`, credit the source in both the package README and `packages/visualizer/README.md`. Same attribution the current overlay README already uses — no new legal surface. |
| 2 | Steamworks SDK redistribution | Match `steamworks-ffi-node`'s stance: do **not** bundle or auto-download. `.gitignore` the `steamworks_sdk/` directory in the companion repo. README documents the manual download step from the Steamworks Partner site. The test harness checks for the SDK path on startup and prints a clear error with a link to the download page when missing. |
| 3 | npm scope | **`@usersfirst/*`** — matches the studio (usersfirst.games), keeps the door open for non-Tandemonium packages later. Packages: `@usersfirst/controller-core`, `@usersfirst/controller-visualizer`. Steam companion publishes as `@usersfirst/controller-steam`. |
| 4 | Slot/claim manager location | Keep in `@usersfirst/controller-core` as a subpath export. Imports: `import { ControllerManager } from '@usersfirst/controller-core/manager'`. Tree-shakeable, single package to publish, one issue tracker. Revisit only if manager grows substantially or a "driver-only without manager" use case shows up. |
| 5 | Tandemonium consumption | Two phases. **Phase 1** (extraction + first ~2 months): Tandemonium keeps its in-tree copy of `shared/controllers/`, kept up to date via `npm run sync-controller-lab` — a sync script that pulls the latest commit from the lab repo and writes it into `shared/`. Lab is source of truth; Tandemonium pins a specific lab commit in a `.controller-lab-sha` file. **Phase 2** (after lab API hits 1.0): Tandemonium switches to consuming `@usersfirst/controller-core` from npm and deletes its in-tree copy. |

## Suggested next steps

1. **Scaffold the new repo's structure.** Pure skeleton — root
   `package.json` with workspaces, `packages/core/package.json` with
   the exports map, `packages/visualizer/package.json`, `apps/overlay/
   package.json` (mostly copied from the current overlay), and a
   one-page README per package. No code moved yet. This is the doc
   that proves the package boundaries actually work before we commit
   to moving files.
2. **Decide where the new repo physically lives during scaffolding.**
   Three options: (a) scaffold in a sibling directory on this machine
   and push to a brand-new `UsersFirst/tandemonium-controller-lab`
   repo created via the GitHub web UI, (b) scaffold inside this repo
   under a temporary `lab-scaffold/` path and migrate later, (c) wait
   to scaffold until the `UsersFirst` org exists on GitHub.
3. **The extraction itself.** Sustained ~2-hour move once scaffolding
   is approved — careful import rewriting, asset relocation, and a
   smoke test that the lab's web demo loads + the Electron overlay
   still launches.
4. **Roadmap issues.** After the move lands, file public issues for
   the new drivers (SuperNova as a first-class driver, Cyclone 2,
   Steam Controller 2026) so the project has a visible roadmap from
   day one.
5. **Tandemonium-side sync script.** Add `scripts/sync-controller-lab.
   sh` and a `shared/.controller-lab-sha` file to Tandemonium on a
   follow-up PR, once the lab repo has a stable enough main branch
   to sync from.
