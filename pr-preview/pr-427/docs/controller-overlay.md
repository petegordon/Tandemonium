# In-game controller overlay

Press **C** during a ride (or open the quick menu and tap **CONTROLLERS**) and
each rider's physical controller appears in a corner of the screen as a live 3D
model: buttons sink, sticks tilt, triggers pull, the body follows the gyro, a
DualSense touchpad or Steam Controller trackpad shows the finger. The choice is
remembered across launches.

The tiles read the **same ControllerManager slots the game steers from**, so
what a tile shows is exactly what the game is receiving. That is the point: a
stuck stick, a pad the manager claimed for the wrong seat, gyro drift, a
Bluetooth pad that stopped reporting — all visible at a glance, without leaving
the ride or opening a test page.

Rendering is the lab's `@usersfirst/controller-visualizer`
([tandemonium-controller-lab](https://github.com/UsersFirst/tandemonium-controller-lab)),
vendored under `shared/visualizer/` by the same tag-pinned sync that vendors the
drivers (`npm run sync-controller-core` / `npm run check:controller-core`). The
in-game glue is `js/controller-overlay-hud.js`.

## Where the tiles go

| Situation | Layout |
|---|---|
| Solo, online captain, online stoker | One tile, **lower-right** (your own pad — always slot P1). |
| Local co-op | **P1 lower-right** (the same corner as solo), **P2 lower-left**, in the player colours (green / coral). |
| Versus (split screen) | **Team A's riders in the lower-left of the left half, Team B's riders in the lower-right of the right half.** Captain outermost, stoker beside it, tinted in the team colour. |
| Lobby | Every claimed slot, lower-right, P1 outermost — the "which pad is which" identify view (#241). |

### Under Steam

Steam re-emits every controller it captures as a virtual XInput device, so the
Gamepad API id of a DualSense literally reads "Xbox 360 Controller". The tile
therefore identifies a pad the way the game arbitrates input, WebHID first:
the slot's bound HID device (vendor:product in the registry) → the driver's
registry entry → **Steam Input's controller type** (when the seat's
InputManager is steering from Steam) → the gamepad id → id sniffing. When
Steam owns the pad exclusively and Electron surfaces no Gamepad-API device at
all, the seat has no slot; the tile is then driven from the InputManager's
synthetic Steam Input gamepad (the bound actions) and its per-handle motion
fusion, so the model still moves and still tilts with the gyro.

Each tile's sub-title names the pad **and the source that fed it** — `DualSense ·
Steam`, `Sony DualSense · WebHID`, `Xbox Wireless (BT) · Pad` — so a photo of
the tile says which arbitration won. An idle Steam Puck receiver interface
(a fan-out sibling that has never streamed) is never treated as a controller,
for identity or for gyro.

Tiles never cover what the ride already draws in a corner: they lift above the
pedal bar and slide sideways past the front-view selfie cam and the partner
webcam PiP, re-measuring a few times a second and on resize.

### Why the outer corners for versus (P3 / P4)

Versus is two split-screen halves, each with its own front view (lower-right of
the half) and pedal bar (bottom-centre of the half). Three placements were
considered for four controllers:

1. **A strip of four across the bottom** (P1 P2 | P3 P4). Reads well as a
   roster but every tile sits over one team's pedal bar or front view, and a
   rider on the left has to look under the *other* team's viewport to find
   their pad.
2. **Both riders of each team stacked vertically in their half's outer
   corner.** Keeps team grouping but the stack climbs into the middle of a
   viewport that is already only half a screen wide.
3. **Each team's riders side by side in their half's outer bottom corner**
   (chosen). Each rider glances at their own half's outer corner; the team
   colour and the captain-outermost order say who is who; the inner corners
   stay free for the front views; a solo team simply shows one tile.

Option 3 is what ships. The tile size scales with the smaller screen dimension,
so two tiles fit beside a half's pedal bar at 1280×720 and up.

## Cost

Nothing while off. On first enable the visualizer module (plus the Three
addons it needs) is imported, and each tile gets a small WebGL canvas with its
own render loop. Everything is created on enable and disposed on disable —
the same lazy-create / dispose the lab's multi-controller overlay uses — so
the game loop's only per-frame work is one `update(gamepad, quaternion)` per
tile. Four tiles in versus is four small extra contexts; that is acceptable
for an opt-in view on desktop, and the tiles are hidden during the finish
cinematic and results.

## Testing

- `test/controller-overlay.html` — the HUD with fake slots and self-animating
  synthetic pads; switch scenarios (solo / local / versus / lobby) and toggle
  stand-ins for the front view, partner PiP and pedal bars to watch the tiles
  dodge them.
- `node scripts/smoke-controller-overlay.mjs` — drives that page headless
  (Playwright + a local `three`) and asserts tile count, corner, model load,
  no overlaps, and no covered widgets for every scenario × obstacle set.

## Follow-ups

- An Options toggle next to Show Riders, for players who never open the quick
  menu (the versus HUD hides the quick-menu button; **C** still works there).
- A gamepad chord to toggle it (the lab overlay uses button combos), so a
  controller-only TV-mode player can reach it.
- Online multiplayer: the partner's pad. The stoker's input already crosses the
  wire as taps + lean, not button state; showing it would need a small state
  message (or just the pedal/lean HUD that exists) — not planned.
- Compact mode: one row of small silhouettes instead of 3D, for low-end GPUs.
