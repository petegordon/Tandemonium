# Local Multiplayer Spike — Feasibility & Implementation Plan

**Question:** Can we add same-screen, two-controller local co-op to Tandemonium without rewriting the game, and if so, what does it take?

**Short answer:** Yes. The core physics, offset-pedaling logic, and two-input data model already exist and work — the network layer is the *only* thing that synthesizes the "stoker" input, and it can be bypassed. The realistic scope is **~400–700 lines across 5–6 files**, bounded by (a) splitting `InputManager` to accept a gamepad slot and (b) adding a new `_updateLocal(dt)` game-loop path plus a lobby entry point.

This document captures the code-level findings from the spike and turns them into a concrete, staged plan.

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
| `js/input-manager.js` | Accept `{ gamepadSlot, enableMotion, enableTouch, keyboard }` options; filter `_setupGamepad` / `pollGamepad` by slot; skip motion/touch for P2 on desktop; namespace keyboard bindings per instance | ~100 | **Medium** — the event-driven gamepadconnected flow needs careful slot assignment (first connected → P1 slot if empty, else P2) |
| `js/game.js` | Add `this.inputP1` / `this.inputP2`; alias `this.input = inputP1`; add `'local'` mode; new `_updateLocal(dt)` method (fork of `_updateCaptain` minus network sends, plus P2 edge-detect); route `_loop` → `_updateLocal` when `mode === 'local'`; add `_onLocalMultiplayerReady()` lobby callback; local reset flow | ~250 | Medium — `_updateCaptain` is ~115 lines and the fork needs to stay in sync with future captain-side changes |
| `js/balance-controller.js` | No change (already takes an input handle); instantiate a second one for P2 in `game.js` | 0 | None |
| `js/pedal-controller.js` | No change (solo controller is unused in local MP; local MP uses `SharedPedalController` directly like captain does) | 0 | None |
| `js/shared-pedal-controller.js` | No change | 0 | None |
| `js/lobby.js` | New mode card "Local Co-op (Same Screen)"; new controller-assignment screen ("P1 press A / P2 press A"); route through existing level-select; emit `onLocalMultiplayerReady({ inputP1, inputP2, level })` | ~180 | Medium — lobby is a complex UI with gamepad nav; the new screen must integrate with `_stepItems` / `_moveFocus` |
| `js/hud.js` | No change (already reads `remoteData`) | 0 | None |
| `js/contribution-tracker.js` | Accept `'local'` and route like `'captain'` (or pass `'captain'` literal for local mode) | ~5 | None |
| `index.html` | New lobby screen DOM for controller-assignment + new mode card | ~30 | None |
| `js/game-recorder.js` | Guard partner-video composite behind `mode !== 'local'` | ~5 | None |
| **Total** | | **~570 LoC** | |

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

### Stage 2 — Lobby flow (1 day)

**Goal:** First-class "Local Co-op" entry in the existing lobby.

1. **New mode card** on `#lobby-mode`: "Same Screen Co-op" (next to SOLO and RIDE TOGETHER).
2. **New lobby step `#lobby-local-pair`:**
   - Prompts "Player 1: press A / Player 2: press A."
   - Detects each gamepad index claim independently.
   - Proceeds to `#lobby-level` when both claimed.
   - Back button returns to mode select.
3. **Level + difficulty flow reuses the existing `#lobby-level` cards** — no new UI.
4. **Lobby emits `onLocalMultiplayerReady({ inputP1, inputP2 })`** which calls a new `Game._onLocalMultiplayerReady` — the same shape as `_onMultiplayerReady(net, mode)` but without a network.
5. **Gamepad navigation integration** — add the new step to `_stepItems` / `_stepBack` so directional nav works.

**Stage 2 exit criteria:** Player can start a Local Co-op ride entirely through the GUI with two gamepads and no URL flags.

### Stage 3 — Polish + edge cases (0.5–1 day)

1. **Controller hot-swap** — if P2 disconnects mid-ride, pause and show "Waiting for Player 2."
2. **Single-gamepad fallback** — if only one gamepad is detected at lobby time, offer "Player 2 use keyboard (WASD + Q/E)" as an opt-in.
3. **Options overlay + pause** — both players' Start buttons can open/close the options menu.
4. **Achievements** — ensure achievements that require "multiplayer" don't mis-fire or mis-block on local (decide per-achievement: do we credit local co-op as "multiplayer" for achievement purposes? Probably yes.)
5. **Analytics** — add a `mode: 'local'` dimension to `analytics.startRide()` so we can measure adoption.
6. **Recorder** — disable partner-video composite; keep pedal-flash indicators for both players.

### Stage 4 — Nice-to-haves (optional, post-launch)

- **Gyro steering for both players simultaneously** — requires two WebHID device claims, one per player. The existing `InputManager.connectControllerGyro()` path should be re-entrant per instance; verify on real hardware.
- **Split-keyboard mode** — P1 uses arrows + A/D, P2 uses IJKL + Q/E, so a couch session needs zero gamepads.
- **Player-specific bike color / nameplate** in HUD.
- **"Captain swap" button** to flip who's tracked as captain vs stoker in `sharedPedal` (affects offset-bonus attribution only, not gameplay).

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

### 4.2 Open questions I want your call on

1. **Captain/stoker asymmetry locally?** Online, captain runs physics and their lean is arguably "more authoritative." Locally, should both players be fully equal (lean averaged 50/50), or should one player be explicitly "the driver"? *My recommendation: equal, identical to the current captain-path averaging. Simplest and preserves the feel.*
2. **Achievements gating:** does a local-co-op finish count toward a multiplayer achievement (e.g., "Finish a ride with a partner")? *My recommendation: yes, local counts as multiplayer for achievement purposes.*
3. **Leaderboards:** should local-co-op runs submit to the leaderboard? *My recommendation: yes, tagged with `mode: 'local'` so you can filter later if it skews the boards.*
4. **Keyboard-only local MP:** is it a Stage 3 must-have, or a Stage 4 nice-to-have? *My recommendation: Stage 4 — two gamepads is the marketing-critical path for Steam / couch / festival demos; keyboard-only local is a niche fallback.*
5. **Demo tier:** does Local Co-op work in the free demo / stoker-link flow? *My recommendation: yes — local co-op is an amazing demo-expansion tool. Low abuse risk because it's local, not a shared session.*

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
