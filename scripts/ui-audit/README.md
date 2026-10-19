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
