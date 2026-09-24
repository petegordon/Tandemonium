# Steam Controller Test Bench

Isolated Electron harness for exercising Steam Input + WebHID against a
Steam Controller / DualSense WITHOUT the Tandemonium game on top.

The goal is to make it obvious whether any controller issue is a
Steam-side problem (Steam Input not loading our IGA, action set not
recognized, getControllers() empty) or a game-side problem.

## Run

From the repo root:

```
npm run steamtest
```

(Requires Steam running. Identifies the process as Tandemonium Playtest
app **4510250** so Steam Input uses the same registered IGA path we set
up in Steamworks > App > Controller > Steam Input Default Controller
Configuration > Custom Configuration.)

## What's in the window

Three independent signal sources, so you can locate where the chain breaks
when no controller is detected.

### Steam Input panel (left)
- `SDK init` — did `steamworks.input.init()` succeed?
- `Session config bitmask` — `getSessionInputConfigurationSettings()`. Non-zero
  means Steam Input has at least one controller-type enabled for this app.
- `Action handles` — `getActionSet('InGameControls')`, `getAnalogAction('Steer')`,
  `getDigitalAction('Confirm')`. Any non-zero handle means Steam parsed our
  IGA's corresponding entry. All-zero = the action manifest didn't load.
- `Gamepad-index probe` — `getControllerForGamepadIndex(0..3)`, a secondary
  enumeration path. Useful when `getConnectedControllers()` returns empty but
  Steam Input still sees a pad in an XInput slot.
- `Captured controllers` — union of the two enumeration paths. Each row has
  steer/confirm values, motion data when supported, and a button to open the
  Steam binding panel directly for that controller.
- `IGA file presence` — checks the file exists at the Steam-managed install
  path and the local dev paths.
- `Steam controller.txt tail` — pulls IGA-relevant lines from Steam's own
  log so you can confirm Steam logged "Found App Manifest for appid 4510250".
- Idle-time hints appear if Steam Input has been ready >5s but enumeration
  returns nothing — calls out the likely cause (Steam not running, process not
  Steam-launched, configuration support disabled, etc).

### Gamepad API panel (middle)
- Polls `navigator.getGamepads()` at 10 Hz. Independent of Steam Input.
- If a pad appears here but NOT under Steam Input, the OS sees it but Steam
  isn't claiming it for this app — pointing at a Steam-side problem rather
  than a hardware or driver problem.

### WebHID panel (right)
- Connect buttons (need a user gesture) — Steam Controller / DualSense / Any
- Live device list
- Last 5 raw input reports (hex)

### Copy diagnostic snapshot
Footer button — copies a markdown-formatted snapshot of everything above to
the clipboard. Paste into a Valve developer support ticket or a GitHub issue.

## Adding a new controller filter

Edit `HID_FILTERS` at the top of `renderer.js`. e.g. Steam Controller v2
when it lands:

```
'steam-controller-v2': [{ vendorId: 0x28de, productId: 0x????? }],
```

Then add a button in `index.html`:

```
<button class="connect-btn" data-target="steam-controller-v2">Connect Steam Controller v2</button>
```

## Files

- `main.js` - Electron main process, steamworks.js init, IPC handlers
- `preload.js` - exposes `window.steamTest` to the renderer
- `index.html` - single-page UI layout
- `renderer.js` - WebHID + Steam Input rendering, copy-repro button
- `styles.css` - layout / colors

No separate `package.json` - reuses the repo root's `node_modules/`.
