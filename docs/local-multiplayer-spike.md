# Local Multiplayer Spike — Feasibility & Implementation Plan

**Question:** Can we add same-screen, two-controller local co-op to Tandemonium without rewriting the game, and if so, what does it take?

**Short answer:** Yes. The core physics, offset-pedaling logic, and two-input data model already exist and work — the network layer is the *only* thing that synthesizes the "stoker" input, and it can be bypassed. The realistic scope is **~800 lines across ~13 files**, bounded by (a) splitting `InputManager` to accept a gamepad/keyboard slot and (b) adding a new `_updateLocal(dt)` game-loop path plus a JOIN RIDE button on the existing host room page.

This document captures the code-level findings from the spike and turns them into a concrete, staged plan.

## TL;DR — final design (after review)

- **Entry point:** existing RIDE TOGETHER → CAPTAIN → host room-code page (`#lobby-host`). No new mode card. A new JOIN RIDE button is added to that page.
- **Unified host page:** the host page waits for *either* an online stoker (via TNDM-XXXX code / QR) *or* a local JOIN RIDE. Whichever happens first wins the room; the other is rejected.
- **Player colors:** P1 = existing bright light green. P2 = coral red `#ff4560`.
- **Input matrix:** one of every pair must be a gamepad. Allowed combos: gamepad+gamepad, gamepad+keyboard, keyboard+gamepad. Blocked: keyboard+keyboard (key collision).
- **JOIN RIDE button states:** 🎮 coral when unclaimed gamepad present; ⌨️ white when P1-not-on-keyboard and keyboard available; greyed with tooltip otherwise.
- **P2 input-mode toggles** (joystick / gyro) appear beside JOIN RIDE only when P2 is a gamepad. The gyro toggle click itself is the WebHID user gesture.
- **Equal lean:** P1 and P2 average 50/50, identical to the current captain path. No "driver" asymmetry.
- **Disconnect handling:** mid-ride pad disconnect → pause + reconnect overlay → 30s Quit fallback saves partial run as `incomplete`.
- **Achievements + leaderboard:** local runs count as multiplayer; submit under P1's account tagged `mode: 'local'`.
- **Nothing about the online MP stack changes** except adding a `destroy()` method for clean teardown when local JOIN RIDE wins the race.

---

## 0. Design decisions (confirmed)

These were decided in review after the initial spike:

| Decision | Choice |
|---|---|
| Captain/stoker asymmetry locally | **Full equality** — 50/50 lean average, identical to the online captain path |
| Achievements gating | **Local counts as multiplayer** — local co-op runs credit the same achievements as online MP |
| Leaderboard submission | **Yes**, tagged `mode: 'local'` in the backend run metadata |
| Keyboard + keyboard local MP | **Not supported** — one keyboard can't serve two players (key collisions on pedal/lean bindings) |
| Local MP entry point | **Option A — existing host room-code page.** No new mode card. The captain goes RIDE TOGETHER → CAPTAIN → host page as today, and a new JOIN RIDE button is added to the host page. |
| Minimum input bar | **At least one gamepad** — because the only other path is "one keyboard shared," which is blocked. Controller-only and controller+keyboard are both allowed. |
| P1 color | **Bright light green** (existing) |
| P2 color | **Coral red `#ff4560`** — classic Player 2 pairing, maximum contrast with P1 green |
| Pre-claim gamepad identification | **First gamepad to send input** becomes the P1 candidate; the other becomes P2 candidate |
| Disconnection mid-ride | **Pause + "Reconnect Player 2 or Quit" overlay**, auto-resume on reconnect, 30s Quit fallback saves partial progress tagged incomplete |
| Online ↔ local race on the host page | **Local JOIN RIDE wins** — pressing JOIN RIDE tears down the PeerJS room, invalidates the TNDM-XXXX code, and starts local. Online stokers trying to connect after that get a "Room not found" error. |
| Lobby menu navigation before JOIN RIDE | P1 candidate (first-to-input gamepad) drives menu nav; P2 candidate's button presses only fire JOIN RIDE and P2 input-mode toggles |
| Bike preset | **Shared** — one tandem bike, P1's preset applies |
| Contribution bar / HUD partner gauge | Re-colored to P1 green + P2 coral in local mode |
| Second-pad discoverability hint | Small "Connect a 2nd controller for local co-op" hint on single-gamepad host pages |

---

## 0.5. Input matrix (what pairings are allowed)

| P1 input | P2 input | JOIN RIDE appearance | Allowed? |
|---|---|---|---|
| Gamepad | 2nd gamepad | 🎮 in coral red | ✅ |
| Gamepad | Keyboard | ⌨️ keyboard emoji (white) | ✅ |
| Keyboard | Gamepad | 🎮 in coral red | ✅ |
| Gamepad | Both available | 🎮 ⌨️ (both shown, first input wins) | ✅ |
| Keyboard | Keyboard | — | ❌ (key collision) |
| Motion-only (mobile) | — | — | ❌ (local MP is desktop-only) |

**Rule of thumb:** at least one of the two players must be on a gamepad. JOIN RIDE is greyed out on the host page only when neither a second gamepad NOR a "P1-is-not-on-keyboard + keyboard present" condition is met.

---

## 1. What the spike found

### 1.1 The offset-pedaling engine is already dual-source

`js/shared-pedal-controller.js` takes `receiveTap(source, foot)` where `source` is `'captain' | 'stoker'`. It tracks per-player last-foot / last-time, computes offset quality, detects crank-fight, and maintains per-player stats — **entirely from the `source` label, with no assumption about where the tap came from.** Local MP just calls `receiveTap` twice, once per local player.

> `js/shared-pedal-controller.js:33` — `receiveTap(source, foot)` is the single integration point. It does not know about networks.

### 1.2 The captain already does exactly what local MP needs to do

In `_updateCaptain(dt)` (`js/game.js:2982–2999`) the captain:

1. Edge-detects its own pedal keys (`ArrowLeft`/`ArrowRight` = "up"/"down").
2. Calls `this.sharedPedal.receiveTap('captain', foot)`.
3. *Also* calls `this.net.sendPedal(foot)` to forward to the stoker.

The stoker's taps arrive via `this.net.onPedalReceived = (source, foot) => this.sharedPedal.receiveTap(source, foot)` at `js/game.js:617–625`.

**Local MP is literally: replace step 3 with a second edge-detect block driven by a second input source, targeting `'stoker'`.** No new physics, no new state machine, no network.

### 1.3 Lean merging is already a simple average

At `js/game.js:3009–3012`:
```js
balanceResult.leanInput = Math.max(-1, Math.min(1,
  (balanceResult.leanInput + this.remoteLean) * 0.5
));
```
For local MP, `this.remoteLean` becomes "P2's current lean from P2's InputManager/BalanceController" instead of "whatever arrived last from `net.onLeanReceived`."

### 1.4 The game has a single `mode` string — easy to extend

`this.mode = 'solo' | 'captain' | 'stoker'` is set in three places (`game.js:152, 581, 600, 2226`) and branched on throughout the file. Adding `'local'` as a fourth value and routing it through a new `_updateLocal(dt)` sibling of `_updateCaptain(dt)` is a surgical change. Most existing branches stay as-is; only the ones that assume `this.net` exists need a `|| mode === 'local'` guard (or equivalent).

### 1.5 `InputManager` is the one real refactor

**This is the biggest change in the spike.** Today `js/input-manager.js` is hard-wired to a *single* gamepad:

- `this.gamepadIndex = null` (line 46) — a single slot.
- `gamepadconnected` event handler claims the first gamepad it sees (line 422).
- `pollGamepad()` walks `navigator.getGamepads()` and binds to the first non-null entry (line 460).

To support two local players we need two independent input streams. The cleanest answer is **two `InputManager` instances**, each configured with a gamepad slot filter:

```js
this.inputP1 = new InputManager({ gamepadSlot: 0, keyboard: 'primary' });
this.inputP2 = new InputManager({ gamepadSlot: 1, keyboard: 'none' });
```

This works because:

- `BalanceController` and `PedalController` both take an `input` handle in their constructor (`game.js:135–136`) — they don't reach into globals.
- All per-device state (`_smoothedLean`, `_driftEma`, gyro bias, WebHID driver) is already self-contained on the instance.
- Motion / touch / iOS permission paths only need to run on P1. P2 on a desktop plays with a gamepad; the P2 `InputManager` can skip `_setupMotion` and `_setupTouch` entirely via the constructor options.
- Existing solo / captain / stoker code paths keep using `this.input` (which becomes an alias for `inputP1`) — **no behavior change for existing modes**.

### 1.6 What does NOT need to change

- **Bike physics, chase camera, world, render loop** — same one-bike, one-camera setup. Tandemonium is a tandem bike: *there is literally one bike in the scene*. No split-screen.
- **HUD partner gauge** (`js/hud.js:177, 313–331`) — it already reads a `remoteData` object with `remoteLean` / `remoteLastFoot` / `remoteLastTapTime`. In local MP we build that object from P2's inputs instead of from network callbacks. **Zero HUD code changes.**
- **`SharedPedalController`** — works as-is.
- **`RaceManager`, `CollectibleManager`, `ObstacleManager`** — unchanged; authoritative path is the same as captain.
- **`ContributionTracker`** — already supports `'solo' | 'captain' | 'stoker'`. We instantiate it with `'captain'` in local mode (since the local game loop is the captain-equivalent) or add a new `'local'` value that mirrors the captain path. Trivial.
- **Network stack** — untouched. Online MP keeps working. Local MP does not import `NetworkManager`.
- **Recorder / video PiP** — no partner stream in local MP; we disable the partner-video composite for `mode === 'local'` and keep the single-player recording path.

---

## 2. File-by-file change list

| File | Change | Est. LoC | Risk |
|---|---|---|---|
| `js/input-manager.js` | Accept `{ gamepadSlot, enableKeyboard, enableMotion, enableTouch }` options; filter `_setupGamepad` / `pollGamepad` to a specific slot index; skip motion/touch setup when disabled; independent WebHID `connectControllerGyro()` per instance (second device claim) | ~120 | **Medium** — WebHID path was written single-device; need to verify two simultaneous `requestDevice` claims work on the same browser tab |
| `js/game.js` | Add `this.inputP1` / `this.inputP2`; alias `this.input = inputP1`; add `'local'` mode; new `_updateLocal(dt)` method forked from `_updateCaptain` minus network sends plus P2 edge-detect; route `_loop` → `_updateLocal` when `mode === 'local'`; add `_onLocalMultiplayerReady()` callback; local reset flow; pause/reconnect overlay wiring | ~270 | Medium — extract `_updateTandemCore(dt, { isLocal })` so captain and local share the body and don't drift |
| `js/balance-controller.js` | No change — already takes an input handle | 0 | None |
| `js/pedal-controller.js` | No change — solo controller unused in local MP | 0 | None |
| `js/shared-pedal-controller.js` | No change — already dual-source | 0 | None |
| `js/lobby.js` | JOIN RIDE button on `#lobby-host`; second-gamepad detection service; P2 input-mode toggles; P2 gamepad polling branch; keyboard-Enter JOIN RIDE handler; `_onLocalJoinRide(sourceType, gamepadIndex?)` transition; scope gamepad-nav to P1's claimed slot; discoverability hint; online ↔ local race teardown | ~220 | Medium — lobby is a complex UI; the new host-page wiring must integrate with `_stepItems` / `_moveFocus` and not break `_pollGamepadNav` |
| `js/network-manager.js` | Add `destroy()` method (if not present) that closes PeerJS peer + relay WS + cancels reconnects, so local JOIN RIDE can win the race cleanly | ~15 | Low |
| `js/hud.js` | Pick up P2 coral color in local mode via CSS var; relabel captain/stoker as P1/P2 in local contribution bar | ~15 | None |
| `js/contribution-tracker.js` | Accept `'local'` mode value and route like `'captain'` | ~5 | None |
| `js/achievements.js` | Audit + ensure multiplayer-gated achievements treat `mode === 'local'` the same as `mode === 'captain'` | ~10 | Low |
| `js/analytics.js` | Add `mode: 'local'` dimension + `local_coop_sessions` counter + `room_local_claimed` event | ~10 | None |
| `index.html` | JOIN RIDE button + P2 toggles DOM on `#lobby-host`; disconnect/reconnect overlay DOM | ~50 | None |
| `css/*.css` (or inline) | `--tandem-player2: #ff4560` token; JOIN RIDE styles; P2 badge; contribution bar segment colors in local mode; HUD gauge re-skin | ~80 | None |
| `js/game-recorder.js` | Guard partner-video composite behind `mode !== 'local'`; color P2 pedal-flash indicators with coral | ~10 | None |
| **Total** | | **~805 LoC** | |

(Up from the original ~570 LoC estimate because the design is now richer: JOIN RIDE button + P2 toggles + disconnect overlay + color tokens + analytics add substantive UI work. Still well below rewriting the network stack.)

---

## 3. Implementation plan — 4 stages

Each stage is independently testable and mergeable. **Ship Stage 1 behind a `?localmp=1` URL flag first.**

### Stage 1 — Prove the data path works (1–1.5 days)

**Goal:** Two gamepads, one bike, offset pedaling works locally. No lobby UI. Triggered by `?localmp=1`.

1. **Refactor `InputManager` to accept a slot.**
   - Constructor takes `{ gamepadSlot = 'any', enableMotion = true, enableTouch = true }`.
   - In `_setupGamepad`, only claim the first connected gamepad whose index matches the slot (or `'any'` for backward compat).
   - In `pollGamepad`, only bind to `gamepads[i]` when `i === gamepadSlot` OR slot is `'any'`.
   - For P2 instance pass `enableMotion: false, enableTouch: false`.
2. **Add keyboard namespacing** (minimal for Stage 1).
   - P1 InputManager reads `ArrowLeft/ArrowRight` (pedal) + `KeyA/KeyD` (lean) — unchanged.
   - P2 InputManager ignores keyboard entirely (two-gamepad-only for the spike).
   - Leave the fancier WASD-vs-IJKL split for Stage 4.
3. **Add `_updateLocal(dt)` in `game.js`:**
   - Fork of `_updateCaptain` minus every `this.net.*` line.
   - P1 edge-detects pedals → `sharedPedal.receiveTap('captain', foot)`.
   - P2 edge-detects pedals → `sharedPedal.receiveTap('stoker', foot)`.
   - `balanceResult.leanInput = average(p1Lean, p2Lean)` (identical to captain path).
   - Reuse `raceManager`, `collectibleManager`, `obstacleManager`, grass, camera, HUD.
4. **Wire the URL flag** — if `?localmp=1`, skip the lobby, instantiate two `InputManager`s, set `mode = 'local'`, and drop into the default level.

**Stage 1 exit criteria:**
- Two DualSense / Switch Pro / Xbox controllers connected.
- Both players can pedal; offset pedaling rewards coordination exactly like online MP.
- Both players' lean averages correctly.
- HUD partner gauge shows P2's lean (via `remoteData` populated from P2's InputManager).
- No network, no room code, no errors in console.

### Stage 2 — Lobby flow (1–1.5 days)

**Goal:** JOIN RIDE button on the existing multiplayer host room-code page, with correct device-aware visual state. No new lobby screens; no new mode card. Entry point is the existing RIDE TOGETHER → CAPTAIN → host flow.

1. **Extend `#lobby-host` (the host room-code page) with a JOIN RIDE button.**
   - Positioned below (or next to) the TNDM-XXXX code + QR, clearly separated as a "local option."
   - Always rendered; its visual state depends on detected inputs.
   - Label: "JOIN RIDE" + one or both of 🎮 / ⌨️ icons per the input matrix (see §0.5).
   - 🎮 icon styled in P2 coral red `#ff4560` when an unclaimed gamepad is ready.
   - ⌨️ icon in white when P1 is NOT on keyboard AND a keyboard is available.
   - Greyed-out state + tooltip "Plug in a controller for local co-op" when neither condition is met.
2. **Second-gamepad detection service.**
   - A small polling helper (`getUnclaimedGamepadIndex()`) that scans `navigator.getGamepads()` for any index that is NOT P1's. Polled from the host page's existing RAF nav loop.
   - Updates the JOIN RIDE button visual whenever the detected set changes (hot-plug support).
   - Fires a state change event so the P2 input-mode toggles (§step 4) can show/hide.
3. **JOIN RIDE click handlers, per input source:**
   - **P2 gamepad path:** a dedicated polling branch watches the unclaimed gamepad's A button; pressing it fires `_onLocalJoinRide('gamepad', gamepadIndex)`.
   - **P2 keyboard path:** the host page listens for Enter/Space while JOIN RIDE has the ⌨️ state visible; fires `_onLocalJoinRide('keyboard')`.
   - First one to fire wins; the other path is disabled.
4. **P2 input-mode toggles beside JOIN RIDE.**
   - Shown only when the second gamepad is present (keyboard-P2 has no sub-modes).
   - Toggles: `joystick` (left stick for lean) and `gyro` (WebHID gyro for lean).
   - Defaults match P1: joystick ON, gyro OFF.
   - Tapping the gyro toggle *is* the user gesture for P2's WebHID `requestDevice()` call — this conveniently satisfies the browser permission requirement without any extra UI.
   - State is session-scoped, not persisted.
5. **`_onLocalJoinRide(sourceType, gamepadIndex?)` — the transition into local mode.**
   - Tears down the online MP attempt: `this.net.destroy()` (closes PeerJS peer, invalidates TNDM-XXXX, stops ICE). Subsequent online stoker connects fail naturally.
   - Instantiates a second `InputManager` for P2 per the matrix:
     - `sourceType === 'gamepad'` → `new InputManager({ gamepadSlot: gamepadIndex, enableKeyboard: false, enableMotion: false, enableTouch: false })`
     - `sourceType === 'keyboard'` → `new InputManager({ gamepadSlot: null, enableKeyboard: true, enableMotion: false, enableTouch: false })` and P1's InputManager is reconfigured to NOT read keyboard (it already isn't, since P1 claimed a gamepad to get here).
   - Instantiates a second `BalanceController` bound to `inputP2`.
   - Calls `game._onLocalMultiplayerReady({ inputP1, inputP2, balanceCtrlP2 })` which sets `this.mode = 'local'`, creates a fresh `SharedPedalController`, applies saved tuning, routes to `_updateLocal(dt)` in the game loop.
6. **Online ↔ local race rule (implemented in §5 above):** JOIN RIDE wins over any in-flight online stoker connection. If an online stoker was mid-handshake, their connection is rejected. Analytics event `room_local_claimed` so we can measure how often this happens.
7. **Gamepad navigation scoping on the host page.**
   - Before JOIN RIDE is clicked, P1's claimed gamepad drives all menu nav (existing behavior, unchanged).
   - The unclaimed gamepad's axes/buttons are ignored by the nav loop EXCEPT for the A button, which is routed to JOIN RIDE only.
   - This prevents "P2 accidentally scrolling P1's cursor" before the handoff.
8. **Discoverability hint (optional polish).**
   - When the host page is open and only P1's gamepad is detected (no second gamepad, and P1 is on that gamepad so keyboard isn't a valid P2 either), render a small dim hint next to JOIN RIDE: "Connect a 2nd controller for local co-op." This is visible until JOIN RIDE becomes eligible.

**Stage 2 exit criteria:**
- A player can go RIDE TOGETHER → CAPTAIN → host page and start a local-MP ride via JOIN RIDE.
- All four allowed input combinations from §0.5 actually work end-to-end.
- Local JOIN RIDE wins the race vs. an in-flight online stoker.
- No regression in the pure online MP path (online stoker still joins normally when JOIN RIDE is not pressed).

### Stage 3 — Polish + edge cases (1 day)

1. **Mid-ride disconnection — pause + reconnect overlay.**
   - When P2's gamepad disconnects during a local ride, pause the game (freeze physics, stop the race timer) and show a full-screen overlay: "Player 2 disconnected — reconnect their controller to resume."
   - Resume button is greyed until the same or another unclaimed gamepad appears.
   - 30s idle timer shows a "Quit to lobby (save progress)" secondary button. Taking Quit ends the ride, submits partial progress to the leaderboard tagged `incomplete: true, mode: 'local'`.
   - If P2 was on the keyboard, there's no disconnection event — skip this overlay entirely (keyboard can't "disconnect").
2. **Single-gamepad fallback at lobby time.** Implemented in Stage 2 already — JOIN RIDE's ⌨️ state covers this. No extra work.
3. **Options overlay + pause.** Either P1 or P2's input source can open/close the pause overlay (P1 via existing Start button, P2 via their gamepad Start or keyboard Escape).
4. **Achievements audit.** Walk `js/achievements.js` and verify:
   - Multiplayer-gated achievements fire for `mode === 'local'` the same as `mode === 'captain'`.
   - No achievement is gated on "has a partner peer ID" or similar online-only signals.
   - Tag analytics events with `coop_type: 'local' | 'online'` so the marketing dashboard can split the two.
5. **Analytics.** Add `mode: 'local'` dimension to `analytics.startRide()`. Add new `local_coop_sessions` counter. Fire `room_local_claimed` whenever JOIN RIDE wins a race vs. an online stoker.
6. **Leaderboard submission.** Runs submit under P1's signed-in account (Steam/Google) with `mode: 'local'` metadata. P2 has no account identity in the submission — that's fine. Achievements fire on P1's account only (documented limitation; acceptable for v1).
7. **Recorder.** Disable partner-video composite branch for `mode === 'local'`. Keep pedal-flash indicators for both players, colored P1 green + P2 coral.
8. **Contribution bar + HUD partner gauge re-color.**
   - The existing captain/stoker contribution bar already splits into two segments. In `mode === 'local'`, apply CSS variables `--p1-color: #00ff7a; --p2-color: #ff4560;` to the segments and label them "P1 / P2" instead of "Captain / Stoker."
   - Partner gauge border + needle pick up `--p2-color` in local mode.
9. **CSS token for P2 color.** Add `--tandem-player2: #ff4560;` to the global stylesheet and reuse it in:
   - JOIN RIDE button styling
   - P2 gamepad-connected badge
   - P2 input-mode toggles (joystick / gyro)
   - Contribution bar P2 segment
   - HUD partner gauge in local mode
   - Pedal-flash indicators for P2 in the recorder overlay

### Stage 4 — Nice-to-haves (optional, post-launch)

- **Dual-gyro steering** is in Stage 1/3 now (baked into the per-instance InputManager). Stage 4 is just hardware validation across real DualSense + Switch Pro + Xbox combinations.
- **Player 2 nameplate** over the tandem bike's rear rider — a small "P2" tag in coral.
- **Captain swap** button on the pause overlay to flip who's tracked as captain vs stoker in `sharedPedal` (affects offset-bonus attribution only, not gameplay).
- **Per-player bike cosmetic slot** — P2 picks a second color stripe on the shared tandem so both players feel ownership. Low priority.
- **Recording with P1/P2 labels baked in** — GameRecorder overlay puts the coral/green labels on the composited video clip for shareability.

---

## 4. Risks & open questions

### 4.1 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `_updateCaptain` drifts from `_updateLocal` as we polish online MP | Medium | Extract the shared body into `_updateTandemCore(dt, { isLocal })` and have both paths delegate to it. Worth doing in Stage 1 itself to avoid double-maintenance. |
| Second gamepad isn't reliably detected (browser gamepad API has quirks) | Medium | Stage 1 uses polling fallback; Stage 2 shows a clear "Press any button on Player 2's controller" instruction screen with live detection feedback. |
| Input permission prompts (WebHID) are per-device and per-user-gesture — two devices in rapid succession may confuse the user | Low-Medium | Do not require WebHID for Stage 1–3; standard gamepad API (the one `pollGamepad` uses) needs no permission. Gyro steering (WebHID) is Stage 4. |
| "Captain" vs "stoker" labeling in `SharedPedalController` looks arbitrary locally | Low | Ship as-is; offset-pedaling stats still work because each player consistently taps from the same labeled source. |
| Achievements / leaderboards that assume online co-op misreport for local | Low | Audit `js/achievements.js` in Stage 3; explicitly scope which achievements count local as multiplayer. |
| Electron / Steam TV-mode build has a different input path | Low | The Electron build uses the same `InputManager`; the only delta is that `window.steam` is true. Local MP should work identically in Electron — verify on Deck hardware as part of Stage 3. |

### 4.2 Open questions — resolved

All initial open questions have been resolved during design review (see §0). Remaining unknowns are hardware-validation items, not design decisions:

1. **Does `navigator.hid.requestDevice()` work cleanly for two simultaneous WebHID claims in the same tab?** Needs a real-hardware test with DualSense + Switch Pro both requesting gyro. If the browser throws on the second claim, we fall back to "P2 joystick-only" gracefully and file a Stage 4 follow-up.
2. **Does the Electron desktop build behave identically?** Expected yes — same input stack — but needs a Deck/TV-mode pass.
3. **Does the free demo include local co-op?** Confirmed yes per review. Low abuse risk; it's a great demo-expansion tool.

---

## 5. Why this is worth doing now

- **Steam discoverability.** "Local Multiplayer" + "Couch Co-op" are top Steam discovery tags. Without them, Tandemonium's store page looks like an online-only game in a category dominated by couch classics.
- **Testing & iteration speed.** Local MP lets you exercise the full two-player offset-pedaling loop *without any network*. Every online MP bug you've been debugging becomes a one-controller-one-keyboard local repro. Worth it for dev velocity alone.
- **Demos and streaming.** Handing a second controller at a festival is infinitely easier than "scan this QR code and let me explain room codes for 30 seconds."
- **Expands the ICP.** The persona ("Remote Co-op Duo") gains a second pathway: *same room, two devices on one screen.* That's additive — existing online-MP messaging still holds.
- **Leverages existing sunk cost.** Every line of `SharedPedalController`, the WebHID gyro drivers, the gamepad navigation in the lobby, the TV mode, and the Electron desktop shell was already built for two-player input and gamepad-first UX. Local MP is the feature that makes that investment land.

## 6. What this plan explicitly does NOT do

- **Does not touch the online multiplayer code path.** `NetworkManager`, PeerJS, the Cloudflare relay, remote bike state, and the stoker-CTA flow are untouched.
- **Does not introduce split-screen.** One bike, one camera. This is correct for a tandem bike and saves substantial rendering work.
- **Does not add local *versus* multiplayer.** This is tandem co-op. No racing two tandem bikes locally in this spike.
- **Does not rewrite `InputManager`.** It extends it with a slot parameter — existing single-player code keeps working unchanged.

---

## 7. Recommendation

**Do Stage 1 first as a half-day spike-in-code** (behind `?localmp=1`) before committing to the full feature. If Stage 1 feels good with two real gamepads on your desk, Stages 2–3 are low-risk follow-ups and the whole thing ships in under a week.

If Stage 1 reveals something I missed — e.g., a hidden `InputManager` global or a physics path that assumes network-sourced stoker input — we'll know *before* touching the lobby, analytics, or achievements.
