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
| PF-05 | All smokes pass | A | `npm run smoke:all` (list in `scripts/run-smokes.mjs`); CI: `smokes.yml` |
| PF-06 | UI and controller-core vendored copies match the lab | A | `check:ui`, `check:controller-core` |
| PF-07 | Steam upload log says `Successfully finished AppID 4510250 build` | A | build-windows.yml |

CI: `pr-preview.yml` runs PF-01, PF-06 (UI) and the lobby smokes on every PR.
`smokes.yml` runs every smoke in parallel groups by hand only
(`gh workflow run smokes.yml --ref main`); locally, `npm run smoke:all`.

## 1. Boot and lobby

| ID | Check | Tag | Covered by |
|---|---|---|---|
| BL-01 | Cold start to mode select in under 10 s on the Steam build | M | — |
| BL-02 | Mode select shows SOLO and TOGETHER (VERSUS is on the TOGETHER step); SOLO lists the levels and the Slingshot card | A | `smoke`, `smoke:edition` |
| BL-03 | Build badge: none on a local build; "PR #n · sha" on a preview; a newer deploy offers a reload | A | `smoke:options` |
| BL-04 | Back button and B / Esc go back one step on every lobby step; root has no back | A | `smoke:flows` |
| BL-05 | First-time SOLO lands in the tutorial with SKIP; returning player goes to levels | A | `smoke:tutorial` |
| BL-06 | Level cards show best time and medal for the chosen difficulty | A | `smoke:records` |
| BL-07 | Difficulty selector: Chill / Adventurous / Daredevil change the card text and bests | A | `smoke:records` |
| BL-08 | Options opens and closes from lobby with mouse, pad and Esc | A | `smoke:flows` |
| BL-09 | Pad focus starts on a visible control on every lobby step | A | `smoke:flows` |
| BL-10 | Every lobby step at 390×844, 844×390, 1920×1080 and 4K: every control reachable, none overlapping | A | `smoke:lobby-layout` |
| BL-11 | Sign-in (web) and profile toggle work; signed-out play still works | M | — |

## 2. Solo rides

| ID | Check | Tag | Covered by |
|---|---|---|---|
| SR-01 | Tutorial: runway, phase 1 (collect) and phase 2 (collect + dodge) prompts advance; all presents and pylons count; the end screen shows the tally, saves the calibration, the feel slider sets the feel; NEXT offered | A | `smoke:solo-extras` |
| SR-01h | Lean-steering onto the tutorial presents feels learnable | M | — |
| SR-02 | Tutorial: you cannot fall | A | `test/unit/crash-policy` |
| SR-03 | Grandma's: clock is held until the first pedal taps, then runs | A | `smoke:ride` |
| SR-04 | Grandma's: ride to the finish; victory overlay shows time, medal, coins | A | `smoke:economy`, `smoke:achievements` |
| SR-05 | Crash: two crashes in a segment go straight back to riding; the third offers help | A | `smoke:crash` |
| SR-05b | Crash: the bike falls once from the lean it crashed at — never pops upright and falls again (#483; Physics FX off shows it) | A | `test/unit/crash-tumble`, `node scripts/reel/crash-probe.mjs --fx off` (manual, GPU) |
| SR-05c | Crash (Physics FX on): both geese are thrown as rag dolls, hats fly, the view slows for a moment with the clock held, then the riders are back in their seats at the checkpoint (#484) | A | `smoke:physics` (crash scene), `test/unit/crash-ragdoll`, `node scripts/reel/crash-probe.mjs` (manual, GPU) |
| SR-05d | SR-05c looks right and is funny: no geese through the floor, no jitter, versus slows only the crashing half | M | `node scripts/reel/crash-review.mjs` (review video) |
| SR-05e | Rag dolls have weight and are not rubbery (#507): no bounce, limbs settle instead of flailing, knees/elbows never fold the wrong way, the neck stays the loose one | A | `npm run sim:ragdoll` (Node, Rapier; `--scene` compares with main), `test/unit/crash-ragdoll` |
| SR-05e | Crash (Physics FX on, goose tandem): the bike comes apart (wheels roll off, bars and saddles fly), nothing sinks, and it is whole again at the checkpoint (#484) | A | `smoke:physics` (bike apart), `test/unit/crash-bike-apart` |
| SR-05f | Versus: a part from one team's crash that reaches the other team wobbles it (once), never crashes it outright; never in online modes (#484) | A | `smoke:physics` (versus hit), `test/unit/crash-bike-apart`, `node scripts/reel/crash-review.mjs versus` (manual, GPU) |
| SR-06 | Helping hand: repeated failure on a checkpoint makes it visibly easier | A | `smoke:helping-hand` |
| SR-07 | Disruptions warn before they act and leave Chill alone | A | `smoke:disruptions` |
| SR-08 | Geese and obstacles appear, collide and react | M | `smoke:geese` (riders only) |
| SR-09 | Game-over buttons: RESTART, END RIDE, SAVE CLIP (only while recording) do what they say; no GARAGE outside Slingshot | A | `smoke:flows`, `smoke:economy` |
| SR-09h | SAVE CLIP opens the clip preview after a recorded ride | M | — |
| SR-10 | Victory buttons: NEXT LEVEL, PLAY AGAIN, END RIDE | A | `smoke:flows` |
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
| SR-21 | Options → goose outfit and colourway apply to the geese on the bike, chosen in the lobby or live mid-ride; "own colours" restores; saved for the next ride | A | `smoke:solo-extras` |
| SR-22 | (PB ghost removed in #400) old saved ghost tracks are dropped, times kept | A | `test/unit/records` |
| SR-23 | 10-minute ride: no fps decay, no memory climb | M | `probe-memory.mjs` (manual run) |
| SR-24 | Grandma's and Today's Road finish: Grandma waves at the roadside on the final approach; outhouse, woodpile and a Timber pine by the house (#475) | A | `smoke:grandma`, `test/unit/grandma-finish` |
| SR-24h | SR-24 looks right: scale, placement, wave reads from the chase camera, no frame drop on Low | M | — |
| SR-25 | 3D present, death cone and Grandma's house (no video billboards); presents still collect, cones still crash and get knocked flying; after the finish the ride's presents fly into a pile beside Grandma (#478) | A | `smoke:props`, `test/unit/props-3d`, `test/unit/present-stack` |
| SR-25h | SR-25 looks right: presents and cones read from the chase camera, the pile lands neatly and is seen during the finish swing, no frame drop on Low / phone / Quest | M | `scripts/review-props.mjs`, `scripts/probe-props.mjs` |
| SR-26 | Bike × geese fit (#505): hips HIP_UP over the socket, feet on the pedals through a crank turn, hands at the grips, body on the saddle, bike's rear end clear of the tyre, for every outfit and Show Solo; measured on the in-game assembly | A | `smoke:fit` (KNOWN BUG lines while the assets are being fixed), `test/unit/fit-rules` |
| SR-26h | SR-26 looks right in the fit viewer (`npm run fit-viewer`: orbit, snap views, close-ups, X-ray, section plane, markers, nudges) | M | `tools/fit-viewer`, screenshots in `renders/fit/` |

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
| IN-01 | Keyboard: ←/→ pedal, A/D lean; Tab/Enter move and pick in the lobby, Esc backs out (arrows are pedals, not menu keys) | A | `smoke:input` |
| IN-02 | Touch (phone): the on-screen pedal bar pedals (one half per pedal; lifting releases). Phone steering is tilt (IN-03/04) | A | `smoke:input` |
| IN-03 | Phone motion, iOS: permission prompt, calibration, lean by tilt | M | `test/unit/tilt-calibration` |
| IN-04 | Phone motion, Android: same as IN-03 | M | — |
| IN-05 | Xbox pad: triggers and bumpers pedal, left stick leans, D-pad moves menu focus, A picks, B backs | A | `smoke:input` |
| IN-06 | DualSense USB: seat binds the HID device, buttons parse, gyro live, PlayStation prompts | A | `smoke:webhid` |
| IN-06h | IN-06 on a real DualSense: gyro lean feels right | M | — |
| IN-07 | DualSense BT: same as IN-06, including the grant toggle | M | lab `playstation-bt-handshake` |
| IN-08 | DualShock 4 (BT): BT detected, feature read sent, reports parse, gyro live | A | `smoke:webhid` |
| IN-09 | Switch Pro: Switch glyphs on prompts (no A/B swap under Chrome's standard mapping) | A | `smoke:local-coop`, `test/unit/controller-labels` |
| IN-10 | Steam Controller via Puck: lizard-mode handshake, seats on A, "Steam Controller 2026 (via Puck)", Steam glyphs, gyro live | A | `smoke:webhid` |
| IN-10h | IN-10 on a real Puck + controller | M | — |
| IN-11 | GameSir Super Nova: IMU layout, gyro live (WebHID can't tell it from a DS4 v2, so it's named "Sony DualShock 4 v2") | A | `smoke:webhid` |
| IN-11h | IN-11 on a real Super Nova | M | — |
| IN-12 | Steam Input holds the pad: seat connects, Confirm and pedals work, gyro lean from Steam motion, Steer fallback, Options names the source | A | `smoke:steam-input`, `test/unit/steam-steer-curve` |
| IN-12h | IN-12 in the real Steam client: lean feels right | M | — |
| IN-13 | Options → DS source Auto / WebHID / Steam is saved and applies on next launch | A | `smoke:steam-input` |
| IN-14 | Options → gyro Euler / Gravity changes lean feel | M | `test/unit/tuning-save-gyro` |
| IN-15 | Recenter from the quick menu mid-ride (tilt steering): the held tilt becomes the new centre; the ride carries on | A | `smoke:input` |
| IN-16 | Button prompts follow P1's pad (Xbox / PlayStation / Switch / Steam): lobby glyphs, coach card, stopped-bike hint | A | `smoke:input`, `test/unit/controller-labels` |
| IN-17 | Unplug the only pad mid-ride: "Your controller disconnected" pause; replug resumes | A | `smoke:disconnect` |
| IN-18 | IN-17 on real hardware, USB and BT | M | — |

## 5. Multi-controller (local co-op and versus)

The main automation target. Every **M→A** row here can run against fake pads; the
real-hardware rows stay manual.

### Local co-op (TOGETHER → this device)

| ID | Check | Tag | Covered by |
|---|---|---|---|
| MC-01 | One pad + keyboard: the pad is always P1 (captain); the keyboard joins as Player 2 in the stoker seat | A | `smoke:local-coop` |
| MC-02 | Two pads: the boot pad is P1; the second pad's first press seats P2; a second press doesn't reseat | A | `smoke:local-coop` |
| MC-04 | P2 joins on keyboard while P1 has a pad; the keyboard pedals only P2 | A | `smoke:local-coop` |
| MC-05 | Each seat's pedals and lean drive only that rider | A | `smoke:local-coop` |
| MC-06 | Captain and stoker geese lean independently by their own input | M | — |
| MC-07 | Unplug P2 mid-ride: pause, 20 s countdown, "Ride on alone" works | A | `smoke:disconnect` |
| MC-08 | Unplug P1 mid-ride: "Player 2: take over" after 20 s; P2 now rides | A | `smoke:disconnect` |
| MC-09 | Replug within 20 s: ride resumes, same seats | A | `smoke:disconnect` |
| MC-10 | MC-07 to MC-09 with real pads, USB and BT | M | — |
| MC-11 | Two identical pads (two DualSense): each keeps its own seat after one drops and reconnects | A | `smoke:webhid` |
| MC-12 | Two Steam Controller bodies on one Puck: two seats, no cross-wiring; the idle interface takes no seat | A | `smoke:webhid` |
| MC-12h | MC-12 on a real Puck with two controllers | M | — |
| MC-13 | Mixed families (DualSense + Switch Pro): each seat's prompts use its own glyphs | A | `smoke:local-coop` |
| MC-14 | Menu focus: P1's pad moves focus one step per press; no double moves. P2's pad does not drive menus (decided 2026-10-25) | A | `smoke:local-coop` |
| MC-15 | Phone remote as local Player 2 next to a pad as P1: not built yet (P4 phase, #455) | M | `smoke:phone-coop` prints NOT BUILT |
| MC-15b | A phone next to a pad: both drive P1's seat (what the game does today) | A | `smoke:phone-coop` |

### Versus (split screen)

| ID | Check | Tag | Covered by |
|---|---|---|---|
| VS-01 | Team setup: seats fill in join order; teams alternate and balance; a fifth pad is refused | A | `smoke:versus` |
| VS-02 | 1v1, 1v2, 2v2 all start and render two half-width views | A | `smoke:versus` |
| VS-03 | Keyboard join seats one keyboard player | A | `smoke:versus` |
| VS-03b | P1 is a keyboard placeholder; the first pad takes P1 (#467) | A | `smoke:versus`, `smoke:local-coop` |
| VS-04 | Each seat shows its own controller name and glyph | A | `smoke:versus` |
| VS-05 | Versus bot fills an empty seat | A | `test/unit/versus-bot` |
| VS-06 | Race finishes; results show the winning team; LOBBY returns | A | `smoke:versus` (finish fast-forwarded) |
| VS-07 | Pad unplug in versus freezes both teams with versus's own notice (no co-op 20 s take-over); replug resumes | A | `smoke:versus` |
| VS-08 | 2v2 at 1080p holds frame rate on the target PC | M | — |

## 6. Online co-op (TOGETHER → online)

Two devices on different networks for the M rows.

| ID | Check | Tag | Covered by |
|---|---|---|---|
| OC-01 | Captain hosts and gets a room code; the stoker joins with it; both connected over the real relay; the partner shows on the host step | A | `smoke:online` |
| OC-02 | Room step: both players shown, seat labels right, Start enabled for captain | A | `smoke:host-room` |
| OC-03 | Camera and mic off by default; turning them on shows PiP both sides | A / M | `smoke:no-media` / — |
| OC-04 | Ride stays in sync: stoker sees the captain's bike, no rubber-banding | M | `test/unit/remote-bike-state` |
| OC-05 | Stoker lookahead shows road past the captain view; Chill turns it off | A | `smoke:lookahead` |
| OC-06 | Sync sprint and emotes reach the other seat | A | `smoke:ping` |
| OC-07 | A short transport drop (< 2 s) mid-ride redials with no pause on either side | A | `smoke:online` |
| OC-07b | A raw relay socket close (server/network drop) is redialled at once, no pause on either side | A | `smoke:online` |
| OC-08 | Drop > 2 s: both pause with "lost connection"; reconnect resumes | A | `smoke:disconnect` (fake net) |
| OC-09 | Drop > 20 s: captain "Ride on alone", stoker "Take over the bike"; ride becomes solo | A | `smoke:disconnect` |
| OC-10 | OC-07 to OC-09 on two real devices (pull the network on one) | M | — |
| OC-11 | BACK TO ROOM after a ride returns both to level select on the same room, still connected; captain picks, stoker waits | A | `smoke:online` |
| OC-11h | Camera/mic PiP keep flowing across the return (PeerJS: needs its CDN and signalling server) | M | — |
| OC-12 | Rejoin after closing the tab | M | — |
| OC-13 | Co-op tutorial: the stoker waits for the captain's countdown, both ride, it completes on both, both return to the room | A | `smoke:online` |
| OC-14 | Co-op Tourist: both see the same world | A | `smoke:tourist` |
| OC-15 | Steam build ↔ web build in the same room | M | `test/unit/room-edition` |

## 7. Phone remote

| ID | Check | Tag | Covered by |
|---|---|---|---|
| PR-01 | QR shows from mode select; phone scans and pairs | A / M | `smoke:phone-pad` / real phone |
| PR-02 | QR is single-use; a second phone gets refused and the game shows a takeover notice | A | `smoke:phone-pad`, `test/unit/phone-pad` |
| PR-03 | Phone menu pad drives lobby focus | A | `smoke:phone-pad` |
| PR-04 | Phone pedal and lean drive a ride | A | `smoke:phone-pad` |
| PR-05 | Phone drop mid-ride: lean eases to centre over ~300 ms (no snap); reconnect, and the phone drives again | A | `smoke:phone-pad` |
| PR-06 | With a pad, B / Start close the QR panel (the menu stays put); "Stop using phone" lets the phone go (game stops reading it, the phone is told) | A | `smoke:phone-coop` |
| PR-07 | Old Steam build pairs with the newest `/remote/` page; an older phone pairs with this game (`hello {v}`) | A | `smoke:phone-pad`, `test/unit/phone-pad` |
| PR-08 | Google TV: PR-01, PR-05, PR-06 (deferred from #454) | M | — |

## 8. Options and quality

| ID | Check | Tag | Covered by |
|---|---|---|---|
| OP-01 | High / Medium / Low boot correctly and switch live | A | `smoke:quality` |
| OP-02 | Auto steps down when slow and back up after steady 50+ fps (#466) | A | `test/unit/quality` |
| OP-03 | A learned tier expires after 3 days | A | `test/unit/quality` |
| OP-04 | FPS readout (live), perf readout, edge smoothing and render lines each apply | A | `smoke:options` |
| OP-05 | Riders on / off, outfits, colours apply without a reload | A | `smoke:options` |
| OP-06 | Physics FX on / off | A | `smoke:physics` |
| OP-07 | Display Testing overrides apply after the self-reload; Reset clears them | A | `smoke:options` |
| OP-08 | Settings survive a restart (web) and are in effect | A | `smoke:options` |
| OP-08h | OP-08 in the Steam build (Electron storage) | M | — |
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
| LY-02 | Disconnect overlay in each button set: on screen, in its box, no overlaps, rows aligned and centred | A | `smoke:lobby-layout` |
| LY-03 | TV at 3 m: all text readable, focus ring obvious | M | — |
| LY-04 | Phone portrait and landscape: HUD clear of notches and home bar | M | — |
| LY-05 | A non-gamer can start a ride without help (playtest protocol) | M | `docs/playtests/2026-11-protocol.md` |

## 12. Data and backend

| ID | Check | Tag | Covered by |
|---|---|---|---|
| DB-01 | Dashboard SQL valid against the schema | A | `check:dashboard-sql` |
| DB-02 | A ride's analytics events (`ride_start`, `crash_recover`, `ride_takeover`, …) reach the dashboard | M | — |
| DB-03 | Today's Road leaderboard records a ranked run | M | — |
| DB-04 | Pad relay rate limit refuses a scripted room flood (30/min per IP; refused requests never reach a room) | A | `test/unit/pad-relay-ratelimit` |

---

## Automation plan

The mocks, all in `scripts/lib/`:

| Mock | What it fakes | Used by |
|---|---|---|
| `smoke-harness.mjs` | Local server, three.js from node_modules, no network; Chrome with software WebGL | the new smokes |
| `fake-gamepads.mjs` | `navigator.getGamepads()` with real model id strings; plug, unplug, replug, press, stick | `disconnect`, `local-coop`, `versus`, `flows`, `webhid` |
| `fake-webhid.mjs` | `navigator.hid` replaying recorded reports (`scripts/fixtures/hid/`, copied from the controller lab) | `webhid` |
| `fake-steam.mjs` | The Electron preload's `steam`, `electronApp`, `tandemoniumSteam` globals | `steam-input` |
| Fake net | Two pages wired together in place of the room transport | `host-room`, `tourist`, `disconnect` |
| Pad relay | Real `worker/pad-relay.js` under `wrangler dev` | `phone-pad` |

Run everything with `npm run smoke:all`, or some with
`node scripts/run-smokes.mjs local-coop versus`. CI runs the same runner.

**Known bugs** are printed as `KNOWN BUG` without failing the run, and print
`FIXED` once the game behaves; then turn them into normal checks. Open ones are
listed in #472.

What stays manual for good: ride feel (section 3), real Bluetooth and USB
pairing, phone sensors, the Steam client, Google TV, two real networks, frame
rate on real GPUs, and playtests with people.
