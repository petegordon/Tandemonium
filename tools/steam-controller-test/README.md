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

### Steam Input panel (left)
- `SDK init` — did `steamworks.input.init()` succeed?
- `Action handles` — `getActionSet('InGameControls')`, `getAnalogAction('Steer')`,
  `getDigitalAction('Confirm')`. Any non-zero handle means Steam parsed our
  IGA's corresponding entry. All-zero = the action manifest didn't load.
- `Captured controllers` — `getControllers()` results. Press a button on
  your pad if the list is empty.
- `IGA file presence` — checks the file exists at the Steam-managed install
  path and the local dev paths.
- `Steam controller.txt tail` — pulls IGA-relevant lines from Steam's own
  log so you can confirm Steam logged "Found App Manifest for appid 4510250".

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
