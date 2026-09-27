# Slingshot mode — adversarial design plan

*PR #397, branch `feat/slingshot-mode`. Written 2026-09-26 after Pete's fourth round of
feedback: "The touch drag pull back works, but there is no aim left and right? And the
pedals are still there — not certain what they would be used for."*

**Status (2026-09-26):**
- Pete accepted defaults D1–D6 and asked for Slingshot to move **under SOLO** in the lobby. It is now a card in the Solo level list, hidden in the demo build.
- **Phase 0 is done.** `npm run smoke:slingshot-aim` checks it on phones (portrait 390×844 and landscape 844×390, real touch).
- Phase 0's pixel checks caught a bug the earlier smoke could not: **the whole aim was mirrored**. Dragging left moved the bike right on screen and aimed it left. My "road right" vector was screen-left from behind the bike, and the old smoke measured with the same wrong convention. It is fixed, and asserted in screen pixels.
- In landscape, the stock vertical FOV made the slingshot a speck (69 px of aim travel). The aim camera now narrows the FOV to frame the forks (257 px), then eases back after launch.
- Next: Phase 1.

This plan is built from three independent adversarial reviews: **game feel / loop**,
**mobile input / camera**, and **technical fit / risk**. It also uses numbers measured
from the code in this branch. Every claim below was either reproduced (emulated iPhone
390×844 with real CDP touch events, headless Puppeteer, numeric integration of the
physics) or is marked *unverified*.

---

## 0. What actually happened on Pete's phone

| Symptom | Cause | Status |
|---|---|---|
| Pedals still visible | **Stale build.** The PR-preview deploy for `43a16c9` failed on an unrelated flaky unit test (`gust-visual`, a random-spawn average), so the preview kept serving the previous commit `c0dec74`. That commit had drag-down pull only, and its pedal pads were visible. | Fixed in `c18ca32` (test seeded). Preview redeployed successfully. On the current build, `#pedal-bar` computes `display:none` on a touch phone. |
| "No aim left and right" | **Stale build, plus a real bug.** The stale build had no aim at all. The current build *does* aim (full left: bike −1.4 m, +20°). But the chase camera follows the bike's position **and heading** during aim, so the aim is cancelled on screen. Full-left and full-right screenshots look almost identical. On a portrait phone the forks sit about 48° off-axis against an ~18° half-FOV, so the slingshot itself is never in frame. | **Open — P0.** |

Lesson: Pete can't currently tell which build he is on. The preview stamps the PR
*merge* commit, not the branch head. The version label only shows in the lobby, and its
value is stale. The ES modules have no cache-busting.

---

## 1. The adversarial findings

### 1a. As a game

| # | Finding | Evidence |
|---|---|---|
| G1 | **The dominant strategy is "aim dead straight, never steer".** Coast mode swapped out the friction but kept the normal ride's *multiplicative* road-edge and grass drag. That drag is proportional to speed, so it swamps the coast drag. | Full pull, no upgrades, road measured: **centre 162 m · 1.0 m off 47 m · 1.3 m off 33 m · 1.8 m off 22 m.** |
| G2 | **Chaos Coins cost more than they pay.** Trails sit up to ±1.8 m off-centre. Sweeping one throws away most of the run for 25 coins, which is about 125 m of distance pay. | Follows from G1. |
| G3 | **Aiming has no upside and no visibility.** ±20° plus a 1.4 m offset leaves the 5 m road in about 11 m, and nothing on the road rewards any line but the centre. | Emulated phone: bike off-road at about 22 m, 2 km/h. |
| G4 | **Progression is broken by the maths.** Stage 1 (300 m) needs about 5 Slingshot levels (about 575 coins, 8+ identical grind runs). Fully maxed, the bike coasts **1,718 m** at best (centre strip) or 1,472 m off it, so **stages 5–7 (1,800 / 2,400 / 3,600 m) can never be cleared.** Stage 4 (1,200 m) is exactly one lap of the loop road. | Integrated from `slingshot.js`. Maxing everything costs 21,485 coins. |
| G5 | **The run has no events.** It's flat, there's no air, and obstacles stay at chill density until stage 4. A launch is about 20 s of watching a number climb. Car Evolve works because the car is a *spectacle* (bounces, flips, air); this is a bike rolling to a stop. | |
| G6 | **Run 2 is run 1.** The only variation is coin-trail placement, and G2 says to ignore it. There's nothing to learn and no line to plan. | |
| G7 | **It isn't Tandemonium.** Solo, no pedalling, no partner. The value plan's thesis is "the verb feels good; together is strictly better", and this mode currently has neither. | `docs/value-and-appeal-plan.md` |

### 1b. Input and presentation

| # | Finding |
|---|---|
| U1 | **The camera cancels the aim** (see §0). The fixed-framing slingshot is the whole UI of this mode, and it's off-screen. |
| U2 | **Controller, Steam Deck, keyboard: there is no way to launch.** Aim reads only pointer drags. `_pollDpad` only runs in `'playing'`. A gamepad-only Steam player is stuck in the slingshot forever. The smoke test hides this because it uses a mouse. *(P0 for a Steam game.)* |
| U3 | **Thumb reach.** A full pull is 30% of the screen height below wherever the finger lands. A thumb landing in the bottom third can't reach it. The drag also changes feel between portrait and landscape. |
| U4 | **Text covers the bike.** `level.description` renders in the countdown flavor block (top 28%) right over the bike, and the bottom hint repeats it. |
| U5 | **Silent cancels and sloppy edges.** An iOS back-swipe fires `pointercancel`, and the pull snaps slack with no feedback. Presses at the screen edge and right-clicks start drags. There's no `setPointerCapture`. Past 15% pull, any release fires, with no stated way to back out. |
| U6 | The front-view PiP still sits in the thumb zone during aim. Whether controller-HUD tiles show pedal cues is *unverified*. |

### 1c. Technical

| # | Sev | Finding |
|---|---|---|
| T1 | P0 | = U2 (no non-pointer launch). |
| T2 | P0 | The unit test "coasts short of stage 1" models a centred, flat road. It tests fiction (G1). |
| T3 | P1 | **Cruise control breaks the run.** D-pad or quick-menu SPEED re-enables `autoSpeed` (+2 m/s² below 3 m/s). The bike never stalls and crawls to any goal. `_setupSlingRun` also clears `autoSpeed` without updating the button. |
| T4 | P1 | **Ride systems still run every launch:** achievements (Speed Demon fires on launch, and distance achievements can be farmed toward Steam), ghost recorder, E-2 disruptions ("pedal!" in a no-pedal mode), DDA/ASSIST, coach card, a difficulty-picked instructions text that says to pedal, and geese/obstacle managers rebuilt on every relaunch (a mobile hitch). |
| T5 | P1 | **The mode overwrites lobby state.** `selectedDifficulty` and `selectedLevel` stay clobbered after leaving. Medal and record lookups go to the wrong key, and safety silently turns off at stage 4. |
| T6 | P1 | **Stages ≥ 1,200 m lap the loop.** The finish wraps into the slingshot rig. Coins and obstacles double-layer on lap 2, and the posts have no collider. |
| T7 | P2 | **Crash bookkeeping breaks after the first crash.** `_lastCrashCause` is only cleared in `_showGameOver`, which slingshot never shows, so later crashes are silent. (It also exists on main after quick recoveries.) |
| T8 | P2 | **Analytics are distorted.** `startRide` fires per launch and includes aim time, every stall logs as an abandoned ride, and lobby-during-aim logs raw distance. This pollutes the A-1 funnel. |
| T9 | P2 | **Saves drop coins spent on the removed upgrades** (`legs`, `stamina`, `gate`). The save has no version field and there's no refund. |
| T10 | P3 | Window listeners are never removed. `resetToDistance` runs every drag frame and leaves `_lateralOffset`/`boostTimer` stale. Stale comments. Slingshot isn't gated out of the demo build. |
| T11 | — | **Wrong abstraction.** A "countdown with no count", a finish that isn't a victory, resets that aren't resets. Every system has to be patched out one by one, and T3–T8 are the ones that got missed. |

### 1d. Where I (the implementer) went wrong

- I **over-built the economy** (7 stages, 4 upgrades, record/stage bonuses) before the
  core toss was fun, and never checked the stages were reachable.
- I **reused the whole race pipeline** instead of giving the mode its own states.
- I **treated the smoke test as proof.** It ran on a desktop viewport, with a mouse and
  camera-agnostic assertions, so it passed while the screen showed no aim at all.
- I **didn't check the preview deploy** after pushing, so Pete tested a stale build.

---

## 2. Decisions for Pete

Each has a recommended default; the plan below assumes the default unless you say otherwise.

| # | Question | Recommended default |
|---|---|---|
| D1 | When you drag **left**, should the bike fly **right** (real slingshot / Angry Birds) or **left** (pointer)? | **Real slingshot**, made obvious by a trajectory line. Keep one constant (`AIM_INVERT`) so it flips in one line. |
| D2 | Where does it launch: the regular loop road, or an open **launch field** built for tossing? | **Road for Phase 1–2** (cheap, playable this week). Aim matters through lane targets on the road. **Field in Phase 4** if the toss proves fun. |
| D3 | What's the payoff: distance, spectacle, or both? | **Distance gates the stage; spectacle pays.** Spectacle means coins, air and jackpot targets. |
| D4 | Does this ship in the **Nov 30 demo**? | **No, post-demo side mode**, hidden behind a flag, unless a co-op launch (Phase 5) lands in time. |
| D5 | How long should a run take, and how many runs to clear a stage? | **15–25 s per run; 2–4 runs per stage.** |
| D6 | Pedals return later as a **co-op** job, or never? | **Later, as co-op only** (Phase 5): one rider aims, the other powers the pull. Out of v1. |

---

## 3. The plan

### Phase 0 — Make what's there honest *(≈1 day; do first)*

The goal: Pete's phone shows the current build, the aim is visible, and every platform can launch.

1. **Build identity.**
   - Stamp `github.event.pull_request.head.sha` (not the merge commit) and the PR number into `window.__BUILD` and `version.json`.
   - Show the short sha as a 10 px corner watermark on preview hosts, including during aim.
   - Fetch `version.json` with `no-store` on load, and show "New build — tap to reload" when it differs.
2. **CI can't hide a build again.** Split `pr-preview.yml` so **deploy does not depend on tests**. Post the preview URL with a test badge on the PR, and gate merge (not preview) on tests.
3. **Fixed aim camera.**
   - During aim, pin the camera to the **road** heading at the fork, not the bike. It sits on the centre line at d = −9 m, 4.5 m up, looking at d = +14 m, so both forks and the pouch are in frame.
   - At launch, seed the chase camera from this pose and blend over about 0.8 s.
   - Hide the front-view PiP during aim.
4. **Non-pointer launch.**
   - **Keyboard:** hold ↓/S to draw (full in 1.2 s), ←/→ or A/D to aim, release to fire, Esc to cancel.
   - **Gamepad / Deck:** left stick is the pouch (down = pull, X = aim), A fires, B cancels.
   - Aim becomes its own `'slingAim'` game state, so the D-pad, quick menu and overlays stop leaking into it.
5. **Text.** Clear the countdown flavor block during aim. Keep one short line at the top ("Pull back · aim · let go") and fade it after the first launch. Delete the bottom hint.
6. **Turn off systems that don't belong** via one `mode.systems` flag set: achievements, ghost, disruptions, DDA/ASSIST, coach card, SPEED/cruise, and the instructions screen (the drag *is* the instruction). Restore `selectedLevel`/`selectedDifficulty`/safety on exit.
7. **Save version plus refund** for removed upgrades.
8. **Analytics.** One `slingshot_launch` / `slingshot_result` event pair per launch, and no `startRide`/`endRide` per launch.

**Acceptance (added to `smoke:slingshot`, run at 390×844 touch *and* 844×390):**
- The camera pose is identical (within 1 cm and 0.1°) at pull 0, full-left and full-right.
- The bike's screen x differs by **≥ 120 px** between full-left and full-right at 390 px wide.
- All fork tips and the pouch project inside the viewport.
- No text box overlaps the bike's projected bounds.
- `#pedal-bar`, `.versus-pedals` and the PiP are hidden.
- A stubbed gamepad (stick down, A) and a keyboard (hold ↓, release) each reach `playing`.
- `pointercancel` mid-pull leaves pull 0 plus a "Cancelled" toast.
- Right-click drags are ignored.
- No achievement fires during a launch.

### Phase 1 — Give aiming a reason *(≈1–2 days)*

The goal: a real choice before every launch, visible before release.

1. **Coast physics the player can read.**
   - In coast mode, replace the multiplicative edge/grass drag with **additive rolling resistance** by surface: strip ×0.6, dirt ×1, edge ×1.5, grass ×4.
   - Extract the speed step into a pure `coastStep(v, surface)` that both the bike and the preview use.
   - Target: sweeping a 12 m coin trail at 1.8 m off-centre costs **≤ 10 m** of distance and pays 25 coins (125 m of pay).
2. **Aim range that fits the road.**
   - Heading **±5°, scaled by pull**; lateral ±1.4 m.
   - Unit test: every aim stays on the road for ≥ 40 m unsteered.
   - Steering after launch (tilt, A/D, stick) is the correction tool.
3. **Trajectory preview.** A dashed line along the launch heading, as long as the *predicted* coast (integrating `coastStep` over the road path). It shows "≈ 240 m" and your best-run flag, and goes red where it leaves the road.
4. **Lane targets in the first 150 m.** Three lanes (left / centre / right). Each stage places, on fixed per-stage positions so the stage is a puzzle you learn:
   - coin fans,
   - soft stoppers (a goose flock or hay that bleeds 50% speed — funny, not fatal),
   - one **jackpot** target (a billboard: hit it for ×2 on the run, but the run ends).
5. **Economy that works.**
   - Goals **150 / 250 / 400 / 600 / 850 / 1,150 m**. They stay under one lap, which removes T6.
   - Payout about 1 coin per 2 m, plus targets.
   - The first upgrade is affordable after run 1.
   - **Unit test:** every stage is reachable within the D5 budget, and a maxed build clears the last stage *off* the strip.

**Acceptance:** at full-left aim the predicted line ends ≥ 75 px right of centre (and the mirror for full-right). The coin-sweep cost stays within target in a unit test. The stage-reachability test passes. Pete plays 10 launches on his phone and reports whether he aimed differently between them.

### Phase 2 — Own the mode *(≈2–3 days)*

The goal: stop patching the race pipeline.

- Build a **`SlingshotMode` controller** with states `garage → aim → flight → results`. `Game` delegates `enter / exit / update / onReset / onCollect / onBikeFallen` to it, and existing call sites check `mode.systems` instead of `isSlingshot`.
- Split ride setup into `buildWorld()` (once) and `armRide()` (per launch), so relaunching doesn't rebuild the geese and obstacle managers.
- Fix T7 (the crash-cause latch), including on main.
- Add a relaunch loop to smoke (20 launches) covering heap, FPS and listener count.

### Phase 3 — Feel *(≈1 day)*

- Band tension visuals: band radius thins with stretch and the colour warms.
- A creak that pitches up with pull; haptic ticks at 25/50/75/100%.
- A pulsing grab ring on the idle pouch.
- The power readout sits about 90 px above the finger, out from under the thumb.
- Release: a camera punch, a band snap sound, a dust burst.

### Phase 4 — Spectacle *(≈3–5 days; only if Phase 1 is fun)*

- **Ramps and air.** Bike height is road-locked (`bike-model.js` ~718). This adds `vy`/`airborne` state, ramp takeoff, gravity and landing, with lean-crash rules adjusted in the air. Gate it behind `coast` so the core ride is untouched.
- Big-air payouts.
- Optionally, the **launch field** (D2): a wide runout past the forks with fixed stage layouts.

### Phase 5 — Together *(≈2 days after Phase 2)*

- Local two-player launch: **captain aims, stoker pulls.** Release is shared: both let go within 150 ms for a *perfect launch* (+15%).
- In flight, the stoker banks the lean for air.
- This is the only version that belongs in a demo selling co-op (D4, D6).

---

## 4. Explicitly *not* doing (until Pete says otherwise)

- Pedalling in solo slingshot (Pete: "not part of the slingshot game for now").
- More upgrades or stages before Phase 1 is fun.
- Online co-op slingshot.
- The prototype's "watch the ad you hit" gag (it reads as a real ad in a Steam game).

## 5. Risks to this plan

- **The fixed aim camera may fight the chase-camera smoothing.** Mitigation: seed its state and assert the camera distance in a smoke test.
- **Additive surface drag changes the feel of the *normal* ride if it leaks out.** Mitigation: it only runs under `bike.coast`, with a unit test on that boundary.
- **A three-lane layout on a 5 m road may be too tight on a phone.** Mitigation: if Pete can't aim reliably in Phase 1, jump to the launch field (Phase 4) rather than widening the road.
