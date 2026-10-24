# Tandemonium test script

The full pass to run before a Steam push, a demo tag or a playtest. Each check has
an ID, so a run, a bug or an issue can name it (`MC-07 failed on DualSense BT`).

## How to read the tags

Every check carries a **proposed** tag. We settle the final split in the tracking
issue; change the tag here when we do.

| Tag | Meaning |
|---|---|
| **A** | Automated today. The command is in the *Covered by* column. |
| **M→A** | Manual today, but can be automated with mocks (fake pads, fake HID, fake net, fake Steam). The mock plan is in [Automation plan](#automation-plan). |
| **M** | Manual. Needs real hardware, a real network, a person's judgement (feel, readability), or a third-party client (Steam, Google TV, Discord). |

*Covered by* names the unit test (`test/unit/…`) or smoke script (`npm run smoke:…`)
that already checks it, or "—".

## Run sheet

Copy this block into the run's issue comment.

```
Build:        web <commit> / Steam BuildID <n> / branch <dev-private|default>
Date:         YYYY-MM-DD
Tester:
Devices:      (PC + GPU, phones, TV, controllers by model and USB/BT)
Automated:    npm test ✅  typecheck ✅  smokes ✅ (list any skipped)
Failed IDs:
Not run IDs:  (and why)
```

## Test matrix

Run the whole script on the **primary** column. Run the sections marked in each
other column.

| Platform | Primary | Sections |
|---|---|---|
| Steam build, Windows (Electron) | ✅ | all |
| Desktop Chrome (web build) | ✅ | 1–9, 12 |
| iOS Safari (phone) | | 1, 2, 4 (motion, touch), 7, 11 |
| Android Chrome (phone) | | 1, 2, 4 (motion, touch), 7, 11 |
| Google TV / Android TV | | 1, 4 (gamepad), 7, 11 |
| Demo edition (`?demo=1` / demo branch) | | 10 |

Controllers to keep on the bench: keyboard, Xbox (USB), DualSense (USB **and** BT),
DualShock 4, Switch Pro, Steam Controller 2026 via Puck (two bodies), GameSir
Super Nova, a phone for the phone remote.

---

## 0. Preflight (automated gate)

Run all of these first. A failure here stops the run.

| ID | Check | Tag | Covered by |
|---|---|---|---|
| PF-01 | Unit tests pass | A | `npm test` (CI runs this on every PR and deploy) |
| PF-02 | Typecheck clean | A | `npm run typecheck` |
| PF-03 | Game loads, no console errors at the lobby | A | `npm run smoke`, `npm run audit:first30` |
| PF-04 | Boot failure shows a readable message, not a blank screen | A | `smoke:boot` |
| PF-05 | All smokes pass: `ride crash records seed daily ctas ranked tutorial lookahead ping disruptions tourist layout slingshot slingshot-aim edition quality economy achievements helping-hand phone-pad disconnect host-room geese physics no-media controller-overlay` | A | each `smoke:*` |
| PF-06 | UI and controller-core vendored copies match the lab | A | `check:ui`, `check:controller-core` |
| PF-07 | Steam upload log says `Successfully finished AppID 4510250 build` | A | build-windows.yml |

**Gap:** CI runs only PF-01. The smokes run locally. Moving them into CI is item 1
of the automation plan.

## 1. Boot and lobby

| ID | Check | Tag | Covered by |
|---|---|---|---|
| BL-01 | Cold start to mode select in under 10 s on the Steam build | M | — |
| BL-02 | Mode select shows SOLO, TOGETHER, VERSUS; SOLO lists the levels and the Slingshot card | A | `smoke`, `smoke:edition` |
| BL-03 | Build badge shows the expected version | M→A | — |
| BL-04 | Back button and B / Esc go back one step on every lobby step; root has no back | M→A | — |
| BL-05 | First-time SOLO lands in the tutorial with SKIP; returning player goes to levels | A | `smoke:tutorial` |
| BL-06 | Level cards show best time and medal for the chosen difficulty | A | `smoke:records` |
| BL-07 | Difficulty selector: Chill / Adventurous / Daredevil change the card text and bests | A | `smoke:records` |
| BL-08 | Options opens and closes from lobby with mouse, pad and Esc | M→A | — |
| BL-09 | Focus ring is visible on the first control of every screen when using a pad | M→A | — |
| BL-10 | Lobby at 390×844, 844×390, 1920×1080 and 4K: nothing clipped or overlapping | M→A | `smoke:layout` (HUD only) |
| BL-11 | Sign-in (web) and profile toggle work; signed-out play still works | M | — |

## 2. Solo rides

| ID | Check | Tag | Covered by |
|---|---|---|---|
| SR-01 | Tutorial: each step advances; calibration results and steering feel show at the end | M→A | `smoke:tutorial` (entry only) |
| SR-02 | Tutorial: you cannot fall | A | `test/unit/crash-policy` |
| SR-03 | Grandma's: clock is held until the first pedal taps, then runs | A | `smoke:ride` |
| SR-04 | Grandma's: ride to the finish; victory overlay shows time, medal, coins | A | `smoke:economy`, `smoke:achievements` |
| SR-05 | Crash: two crashes in a segment go straight back to riding; the third offers help | A | `smoke:crash` |
| SR-06 | Helping hand: repeated failure on a checkpoint makes it visibly easier | A | `smoke:helping-hand` |
| SR-07 | Disruptions warn before they act and leave Chill alone | A | `smoke:disruptions` |
| SR-08 | Geese and obstacles appear, collide and react | M | `smoke:geese` (riders only) |
| SR-09 | Game-over buttons: RESTART, Garage, Lobby, Clip all do what they say | M→A | — |
| SR-10 | Victory buttons: Next level, Play again, Garage, Lobby | M→A | — |
| SR-11 | Today's Road: same road for two players on the same day; difficulty locked | A | `smoke:daily` |
| SR-12 | Today's Road ranked: chooser on web, never in demo; share strip has no road spoilers | A | `smoke:ranked` |
| SR-13 | Expired `?daily=` link lands on today | A | `smoke:daily` |
| SR-14 | Slingshot: garage → buy upgrade → aim → launch → tally | A | `smoke:slingshot` |
| SR-15 | Slingshot aim on phone (portrait and landscape, real touch) | A | `smoke:slingshot-aim` |
| SR-16 | Slingshot ramps and big air feel right | M | — |
| SR-17 | Tourist: hidden without Maps key; two addresses plan a route; arrival result shares | A | `smoke:tourist` |
| SR-18 | Tourist on real Google 3D tiles: loads, rides, no holes in the road | M | — |
| SR-19 | Achievements unlock during a ride and appear in the list | A | `smoke:achievements` |
| SR-20 | Chaos Coins: one wallet across modes; payout on game-over and victory | A | `smoke:economy` |
| SR-21 | Garage: bike colours and outfits apply in the ride | M→A | — |
| SR-22 | PB ghost rides your best line | M→A | — |
| SR-23 | 10-minute ride: no fps decay, no memory climb | M | `probe-memory.mjs` (manual run) |

## 3. Ride feel (manual only)

These need a person. Score each 1–5 and write one line.

| ID | Check | Tag |
|---|---|---|
| RF-01 | Pedal rhythm: alternating taps feel like pedaling, not button mashing | M |
| RF-02 | Lean: the bike follows your lean without lag or overshoot | M |
| RF-03 | Wobble warning (Adventurous): you can feel a crash coming | M |
| RF-04 | Camera: chase camera never clips the riders or ground | M |
| RF-05 | Haptics on each pad: pedal beat, crash, checkpoint | M |
| RF-06 | Audio: music, pedal, crash, honk levels balanced; music toggle works | M |
| RF-07 | Goose riders lean and pedal in step with the bike | M |

## 4. Single-controller input

One player, one device. Run each device through the lobby and one Grandma's ride.

| ID | Check | Tag | Covered by |
|---|---|---|---|
| IN-01 | Keyboard: pedals, lean, menu navigation, Esc | M→A | `smoke:ride` (taps) |
| IN-02 | Touch (phone): on-screen pedals and joystick | M→A | — |
| IN-03 | Phone motion, iOS: permission prompt, calibration, lean by tilt | M | `test/unit/tilt-calibration` |
| IN-04 | Phone motion, Android: same as IN-03 | M | — |
| IN-05 | Xbox pad: pedals on triggers/bumpers, lean on stick, menu A/B | M→A | — |
| IN-06 | DualSense USB: buttons, gyro lean via WebHID | M | lab `playstation-driver` |
| IN-07 | DualSense BT: same as IN-06, including the grant toggle | M | lab `playstation-bt-handshake` |
| IN-08 | DualShock 4: buttons and gyro | M | lab fixtures |
| IN-09 | Switch Pro: buttons with A/B swap, Switch glyphs on prompts | M→A | `test/unit/controller-labels` |
| IN-10 | Steam Controller via Puck: name reads "Steam Controller 2026 (via Puck)", Steam glyphs, gyro | M | `test/unit/controller-labels`, lab `steam-controller-*` |
| IN-11 | GameSir Super Nova: buttons and gyro | M | lab fixture |
| IN-12 | Steam Input on (Steam build): gyro comes from Steam Input; Options shows the source | M | `test/unit/steam-steer-curve` |
| IN-13 | Options → DS source Auto / WebHID / Steam switches live | M→A | — |
| IN-14 | Options → gyro Euler / Gravity changes lean feel | M | `test/unit/tuning-save-gyro` |
| IN-15 | Recalibrate from the quick menu mid-ride | M→A | — |
| IN-16 | Button prompts match the pad in use (Xbox / PlayStation / Switch / Steam) | M→A | `test/unit/controller-labels` |
| IN-17 | Unplug the only pad mid-ride: "Your controller disconnected" pause; replug resumes | A | `smoke:disconnect` (faked pad) |
| IN-18 | IN-17 on real hardware, USB and BT | M | — |

## 5. Multi-controller (local co-op and versus)

The main automation target. Every **M→A** row here can run against fake pads; the
real-hardware rows stay manual.

### Local co-op (TOGETHER → this device)

| ID | Check | Tag | Covered by |
|---|---|---|---|
| MC-01 | P1 on keyboard, P2 joins with a pad press; P2 takes the stoker seat | M→A | `smoke:host-room` (seat only) |
| MC-02 | Two pads: first press is P1, second is P2 | M→A | — |
| MC-03 | P1 is a keyboard placeholder; the first pad takes P1 (#467) | M→A | — |
| MC-04 | P2 joins on keyboard while P1 has a pad | M→A | — |
| MC-05 | Each seat's pedals and lean drive only that rider | M→A | — |
| MC-06 | Captain and stoker geese lean independently by their own input | M | — |
| MC-07 | Unplug P2 mid-ride: pause, 20 s countdown, "Ride on alone" works | A | `smoke:disconnect` |
| MC-08 | Unplug P1 mid-ride: "Player 2: take over" after 20 s; P2 now rides | A | `smoke:disconnect` |
| MC-09 | Replug within 20 s: ride resumes, same seats | A | `smoke:disconnect` |
| MC-10 | MC-07 to MC-09 with real pads, USB and BT | M | — |
| MC-11 | Two identical pads (two DualSense): each keeps its own seat after replug | M→A | lab `manager-duplicate-controllers` |
| MC-12 | Two Steam Controller bodies on one Puck: two seats, no cross-wiring | M | lab `manager-multi-steam-claim` |
| MC-13 | Mixed families (DualSense + Switch Pro): each seat's prompts use its own glyphs | M→A | — |
| MC-14 | Menu focus: either pad can drive menus; no double moves | M→A | — |
| MC-15 | Phone remote as P2 next to a pad as P1 | M→A | `smoke:phone-pad` (single) |

### Versus (split screen)

| ID | Check | Tag | Covered by |
|---|---|---|---|
| VS-01 | Team setup: seats fill in join order; team sizes balance | M→A | — |
| VS-02 | 1v1, 1v2, 2v2 all start and render the right number of views | M→A | — |
| VS-03 | Keyboard join button seats a keyboard player | M→A | — |
| VS-04 | Each seat shows its own controller name and glyph | M→A | `test/unit/controller-labels` |
| VS-05 | Versus bot fills an empty seat | A | `test/unit/versus-bot` |
| VS-06 | Race finishes; results show the winning team | M→A | — |
| VS-07 | Pad unplug in versus does not trigger the co-op drop pause | M→A | — |
| VS-08 | 2v2 at 1080p holds frame rate on the target PC | M | — |

## 6. Online co-op (TOGETHER → online)

Two devices on different networks for the M rows.

| ID | Check | Tag | Covered by |
|---|---|---|---|
| OC-01 | Captain hosts, gets a room code; stoker joins with it | M→A | `smoke:host-room` (fake net) |
| OC-02 | Room step: both players shown, seat labels right, Start enabled for captain | A | `smoke:host-room` |
| OC-03 | Camera and mic off by default; turning them on shows PiP both sides | A / M | `smoke:no-media` / — |
| OC-04 | Ride stays in sync: stoker sees the captain's bike, no rubber-banding | M | `test/unit/remote-bike-state` |
| OC-05 | Stoker lookahead shows road past the captain view; Chill turns it off | A | `smoke:lookahead` |
| OC-06 | Sync sprint and emotes reach the other seat | A | `smoke:ping` |
| OC-07 | Short drop (< 2 s): no pause | M→A | — |
| OC-08 | Drop > 2 s: both pause with "lost connection"; reconnect resumes | A | `smoke:disconnect` (fake net) |
| OC-09 | Drop > 20 s: captain "Ride on alone", stoker "Take over the bike"; ride becomes solo | A | `smoke:disconnect` |
| OC-10 | OC-07 to OC-09 on two real devices (pull the network on one) | M | — |
| OC-11 | End ride / Back to room returns both to the room; media keeps flowing | M→A | — |
| OC-12 | Rejoin after closing the tab | M | — |
| OC-13 | Co-op tutorial: captain and stoker flows | M→A | — |
| OC-14 | Co-op Tourist: both see the same world | A | `smoke:tourist` |
| OC-15 | Steam build ↔ web build in the same room | M | `test/unit/room-edition` |

## 7. Phone remote

| ID | Check | Tag | Covered by |
|---|---|---|---|
| PR-01 | QR shows from mode select; phone scans and pairs | A / M | `smoke:phone-pad` / real phone |
| PR-02 | QR is single-use; a second phone gets refused and the game shows a takeover notice | M→A | `test/unit/phone-pad` |
| PR-03 | Phone menu pad drives lobby focus | A | `smoke:phone-pad` |
| PR-04 | Phone pedal and lean drive a ride | A | `smoke:phone-pad` |
| PR-05 | Phone drop mid-ride: lean eases to centre, reconnect resumes | M→A | — |
| PR-06 | B / Start closes the QR panel; "Stop using phone" releases it | M→A | — |
| PR-07 | Old Steam build pairs with the newest `/remote/` page (`hello {v}`) | M→A | `test/unit/phone-pad` |
| PR-08 | Google TV: PR-01, PR-05, PR-06 (deferred from #454) | M | — |

## 8. Options and quality

| ID | Check | Tag | Covered by |
|---|---|---|---|
| OP-01 | High / Medium / Low boot correctly and switch live | A | `smoke:quality` |
| OP-02 | Auto steps down when slow and back up after steady 50+ fps (#466) | A | `test/unit/quality` |
| OP-03 | A learned tier expires after 3 days | A | `test/unit/quality` |
| OP-04 | FPS readout, perf HUD, AA, line-resolution options each apply | M→A | — |
| OP-05 | Riders on / off, outfits, colours apply without a reload | M→A | — |
| OP-06 | Physics FX on / off | A | `smoke:physics` |
| OP-07 | Display Testing overrides apply and Reset clears them | M→A | — |
| OP-08 | Settings survive a restart (web and Steam) | M→A | — |
| OP-09 | Visual check of each tier on the target PC and a weak laptop | M | — |

## 9. Steam build specifics

| ID | Check | Tag | Covered by |
|---|---|---|---|
| ST-01 | Launches from Steam on the dev-private branch | M | — |
| ST-02 | Launches with the network off; three.js and the Draco decoder load locally (#465) | M | `test/unit/local-vendors` |
| ST-03 | Steam overlay (Shift+Tab) opens over the game | M | — |
| ST-04 | Achievements unlock in the Steam client | M | `tandemonium:sync-steam-achievements` (definitions only) |
| ST-05 | Fullscreen / windowed toggle; window size is remembered | M | — |
| ST-06 | Steam Deck / Big Picture: pad-only navigation of every screen | M | — |
| ST-07 | Wishlist CTA opens the store page inside the Steam build | M | — |

## 10. Editions (demo vs full)

| ID | Check | Tag | Covered by |
|---|---|---|---|
| ED-01 | Demo shows Tutorial, Grandma's, This Week's Road, Slingshot; no Tourist | A | `smoke:edition` |
| ED-02 | Demo-gated items show a wishlist hint, not a dead lock | A | `smoke:edition`, `smoke:ctas` |
| ED-03 | No ranked runs, streaks or share strip in the demo | A | `smoke:ranked` |
| ED-04 | Wishlist and invite buttons fit at 390 px | A | `smoke:ctas` |
| ED-05 | The real demo build on Steam matches ED-01 to ED-03 | M | — |

## 11. Layout and readability

| ID | Check | Tag | Covered by |
|---|---|---|---|
| LY-01 | Every in-ride overlay at once: no overlap at desktop and phone sizes | A | `smoke:layout` |
| LY-02 | Disconnect overlay buttons line up at every size | M→A | `smoke:disconnect` (screenshots) |
| LY-03 | TV at 3 m: all text readable, focus ring obvious | M | — |
| LY-04 | Phone portrait and landscape: HUD clear of notches and home bar | M | — |
| LY-05 | A non-gamer can start a ride without help (playtest protocol) | M | `docs/playtests/2026-11-protocol.md` |

## 12. Data and backend

| ID | Check | Tag | Covered by |
|---|---|---|---|
| DB-01 | Dashboard SQL valid against the schema | A | `check:dashboard-sql` |
| DB-02 | A ride's analytics events (`ride_start`, `crash_recover`, `ride_takeover`, …) reach the dashboard | M | — |
| DB-03 | Today's Road leaderboard records a ranked run | M | — |
| DB-04 | Pad relay rate limit refuses scripted room floods | M→A | — |

---

## Automation plan

Most of the remaining **M→A** rows are input and flow checks, and most of those
are multi-controller. They need four mocks. Two exist already.

| Mock | What it fakes | Status |
|---|---|---|
| **Fake net** | Two pages wired together in place of the room transport | Exists (`smoke:host-room`, `smoke:tourist`, `smoke:disconnect`) |
| **Pad relay** | Real `worker/pad-relay.js` under `wrangler dev` | Exists (`smoke:phone-pad`) |
| **Fake Gamepad API** | `navigator.getGamepads()` returning scripted pads with a given id string (so each family's name and glyph is picked), plus `gamepadconnected` / `gamepaddisconnected` events and a per-frame button/axis script | To build |
| **Fake WebHID** | `navigator.hid` handing out devices that replay the lab's recorded reports (`controller-lab/packages/core/test/fixtures`), including duplicates and the Puck's two interfaces | To build; the lab's manager tests already use this pattern |
| **Fake Steam bridge** | The Electron preload's Steam Input calls (handles, type, gyro) | To build |

Order of work:

1. **Smokes in CI.** Run PF-05 on every PR (headless Chrome is already what they
   use). The phone-pad smoke needs `wrangler dev` on the runner.
2. **Fake Gamepad API helper** in `scripts/lib/`, then a `smoke:local-coop` covering
   MC-01 to MC-05, MC-13, MC-14 and a `smoke:versus` covering VS-01 to VS-04,
   VS-06, VS-07. Move `smoke:disconnect` from its property overrides onto the
   helper so it tests the real connect / disconnect path.
3. **Fake WebHID** with the lab fixtures: IN-06 to IN-11 at the parsing level and
   MC-11 duplicate seats. Gyro *feel* stays manual.
4. **Flow sweeps**: one smoke that walks every lobby step with B / Esc (BL-04,
   BL-08, BL-09) and every game-over and victory button (SR-09, SR-10).
5. **Fake Steam bridge**: IN-12, IN-13.

What stays manual for good: ride feel (section 3), real Bluetooth and USB
pairing, phone sensors, the Steam client, Google TV, two real networks, frame
rate on real GPUs, and playtests with people.
