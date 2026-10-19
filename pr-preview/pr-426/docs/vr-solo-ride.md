# VR SOLO RIDE (#425)

A reference example game: Tandemonium's Grandma's House road, ridden seated in VR on a Quest, steering by holding handlebars. It lives in `vr/`, is built on the **Meta Immersive Web SDK** (`@iwsdk/core`), and is served at **`/vr/`** next to the flat game (`/pr-preview/pr-N/vr/` on PR previews). The flat game is untouched.

## How it fits

- **Its own app.** Vite + IWSDK + `three` → `super-three@0.181.0`, with its own `vr/package.json` and `node_modules`. The flat game stays on three.js 0.161 from the CDN import map, with no build step.
- **Reuses the game's modules** from `../js`: `world.js` (road, trees, scenery, Grandma's markers), `bike-model.js` (the bike and its lean/speed physics, including the auto-speed cruise), `config.js`, `race-config.js`. `vite.config.ts` dedupes `three` so those modules get super-three too.
- **Its own ride loop** (`vr/src/ride-system.ts`), small on purpose: read the lean, `bike.update(...)`, `world.update(...)`, place the player. No game.js code is used, so there's nothing to extract from it. The cost is that the VR ride can drift from the flat game's rules; that's fine for an example.
- **Game asset URLs.** The shared modules load `assets/...` and `tandem-3d/...` relative to the page. At `/vr/` that would miss, so `vr/src/asset-base.ts` points them one folder up (three.js loaders through `DefaultLoadingManager.setURLModifier`, and `<video>` src for Grandma's house clip). In dev, `vite.config.ts` serves those folders from the repo root.
- **Deploys.** `deploy.yml` and `pr-preview.yml` build `vr/` (`npm ci && npm run build`) and copy `vr/dist` to `_site/vr`. The repo copy excludes `/vr`, and `forge.config.js` keeps `vr/` out of the Steam (Electron) build. Electron has no WebXR, so VR is web only.

## The ride (V0)

- **Seat:** the player rig (`world.player`) sits on the captain's seat, 0.45 m ahead of the bike's origin, lifted 0.25 m so a seated player's eyes are at riding height. The rig turns only with the bike's heading and never rolls with its lean, so the horizon stays level.
- **Steering (S1, handlebar roll):** `vr/src/handlebar-lean.ts`. When both hands hold the bars (controllers: the grip button; tracked hands: present, a real grasp check comes in V2), the roll of the line between them is the lean: left hand lower = lean left, 30° = full lean, 2° deadzone, lightly smoothed. A see-through green bar is drawn hand to hand. Otherwise A/D or the arrow keys lean.
- **Pedalling:** none. The bike model's own auto-speed cruises at 3 m/s.
- **Quality:** Low tier (no shadows, plain bike without the goose riders).
- **Readout:** frame rate, lean source, speed, distance and draw calls, top left on screen and on a small panel below the bars in VR.

## Run it

```
cd vr
npm install
npm run dev          # https://localhost:8082 (self-signed certificate)
```

In dev the IWSDK plugin injects IWER, an emulated Quest 3, so **Enter VR** works in desktop Chrome. A Quest on the same Wi-Fi can open `https://<this PC's IP>:8082` (accept the certificate warning). `npm run build` writes `vr/dist`; `npm run typecheck` runs `tsc`.

Emulator gotcha for scripted tests: set `IWER_DEVICE.controlMode = 'programmatic'` before moving `IWER_DEVICE.controllers.left/right.position`, or the emulator puts the controllers back.

## V0 results (2026-10-19)

- World + bike load and run under Vite + IWSDK + super-three 0.181 with no changes to the shared modules.
- Flat, headless software rendering: 32 draw calls, about 51k triangles.
- VR in the emulator: the session starts, and handlebar roll steers: level bars 0, left hand 0.2 m lower −0.65, right hand lower +0.65. About 200 draw calls in stereo with the SDK's controller visuals.
- Bundle: 2.4 MB (670 KB gzipped), after aliasing the Lucide icon set to a subset as SandQuest does.
- **Still to measure:** the frame rate on a real Quest. That decides how much Low needs cutting for a steady 72 Hz.

## Next (see #425)

- **V1:** comfort vignette, the presents and checkpoints, a finish at Grandma's, `vr=1` on analytics.
- **V2:** a real grasp check for tracked hands, 🎯 recenter, let go = coast / pause.
- **V3:** trigger pedalling option, haptics.
- **V4:** start / pause / results panels in VR, a headless IWER smoke test.
