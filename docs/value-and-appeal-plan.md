# Value & Appeal — Implementation Plan and Requirements (v2)

**Status:** plan, ready to implement. v1 written 2026-09-08 against `main` at `dc2ddad`;
**v2 revised the same day** after four independent investigations (see §1.2). Line numbers
are valid at `dc2ddad`.
**Source:** [`docs/value-and-appeal.md`](value-and-appeal.md) (the assessment). Read it
first; then read §1 of this document, which corrects it in one important respect.
**Branch for this plan:** `feat/value-appeal-plan`. Each work item below is meant to be
delivered as its own branch + PR off `main`, named as given in the item.

**What changed from v1 → v2, in one paragraph.** v1 accepted the assessment's premise that
the core ride is fine and the game only lacks *cadence* (a Daily Ride) and a *pair* model.
A read of the actual pedal, balance, crash and HUD code shows the core loop itself is the
weak point: the game's central verb (a pedal tap) has no sound, haptic or animation; the
co-op "offset" scoring is mathematically anti-cooperative (two players pedalling together
cap at 50 % "perfect"; a captain carrying an idle stoker scores 100 %); balance crashes are
impossible on every difficulty by default while the instructions say "you'll crash"; a
crash is a 6–9 s modal; and every Grandma's run is the identical pylon at 88 m. A Daily Ride
would have put that experience on a schedule. Separately, Steam Next Fest data says 68–88 %
of wishlists come from people who never play the demo, and co-op demos "get plays, not
wishlists". So v2 puts **ride feel + first-five-minutes + measurement** before the demo
(cut by 2026-11-30 for Steam Next Fest, February 2027), and moves the ranked
Daily/pair/Tourist beats to the window between the demo and the fest, with corrected rules
(unlimited practice, per-mode ranked runs, pair-scoped boards, streak freezes, 09:00 UTC
reset). The detailed specs from v1 are retained where still valid.

---

## 0. How to use this document

This plan is written to be executed one work item at a time by an engineer (human or
model) who has **not** read the whole codebase. Every work item states:

- **Goal** — the one sentence that must be true when the item is done.
- **Files** — the files you will touch, with line numbers valid at `dc2ddad`. Line numbers
  drift; the surrounding code comments and function names are the durable anchors.
  **Always re-locate by `grep -n` before editing.**
- **Steps** — an ordered recipe. Do them in order.
- **Acceptance criteria** — checkable statements. All must pass before the PR is opened.
- **Tests** — what automated tests to add and what manual checks to run.
- **Out of scope** — things you will be tempted to do and must not.

Rules that apply to every item:

1. **One item = one branch = one PR.** Branch off `main`, name it as the item says. Do not
   stack items on each other unless the item says "depends on".
2. **Do not widen scope.** The assessment's §5.5 ("stop adding surface") is a hard rule
   for this plan: no new bike colors, achievements (except where an item says so),
   controller drivers, or ambient scenery in any of these PRs.
3. **Keep the game playable at every commit.** `index.html` is served statically
   (`npx serve -l 8888`); there is no build step for the web game. Every PR must load in
   Chrome with no console errors at the lobby.
4. **Unit tests** are plain Node: `node --test test/unit/`. There is currently no test
   runner script; item **A-0** adds one and is the first PR. Put pure logic (pedal scoring,
   seeds, formatting, medal thresholds) in small ES modules under `js/` that import nothing
   from `three` or the DOM so they are testable.
5. **Analytics** for every new user-facing feature: add `analytics.trackEvent(...)` calls
   using the existing helpers in `js/analytics.js`. Event names are listed per item.
   Do not invent extra ones.
6. **Online multiplayer must stay deterministic.** Both clients build the world from
   seeds. Anything that changes a seed must be sent from captain to stoker over the
   existing room protocol (`js/lobby/room-protocol.js`) *before* the countdown. Anything
   that changes the pedal/balance model must be applied identically on both sides (the
   captain simulates; the stoker receives state via `js/remote-bike-state.js`) — check
   whether the stoker runs the model locally for prediction before changing constants.
7. **Do not touch** `shared/` (vendored from the controller lab via
   `scripts/sync-controller-core.js`), `electron/`, `steam/`, or `.github/workflows/`
   unless the item explicitly lists them.
8. When an item says "server", it means the Cloudflare Worker in `worker/leaderboard.js`
   with D1 schema in `worker/schema.sql` + `worker/migrations/`. New tables/columns go in
   a new migration file `worker/migrations/0008_*.sql` (next free number), never by
   editing old migrations.
9. **"Feel" items need evidence, not opinion.** Every Phase A item that changes how the
   ride feels must attach to its PR: (a) a 20–30 s before/after screen recording, and
   (b) the numbers from one ride on Grandma's/Adventurous (time, taps, crashes) before and
   after. The reviewer plays it before merging.
10. **Never ship a tuning change that makes the tutorial or Chill un-finishable by a
    non-gamer.** The bar is issue #261's protocol: a first-time non-gamer finishes Grandma's
    Chill in under 5 minutes with zero balance crashes.

---

## 1. Context

### 1.1 What the assessment found (still true)

- The meta-game (19 achievements, 7 bikes, collectibles) is being asked to carry value
  the core loop should carry. After one clean finish of Grandma's (250 m) and the Castle
  (500 m) the game has nothing new to ask.
- The persona's core promise ("a ritual with a specific person you cannot be in a room
  with") is not modelled: no notion of a pair; achievements are per-account; "Together" is
  a global board. One seed exists: `GET /partners` (`worker/leaderboard.js:616`).
- Persona doc vs code disagree about local play (local co-op and VERSUS shipped).
- Tourist Mode is built, deployed and unmerged (PR #360, `feat/333-tourist-mode-3d-tiles`,
  ~6 weeks behind `main`, playable at `pr-preview/pr-360/?mode=tourist`).
- World generation is fully seeded, so a date-seeded ride is cheap plumbing.

### 1.2 What the follow-up investigations found (new in v2)

Four read-only investigations were run on 2026-09-08: an evidence sweep (analytics
schema, issues, commit history), a designer's audit of the core loop with file:line
citations (spot-checked by hand), a survey of comparable games with sources, and an
adversarial producer's review of v1. Findings that change the plan:

**A. The core loop is silent, anti-cooperative, tension-free and repetitive.**

| # | Finding | Evidence (at `dc2ddad`) |
|---|---|---|
| 1 | A pedal tap has no sound, no haptic, no animation. The crank angle is computed and never rendered; the crank spins by speed. Pressing a pedal produces a 0.2 s CSS class flash. | `js/audio-engine.js` has no tap method (`startBike/updateBike` :533–:630 track speed only); `js/haptics.js` has crash/bump/checkpoint only; `js/bike-model.js:451` stores `crankAngle`, nothing reads it for the mesh; `js/hud.js:232–281` |
| 2 | Solo pedalling is a mash-rate function with one rule (don't repeat a key). No timing window, no rhythm, no gearing. Hidden speed sources (centre-strip +0.3 m/s², collectible boost +4 m/s² for 3 s) are never signalled. | `js/pedal-controller.js:54–63`; `js/bike-model.js:492–507` |
| 3 | **The co-op offset rule punishes cooperation.** "Perfect" requires `tap.foot !== otherLastFoot`. Two riders alternating normally (C:L, S:R, C:R, S:L …) score every captain tap after the first as "in-phase" (offset −0.08, wobble +0.2, no bonus). Two cooperating players cap at ~50 % perfect; a captain pedalling with an idle stoker scores 100 %. The `perfect_sync` achievement (`offsetScore > 0.9` for 10 s) is therefore only reachable by a carry. | `js/shared-pedal-controller.js:70–98`; `js/achievements.js:17` |
| 4 | Both players pedal and both steer; lean is a flat average. Neither seat has a unique job, unique information, or unique authority. The only genuine laugh moment (crank fight: both same foot within 100 ms → brake + wobble) is never explained on screen. The co-op HUD never shows `offsetScore` (only the versus HUD does). | `js/game.js:4238–4241`; `js/shared-pedal-controller.js:48–62`; `js/versus/versus-hud.js:110–115`; `js/hud.js:303–330` |
| 5 | **Balance crashes are impossible by default on every difficulty.** Safety mode defaults on and clamps lean to ±1.0 rad; every preset's `crashThreshold` ≥ 1.8; danger-wobble onset (threshold × `dangerOnset` ≥ 1.08) is unreachable. The instructions overlay says "Don't lean too far or you'll crash!" — false unless the player finds the SAFETY button. | `js/game.js:386`; `js/bike-model.js:583–585`; `js/config.js:127–168`; `index.html:4517` |
| 6 | The likeliest first failure is TOO SLOW, not a crash: segment budget is `max(10, d/250·60)` s (16.4 s for the first 62 m segment on Chill) while auto-cruise is 3 m/s, so a player still reading the screen is bounced to the checkpoint. The first 80 m of road are forced flat and straight — nothing happens before the first checkpoint. | `js/race-manager.js:34–35`; `js/bike-model.js:474–479`; `js/road-path.js:8–21` |
| 7 | Crash recovery is 6–9 s: 2 s fallen timer → modal (RESTART / END RIDE) → click (+ pointer-lock wait on mobile) → 3 s countdown. The crash itself is a red flash, a noise burst and camera shake 0.2 — no tumble, no goose pile-on. Punishing without being funny. | `js/bike-model.js:779–788`; `js/game.js:2263–2334`, `:2044–2136`, `_recordCrash` :3882 |
| 8 | No personal-best logic exists anywhere. No checkpoint split deltas, no medals, no ghost. | `grep -in "personal best\|bestTime" js/*.js` → nothing |
| 9 | Every level is the first N metres of one seeded 1200 m road. Obstacles and presents are seeded from the level id's first character, so Grandma's Chill is exactly one pylon at 88 m and the same 7 presents, every run. Geese are the only non-deterministic element. | `js/obstacles.js:161–191`; `js/collectibles.js:161–179`; `js/world.js:70` |
| 10 | The tutorial runs only for motion input; keyboard and gamepad players never see it. It teaches steering only. README says pedals are Up/Down; code is Left/Right, touch halves, LB/RB or LT/RT. | `js/game.js:5176–5192`; `js/input-manager.js:1170–1171` |

**B. There is no player-behaviour data in hand, but the pipeline exists.** `rides`
already records `level, role, difficulty, completed, abandon_reason, duration_ms,
crash_count, timeout_count, restarts, pedal correctness, fps, dda assists`; `rooms`
records stoker join, WebRTC success, p2p vs relay; `conversions` records
`room_code_generated, stoker_joined, replay_click, clip_shared`. The dashboard is gated to
the owner's email and this machine is not logged into wrangler, so nobody has ever read
it. Signed-in players *do* have `sessions.google_uid`, so a partial D1/D7 is one query
away today. (Migrations `worker/migrations/0002…0007`.)

**C. Every recorded external confusion is in the first 60 seconds.** Gyro/input not
working (#296, #293, #139), who-is-P1/P2 controller claiming (#204/#218), tutorial gates
(#139/#113), first-ride jank (#216), silent "Tap to Start" dead end (#350), no loading
indicator (#162). The first-30-seconds bounce audit (#263) and the 3-non-gamer playtest
protocol (#261) are open and have never been executed. 250 Steam playtesters produced
zero feedback; the 2026-07-19 Code & Coffee playtest left no notes. Since May, ~70 % of
commits went to controller/gyro plumbing and goose polish; none to onboarding, retention
or measurement.

**D. Comparable-game evidence (sources in §10).**

- Next Fest: 68–88 % of wishlists come from people who never play the demo; the capsule,
  tags and page matter most. Co-op demos "get plays, not wishlists" — add an end-of-run
  wishlist prompt. Median demo playtime 14 min (18.5 for replayable games).
- Daily modes: Trackmania and PEAK allow unlimited replays on the shared seed; Spelunky's
  one-shot works because it creates spectating. Wordle's grid was invented by a player as a
  *spoiler-free story of the run*; Wardle deliberately had no leaderboard. Duolingo's streak
  freeze cut churn 21 % — leniency increases engagement.
- Co-op stickiness (Overcooked, KTANE, Portal 2, It Takes Two): asymmetric information,
  mid-level disruptions that force re-coordination, sync pings with a countdown, expressive
  gestures, small failure penalties with room to coordinate.
- Physics comedy (Human Fall Flat, Getting Over It): failure is funny when the body flops
  and the tone winks; fixed-content failure lands on the player (good for blame comedy);
  re-entry is sub-2 s with no menu.
- Async competition (Mario Kart ghosts, Strava): ghosts are target *and* teacher; small
  local leaderboards beat global; reward *frequency* ("Local Legend") not just speed.

**E. The adversarial review's points that v2 adopts.** A daily is a launch-retention
beat, not a fest-wishlist beat. The v1 one-ranked-attempt rule locks out the persona's own
scenario (solo at lunch, partner at 21:40). The persona says "weekly game night", not
daily. 00:00 UTC is 20:00 ET / 17:00 PT — inside the US evening. The text strip is the
wrong medium for a TikTok/Reels audience; the clip recorder already exists
(`js/game-recorder.js:1480–1503`). Surfacing mastery (PB, medals, "beat 2:41") is 1–2 days
of work, needs no world refactor, and is the strongest extender of a 10-minute demo
session.

### 1.3 The revised thesis

> Make the ride's one verb feel good and honest, make doing it *together* strictly better
> than doing it alone, make failure fast and funny, and show the player a number to beat.
> Do that before the demo. Then give the pair a reason to come back (shared road, ghosts,
> pair records) and, after that, the emotional headline (ride the distance between you).

---

## 2. Goals, non-goals, success metrics

### Goals (in priority order)

1. **The verb feels good and is honest.** A pedal tap is heard, felt and seen; sync in
   co-op is visible and rewards cooperation; tension exists by default at a level a
   non-gamer can survive; the instructions tell the truth. (Phase A)
2. **The first five minutes don't fail.** Boot dead-ends, first-ride jank and input
   confusion are fixed; keyboard/gamepad players get 20 s of coaching; the first segment
   can't time out while someone reads the screen. (Phase A)
3. **Failure is a beat, not a menu.** Crash → funny → riding again in ≤ 2.5 s. (Phase B)
4. **There is a number to beat.** Local PB, checkpoint split deltas, medals per
   level/difficulty, "beat 2:41" on the level card. (Phase B)
5. **The demo converts.** Solo-viable (it already is), ends every ride with a wishlist +
   "send the link to your partner" CTA, per-phase instrumented; store page work (#262,
   #357) done by the owner in parallel. (Phase B)
6. **Measure.** Read the existing data in week 1; add `device_id`; dashboard retention /
   drop-off / pairs routes. (Phase A → C)
7. **A returning pair has a reason to ride again** — shared-seed road with practice + one
   ranked run per mode, spoiler-free strip, pair-scoped board, ghosts, streaks with
   freezes. (Phase D)
8. **The pair is a first-class object** the game remembers and celebrates. (Phase D)
9. **Co-op has depth**: asymmetric information, disruptions, sync ping, seat-specific
   jobs. (Phase E)
10. **Tourist Mode becomes "Ride the distance between you."** (Phase E)

### Non-goals (for this plan)

- Real-money monetization, Chaos Coin economy, new cosmetics.
- New authored levels or biomes. The whole point is value without authored content.
- A global daily leaderboard. Boards are pair/partners-scoped (§3 decision 5).
- Controller / Steam Input / overlay work. Separate track; the evidence says it has had
  enough attention for now.
- Rewriting the lobby, the pedal input pipeline, or the netcode. Change constants and
  rules; add small modules; do not restructure.

### Success metrics

Pre-launch (demo, measured via existing `rides`/`sessions`/`conversions` + new events):

| Metric | How measured | Target |
|---|---|---|
| First-ride completion (first `rides` row per session, `completed=1`) | `rides` | ≥ 70 % |
| Rides per demo session | `rides` per `session_id` | ≥ 3 |
| Median demo session length (Steam) | `sessions.ended_at − started_at`, platform=steam | ≥ 14 min |
| Time to first input | `first_input.time_to_first_input_ms` | median ≤ 20 s |
| Co-op sync quality with two active players | `rides.offset_quality` where role≠solo | median ≥ 0.7 (today: mathematically ≤ ~0.5) |
| Crash → riding again | new event `crash_recover` with `ms` | median ≤ 2.5 s |
| Wishlist CTA click rate | new conversion `wishlist_click` ÷ victories | ≥ 15 % |
| "Send link to partner" from victory | new conversion `invite_click` ÷ solo victories | ≥ 10 % |

Post-launch (from the persona doc §13, plus the retention beats):

| Metric | How measured | Target |
|---|---|---|
| D1 / D7 return (any player) | `sessions.device_id` (A-9) → dashboard `retention` (C-1) | ≥ 45 % / ≥ 20 % |
| Repeat-pair sessions (same two accounts ≥ 2×) | `pairs` table (D-7) | ≥ 40 % of MP pairs |
| Shared-road share rate (strip or clip shared ÷ finishes) | `daily_share` + `clip_shared` ÷ `daily_finish` | ≥ 0.3 |
| Pair returns within 8 days of a shared-road ride | `pairs.last_ride` deltas | ≥ 40 % |
| Where sessions end | `rides.abandon_reason` + `ride_events`, dashboard `dropoff` | informational |

---

## 3. Decisions taken (v2)

These are the assumptions this plan is built on. If the owner overrides one, the affected
items are named so they can be re-scoped. Decisions 1–7 are new in v2; 8–14 revise v1.

| # | Question | Decision | Why | Affects |
|---|---|---|---|---|
| 1 | What ships in the demo (cut by **2026-11-30**; Steam Next Fest **February 2027**)? | **Feel, first-five-minutes, PB/medals, crash beat, demo CTAs, measurement, and "Today's Road" in practice form only** (seeded daily road, no ranked/board/streaks). No pair server, no Tourist in the demo build. Ranked/board/streaks/pairs go live on the web build between the demo and the fest. | Fest visitors play once for ~14 min; wishlists come from the page and the first ride. The demo should be live 2–3 months before the fest, so it must be cut by end of November. | Phases A–C vs D–E |
| 2 | Co-op "perfect" definition | **Beat-window model.** A tap opens a 250 ms window. Partner taps the opposite foot inside the window → both score *perfect* (offset +0.10, bonus accel). Same foot inside the window → *crank fight* (existing rule). No partner tap in the window → *solo stroke*: normal accel, no offset bonus, offset decays. Own-foot repeat → *wrong* (unchanged). | Makes riding together strictly better than a carry; gives a readable skill ("match your partner's beat with the opposite foot"). Matches how a real 180°-offset tandem crank works. | A-2, A-4, achievements |
| 3 | Safety / tension defaults | **Safety ON by default only on Tutorial and Chill.** Adventurous and Daredevil default OFF with a reachable danger-wobble onset. Instructions text becomes true for the selected difficulty. Chill keeps the clamp but gains a *visible* wobble band so the player feels the edge exists. | Tension is currently zero on every preset; the persona is "forgiving of their own mistakes", so Chill stays un-crashable — but must stop lying. | A-5 |
| 4 | Crash recovery | **Non-final crashes skip the modal.** Tumble animation + goose honk + auto 3-2-1 countdown, ≤ 2.5 s to riding. The modal appears only on END RIDE / time-up / a crash on a ranked run. | Failure should be a beat; the sub-2 s re-entry is the consistent pattern in physics-comedy games. | B-2 |
| 5 | Leaderboard scope for shared-road rides | **Pair + partners only** (`/partners` list). No global daily board. "Everyone: #7 of 23" is dropped. | Wordle's "feels human" finding; Strava's small-pool evidence; a dead global board is worse than none. | D-6 |
| 6 | Reset time for the shared road | **09:00 UTC** (05:00 ET / 02:00 PT / 10:00 UK / 19:00 AEST). | Outside every launch market's evening; long-distance pairs share one window. | D-1, D-2 |
| 7 | Cadence: daily or weekly? | **Both, one mechanism.** The road reseeds daily. The *pair streak* counts weeks with ≥ 1 shared-road ride together (persona: "weekly game night"). The *personal streak* counts days, with 2 free freezes per month (Duolingo). | Daily streaks are designed to break for this audience; weekly matches their stated cadence. | D-5 |
| 8 | Ranked attempts | **One ranked run per (account, mode) per day**, mode ∈ {solo, pair}. Unlimited practice. Ranked = first *full* run the player starts as ranked; normal rules (rewind allowed, DDA **off** so everyone rides the same road; Safety allowed and flagged 🛡️). | v1's single attempt with no rewind locked out the persona's own scenario and contradicted the cozy positioning. DDA off keeps the road identical for everyone. | D-3 |
| 9 | Procedural road or Tourist tiles for the shared road? | Procedural first (unchanged). | Ships without Maps billing; determinism proven. | D-*, E-6 |
| 10 | Tourist Mode: headline or side mode? | **Post-launch headline**, sequenced after Phases A–D. | No comparable retention evidence — it is an emotional hook, not a habit driver, and the largest build. | Phase E |
| 11 | What is D1/D7 today? | **Partly measurable now** for signed-in users via `sessions.google_uid`; run it in A-1. `device_id` (A-9) extends it to anonymous players. | The v1 claim "unmeasurable" was too strong. | A-1, A-9, C-1 |
| 12 | Persona doc | Revise to admit local co-op and VERSUS as secondary modes (unchanged), and add the "verb first" thesis. Docs-only; **not** before the demo. | Zero player value pre-fest. | C-3 |
| 13 | Which difficulty for the shared road? | Adventurous, fixed (unchanged) — **after** A-5 has re-tuned Adventurous. | Everyone rides the same thing; it must be a tuned preset. | A-5, D-2 |
| 14 | Who counts as a pair? | Two signed-in accounts (unchanged); guests keyed by device id and merged on sign-in. | — | D-7…D-9 |

---

## 4. Codebase orientation (read before any item)

Key facts an implementer needs, all verified at `dc2ddad`.

### 4.1 Where the world comes from (seeds)

| What | Where | Seed today |
|---|---|---|
| Road centreline (closed loop, 1200 m) | `js/world.js:70` → `new RoadPath(42)`; `js/road-path.js:21` `constructor(seed = 42)` | literal `42` |
| Road chunks (mesh built from `roadPath`) | `js/world.js:73` `new RoadChunkManager(scene, this.roadPath)` | none (derived) |
| Trees | `js/world.js:80` `this._treeRngState = 137` | 137 |
| Clouds | `js/world.js:98` `this._cloudRngState = 271` | 271 |
| Balloons | `js/world.js:103` and `:530` `_balloonRngState = 53` | 53 |
| Ground bumps | `js/world.js:134` `let seed = 12345` | 12345 |
| Obstacles | `js/obstacles.js:165` `makeRng(this.level.id.charCodeAt(0) * 2000 + 13)` | from level id |
| Collectibles | `js/collectibles.js:163` `makeRng(this.level.id.charCodeAt(0) * 1000 + 7)` | from level id |
| Roadside geese | `js/geese.js:501` `makeRng(Math.floor((this.level?.distance \|\| 1000) * 7) + 991)` | from level distance |

`World` is constructed **once** in the `Game` constructor (`js/game.js:246`) and reused
across rides. `bike.roadPath` is assigned once at `js/game.js:250`. The per-ride managers
(collectibles, obstacles, geese, race manager, DDA) are re-created at the start of every
countdown in `_startCountdown` (`js/game.js:1576`, managers at `:1670–1681`; the VERSUS
equivalent is `_startVersusCountdown` at `:1791`, managers at `:1848–1873`).

The road path, trees, clouds and balloons are placed lazily as the bike advances
(`_placeTreesUpTo`, `_placeCloudsUpTo`, `RoadChunkManager.update`).

### 4.2 Levels

`js/race-config.js` exports `LEVELS` (tutorial 225 m, grandma 250 m, castle 500 m) and
`getLevelById(id)`. Level fields used elsewhere: `id`, `name`, `distance`, `collectibles`
(`'presents'`|`'gems'`), `checkpointInterval`, `icon`, `description`, `isTutorial`,
`coaching`, `timerEnabled`, `treeCollision`, `motionAdaptation`.

Level cards are built in `js/lobby.js:1143` `_buildLevelCardsShared(...)`. Unlock rule
lives there as `LEVEL_UNLOCK = { castle: 'home_sweet' }`. Difficulty picker visibility
per level: `_updateDifficultyVisibility(levelId)` at `js/lobby.js:1304`. Level choice is
synced to the online partner via `RoomProtocol.levelSync(levelId)`
(`js/lobby/room-protocol.js:29`, sent from `js/lobby.js:1194` and `:1226`).

### 4.3 Ride lifecycle in `js/game.js`

| Step | Function | Notes |
|---|---|---|
| Start | `_startCountdown()` `:1576` | applies difficulty (`applyDifficulty`), creates `DDAManager` `:1595`, race manager + item managers `:1670`, `analytics.startRide(...)` `:1688` |
| Restart | `_resetGame(fromRemote, fromBeginning)` `:2044` | rewinds to last checkpoint unless `fromBeginning`; increments `raceManager.restartCount`; calls `ddaManager.applyInvisibleAdjustments()` |
| Crash overlay | `_showGameOver()` `:2263` | |
| Finish | `_startFinishCinematic()` `:2567` → `_showVictory()` `:2623` | builds stats grid, calls `_submitScore()` `:2913` (signed-in only, skips demo) |
| Back to lobby | `_returnToLobby()` `:3104` | |

Game state names: `lobby`, `instructions`, `waiting`, `calibrating`, `countdown`,
`playing`, `gameover`, `victory` (see `docs/screen-flow.md`).

Safety mode: `this.safetyMode` (`js/game.js:386`), toggled by the side button, passed
into `bike.update(...)`. Recorded as `safety_used` in scores and rides.

### 4.4 Difficulty and DDA

`js/config.js` `DIFFICULTY_PRESETS` (`tutorial`, `chill`, `adventurous`, `daredevil`),
`applyDifficulty(name)` copies a preset into the mutable `TUNE`. `js/dda-manager.js`
`DDAManager` tracks failures per checkpoint and offers assist/skip; `applyInvisibleAdjustments()`
is called on every restart.

### 4.5 Identity, scores, server

- `js/auth.js` — Google / Steam sign-in, JWT, `submitScore(data)` → `POST /score`.
- `worker/leaderboard.js` routes (`:23–108`): `/auth/google`, `/auth/steam`, `/score`,
  `/me`, `/achievements/sync`, `/partners`, `/relay-token`, `/leaderboard`, `/player/*`,
  `/api/analytics/{session,event/batch,ride,room,conversion}`,
  `/api/analytics/dashboard/*` (dashboard-auth'd; handlers map at `:1037`).
- D1 tables: `users`, `scores`, `score_contributions` (has `player_user_id` per role),
  `user_achievements`, `friends` (unused) in `worker/schema.sql`; analytics tables
  `sessions`, `events`, `rides`, `ride_events`, `rooms`, `conversions` in
  `worker/migrations/0002_analytics.sql` (later migrations add columns).
- `dashboard/index.html` renders the dashboard routes.

### 4.6 Analytics client

`js/analytics.js`: `initSession(opts)`, `trackEvent(type, data)`, `startRide(...)`,
`trackRideEvent(...)`, `trackConversion(...)`. Session id is `crypto.randomUUID()` stored
in `sessionStorage` only — a new id per tab, nothing persistent.

### 4.7 Sharing

`js/game-recorder.js:1480–1500` already uses `navigator.share` / `navigator.canShare`
(mobile) for clip files; that's the pattern to copy for the daily result strip
(text share, with clipboard fallback).

### 4.8 Tourist Mode branch (`feat/333-tourist-mode-3d-tiles`)

Adds `js/tourist-config.js` (324 lines: origin resolution, key lookup, elevation),
`js/tourist-world.js` (440 lines: 3D Tiles world source, ground probe), `docs/tourist-mode.md`,
`scripts/gen-tourist-key.js`, key-injection steps in `.github/workflows/deploy.yml` and
`pr-preview.yml`, `?mode=tourist&lat=&lon=` URL params, and ~40 lines in `js/game.js`.
There is no destination, no finish, no result screen — it is free-roam.

---


### 4.9 The verb: pedal, balance, crash, HUD (read before any Phase A/B item)

- **Solo pedal model:** `js/pedal-controller.js`. `update(dt)` drains pending taps; a
  tap with a different foot than the last adds `0.35 + 0.6·power` m/s of acceleration and
  builds `pedalPower` (cadence bonus for gaps < 0.8 s, `:55`); a repeated foot costs power
  and adds wobble (`:54–63`). Power decays 40 %/s (`js/bike-model.js:494–501`).
- **Shared (co-op) pedal model:** `js/shared-pedal-controller.js`. Same shape but taps
  carry `source: 'captain'|'stoker'`. Crank-fight check at `:48–62`; per-tap scoring at
  `:65–112` (wrong / in-phase / perfect); `offsetScore` decays 5 %/s (`:117`). Flags
  `wasCorrect/wasWrong/wasInPhase/wasBrake` are read by `js/hud.js:232–281` for the tap
  arrows and by `js/versus/versus-hud.js:110–115` for the sync dot.
- **Balance and crash:** `js/bike-model.js` `update(pedalResult, balanceResult, dt,
  safetyMode, autoSpeed)` at `:450`. Auto-cruise (`autoSpeed` presets) holds 3 m/s
  (`:474–479`); safety clamp `:583–585`; danger wobble uses `crashThreshold × dangerOnset`;
  `_fall()` sets `fallen=true, fallTimer=2.0` (`:779–788`). The crank mesh spins by speed
  (`:668–673`); `crankAngle` from the pedal model is stored at `:451` and never rendered.
- **Presets:** `js/config.js` `DIFFICULTY_PRESETS` (`:125–176`): `crashThreshold`,
  `gravityForce`, `wobbleMultiplier`, `dangerOnset`, `timeMultiplier`, `maxSpeed`,
  `autoCorrection(Strength)`, `pedalLeanKickScale`, `autoSpeed`. Applied by
  `applyDifficulty(name)` into the mutable `TUNE`.
- **Crash flow in `js/game.js`:** `_recordCrash(cause)` `:3882` → `bike.fallen` →
  `_showGameOver()` `:2263` (modal RESTART/END RIDE, buttons registered with
  `_setOverlayButtons` for gamepad focus) → `_resetGame(fromRemote, fromBeginning)`
  `:2044` → `_startCountdown()` `:1576` (3 s). Timer expiry: `_onTimerExpired()` `:1979`.
- **Segment timer:** `js/race-manager.js` `_segmentBudget(d) = max(10, d/250·60)` `:34`;
  first segment budget set on first start `:40–47`; per-checkpoint budget `:100–106`.
- **HUD:** `js/hud.js` — tap arrows `:232–281`, status line ("Pedal! Alternate ← →")
  `:286–294`, co-op partner indicators `:303–330`. Sync dot only in the versus HUD.
- **Audio:** `js/audio-engine.js` class `AudioEngine` — `tone()` `:147`, `chime()` `:167`,
  `gooseHonk()` `:356`, `crash()` `:487`, bike loop `startBike/updateBike` `:533/:630`.
- **Haptics:** `js/haptics.js` — `hapticCrash/TreeHit/Bump/Checkpoint/Finish/OffRoad`
  (`:140–172`), all via `_gamepadRumble(strong, weak, ms)` `:69`; sources registered with
  `setHapticSources`.
- **Instructions overlay:** `index.html:4514–4519` (static text, shown before every ride).
- **Victory overlay:** `#victory-overlay` `index.html:5182`, stats grid `#victory-stats`;
  populated by `_showVictory()` `js/game.js:2623–2911`. Steam store links exist at
  `index.html:5164` and `:5217`. `_isDemo` (`js/game.js:743`) currently hard-returns
  `false`.
- **Clip recorder:** `js/game-recorder.js` — share path `:1480–1503` (`navigator.share`
  with a file, `clip_save` event, `clip_shared` conversion).

---

## 5. Work items

Item IDs: `<phase>-<n>`. Phases are ordered by the launch calendar (§6). Within a phase,
items are ordered by dependency. Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** ≥ 1 week.

### Phase A — The verb, the first five minutes, the data (2026-09-08 → 2026-10-12, before GDEX)

#### A-0 · Unit test harness (first PR)

- **Branch:** `chore/unit-test-harness` · **Size:** S
- **Goal:** `npm test` runs `node --test test/unit/` and passes; CI runs it on PRs.
- **Files:** `package.json` (`"test": "node --test test/unit/"`), a first real test
  `test/unit/race-config.test.mjs` asserting `getLevelById('nope')` returns the tutorial,
  `.github/workflows/pr-preview.yml` (add an `npm test` step before deploy — this is the
  one workflow edit this plan allows in Phase A).
- **Acceptance criteria:** `npm test` exits 0 locally; a PR shows the test step.
- **Out of scope:** browser/DOM tests, puppeteer.

#### A-1 · Read the data we already have

- **Branch:** `docs/analytics-baseline` · **Size:** S (owner-assisted: needs `wrangler login`)
- **Goal:** `docs/analytics-baseline-2026-09.md` records the real funnel so every later
  tuning and design decision cites a number.
- **Files:** new doc only. Queries run read-only with
  `npx wrangler d1 execute tandemonium-leaderboard --remote --command "..."` from
  `worker/` (config `worker/wrangler-api.toml`). Exclude developer traffic the same way
  the dashboard does (see the exclusion helper near `worker/leaderboard.js:1066`).
- **Steps (each query's result goes in the doc with the SQL):**
  1. Sessions per day, last 90 days, by `platform` (browser/electron/steam).
  2. Rides: count, `completed` rate, median `duration_ms`, mean `crash_count`,
     `timeout_count`, `restarts`, grouped by `level × difficulty × role`.
  3. Abandon reasons by level; distribution of `checkpoints_passed` for abandoned rides.
  4. First ride per session: completion rate and duration (this is the demo's key number).
  5. Rides per session distribution (1, 2, 3, ≥4).
  6. Co-op: `rooms` — stoker join rate, WebRTC success, p2p vs relay share, `rides_played`
     per room; `rides.offset_quality` distribution for role ≠ solo.
  7. Returning users: for `google_uid IS NOT NULL`, share with a session on day +1 and
     within 7 days of their first. (Partial D1/D7.)
  8. Returning IPs as a rough anonymous proxy (flag as unreliable).
  9. `conversions`: `room_code_generated → stoker_joined` rate; `clip_shared` count;
     `replay_click` count.
  10. `events` where `type='first_input'`: median `time_to_first_input_ms`.
  11. Achievements unlocked distribution (which ones, how many players).
- **Acceptance criteria:** the doc has all 11 numbers or an explicit "no rows" per
  query; a one-paragraph "what this says" at the top; the A-5 tuning table and B-3 medal
  thresholds cite it.
- **Out of scope:** dashboard code (C-1); fixing anything found.

#### A-2 · Fix the co-op offset rule (beat-window model)

- **Branch:** `feat/coop-beat-window` · **Size:** M · **Depends on:** A-0
- **Goal:** two players pedalling together score strictly better than one player
  pedalling alone, and the rule is readable: *match your partner's beat with the opposite
  foot*.
- **Files:** `js/shared-pedal-controller.js` (scoring `:65–112`), new pure module
  `js/pedal-scoring.js`, `js/achievements.js:17` (comment/threshold), `test/unit/`.
- **Spec (decision 2):**
  - Keep the input path, `_pendingTaps`, crank-fight detection (`:48–62`) and the
    `wasCorrect/wasWrong/wasInPhase/wasBrake` flags — the HUD depends on them.
  - Extract the per-tap classification into `js/pedal-scoring.js`:
    `classifyTap(state, tap, WINDOW_S = 0.25) → { kind: 'wrong'|'perfect'|'solo'|'fight', pair?: tap }`
    where `state = { captainLastFoot, captainLastTime, stokerLastFoot, stokerLastTime, openBeat }`.
  - Rules, in order: (1) same foot as own last foot → `wrong` (unchanged penalties).
    (2) If a partner tap is *open* (arrived within `WINDOW_S` before this tap, not yet
    paired) and has the opposite foot → `perfect` for **both** taps: `offsetScore += 0.10`
    (once per pair, not twice), each tap gets the current perfect accel formula
    (`0.35 + 0.6·power + offsetScore·0.15`). (3) Open partner tap with the same foot →
    `fight` (existing brake/wobble rule; this replaces the 100 ms window with the same
    `WINDOW_S`). (4) No open partner tap → `solo`: accel `0.35 + 0.6·power` (no offset
    bonus), `offsetScore` unchanged (it still decays 5 %/s at `:117`), wobble +0. Then
    this tap becomes the open beat for `WINDOW_S`.
  - `wasInPhase` is now set for `solo` strokes (it drives the amber arrow in the HUD);
    `wasCorrect` for `perfect`; rename nothing else.
  - **Determinism:** the captain is authoritative for the shared model in online play.
    Confirm by reading `js/game.js` around `:4238–4260` and `js/remote-bike-state.js`
    whether the stoker runs `SharedPedalController` locally; if it does, both sides must
    use the same `WINDOW_S` and the same tap timestamps source. Document what you found in
    the PR.
  - `perfect_sync` (`js/achievements.js:17`, `offsetScore > 0.9` for 10 s) becomes
    reachable by cooperation: with +0.10 per paired beat and 5 %/s decay, two players at
    ~1 beat/s reach 0.9 in ~10 s. Keep the threshold; update the comment.
- **Steps:**
  1. Write `test/unit/pedal-scoring.test.mjs` first with these cases: alternating
     interleaved (C:L, S:R, C:R, S:L… with 100 ms offsets) → every tap after the first
     pair is `perfect`; simultaneous opposite feet → `perfect`; simultaneous same feet →
     `fight`; captain alone alternating → all `solo`, offset never rises; own-foot repeat
     → `wrong`; a partner tap 300 ms later → `solo` + `solo` (window missed).
  2. Implement `classifyTap`; wire `SharedPedalController.update` to it; keep stats
     (`pStats.correctTaps` for perfect and solo, `wrongTaps` for wrong).
  3. Run a two-browser local co-op ride and a captain-only ride; record `offsetScore`
     traces; attach both to the PR (rule 9).
- **Acceptance criteria:**
  - Unit tests pass. Two cooperating players reach `offsetScore ≥ 0.9` within 15 s of
    steady pedalling; a captain alone never exceeds its starting value.
  - Online co-op (two browsers, one on `?room=`) shows the same `offsetScore` on both
    sides within ±0.05 (log it on the HUD debug line during the test).
  - `rides.offset_quality` for the test ride ≥ 0.8.
- **Out of scope:** HUD changes (A-4), solo model changes, the versus rig.

#### A-3 · Make a pedal tap feel like a tap

- **Branch:** `feat/pedal-tap-feel` · **Size:** M · **Depends on:** none (parallel with A-2)
- **Goal:** every pedal tap is heard, felt and seen; cadence is audible.
- **Files:** `js/audio-engine.js` (new `pedalTap(kind, cadence)`), `js/haptics.js` (new
  `hapticPedal(kind)`), `js/bike-model.js:668–673` (crank driven by `crankAngle`),
  `js/game.js` (call sites where `pedalResult` is produced, ~`:4153–4161` and `:4253`),
  `js/chase-camera.js:29–88` (tiny bob), `js/hud.js:232–281` (no change expected).
- **Spec:**
  - **Sound.** `pedalTap(kind, cadenceHz)`: a 30–50 ms percussive click via the existing
    `tone()` path (`:147`), pitch rising with cadence (e.g. 180 Hz at 0.5 Hz → 320 Hz at
    2 Hz), `kind='wrong'` = a dull 90 Hz thud, `kind='fight'` = the existing crash noise at
    low gain, `kind='perfect'` (co-op) = click plus a short 5th above. Route through the
    master bus so the recorder captures it. Respect `setMuted`.
  - **Haptic.** `hapticPedal(kind)`: `_gamepadRumble(0.15, 0.35, 40)` for a normal tap,
    `(0.5, 0.2, 90)` for wrong, nothing for perfect beyond the normal tick (the sound
    carries it). In co-op with per-seat controllers, rumble only the seat that tapped
    (haptic sources are per-seat — see `setHapticSources`).
  - **Crank.** Replace the speed-driven spin at `bike-model.js:668–673` with
    `node.rotation.z = crankAngle (+ per-node offset)` lerped at ≥ 20 rad/s so it snaps a
    quarter turn per tap; keep a slow idle spin from speed when no tap has arrived for
    > 1.5 s so the wheel-to-crank ratio still looks plausible while coasting.
  - **Camera bob.** On each tap, a 60 ms, 1.5 cm vertical impulse in the chase camera;
    doubled on `wrong`. Skip when `prefers-reduced-motion`.
  - **Wire-up.** One function `onPedalTap(kind, cadence, seat)` in `game.js` called
    wherever `wasCorrect/wasWrong/wasInPhase/wasBrake` transitions are already detected
    for the HUD (`hud.js:256–265` shows the edge-detection pattern; do the same in
    `game.js` so audio isn't in the HUD).
- **Acceptance criteria:** with sound on, a blind listener can tell cadence and a wrong
  tap; the crank visibly quarter-turns per tap at low speed; rumble on a DualSense/Xbox pad
  per tap; no audio when muted; recorded clip contains the ticks; frame time unaffected
  (< 0.2 ms per tap in the profiler).
- **Tests:** none automated beyond a pure `tapPitch(cadence)` helper test. Before/after
  recording per rule 9.
- **Out of scope:** music, goose audio, new sounds for boosts (leave for B-4's "signal the
  boost" note).

#### A-4 · Show sync live in the co-op HUD

- **Branch:** `feat/coop-sync-hud` · **Size:** S · **Depends on:** A-2
- **Goal:** both players can see, at a glance, whether they are in sync and who missed.
- **Files:** `js/hud.js` (`:303–330` partner indicators), `index.html` (HUD markup/CSS),
  `js/versus/versus-hud.js:110–115` (reuse its sync-dot colour ramp — extract to a small
  helper if convenient).
- **Spec:**
  - A **sync bar** (0–100 %, red→amber→green) under the speed readout in online and
    local co-op, driven by `sharedPedal.offsetScore`. Hidden in solo.
  - Two small **seat chips** (C / S) that flash green on `perfect`, amber on `solo`,
    red on `wrong`, so the blame is visible and warm ("S missed" is never printed; the
    colour is enough).
  - **"CRANK FIGHT!"** stamp (0.6 s, shaking) on `wasBrake`, with a one-line hint the
    first two times per session: "Same foot, same moment — alternate!"
  - **Coaching line** (first ride of a session only, co-op): "Match your partner's beat
    with the opposite foot" shown until the pair scores 5 perfects.
- **Acceptance criteria:** in a two-browser ride, the bar rises when both alternate in
  time and falls when one stops; the stamp appears on a deliberate same-foot tap; nothing
  new renders in solo; mobile layout does not overlap the pedal buttons (#367 territory —
  check at 390×844).
- **Out of scope:** post-ride contribution UI (exists in `contribution-tracker.js`).

#### A-5 · Honest tension: tune the presets and tell the truth

- **Branch:** `feat/honest-tension` · **Size:** M · **Depends on:** A-1 (cite crash and
  timeout rates), A-3 (feel must be in before tuning)
- **Goal:** on Adventurous and Daredevil the bike *can* fall and warns before it does; on
  Chill and Tutorial it cannot, the player feels the edge, and the instructions text is
  true for the selected difficulty.
- **Files:** `js/config.js:125–176`, `js/game.js:386–391` (safety default), `js/bike-model.js`
  (danger wobble + clamp), `index.html:4514–4519` (instructions), `js/lobby.js`
  (difficulty descriptions in the picker, `_updateDifficultyVisibility` :1304 area).
- **Spec (decision 3):**
  - `safetyMode` default becomes a per-preset field `safetyDefault: true|false`
    (tutorial/chill `true`, adventurous/daredevil `false`), applied in `applyDifficulty`
    and reflected in the SAFETY button state at ride start. The player's manual toggle
    persists for the session as today.
  - **Chill/Tutorial:** keep the ±1.0 clamp; add a *visible* wobble band — when
    `|lean| > 0.8`, danger wobble at 30 % amplitude + the existing danger sound at low
    gain, so the player learns the edge exists without ever falling.
  - **Adventurous:** `crashThreshold 1.4`, `dangerOnset 0.65` (wobble from 0.91 rad),
    `autoCorrectionStrength 4.0`. **Daredevil:** `crashThreshold 1.2`, `dangerOnset 0.55`,
    `autoCorrectionStrength 2.5`. These are starting values; B-1 (GDEX playtest) tunes
    them. Record the before/after crash-per-ride from your own 5 rides in the PR.
  - **Instructions overlay** becomes per-difficulty text from a small table in
    `js/race-config.js` (e.g. Chill: "Lean to steer. You can't fall on Chill — but you
    can go off-road and lose time." Adventurous: "Lean to steer. Lean too far and you'll
    go down. Safety is off — press SAFETY to turn it on."). Fix the README pedal keys
    (Left/Right, LB/RB or LT/RT) in the same PR.
- **Acceptance criteria:** a deliberate hard lean on Adventurous falls within 2 s with
  visible/audible warning first; the same on Chill wobbles and recovers; instructions
  match the preset; rule 10 holds (owner or a non-gamer finishes Grandma's Chill with zero
  balance crashes).
- **Tests:** unit test that every preset has `safetyDefault` and `crashThreshold ×
  dangerOnset < clamp` for presets where `safetyDefault` is false (i.e. the warning is
  reachable). Before/after recording per rule 9.
- **Out of scope:** DDA changes; steering-feel options (`steering_feel_change` exists).

#### A-6 · First-segment grace and coaching for every input

- **Branch:** `feat/first-ride-grace` · **Size:** M · **Depends on:** A-3
- **Goal:** nobody times out while reading the screen, and keyboard/gamepad/touch players
  get 20 seconds of pedal coaching the first time.
- **Files:** `js/race-manager.js:34–47`, `js/game.js` (`_shouldRunTutorial` :5176,
  countdown/HUD start), `js/hud.js:286–294`, `index.html` (coach card markup).
- **Spec:**
  - **Grace:** the first segment's timer does not start until the first correct pedal
    tap *or* 10 s after the countdown, whichever is first; and the first segment budget
    gets +8 s on every difficulty. Timer display shows "—" until it starts.
  - **Coach card** (non-motion inputs; motion inputs keep the existing tutorial): a
    compact card above the HUD on the first ride of a session on Tutorial/Grandma's:
    line 1 "Pedal: alternate ← → " (or LB/RB, or the touch-halves glyph — use
    `getInputMethod()` in `js/analytics.js:89` or the input manager's current source),
    line 2 a live 5-dot meter that fills green per correct tap and flashes red on a wrong
    one. Dismisses itself after 5 correct taps or 20 s. Remember dismissal in
    `localStorage['tandemonium_coach_seen']` keyed by input method.
  - The coach card also explains steering in one line for the current input.
- **Acceptance criteria:** a first-time keyboard player who does nothing for 8 s is not
  bounced; the card shows the right keys for keyboard, gamepad and touch; it never shows
  on the second ride; motion-input players see the existing tutorial unchanged.
- **Tests:** unit test for the grace rule (pure function `segmentStartsAt(firstTapAt,
  countdownEndAt)`); manual for the card.
- **Out of scope:** rewriting the gyro tutorial.

#### A-7 · Close the first-five-minutes issues

- **Branch:** one per issue (`fix/350-tap-to-start`, `fix/162-loading-bar`,
  `fix/216-first-ride-calibration`, `docs/263-bounce-audit`) · **Size:** S each
- **Goal:** the four open first-minute issues are closed and the bounce audit exists.
- **Items:** #350 silent "Tap to Start" dead end; #162 no loading indicator; #216 first
  game janky/pulling (gyro calibration race — first ride must calibrate the same way the
  second does); #263 execute the first-30-seconds bounce audit and write it up as
  `docs/playtests/2026-09-bounce-audit.md` (desktop keyboard, gamepad, iPhone Safari,
  Android Chrome, Steam Deck; time-to-riding and every point of confusion).
- **Acceptance criteria:** each issue's own criteria; the audit lists time-to-first-ride
  per platform and any new issues it filed.

#### A-8 · Store page and capsule (owner, parallel, non-code)

- **Issues:** #262 store page, #357 hero/capsule art.
- **Why here:** 68–88 % of Next Fest wishlists come from people who never play the demo.
  No engineering item depends on this; it is listed so it is not forgotten behind the code
  work. Target: page and capsule updated before the demo goes live (2026-11-30).

#### A-9 · Persistent anonymous device id + the new events

- **Branch:** `feat/analytics-device-id` · **Size:** S
- **Goal:** every analytics session carries a stable per-browser `device_id`, and the
  three new events/conversions used by Phase B exist in `js/analytics.js`.
- **Files:** `js/analytics.js` (`initSession`, ~`:26`), `worker/migrations/0008_device_id.sql`
  (new), `worker/leaderboard.js` (`handleAnalyticsSession` and the sessions INSERT).
- **Steps:**
  1. In `js/analytics.js` add `getDeviceId()`: read `localStorage['tandemonium_device_id']`;
     if missing, generate `crypto.randomUUID()` and store it. Wrap in `try/catch`
     (private mode) and fall back to the session id.
  2. Include `device_id: getDeviceId()` in the `beacon(...)` payload of `initSession`.
  3. Migration `0008_device_id.sql`: `ALTER TABLE sessions ADD COLUMN device_id TEXT;`
     plus `CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);`.
  4. In the worker's session insert, read `device_id` from the body and store it
     (nullable). Do not reject sessions without it (old clients).
  5. Add helper wrappers (no new schema): `trackEvent('crash_recover', { ms, cause })`,
     `trackConversion('wishlist_click', where)`, `trackConversion('invite_click', where)`.
     Document them in the comment block at the top of `js/analytics.js`.
- **Acceptance criteria:** reload twice → two `sessions` rows share one `device_id`;
  incognito → different id, no console errors when `localStorage` throws; existing
  dashboard routes still 200.
- **Tests:** unit test for `getDeviceId()` with a fake `localStorage`.
- **Out of scope:** using `device_id` for anything user-facing; merging across sign-in.

### Phase B — Failure, mastery, demo conversion (2026-10-13 → 2026-11-09)

#### B-1 · GDEX playtest capture (2026-10-15 → 18) and the #261 protocol

- **Branch:** `docs/playtests-2026-10` · **Size:** S (plus the event itself)
- **Goal:** the Phase A build is watched being played by strangers and the observations
  drive the A-5 numbers and the B-2/B-3 designs.
- **Steps:**
  1. Before GDEX: print the observation sheet — per player: input used, seconds to first
     tap, first-ride finished Y/N and time, balance crashes, timeouts, moments they laughed,
     moments they asked a question, whether they asked to go again, whether they'd send a
     link to someone (who?).
  2. Run #261 with three non-gamers (tutorial → Grandma's Chill → one Adventurous ride).
  3. Run two co-op pairs on the same laptop+phone; note whether they talk about the beat.
  4. Write `docs/playtests/2026-10-gdex.md`; file issues; adjust `DIFFICULTY_PRESETS` in a
     follow-up PR citing the doc.
- **Acceptance criteria:** ≥ 8 observed players; the doc exists; each preset change cites
  a line of it.

#### B-2 · Crash is a beat, not a menu

- **Branch:** `feat/crash-beat` · **Size:** M · **Depends on:** A-3
- **Goal:** a non-final crash goes tumble → honk → 3-2-1 → riding in ≤ 2.5 s with no
  modal; the modal appears only when the player chooses to stop or the ride is over.
- **Files:** `js/game.js` (`_recordCrash` :3882, `_showGameOver` :2263, `_resetGame` :2044,
  `_startCountdown` :1576), `js/bike-model.js:779–788`, `js/geese.js` (a "pile-on" honk
  burst helper), `js/audio-engine.js` (`gooseHonk` :356), riders' lean clips (see
  `docs/` for the riders rig; a simple Y-rotation tumble of the bike group is acceptable
  for v1 — do not touch the GLB).
- **Spec (decision 4):**
  - `fallTimer` 2.0 → 1.2 s. During it: bike group rolls to the fallen side with a
    0.4 s ease and a small bounce; riders' lean clip to full extent; `gooseHonk` ×2 with
    random pitch; camera shake 0.35; screen vignette instead of full red flash.
  - At `fallTimer` end, if the ride is not over: `_resetGame()` to the last checkpoint
    with a **1.5 s** countdown ("3-2-1" compressed, or "GO" only) instead of 3 s. No
    modal. The existing END RIDE side button remains available throughout.
  - The modal (`_showGameOver`) is used only for: time-up, END RIDE, ranked-run crash
    (Phase D), and after the **third** crash in one segment (offers RESTART SEGMENT /
    CHILL MODE / END RIDE — DDA already suggests assists; wire to the existing
    `dda_assist` flow).
  - Online co-op: the captain drives the sequence; the stoker's client mirrors from the
    existing reset/countdown messages — verify `_resetGame(fromRemote=true)` path at
    `:2044` still works with the shorter countdown.
  - Analytics: `crash_recover` with `ms` from impact to `state === 'playing'`.
- **Acceptance criteria:** measured `crash_recover` median ≤ 2.5 s on desktop, ≤ 3.5 s on
  mobile (pointer-lock wait); the third crash in a segment shows the modal; both clients
  in co-op resume together; the recorder captures the tumble.
- **Tests:** unit test for the "third crash in segment" counter; recording per rule 9.
- **Out of scope:** ragdoll physics; new goose animations.

#### B-3 · Personal bests, split deltas, medals

- **Branch:** `feat/local-pb-splits` · **Size:** M · **Depends on:** A-0, A-1 (thresholds)
- **Goal:** every ride is against a number: the level card shows your best and medal, the
  HUD shows ± at each checkpoint, the victory screen says NEW BEST or how far off.
- **Files:** new pure `js/records.js`, `js/race-config.js` (medal table), `js/game.js`
  (`_showVictory` :2623, checkpoint event handling near `:2024–2038`), `js/lobby.js`
  (`_buildLevelCardsShared` :1143), `js/hud.js`, `index.html`.
- **Spec:**
  - `records.js`: `key(level, difficulty, mode)` with `mode ∈ {solo, coop, versus}`;
    `getBest(key) → { timeMs, splits: [ms…], date } | null`; `recordRun(key, run) →
    { isNewBest, delta }`; storage `localStorage['tandemonium_records']` (JSON, capped at
    200 keys). Splits are cumulative ms at each checkpoint.
  - **Medals** per `level × difficulty` in `race-config.js`: `{ gold, silver, bronze }`
    ms. Initial values: from A-1's finish-time distribution (p10/p35/p65) where ≥ 20
    rides exist, else the owner's best ×1.1 / ×1.35 / ×1.7. Comment the source.
  - **Level card:** under the name, "Best 2:41 · 🥈 · gold at 2:20" (or "No ride yet").
  - **HUD:** at each checkpoint, "+1.3" (red) / "−0.8" (green) vs the best's split for
    1.5 s next to the checkpoint flash; only when a best exists.
  - **Victory:** "NEW BEST!" banner (existing celebration audio), else "Best 2:41 · you
    2:47 (+6)"; medal earned this run; "gold at 2:20" if not gold.
  - Co-op bests are keyed by mode only (the pair-scoped record is D-6); guests included.
- **Acceptance criteria:** unit tests for `recordRun` (first run, worse run, better run,
  splits length mismatch); a second Grandma's ride shows deltas; the card updates without
  reload; clearing storage returns to "No ride yet".
- **Out of scope:** server sync of bests; ghosts (D-4).

#### B-4 · Seed plumbing and per-run placement

- **Branch:** `feat/seed-plumbing` · **Size:** M · **Depends on:** A-0
- **Goal:** the world can be reseeded without rebuild, item placement can vary per run
  while the road stays the same, and both clients agree — the foundation for Today's Road.
- **Spec:** implement item **D-0** below (the v1 `World.reseed` / `js/daily-seed.js`
  design, unchanged) **plus** one consumer: `placementSalt` (an integer the captain
  chooses per run — `Date.now() % 1e6` — and sends via `levelSync(levelId, { placementSalt })`)
  is mixed into the obstacle and collectible seeds (`deriveSeed(seed, 6 + salt)`,
  `deriveSeed(seed, 7 + salt)`). Road, trees, clouds unchanged. Tutorial exempt.
  Grandma's Chill keeps *exactly one* obstacle but its position varies within 60–200 m.
- **Also:** signal the two hidden speed sources — a brief "BOOST" ribbon + pitch-up on
  collectible boost, and a faint centre-strip glow when the +0.3 m/s² strip bonus is
  active (`bike-model.js:504–507`). (S, same PR.)
- **Acceptance criteria:** D-0's golden test for `RoadPath(42)`; two runs of Grandma's
  differ in pylon position; both browsers in co-op place items identically (compare the
  first obstacle's z on both HUD debug lines).

#### B-5 · Demo conversion: wishlist + "send the link"

- **Branch:** `feat/demo-ctas` · **Size:** S · **Depends on:** A-9
- **Goal:** every victory and game-over ends with two obvious next actions: wishlist
  (demo/web) and send a room link to a partner (solo only).
- **Files:** `js/game.js` (`_isDemo` :743 → real detection; `_showVictory`,
  `_showGameOver`), `index.html` (`#victory-overlay` :5182 buttons; reuse the store URL at
  `:5164`), `js/analytics.js` (conversions from A-9).
- **Spec:**
  - `_isDemo` returns true when `?demo=1`, or when the Steam bridge reports the demo app
    id (read whatever `steam/`-side flag the Electron preload already exposes — do not
    edit `steam/`; if nothing is exposed, `?demo=1` in the demo's launch URL is enough).
  - Victory/game-over: a **"♥ WISHLIST ON STEAM"** button (web + demo; hidden in the full
    Steam build) opening the store URL; and, in solo, **"🚴 SEND A LINK TO YOUR
    PARTNER"** which creates a room and copies/shares the `?room=` link exactly as the
    lobby's room flow does (call the same code path as the CAPTAIN button; do not
    duplicate).
  - Gamepad focus via `_setOverlayButtons`.
  - Analytics: `wishlist_click` (`where: 'victory'|'gameover'`), `invite_click`.
- **Acceptance criteria:** buttons visible on desktop and 390×844 mobile without
  covering stats; wishlist hidden in the full Steam build; invite path lands the partner
  in the room as stoker.

#### B-6 · Non-gamer playtest gate before the demo cut

- **Branch:** `docs/playtests-2026-11` · **Size:** S
- **Goal:** the #261 protocol is passed by three fresh non-gamers on the Phase B build
  (0 balance crashes on Chill, finish < 5 min, at least one laugh) before C-4 cuts the
  demo. Write `docs/playtests/2026-11-protocol.md`. Failures become issues that block C-4.

### Phase C — Demo cut and measurement (2026-11-10 → 2026-11-30)

#### C-1 · Dashboard: retention, drop-off, pairs

- **Branch:** `feat/dashboard-retention` · **Size:** M · **Depends on:** A-9 (≥ 1 week of
  `device_id` data)
- **Goal:** the dashboard answers "what is D1/D7?", "how many pairs come back?", "where
  do sessions end?".
- **Files:** `worker/leaderboard.js` (`handleDashboard` handlers map `:1037`; add
  `dashRetention`, `dashDropoff`, `dashPairs`), `dashboard/index.html` (three panels).
- **Steps:**
  1. `retention`: per cohort day, distinct `device_id` first seen that day and the
     fraction with a session on day +1 / day +7 → `{ cohorts: [{ day, n, d1, d7 }],
     overall }`. Apply the developer-exclusion helper (`:1066`).
  2. `dropoff`: `rides` grouped by `level, completed, abandon_reason`; histogram of
     `duration_ms` (30 s buckets) for abandoned rides; abandoned rides by
     `checkpoints_passed`; plus `crash_recover` median from `events`.
  3. `pairs` (pre-D-6): unordered pairs of `player_user_id` sharing a `score_id` in
     `score_contributions`; distinct pairs and share with ≥ 2 shared scores; median gap in
     days between a pair's rides (this decides whether the pair streak is weekly — decision 7).
  4. Panels follow the existing `overview` pattern; plain tables; no chart library.
- **Acceptance criteria:** routes return and match hand SQL; exclusion params apply;
  dashboard loads with no console errors.
- **Out of scope:** charts, exports, alerts.

#### C-2 · "Today's Road" (practice-only) in the demo

- **Branch:** `feat/todays-road` · **Size:** M · **Depends on:** B-4
- **Goal:** a level card "Today's Road 📅" that everyone in the world rides the same
  seeded 500 m Adventurous road on, with unlimited runs, PB/splits from B-3, and no
  ranked/board/streak machinery.
- **Spec:** implement v1 item **D-1** (daily level + lobby card + `levelSync` extra + the
  `?daily=` deep link) with these changes: day key rolls at **09:00 UTC**
  (`dailyKey(now) = ISO date of (now − 9 h)`); card subtitle "Same road for everyone
  today · new road at 09:00 UTC (05:00 ET)"; no PRACTICE/RANKED chooser; `daily_open`
  event only. Not in the VERSUS list.
- **Acceptance criteria:** D-1's criteria minus ranked; two machines on the same UTC day
  get identical worlds; the card shows B-3's best for today's key (records key includes
  the day key so yesterday's best doesn't carry).

#### C-3 · Persona doc and roadmap note (docs only)

- **Branch:** `docs/persona-and-roadmap` · **Size:** S
- **Steps:** edit `docs/ideal-customer-persona.md` (local co-op and
  VERSUS as secondary modes; drop the "couch co-op" prohibition and the anti-persona
  bullet; add the §2 metrics), add a §15 "Retention thesis" that states §1.3 of this plan
  (verb first, then cadence, then pair, then Tourist), and add a one-line "Roadmap: see
  docs/value-and-appeal-plan.md — surface freeze in effect" under a Roadmap heading in
  `README.md`.
- **Acceptance criteria:** nothing in the persona doc contradicts the lobby.

#### C-4 · Demo cut checklist (2026-11-24 → 30)

- **Owner + engineer.** Not a branch; a checklist in `docs/demo-2026-11-checklist.md`:
  - [ ] All Phase A and B items merged; B-6 passed.
  - [ ] Zero console errors at lobby on Chrome, Safari iOS, Android Chrome, Steam build.
  - [ ] A-1 queries re-run on the last two weeks; first-ride completion ≥ 70 %.
  - [ ] `crash_recover` median ≤ 2.5 s; `offset_quality` median ≥ 0.7 in co-op rides.
  - [ ] Wishlist CTA verified in the Steam demo build; store page (#262/#357) live.
  - [ ] Demo content: Tutorial, Grandma's, Today's Road; Castle locked with wishlist hint.
  - [ ] Tag `demo-2026-11`; note the commit in this doc.


### Phase D — The shared road, ranked runs, ghosts, and the pair (2026-12-01 → 2027-01-31; live on the web build before Next Fest)

Ordering inside Phase D: D-0 and D-1 are **already implemented by B-4 and C-2** in the
demo (practice form); they are kept here as the full spec. Then rules → strip → ghosts →
streaks → partners board → pair server. Everything through D-5 is **client-only** and
works signed-out.

**Day key (decision 6):** everywhere this phase says "UTC day", the key is the ISO date
of `now − 9 h` (rollover 09:00 UTC). `dailyKey()` in `js/daily-seed.js` implements this;
nothing else computes a day.

#### D-0 · Seed plumbing: `World.reseed(seed)` and seeded item managers (spec for B-4)

- **Branch:** `feat/seed-plumbing` (B-4)
- **Goal:** the whole world (road, trees, clouds, balloons, obstacles, collectibles,
  geese) can be rebuilt from a single integer seed at ride start, and rebuilding with the
  same seed twice yields identical placement. Existing levels keep their **exact current
  layout** (regression safety).
- **Files:** `js/road-path.js`, `js/world.js`, `js/road-chunks.js`, `js/obstacles.js`,
  `js/collectibles.js`, `js/geese.js`, `js/race-config.js`, `js/game.js`
  (`_startCountdown`, `_startVersusCountdown`), new `js/daily-seed.js`.
- **Steps:**
  1. **Level field.** In `js/race-config.js` document a new optional level field
     `seed` (integer). When absent, behaviour is exactly today's. Add a helper
     `getLevelSeed(level)` that returns `level.seed ?? null`.
  2. **`js/daily-seed.js` (pure, testable).** Export:
     - `dailyKey(date = new Date())` → `'YYYY-MM-DD'` of `date − 9 h` in **UTC**
       (rollover at 09:00 UTC, decision 6).
     - `seedFromKey(key)` → 32-bit positive integer via a simple string hash (FNV-1a is
       fine; write it inline, no dependency). Must never return 0.
     - `dailySeed(date)` = `seedFromKey(dailyKey(date))`.
     - `deriveSeed(base, salt)` → `(base ^ (salt * 2654435761)) >>> 0 || 1` — used to give
       trees/clouds/obstacles/etc. distinct-but-derived seeds. Document the salt table
       here: road `1`, trees `2`, clouds `3`, balloons `4`, ground `5`, obstacles `6`,
       collectibles `7`, geese `8`.
  3. **`World.reseed(seed)`** in `js/world.js`:
     - `this.roadChunks.dispose()`; `this.roadPath = new RoadPath(deriveSeed(seed, 1))`;
       `this.roadChunks = new RoadChunkManager(this.scene, this.roadPath)`.
     - Reset tree state: set every pool entry `active = false` and remove/hide its mesh
       (mirror what `_updateTreeVisibility` does to hide), `this._treeNextD = 0`,
       `this._treeRngState = deriveSeed(seed, 2)`.
     - Same for clouds (`_cloudNextD = 0`, `_cloudRngState = deriveSeed(seed, 3)`) and
       balloons (`_balloonRngState = deriveSeed(seed, 4)`; rebuild balloons the same way
       the constructor does).
     - Ground bumps: leave as-is for v1 (they are cosmetic and rebuilding the ground is
       expensive). Note this in a comment.
     - `this.clearRaceMarkers()`.
     - Keep a `this.roadSeed` property; `reseed` is a no-op when called with the current
       seed (important: restarts must not rebuild).
     - Add `World.DEFAULT_ROAD_SEED = 42` and make the constructor call
       `this.reseed(options.roadSeed ?? 42)` **only for the road** — i.e. refactor so the
       constructor's current road/tree/cloud/balloon seed setup goes through one
       `_applySeeds(seed)` helper, where the default path must produce **exactly** the
       seeds `42 / 137 / 271 / 53` (special-case: when `seed === 42` use the legacy
       literal seeds so existing levels are pixel-identical). Write this special case
       explicitly; do not try to be clever.
  4. **Item managers.** `ObstacleManager`, `CollectibleManager`, `GeeseManager`
     constructors: compute their rng seed as today **unless** `level.seed` is set, in
     which case use `deriveSeed(level.seed, 6|7|8)`. One-line change each at
     `js/obstacles.js:165`, `js/collectibles.js:163`, `js/geese.js:501`.
  5. **`game.js` wiring.** In `_startCountdown` (before the managers are created, ~`:1670`)
     and `_startVersusCountdown` (~`:1848`):
     `this.world.reseed(level.seed ?? World.DEFAULT_ROAD_SEED); this.bike.roadPath = this.world.roadPath;`
     and for VERSUS also each `rig.bike.roadPath`. Then `this.bike.fullReset()` if the
     seed changed (the bike position depends on the road). Confirm `chaseCamera.update`
     reads `this.world.roadPath` each frame (it does, `:4461`) so no other reference is
     stale. Search for any other cached `roadPath` reference (`grep -n roadPath js/`) and
     re-point it.
  6. **Race markers.** `setRaceMarkers(level, camera)` (`js/world.js:783`) is already
     called per ride; verify it runs *after* `reseed`.
- **Acceptance criteria:**
  - Playing Grandma's and the Castle: tree, obstacle and present positions are unchanged
    from `main` (compare a screenshot at the start line and at 100 m before/after).
  - A temporary level `{ id: 'seedtest', seed: 12345, distance: 500 }` produces a visibly
    different road; loading it twice gives the same road; changing the seed changes it.
  - Restart (checkpoint rewind and from-beginning) does **not** rebuild the world
    (`reseed` no-op) — verify no frame hitch on restart.
  - Online MP: captain and stoker on a seeded level see the same obstacles (verified in
    D-1 when the seed is transmitted; here just ensure nothing reads `Date` inside the
    managers).
  - No new console errors; memory does not grow across 10 reseeds (check
    `renderer.info.memory.geometries` before/after — should return to baseline).
- **Tests:** `test/unit/daily-seed.test.mjs`: `dailyKey` for a fixed `Date` (rollover
  edge: `2026-09-08T08:59:59Z` → `2026-09-07`, `2026-09-08T09:00:00Z` → `2026-09-08`;
  local-time midnight does not change the key); `seedFromKey` stable and non-zero;
  `deriveSeed` distinct across salts. Also a test that `new RoadPath(42)` cached points equal a golden sample
  (first 5 points, 3 decimals) to lock the legacy road.
- **Out of scope:** reseeding the ground mesh; changing `LOOP_LENGTH`; touching versus
  team logic beyond the `roadPath` re-point.

#### D-1 · The shared-road level and lobby card (spec for C-2; ranked status added by D-2)

- **Branch:** `feat/todays-road` (C-2); the ranked-status parts land with D-2.
- **Depends on:** D-0.
- **Goal:** a "Today's Road" card appears in the level list (solo and online co-op),
  shows today's date and the player's status (not ridden / practiced ×n / ranked done per
  mode), and starts a ride on today's seeded 500 m road. (The card was called "Daily
  Ride" in v1; the level id stays `daily`.)
- **Files:** `js/race-config.js`, `js/lobby.js` (`_buildLevelCardsShared`,
  `_updateDifficultyVisibility`, level sync), `js/lobby/room-protocol.js`,
  `js/game.js` (`_startCountdown`), `index.html` (card CSS only), new `js/daily-ride.js`.
- **Steps:**
  1. **Level.** Add to `LEVELS` in `js/race-config.js`, *after* castle:
     ```js
     {
       id: 'daily', name: "Today's Road", distance: 500, collectibles: 'presents',
       checkpointInterval: 125, icon: '📅' /* 📅 */,
       description: 'A new road every day. Same for everyone.',
       isDaily: true, fixedDifficulty: 'adventurous',
       treeCollision: true
     }
     ```
     `seed` is **not** stored on the static level; it is resolved at selection time
     (next step) so the object in `LEVELS` stays constant.
  2. **`js/daily-ride.js`** (DOM-free, testable):
     - `resolveDailyLevel(baseLevel, { key, seed })` → a *copy* of the level with
       `key`, `seed`, and `name: "Today's Road"` set.
     - `dailyStatus(store, key)` → `{ practiced: n, ranked: {timeMs, ...} | null }`.
       `store` is an object with `get(key)`/`set(key, value)` (wrap `localStorage`
       under key `tandemonium_daily` → JSON `{ [dateKey]: { practice: n, ranked: {...} } }`).
       Prune entries older than 60 days on write.
     - `dailyDescription(status, key)` → the card subtitle string, e.g.
       `"Sep 8 · not ridden yet"`, `"Sep 8 · practiced ×2 · ranked run available"`,
       `"Sep 8 · ranked 2:41 🛡️"`.
  3. **Card.** In `_buildLevelCardsShared`, when `level.isDaily`:
     - Not gated by `LEVEL_UNLOCK` (it should be available from the first session; the
       persona doc's player bounces off gates).
     - Subtitle from `dailyDescription(...)`.
     - On click: `this.selectedLevel = resolveDailyLevel(level, { key: dailyKey(), seed: dailySeed() })`,
       call `_updateDifficultyVisibility('daily')` which must **hide** the difficulty
       picker and force `this.selectedDifficulty = level.fixedDifficulty`.
     - Send `RoomProtocol.levelSync('daily', { key, seed })` — extend `levelSync` to accept
       an optional `extra` object merged into the message (`{ type, levelId, key, seed }`).
       On receive (`_handleRoomMessage` ~`js/lobby.js:3510`), if `levelId === 'daily'`,
       resolve the level with the **received** key/seed, not the local clock.
  4. **Countdown flavour text** already reads `level.description`; make it read
     `level.dateLabel` first if present (`"Monday, Sep 8"`).
  5. **CSS:** give `.level-card[data-level-id="daily"]` a subtle distinct border colour
     using existing palette variables in `index.html`. Nothing else.
  6. **Analytics:** `level_select` already fires with `level: 'daily'`. Add
     `analytics.trackEvent('daily_open', { key })` when the card is clicked.
- **Acceptance criteria:**
  - Solo: Today's Road card visible without any achievement; clicking hides the difficulty
    picker; START RIDE works; the road differs from Grandma's.
  - Two browsers on the same UTC day get the same road (compare first two obstacles).
  - Online co-op: stoker sees the same obstacles as captain, including when the stoker's
    clock is on a different day (simulate by faking `dailyKey` on one side).
  - The VERSUS level list does **not** show Today's Road (versus has its own rules; add
    it there later if wanted).
  - Tutorial and existing levels unchanged.
- **Tests:** `test/unit/daily-ride.test.mjs` for `resolveDailyLevel`, `dailyStatus`,
  `dailyDescription`, and pruning. Extend `room-protocol` test (create if missing) for
  the extended `levelSync` shape.
- **Out of scope:** streaks (D-5), share strip (D-3), ranked-run rules (D-2), server.

#### D-2 · Ranked runs: practice vs. one ranked run per mode

- **Branch:** `feat/daily-ranked-run`
- **Depends on:** D-1 (C-2), B-3 (records).
- **Goal:** on Today's Road the player chooses **Practice** (unlimited, normal rules) or
  **Ranked run** — one per day per **mode** (solo / pair), normal rules except DDA off,
  result recorded locally and (D-6) shared with partners.
- **Rules (decision 8), stated once here and referenced everywhere:**
  - A ranked run is the *first full run* started as ranked for that `(dayKey, mode)`.
    Mode is `solo` when riding alone, `pair` when riding online or local co-op.
  - Checkpoint rewind and restarts are **allowed** (they cost time, as they do today).
    "Time" is the ride clock as shown on the victory screen. There is no DNF state: END
    RIDE on a ranked run records `{ dnf: true, distance }` and *does* consume the run
    (so a bad start can't be abandoned for a re-roll); a crash does not.
  - `DDAManager` is not created (everyone rides the same road). Safety mode stays
    available, recorded and flagged 🛡️.
  - One solo ranked run and one pair ranked run per day are independent: riding solo at
    lunch does not use up the evening ride with a partner.
- **Files:** `js/game.js` (`_startCountdown`, `_showGameOver`, `_showVictory`),
  `js/daily-ride.js`, `index.html` (chooser overlay), `js/lobby.js` (START RIDE handler).
- **Steps:**
  1. **Chooser.** When START RIDE is pressed with `selectedLevel.isDaily`, show
     `#daily-mode-overlay`: **PRACTICE** and **RANKED RUN** (disabled with subtitle
     "done for today — 2:41" when `dailyStatus(...).ranked[mode]` exists). Use
     `_setOverlayButtons` for gamepad focus. Store `this._dailyMode`.
     In online co-op the **captain** chooses; send `{ type: 'dailyMode', mode }` via
     `net.sendProfile(...)` before the countdown (the countdown event at
     `js/game.js:1767` is a bare byte, so a separate typed message is required); the
     stoker's HUD shows "RANKED" and the stoker's own store records the pair run too.
  2. **Ranked rules** in `_startCountdown` when `this._dailyMode === 'ranked'`: skip
     `DDAManager` construction (`this.ddaManager = null`) and guard every
     `this.ddaManager.` call site (`grep -n ddaManager js/game.js`). Nothing else changes
     in the ride.
  3. **Finish.** In `_showVictory`, when ranked: `recordRanked(store, key, mode, {
     timeMs, collectibles, crashes, restarts, safety: this.safetyMode, partner })`.
     Practice finish increments `practice`. Both feed B-3's records with a key that
     includes the day (`daily:<key>`), so "NEW BEST" works within the day.
  4. **END RIDE on ranked:** confirm dialog "End your ranked run? It counts as
     unfinished for today." → record `{ dnf: true, distance }`.
  5. **Tutorial gate:** `_shouldRunTutorial` (`js/game.js:5176`) must not treat the daily
     differently from Grandma's.
  6. **Analytics:** `daily_start { key, mode, ranked }`, `daily_finish { key, mode,
     ranked, time_ms, safety, dnf, crashes }`.
- **Acceptance criteria:**
  - Ranked run: crash → B-2's fast recovery as normal; the finish time is stored and the
    card shows it; RANKED RUN is disabled for that mode until the next key.
  - Solo ranked done → RANKED RUN still available when the same account joins a room.
  - Practice identical to today's rules incl. DDA.
  - Both sides of an online ride store the same time (±100 ms) and the same key.
  - Faking the clock past 09:00 UTC re-enables both modes.
- **Tests:** unit tests for `recordRanked`, the per-mode "already ranked" predicate, DNF
  consumption, and the key rollover. Manual for overlays.
- **Out of scope:** server submission (D-6), ghosts (D-4).

#### D-3 · The shareable result: strip + clip

- **Branch:** `feat/daily-share-strip`
- **Depends on:** D-2.
- **Goal:** after a ride on Today's Road, the victory/game-over overlay shows a
  Wordle-style, **spoiler-free** text strip that tells the story of the run, and a SHARE
  button that copies it (desktop) or opens the share sheet (mobile) — and, where a clip
  was recorded, offers the clip first (the persona's channel is video).
- **Files:** `js/daily-ride.js` (`buildShareStrip(result, opts)` — pure), `js/game.js`
  (`_showVictory`, `_showGameOver`), `index.html` (markup + CSS for `#daily-strip`,
  `#daily-share-btn`), `js/game-recorder.js:1480–1503` (reuse the clip share path).
- **Strip format** (exact; test it):
  ```
  Tandemonium · Today's Road · Sep 8
  👥 2:41 · 🥈 · 🎁 9/12 · 💥 1 · 🔗 82% · 🛡️
  ▰▰▰▰▰▰▰▰▱▱▱▱ 500m
  https://tandemonium.jimandi.love/?daily=2026-09-08
  ```
  - Line 2, in order: `👥` for a pair ride (omitted solo); time (or `DNF @ 320m`); medal
    from B-3 (`🥇🥈🥉`, omitted if none); presents `collected/total`; crashes; `🔗 nn%`
    sync (pair rides only, from `offset_quality`); `🛡️` if safety was on; `🏋️` if practice.
    Never include obstacle positions or anything that spoils the road.
  - Line 3: 12 blocks, filled = `round(12 · distance / 500)`.
  - Line 4: deep link. `?daily=YYYY-MM-DD` opens the lobby with Today's Road selected
    (add next to the `?room=` handling at `js/lobby.js:2809`; if the key is not today's,
    toast "That road has expired — here's today's").
  - Streak suffix from D-5 when ≥ 2: ` · 🔥 4` (solo: days; pair: weeks).
  - When both players are signed in, append `with <partner display name>` on line 1.
- **Steps:**
  1. Implement `buildShareStrip` and its unit tests first.
  2. Render the strip in a `<pre>`-styled block inside the overlays when
     `level.isDaily`; hide otherwise.
  3. SHARE button: if a clip exists (`game-recorder` has a blob) and `navigator.canShare`
     with files → share the clip with the strip as `text`; else if `navigator.share` and
     mobile → `navigator.share({ text })`; else clipboard + "COPIED".
  4. Gamepad focus via `_setOverlayButtons`.
  5. Analytics: `daily_share { key, mode, method: 'clip'|'share'|'copy' }`.
- **Acceptance criteria:** strip matches the format for: ranked solo finish, ranked pair
  finish with medal, DNF, practice, safety on; SHARE copies on desktop Chrome; opens the
  sheet on iOS Safari and Android Chrome; pasting the link lands on Today's Road.
- **Tests:** `buildShareStrip` golden-string tests for the five cases.
- **Out of scope:** image generation; social-network-specific text.

#### D-4 · Ghosts: yesterday's you, and your partner's last run

- **Branch:** `feat/ride-ghosts` · **Size:** M
- **Depends on:** B-3 (records), D-1.
- **Goal:** on any level with a best, a translucent ghost bike rides your PB line; on
  Today's Road in a pair it can instead ride your partner's last run — a target and a
  teacher, without live matchmaking (Mario Kart ghosts, §1.2 D).
- **Files:** new `js/ghost.js` (recorder + player; sampling/interpolation pure and
  testable), `js/records.js` (store a track with the best), `js/game.js` (sample per
  frame at 10 Hz, spawn/advance ghost), a low-cost mesh (clone of the bike group with a
  transparent material; no riders), `js/lobby.js` (card toggle "Ghost: best / partner /
  off").
- **Spec:**
  - Track = `Float32Array` of `[t, roadD, lateral, lean]` at 10 Hz, capped to 6 min
    (≈ 14 KB); stored with the best in `records.js` (tracks only for the current best
    per key, so the store stays small).
  - Ghost playback advances by ride clock; rendered 40 % opaque; disabled when
    `prefers-reduced-motion` or when the session's `avg_fps < 40`.
  - Partner ghost: after a pair ride, each side stores the *shared* bike track under the
    partner key (D-5's `partnerKey`); the card offers it when riding solo.
  - HUD: "vs ghost +1.3 s" at checkpoints replaces B-3's split delta when a ghost is on.
- **Acceptance criteria:** a second Grandma's ride shows the ghost from the first; the
  ghost finishes within ±0.2 s of the recorded time; no frame-time regression > 0.5 ms
  on the perf harness (A-0).
- **Tests:** unit tests for sampling/interpolation and the size cap.
- **Out of scope:** server-hosted ghosts; ghosts in VERSUS.

#### D-5 · Streaks: personal (days, with freezes) and pair (weeks)

- **Branch:** `feat/daily-streaks`
- **Depends on:** D-2 (D-3 for the strip suffix).
- **Goal:** the card and the strip show a personal streak ("🔥 4 days") and, for a pair,
  a weekly streak ("🔥 3 weeks together"). Leniency is built in (decision 7; Duolingo's
  streak freeze, §1.2 D).
- **Files:** `js/daily-ride.js`, `js/lobby.js` (card subtitle), `js/game.js`
  (`_showVictory` → write streak).
- **Steps:**
  1. `computeStreak(store, todayKey, { freezes })`: consecutive day keys ending today (or
     yesterday — alive until the end of today) with any finish on Today's Road. A missed
     day consumes a **freeze** if one is available (2 granted per calendar month, unused
     ones don't accumulate beyond 2). Return `{ current, best, freezesLeft }`.
  2. `computePairStreak(store, partnerKey, todayKey)`: consecutive **ISO weeks** ending
     this week (or last week, alive until Sunday 09:00 UTC) with ≥ 1 Today's Road finish
     together. `partnerKey` = partner's server user id if known (`this._partnerServerId`)
     else the peer display name.
  3. Card subtitle: ` · 🔥 4` (solo) when `current ≥ 2`; in a room, ` · 🔥 3 wks with
     <name>` when the pair streak ≥ 2. If a freeze was used since the last visit, a
     one-time toast "Streak saved ❄️ (1 left this month)".
  4. Analytics: `daily_streak { key, current, best, pair, freezes_left }`.
- **Acceptance criteria:** streak increments once per key regardless of run count; one
  missed day with a freeze available keeps `current`; two missed days without freezes
  reset it and keep `best`; the pair streak counts a week with a Tuesday ride and the next
  week with a Saturday ride as 2; the pair streak survives swapped seats.
- **Tests:** unit tests over a synthetic store for each acceptance case.
- **Out of scope:** server-side streaks; buying freezes.

#### D-6 · Partners board (ships last, behind a flag)

- **Branch:** `feat/daily-partners-board`
- **Depends on:** D-2, D-7 (pairs), A-0. Ship only after ≥ 2 weeks of D-2 data show
  real Today's Road players.
- **Goal:** a signed-in player's ranked results are stored server-side and the victory
  overlay shows **only people they've ridden with**: "You 2:41 · Sam 2:38 · Jo 3:05".
  No global board (decision 5).
- **Files:** `worker/migrations/0009_daily.sql`, `worker/leaderboard.js`
  (`POST /daily`, `GET /daily?key=`), `js/auth.js` (`submitDaily`), `js/game.js`
  (`_showVictory`), `js/lobby.js` (Today's Road card: "Partners today" list).
- **Steps:**
  1. Migration: `daily_results(id, user_id, day_key TEXT, mode TEXT, time_ms INTEGER,
     collectibles, safety_used, dnf INTEGER, distance REAL, partner_user_id INTEGER NULL,
     created_at)`, `UNIQUE(user_id, day_key, mode)`; index on `(day_key, user_id)`.
  2. `POST /daily` (authed, rate-limited like `/score`): insert-once per
     `(user, day, mode)` → 409 on repeat. Validate `day_key` is today or yesterday (by the
     09:00 UTC rule) and `time_ms ∈ [30_000, 900_000]`.
  3. `GET /daily?key=` (authed): results for the caller **and their partners** (join on
     the `pairs` table from D-7, falling back to the `/partners` logic); never returns
     strangers.
  4. Client: submit on ranked finish when signed in (mirror `_submitScore`'s guard).
     Render the partners line on the overlay and on the card.
  5. Feature flag `DAILY_BOARD_ENABLED` in `js/config.js`, default `false`.
- **Acceptance criteria:** second ranked submit same `(day, mode)` → 409; the response
  never includes a user the caller has not ridden with; unauthenticated client never
  POSTs.
- **Tests:** unit test for the client guard; manual for the worker.
- **Out of scope:** global ranks; anti-cheat.


#### The pair as a first-class object (D-7 … D-9)

Ship after D-2/D-3 have data. Two signed-in accounts = a pair (decision 14); D-9 covers
the guest case. All three are server-side plus small lobby UI.

#### D-7 · `pairs` table and `/pair` endpoints

- **Branch:** `feat/pair-records-server`
- **Goal:** the server stores, per unordered pair of accounts: rides together, distance
  together, best time per level, last ride date, current/best daily streak.
- **Files:** `worker/migrations/0010_pairs.sql`, `worker/leaderboard.js`
  (`submitScoreWithLimit` → update pair row; new `GET /pair?with=<userId>`; extend
  `GET /partners` to include the pair aggregates), `worker/schema.sql` (append the table
  for fresh installs).
- **Steps:**
  1. Table `pairs(user_lo INTEGER, user_hi INTEGER, rides INTEGER DEFAULT 0,
     distance REAL DEFAULT 0, last_ride TEXT, best_json TEXT /* {level: time_ms} */,
     daily_streak INTEGER DEFAULT 0, daily_best_streak INTEGER DEFAULT 0,
     daily_last_key TEXT, PRIMARY KEY(user_lo, user_hi))` with `user_lo < user_hi`.
  2. In the score submit path, when `contributions.captain.userId` and
     `contributions.stoker.userId` are both non-null, upsert the pair row: `rides+1`,
     `distance+=`, `best_json[level] = min(...)`, `last_ride = now`. If `levelId ===
     'daily'` and the submission is ranked (D-6 adds this flag; before D-6, use the
     `POST /daily` path instead), update the streak fields with the same consecutive-day
     rule as D-5.
  3. `GET /pair?with=` returns the row plus both display names/avatars.
  4. `GET /partners` gains `distance_together`, `best_times`, `daily_streak`.
- **Acceptance criteria:** two signed-in accounts finishing Grandma's together produce
  one `pairs` row regardless of who was captain; a solo ride never touches `pairs`.
- **Tests:** manual with two accounts on the PR preview; SQL check.
- **Out of scope:** guest pairs (D-9), UI (D-8).

#### D-8 · "Us" — the pair panel in the lobby room and on the victory screen

- **Branch:** `feat/pair-panel-ui`
- **Depends on:** D-7.
- **Goal:** when two signed-in players are in a room together, both see an "Us" panel:
  "You & Sam · 14 rides · 3.2 km together · best Grandma's 2:41 · 🔥 4-day daily streak".
  After a finish, the victory overlay says whether this was a **pair best**.
- **Files:** `js/lobby.js` (`showRoom` `:4813`, `_updatePartnerPip` `:3350`, leaderboard
  "Together" tab `:2252` → rename label to **"Us"** and put the pair rows first, global
  rows below), `js/game.js` (`_showVictory`: compare to `best_json[level]`), `js/auth.js`
  (`fetchPair(withId)`), `index.html` (panel markup/CSS).
- **Steps:**
  1. On room connect, once both profiles are exchanged (`_handleRoomMessage`) and both
     have `serverId`, call `auth.fetchPair(partnerId)` and render the panel under the
     partner's PiP. If either is a guest, render "Sign in to keep a record with Sam" with
     the existing sign-in button.
  2. Victory: if `timeMs < best_json[level]` (or none) show "⭐ NEW PAIR BEST" under the
     stats grid. Use the value fetched at room time; do not re-fetch mid-overlay.
  3. Leaderboard "Us" tab: list partners (from `/partners`) with the new aggregates; each
     row expandable to per-level bests. Global "Together" rows go below a divider
     labelled "Everyone" (that global list already exists; it is not a new board — decision 5
     applies to Today's Road results, which never appear here). Add a **Local Legend**
     line: "Most rides together this month: You & Sam (6)" from `pairs.rides` filtered by
     `last_ride` month (Strava, §1.2 D).
  4. Analytics: `pair_panel_view`, `pair_best` events.
- **Acceptance criteria:** the panel appears within 2 s of both profiles arriving; a
  guest stoker sees the sign-in nudge; "NEW PAIR BEST" appears exactly when the time
  beats the stored best.
- **Out of scope:** friends list / invites; notifications.

#### D-9 · Guest pair continuity

- **Branch:** `feat/guest-pair-id`
- **Depends on:** A-9, D-7.
- **Goal:** a stoker who never signs in still accumulates a pair record with a
  signed-in captain, keyed by the guest's `device_id`, and the record merges into their
  account when they later sign in.
- **Files:** `js/lobby.js` (send `device_id` in the room profile), `js/game.js`
  (`_submitScore`: include `guestDeviceId` for the unsigned side), `worker/leaderboard.js`
  (`pairs.user_hi` may reference a `guest:<device_id>` pseudo-id; on `/auth/*` success,
  migrate rows from `guest:<device_id>` to the real user id), `worker/migrations/0011_guest_pairs.sql`
  (change `pairs` key columns to TEXT if they were INTEGER — simpler: create them as
  TEXT in D-7 from the start; **do that**, and this item becomes client + auth-merge only).
- **Acceptance criteria:** captain signed in + guest stoker → a pair row exists; the
  guest signs in on the same device → the row now names them; a different device does
  not inherit it.
- **Out of scope:** merging across devices without sign-in.

### Phase E — Co-op depth and Tourist Mode (2027-02 →; after the Next Fest demo)

Two threads. **E-1…E-3** give the pair something to *talk about* — the co-op comparables
(§1.2 D: Overcooked, Keep Talking, Portal 2) all rely on asymmetric information,
disruptions, and a shared call — Tandemonium has none of those; both players see the
same screen and press the same rhythm. **E-4…E-9** is Tourist Mode "Ride the distance
between you", the post-launch headline (decision 10). Order within the phase is E-1,
E-3, E-2, then Tourist; re-plan after the Next Fest numbers (§2 metrics).

#### E-1 · Stoker look-ahead (asymmetric information)

- **Branch:** `feat/stoker-lookahead` · **Size:** M
- **Depends on:** A-4, B-4.
- **Goal:** the stoker gets information the captain doesn't: a small "road ahead" panel
  on the stoker's HUD showing hazards 40 m further than the captain can see (fog/
  camera-limited for the captain). The stoker's job becomes *calling the road* —
  "pothole left!" — which is the Keep-Talking dynamic in bike form.
- **Files:** `js/hud.js` (new `#lookahead` strip drawn from `obstacles.js` positions in
  `[d+camRange, d+camRange+40]`), `js/game.js` (per-seat HUD flag; in online co-op each
  client already knows its seat; local co-op / VERSUS: stoker panel on the stoker's
  half), `js/config.js` (`LOOKAHEAD_M = 40`, per-difficulty on/off; off in Chill).
- **Spec:** panel is a 1-D lane map: three lanes × 40 m, icons for obstacle / present /
  goose; updates at 10 Hz; captain never sees it (verify in online co-op that it's gated
  by seat, not by peer role). Optional (flagged): captain's fog distance reduced by 15 m
  on Adventurous+ so the asymmetry matters.
- **Acceptance criteria:** in a 2-account online ride, only the stoker's HUD shows the
  strip; hazards appear in it ≥ 2.5 s before they enter the captain's view at 12 m/s;
  pair playtest (≥ 3 pairs) reports at least one "called" hazard per ride.
- **Tests:** unit test for the lane-map projection from a fixed obstacle list.
- **Out of scope:** voice; new obstacle types.

#### E-2 · Ride disruptions (seeded events)

- **Branch:** `feat/ride-disruptions` · **Size:** M
- **Depends on:** B-4 (seeded), A-2 (beat window), A-3 (feel).
- **Goal:** two or three seeded, telegraphed events per ride that break the rhythm and
  force the pair to re-sync: a crosswind gust (lean pushed for 2 s), a goose crossing that
  demands a coast (no pedal for 1.5 s or you clip it), a cobbled patch where the beat
  window tightens to 150 ms. Overcooked's "the kitchen splits" — disruptions are what
  make co-op talk.
- **Files:** new `js/disruptions.js` (schedule from the road seed via `deriveSeed(seed,
  9)`; pure, testable), `js/game.js` (apply: lean impulse via `bike-model`, coast rule via
  `pedal-scoring` state, window override), `js/hud.js` (3-s telegraph banner "💨 GUST
  →"), `js/audio-engine.js` (one cue per type), `js/haptics.js` (`hapticGust`).
- **Spec:** 0 events in Chill; 2 in Normal; 3 in Adventurous+; never within 5 s of a
  checkpoint or the first 20 s; identical for both peers (seeded; no network message
  needed beyond the seed from B-4).
- **Acceptance criteria:** same seed → same schedule on both clients; each event is
  telegraphed ≥ 3 s ahead; a coast during the goose event costs no crank-fight; A-5's
  crash rates after a gust stay under the §2 target on Adventurous.
- **Tests:** schedule determinism and spacing rules.
- **Out of scope:** random (unseeded) events; new fauna models (surface freeze, rule 3).

#### E-3 · Sync ping: the sprint call and emotes

- **Branch:** `feat/sync-ping` · **Size:** S
- **Depends on:** A-4.
- **Goal:** a one-button call either rider can make that both hear/see: hold → "3-2-1
  SPRINT!" (both HUDs count down; taps in the following 5 s score double sync bar
  progress), plus four emotes (👍 🫠 🐢 🔥) on the d-pad — Portal 2's ping tool,
  cheap to build, and it gives the pair a vocabulary without voice chat.
- **Files:** `js/game.js` (input mapping; network message `{type:'ping', kind}` via the
  existing `sendProfile`-style channel — add a `ping` case to `_handleGameMessage`),
  `js/hud.js` (countdown + emote bubbles above the partner indicator `:303–330`),
  `js/audio-engine.js` (countdown ticks reuse `tone`), `js/local-coop-input.js` for
  local seats.
- **Acceptance criteria:** ping arrives on the peer within 200 ms on the PeerJS path;
  countdown shows on both; emote bubble lasts 2 s and never stacks more than 2;
  keyboard, gamepad, and touch (long-press the sync bar) all reach it.
- **Tests:** unit test for the sprint-window scoring multiplier in `pedal-scoring`.
- **Out of scope:** voice; text chat.

#### Tourist Mode: "Ride the distance between you" (E-4 … E-9)

Post-launch headline (decision 10). Everything below assumes the tiles branch and the
key-injection work; do not start before Phase D is live on the web build.

#### E-4 · Bring `feat/333-tourist-mode-3d-tiles` up to `main`

- **Branch:** the existing `feat/333-tourist-mode-3d-tiles` (merge `main` into it).
- **Goal:** PR #360 merges cleanly and Tourist Mode runs on the current `main` (with
  riders model, controller overlay, geese, VERSUS present).
- **Steps:**
  1. `git merge main` on the branch; resolve conflicts in `js/game.js`, `index.html`,
     `.github/workflows/*.yml`, `package.json`.
  2. Run `?mode=tourist` locally with a key in `js/tourist-key.local.js`
     (see `docs/tourist-mode.md`); confirm the bike rides, the riders model shows, the
     controller overlay (`C`) works, and geese/obstacles/collectibles are **disabled** in
     tourist (they assume the procedural `roadPath`; guard their construction in
     `_startCountdown` with `if (!this._tourist)`).
  3. Write a short "what broke and what was fixed" list into the PR description.
  4. Issue #366 (fail fast on Maps auth failure) — fix it here if it's < 30 lines;
     otherwise leave it linked.
- **Acceptance criteria:** PR #360 is green on the preview deploy and marked
  ready; `main` stays identical for non-tourist play.
- **Out of scope:** any of the goal-directed features below.

#### E-5 · Key injection on `main` + Options entry (make it reachable)

- **Branch:** `feat/tourist-entry`
- **Depends on:** E-4 merged.
- **Goal:** `https://tandemonium.jimandi.love/?mode=tourist` works (deploy workflow on
  `main` injects the key), and there is an "Explore (beta)" entry in the lobby Options
  panel that opens Tourist Mode at the default origin.
- **Files:** `.github/workflows/deploy.yml` (the key step from the branch),
  `js/game.js` `_initOptionsOverlay` `:3454`, `index.html`.
- **Steps:** the workflow change is already authored on the branch; confirm the
  `GOOGLE_MAPS_API_KEY` secret is set on the repo; add the Options button; add a
  **billing bound** now: a hard cap on tiles distance from origin in `js/tourist-world.js`
  (e.g. 3 km radius; beyond it the bike is turned around with a HUD message). Confirm a
  budget alert exists in Google Cloud before flipping the button on (owner action; note
  it in the PR).
- **Acceptance criteria:** front-door URL works; Options button works; riding away from
  origin is bounded.
- **Out of scope:** address entry; destination.

#### E-6 · Geocoding two addresses → route → level

- **Branch:** `feat/tourist-route`
- **Depends on:** E-5.
- **Goal:** the player enters two addresses (theirs and their partner's); the game
  geocodes both, computes a great-circle path, and defines a **ride** from A to B of
  the real distance (capped) rendered over the tiles.
- **Files:** new `js/tourist-route.js` (pure: `greatCirclePoints(a, b, stepM)`,
  `capRoute(points, maxM)`), `js/tourist-config.js` (geocode via the Maps JS
  `Geocoder`, same key), `js/tourist-world.js` (follow a polyline instead of free-roam:
  lateral clamp to the polyline like the procedural road does with `roadPath`), lobby
  step markup for the two inputs (`index.html`, `js/lobby.js` — a new `#lobby-tourist`
  step, reuse the existing step machinery `_showStep`).
- **Design:**
  - The route is the straight great-circle line, not road-routed. Real roads don't
    matter — the bike flies over photogrammetry. Straight lines also keep tile usage
    predictable (billing).
  - **Distance cap:** full real distance up to **5 km**; beyond that, the level is the
    **first 2.5 km and last 2.5 km** with a "✂️ 1,204 km skipped" jump in the middle
    (fade to black, reposition). Show the real distance on the HUD regardless
    ("Ride the distance between you: 1,209 km").
  - Elevation: reuse the branch's `resolveTouristOrigin()` per waypoint at 500 m spacing.
- **Acceptance criteria:** two Columbus addresses → a ~10 km ride becomes the 2.5+2.5 km
  form; two addresses 2 km apart → a 2 km ride; invalid address → inline error, no
  console exception; geocoding uses the referrer-restricted key only.
- **Tests:** unit tests for `greatCirclePoints` (known distances, e.g. Columbus→Denver
  ≈ 1,745 km ±1 %) and `capRoute`.
- **Out of scope:** road-following routes; saved addresses (E-8).

#### E-7 · Destination, distance-to-go, finish, shareable result

- **Branch:** `feat/tourist-finish`
- **Depends on:** E-6.
- **Goal:** the ride has a visible destination marker at B, a HUD "to go" readout, a
  finish condition, a victory overlay with a share strip ("🏠→🏠 We rode the 1,209 km
  between us in 4:12"), and the pair record (P2) counts the ride.
- **Files:** `js/tourist-world.js` (marker: reuse `_createFinishStripe`/cloud arch
  from `js/world.js:938–1010` or a simple pylon), `js/hud.js` (a "to go" line; keep
  the existing progress bar semantics by mapping ride distance to it), `js/game.js`
  (`RaceManager` with a synthetic level `{ id: 'tourist', distance: rideMeters,
  checkpointInterval: rideMeters / 4 }`), `js/daily-ride.js` `buildShareStrip` (add a
  `tourist` variant), analytics `tourist_start`, `tourist_finish`, `tourist_share`.
- **Acceptance criteria:** arriving at B triggers the finish cinematic and overlay;
  strip format tested; the ride writes a `scores` row with `level_id = 'tourist'` and
  updates `pairs` when both are signed in.
- **Out of scope:** leaderboards for tourist rides (distances differ per pair).

#### E-8 · Remember the pair's route

- **Branch:** `feat/tourist-saved-route`
- **Depends on:** E-7, D-7.
- **Goal:** the pair's two addresses (as lat/lon only — never store the raw address
  string server-side) are saved on the `pairs` row so "Ride the distance between you"
  is one click the second time.
- **Files:** migration `0012_pair_route.sql` (`route_json TEXT`), `/pair` PUT,
  `js/lobby.js` tourist step pre-fill.
- **Acceptance criteria:** second session shows "Ride Columbus → Denver again (1,209 km)"
  with one button; either partner can clear it.

#### E-9 · Today's Road on tiles (optional, decision 1 revisited)

Only if the Phase D numbers are good and E-7 is stable: a daily fixed real-world location
(rotating list of 30 scenic origins in `js/tourist-config.js`), 2 km straight line,
same practice/ranked rules and strip as Phase D. Bounded billing by construction. Write
requirements when reached; do not start before E-4…E-7 are merged.

### Phase F — Re-aim the reward tissue (after Phase D is live)

#### F-1 · Achievements for the new loops

Add exactly these to `js/achievements.js` (and `scripts/sync-steam-achievements.js`):
`daily_first` (finish a ranked daily), `daily_streak_7`, `daily_streak_30`,
`pair_10_rides`, `pair_100km`, `distance_between_us` (finish a Tourist A→B ride
together). No others. Also **retire** the seven per-bike-colour Grandma's achievements
from the *visible* list (keep the ids so earned ones still show) — they reward the
anti-persona. `perfect_sync` stays as-is: A-2 makes it reachable by an actual pair; only
its description text changes ("Ride 10 seconds with your partner in perfect rhythm").

---


## 6. Timeline against the launch calendar

Fixed dates (owner, 2026-09-08): **demo cut by 2026-11-30**; **Steam Next Fest
February 2027** (the October 2026 registration was missed); GDEX **Oct 15–18** as a
guerrilla playtest (no booth); one Code & Coffee playtest in November (date TBD). Phase
windows below are the plan; the demo cut is the only hard wall.

| Window | Phase | Items | Gate at the end of the window |
|---|---|---|---|
| Sep 8 – Sep 21 | A | A-0, A-1, A-2, A-3, A-9 | `npm test` green in CI; baseline doc exists (or the wrangler login blocker is recorded); the verb has sound/haptics/crank on a branch with a before/after recording. |
| Sep 22 – Oct 12 | A | A-4, A-5, A-6, A-7, A-8 | A-2…A-6 merged; first-60-s issues #350/#162/#216 closed; #263 bounce audit written; store page copy handed to owner. |
| Oct 15 – Oct 18 | B | B-1 (GDEX) | `docs/playtests/2026-10-gdex.md`: ≥ 8 pairs observed, first-crash and first-perfect timestamps, the three worst confusions. |
| Oct 19 – Nov 9 | B | B-2, B-3, B-4, B-5, then B-6 protocol | Crash beat ≤ 2.5 s; PB/medals on every level; seeds plumbed (D-0 spec); demo CTAs behind `?demo=1`; the non-gamer protocol ready for the November playtest. |
| Nov 10 – Nov 30 | C | C-1, C-2, C-3, C-4 · **demo cut Nov 30** | Dashboard shows D1/D7 + drop-off; Today's Road (practice) on the card; `demo-2026-11` tag; checklist all green; **Code & Coffee playtest run against the release candidate before the tag**. |
| Dec 1 – Jan 31 | D | D-2, D-3, D-4, D-5, then D-7/D-8/D-9, D-6 last | Ranked runs + strip + ghosts + streaks live on the **web** build (not the demo); two weeks of `daily_*` data before D-6 flips on. |
| Feb 2027 | — | Next Fest: demo is the Nov-30 cut + bug fixes only | Track the §2 pre-launch metrics from the fest week (wishlists/plays, median demo playtime, invite clicks). |
| Feb 2027 → | E | E-1, E-3, E-2, then E-4…E-9 | Re-plan after the fest numbers; Tourist becomes the next release headline; refresh the store page (#262). |
| After D is live | F | F-1 | — |

Rules the schedule leans on:

- **Nothing in Phase D touches the demo build.** The demo is frozen at the `demo-2026-11`
  tag; only fixes cherry-pick onto it. Phase D ships on the web build, where Today's Road
  ranked runs and streaks are launch-retention features, not fest features (§1.2 E).
- **If Phase A slips, cut from the end of B, not from A.** The verb (A-2…A-5) and the
  first five minutes (A-6, A-7) are what the fest will judge; B-3/B-4/B-5 can each be
  dropped from the demo without breaking the others (B-4 is then done in December as D-0).
- **Two playtests are gates, not events.** GDEX (B-1) feeds B-2/B-3 priorities; the
  November Code & Coffee session (B-6 protocol) is the go/no-go on the first-60-s fixes
  before the tag. If it fails on the non-gamer protocol, the tag waits, up to Nov 30.
- If only one thing ships before Nov 30, it is **A-2 → A-6** (an honest, felt verb and a
  gentle first ride). Everything else is sequenced to never block it.

## 7. Testing strategy

- **Unit (Node, `npm test`, A-0)**: every pure module named in §5 — `pedal-scoring.js`
  (A-2), `records.js` (B-3), `daily-seed.js` (D-0), `daily-ride.js` (status, strip,
  streaks), `ghost.js` sampling (D-4), `disruptions.js` (E-2), `tourist-route.js` (E-6),
  the extended room-protocol shape, and a golden test on `RoadPath(42)`. Rule 4: every
  item that adds a pure module adds its tests in the same PR; CI runs them on every PR.
- **Feel items (A-3, A-5, B-2, E-3) — rule 9**: a 20-s before/after screen recording
  attached to the PR plus the numbers the item names (crash rate per preset, time to
  first perfect, recovery time). No feel PR merges on description alone.
- **Determinism (manual, every PR that touches seeds)**: two browsers on the same day
  key see the same first three obstacle positions; captain + stoker see the same items;
  the 08:59:59Z / 09:00:00Z rollover test passes.
- **Regression (manual, every PR touching `world.js`, `game.js`, `bike-model.js`,
  `shared-pedal-controller.js`)**: Tutorial, Grandma's, Castle, local co-op, online
  co-op, VERSUS all start, finish, crash, and restart with no console errors; the
  start-line screenshot matches `main`; **Chill with Safety on cannot crash** (rule 10).
- **Input matrix for anything in the HUD or overlays**: keyboard, one gamepad, touch,
  and the motion-input tutorial path — non-motion inputs get the A-6 coach card.
- **Preview deploy**: every PR gets `pr-preview/pr-<n>/`; use it for two-device tests.
- **Analytics**: after merge, confirm each new event name appears in `events` (A-9 list,
  `daily_*`, `pair_*`); C-1's dashboard routes are the acceptance check for A-9.
- **Playtests as tests**: B-1 and B-6 have written protocols with fixed observation
  fields; their docs are deliverables, not notes.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Fixing the offset rule (A-2) changes how the game feels for the ~50 carry-players who learned the old scoring | Beat-window keeps the alternate-foot rule; only the partner-phase check changes. Announce in the release note; `perfect_sync` becomes reachable, not harder. |
| A-5 makes Adventurous/Daredevil crash too often for the persona | Chill/Normal defaults are untouched for crash-ability; A-5 requires before/after crash-rate numbers and the Chill wobble band, and decision 3 keeps Safety default ON for tutorial/Chill. |
| Time-to-first-perfect doesn't move after A-3/A-4/A-6 | A-1 baseline + GDEX (B-1) give two independent measurements; if no movement, B-2/B-3 are deprioritised in favour of a second first-ride pass. |
| `World.reseed` breaks the legacy road subtly (trees shift) | Golden `RoadPath(42)` test + explicit legacy-seed special case + start-line screenshot diff (B-4/D-0). |
| 09:00 UTC rollover mid-session | Captain-authoritative key via `levelSync`; ranked lock keyed on the run's `key`, not the clock at finish (D-2). |
| One-ranked-run rule feels punitive to the non-gamer partner | Practice unlimited; the *pair* run is separate from the solo run; a crash doesn't consume it; Safety allowed and flagged 🛡️ (decision 8). |
| Empty partners board | D-6 last and flag-gated; it only ever shows people you've ridden with, so "empty" reads as "ride with someone", not as a dead game. |
| Ghost tracks bloat `localStorage` | One track per record key, 10 Hz, 6-min cap (≈ 14 KB); drop tracks first if the store exceeds 2 MB. |
| Tourist billing | Radius cap (E-5), straight-line routes and 5 km cap (E-6), no daily-on-tiles until E-9. Owner sets a Cloud budget alert before E-5 flips on. |
| Wrangler not logged in → A-1 has no numbers | A-1 records "not measurable" per query rather than guessing; owner runs `npx wrangler login` in `worker/`; C-1 makes the questions permanently answerable. |
| Scope creep from the geese/controller tracks (~70 % of recent commits) | §0 rule 2 (surface freeze); reviewers reject unrelated changes in these PRs. |
| Demo cut collides with Phase C | C-2 and C-3 can be dropped from the demo; C-1 and C-4 cannot. Nov 30 is the wall. |
| Next Fest co-op demos "get plays, not wishlists" (§1.2 D) | B-5's WISHLIST + SEND A LINK on every end screen; solo Today's Road practice is playable alone; the store page (A-8) sells the pair fantasy to the person watching. |

## 9. Definition of done for the plan

**Demo (2026-11-30):**

- Pedalling alone or with a partner sounds, shakes, and looks like a pedal stroke; a
  real pair can reach a 100 % perfect run; crank fights are named on screen.
- Adventurous and Daredevil can be crashed; Chill and the tutorial cannot; the
  instructions match the rules.
- A first-time non-motion player reaches their first perfect tap in under 30 s and
  their first checkpoint without a time-out, on the November non-gamer protocol.
- A non-final crash is back on the road in ≤ 2.5 s.
- Every level shows a PB, splits, and a medal; the end screens carry WISHLIST and
  SEND A LINK; `docs/demo-2026-11-checklist.md` is all green at tag `demo-2026-11`.
- Retention (D1/D7), drop-off, and pair numbers are visible on the dashboard.

**Web build before Next Fest (2027-01-31):**

- A player can open the game any day, ride Today's Road, take one ranked run per mode,
  get a spoiler-free strip (or clip), and see a streak that forgives a missed day.
- A ghost of yesterday's you (or your partner's last run) rides beside you.
- Two signed-in people see their shared history, a pair best, and who they've ridden
  with today.

**After the fest:**

- The stoker has something the captain doesn't; the road throws something at the pair;
  the pair can call a sprint.
- Tourist Mode is reachable from the front door with a goal, a finish, and a result.
- The persona doc, README roadmap note, and Steam page (via #262) all describe the same
  game.

## 10. Sources

Comparables and figures cited in §1.2 D–E (from the comparables research on 2026-09-08):

- Wordle: Slate on the design and the spoiler-free share grid —
  https://slate.com/culture/2022/01/wordle-game-creator-wardle-twitter-scores-strategy-stats.html
- Spelunky Daily Challenge: Game Developer, "The understated genius of the Spelunky
  daily challenge" —
  https://www.gamedeveloper.com/design/the-understated-genius-of-the-i-spelunky-i-daily-challenge
- Trackmania Track of the Day (unlimited replays) and Cup of the Day (one ranked cup):
  https://doc.trackmania.com/play/what-is-totd/ ·
  https://doc.trackmania.com/play/how-to-play-cotd/
- Duolingo streak freeze (−21 % churn): Sensor Tower —
  https://sensortower.com/blog/duolingo-streak-feature-app-engagement-growth
- Wordle near-miss / retention study: PMC —
  https://pmc.ncbi.nlm.nih.gov/articles/PMC11487082/
- PEAK daily map seed analysis —
  https://www.peakwiki.online/blog/daily-seed-analysis-peak-maps/
- Overcooked: Game Developer, "Building truly cooperative play in Overcooked" —
  https://www.gamedeveloper.com/design/game-design-deep-dive-building-truly-cooperative-play-in-i-overcooked-i-
- Keep Talking and Nobody Explodes (asymmetric information): Game Developer, Road to
  the IGF —
  https://www.gamedeveloper.com/design/road-to-the-igf-steel-crate-games-i-keep-talking-and-nobody-explodes-i-
- It Takes Two: AV Club interview with Josef Fares —
  https://www.avclub.com/josef-fares-it-takes-two-interview
- Portal 2 co-op ping tool: PC Gamer interview with Valve —
  https://www.pcgamer.com/interview-valve-on-their-insane-portal-2-ideas/
- Chained Together launch (fail-together co-op): Game World Observer —
  https://gameworldobserver.com/2024/06/25/chained-together-85k-concurrent-players-launch-steam
- Human Fall Flat (sub-2-s re-entry): TheGamer interview with Tomas Sakalauskas —
  https://www.thegamer.com/human-fall-flat-interview-tomas-sakalauskas/
- Getting Over It, "the aesthetics of frustration": Game Developer —
  https://www.gamedeveloper.com/design/designer-interview-the-aesthetics-of-frustration-in-i-getting-over-it-i-
- Gang Beasts physics comedy: bit-tech interview —
  https://bit-tech.net/reviews/gaming/pc/interview-gang-beasts/2/
- Mario Kart ghosts: https://www.mariowiki.com/Ghost_(Mario_Kart_series)
- Strava Local Legends and segment leaderboards:
  https://medium.com/strava-engineering/building-local-legends-290879265c83 ·
  https://trophy.so/blog/how-strava-uses-segmented-leaderboards-to-drive-engagement
- Steam Next Fest February 2026 retrospective (68–88 % of wishlists from non-players;
  co-op demos "get plays, not wishlists"): How To Market A Game —
  https://howtomarketagame.com/2026/04/13/making-sense-of-the-february-2026-steam-next-fest/
- Median demo playtime benchmark (≈ 14 min): How To Market A Game —
  https://howtomarketagame.com/2022/10/26/what-is-a-good-median-play-time-for-a-demo-benchmark/
- Jackbox party-pack design (onboarding a room of non-gamers): Built In Chicago —
  https://www.builtinchicago.org/articles/jackbox-games-design-party-pack
- Online party-game share flows (Gartic Phone vs skribbl.io):
  https://onlineparty.games/compare/gartic-phone-vs-skribbl-io

The implementer does not need any source to build anything — the design decisions are
stated in §3; the sources are there so the owner can check the reasoning.

---

*v1 of this plan (2026-09-08, commit `661932b`) is in git history; v2 supersedes it in
full. Item ids map v1→v2 as: P0-1→A-9, P0-2→C-1, P0-3→C-3, P0-4→A-0, P1-1→D-0/B-4,
P1-2→D-1/C-2, P1-3→D-2, P1-4→D-3, P1-5→D-5, P1-6→D-6, P2-1..3→D-7..D-9, P3-1..6→E-4..E-9,
P4-1→F-1.*
