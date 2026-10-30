# UI audit capture (#428)

Drives the game in headless Chrome at 1920×1080 with simulated controllers and saves a screenshot per screen plus `manifest.json` (step, game state, focused control, controller slots).

```
node scripts/ui-audit/capture.mjs <outDir> [scenario...]
```

Scenarios: `boot lobby ctrltest firstsolo solo together joinglyphs localcoop versus hotplug browser` (all when none are given).

- `fake-input.js`: injected before the page loads. It fakes the Gamepad API (`dualsense`, `switch`, `supernova`, `xbox`, `generic`) and WebHID with a Steam Controller Puck (28de:1304) that streams 53-byte 0x45 state reports. Drive it through `window.__fake` (`addPad`, `press`, `addPuck`, `pressHid`, `removePad`).
- `harness.mjs`: static server, browser and `shot()`. Each page gets its own browser context, so localStorage never leaks between scenarios.
- `sheet.mjs <dir> <out.png> <prefix>`: contact sheet of screenshots.
- `to-jpg.mjs <srcDir> <dstDir> <id...>`: compact JPEGs for the report.

Use the real GPU (the default, `--use-angle=d3d11`). SwiftShader (`UI_AUDIT_SWIFTSHADER=1`) runs at about 4 fps and misses button presses. Most scenarios fake the desktop app's user agent, but `window.steam` (Steam Input) isn't present.

The report built from these captures is in `docs/ui-review-2026-10-19/`.

## Layout mockups

`layout-mock.mjs <outDir> [variant...]` screenshots mode select, level select and 4-player versus with each stylesheet in `layouts/` applied over the live game (no game code changes). `layouts/_wide.css` holds the reflow shared by every variant (TV type scale through `--uf-size-*`, a top bar, a step footer, level cards in one row, four seat cards across). Each variant only places the right painting:

- `a-hero-right.css`: the painting fixed on the right at its natural shape (535×1080).
- `b-bleed.css`: the painting blurred behind everything and sharp on the right.
- `c-art-mode-only.css`: the painting on the mode screen only; the other steps use the full width.

Round 2 (`a2-*.css`) builds on A with `extends:` partials: `_a2.css` (wordmark on the painting, two-line mode buttons, bigger bike chooser, redesigned phone-QR sheet and captain's room) and `_toggle-labels.css`. The three files differ only in where the toggles go: `a2-bottom` (bottom bar), `a2-top`, `a2-rail`. Screens: `--screens=mode,level,versus,host,phone`.

Round 3 (`a3.css`, extends `a2-bottom`) adds proposal-only DOM through `/* script: … */` files (`_controls.js`: one Controls pill that names the controller, plus the Controls sheet on `--screens=controls`; `_join.js`: the stoker's join screen with an 8×4 on-screen keyboard on `--screens=join`). Script-made elements carry the class `mock-dom` and are removed between variants.

Round 4 (`a4.css`, extends `a3`, script `_seats.js`): the captain's local join as a versus-style team box (Captain + Stoker seats), an "Also connected" line on the captain and versus screens instead of the expandable Controllers list, and the full list inside the Controls sheet. Screens `host3` (DualSense, Switch Pro, Puck) and `versus5` (five controllers, four seated).

Round 5 (`a5.css`, extends `a3` + `_coop`, script `_seats2.js`): the captain's room as "Online multiplayer" / "Local multiplayer" columns, each waiting for a partner, and an always-visible controller strip under the seats (every connected controller, seat badge in team colour, spare ones "press ✕ / A" or "seats full"). Screens `host4` (4 controllers + keyboard) and `versus8` (8, four seated). `_coop.css` holds the CSS shared by rounds 4 and 5.
