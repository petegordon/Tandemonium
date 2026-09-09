# Value & Appeal — Implementation Plan and Requirements

**Status:** plan, ready to implement. Written 2026-09-08 against `main` at `dc2ddad`.
**Source:** [`docs/value-and-appeal.md`](value-and-appeal.md) (the assessment). Read it
first; this document turns its recommendations into ordered, self-contained work items.
**Branch for this plan:** `feat/value-appeal-plan`. Each work item below is meant to be
delivered as its own branch + PR off `main`, named as given in the item.

---

## 0. How to use this document

This plan is written to be executed one work item at a time by an engineer (human or
model) who has **not** read the whole codebase. Every work item states:

- **Goal** — the one sentence that must be true when the item is done.
- **Files** — the files you will touch, with line numbers valid at `dc2ddad`. Line numbers
  drift; the surrounding code comments and function names are the durable anchors.
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
   runner script; item **P0-4** adds one. Put pure logic (seeds, formatting, scoring
   rules) in small ES modules under `js/` that import nothing from `three` or the DOM so
   they are testable.
5. **Analytics** for every new user-facing feature: add `analytics.trackEvent(...)` calls
   using the existing helpers in `js/analytics.js`. Event names are listed per item.
   Do not invent extra ones.
6. **Online multiplayer must stay deterministic.** Both clients build the world from
   seeds. Anything that changes a seed must be sent from captain to stoker over the
   existing room protocol (`js/lobby/room-protocol.js`) *before* the countdown.
7. **Do not touch** `shared/` (vendored from the controller lab via
   `scripts/sync-controller-core.js`), `electron/`, `steam/`, or `.github/workflows/`
   unless the item explicitly lists them.
8. When an item says "server", it means the Cloudflare Worker in `worker/leaderboard.js`
   with D1 schema in `worker/schema.sql` + `worker/migrations/`. New tables/columns go in
   a new migration file `worker/migrations/0008_*.sql` (next free number), never by
   editing old migrations.

---

## 1. Context: what the assessment found

Read `docs/value-and-appeal.md` for the full argument. The short version:

- **Diagnosis:** the meta-game (19 achievements, 7 bikes, collectibles) is being asked to
  carry value the core loop should carry. After one clean finish of Grandma's (250 m)
  and the Castle (500 m) the game has nothing new to ask. It implements *completion*,
  not *mastery* (Trackmania) or *cadence* (Wordle / PEAK).
- **The persona's core promise is not modelled.** `docs/ideal-customer-persona.md` says
  the product is "a ritual with a specific person you cannot be in a room with", but the
  code has no notion of a pair — achievements are per-account, "Together" is a global
  board. (There is one seed: `GET /partners` in `worker/leaderboard.js:616` lists who you
  have ridden with, derived from `score_contributions`.)
- **Persona doc vs code disagree** about local play: local co-op and 2–4 player VERSUS
  shipped after the doc said to avoid "couch co-op" framing.
- **Tourist Mode is built, deployed, and unmerged** (PR #360, branch
  `feat/333-tourist-mode-3d-tiles`, +1097/−14, last pushed 2026-07-26, ~6 weeks behind
  `main`). It is playable at
  `https://tandemonium.jimandi.love/pr-preview/pr-360/?mode=tourist` but unreachable from
  the front door.
- **World generation is already fully seeded** (required by online MP), so a date-seeded
  Daily Ride is "threading one integer through constructors that already take a seed".
- **Nobody knows the retention numbers.** `js/analytics.js` uses a per-tab
  `sessionStorage` id only; anonymous returning players cannot be recognised, so D1/D7
  return cannot currently be computed at all.

## 2. Goals, non-goals, success metrics

### Goals (in priority order)

1. Give a returning player a **new reason to start a ride every day** with zero authored
   content per day (Daily Ride).
2. Make **the pair** — two specific people — a first-class object the game remembers and
   celebrates (pair record, pair streak, distance together).
3. Turn Tourist Mode from a tech demo into **this game's feature**: "Ride the distance
   between you" — the route between two real addresses becomes the level.
4. **Measure** retention and pair-repeat rate so the next round of decisions is made
   on numbers.
5. Reconcile the persona document with the shipped product.

### Non-goals (for this plan)

- Real-money monetization, Chaos Coin economy, new cosmetics. (Deferred per the launch
  plan until after October.)
- New authored levels. The whole point is retention without authored content.
- A global daily leaderboard as the *lead* feature. Ranking ships last (P1-6), behind
  freshness and sharing.
- Controller / Steam Input / overlay work. Separate track.
- Rewriting the lobby. Add cards and tabs; do not restructure `js/lobby.js`.

### Success metrics (from the persona doc §13, plus two new ones)

| Metric | How measured after this plan | Target |
|---|---|---|
| D1 return (any player) | `sessions.device_id` (P0-1) → dashboard `retention` route (P0-2) | ≥ 45 % |
| D7 return | same | ≥ 20 % |
| Repeat-pair sessions (same two accounts ≥ 2×) | `pairs` table (P2-1) | ≥ 40 % of MP pairs |
| Daily Ride share rate (share strip copied/shared ÷ daily finishes) | `daily_share` event ÷ `daily_finish` (P1-4) | ≥ 0.3 |
| Daily Ride return (played daily on ≥ 2 consecutive days) | `daily_streak` ≥ 2 (P1-5) | ≥ 25 % of daily players |
| Where sessions end | `rides.abandon_reason` + `ride_events` already exist; add dashboard `dropoff` route (P0-2) | informational |

## 3. Decisions taken (answers to the assessment's §8 open questions)

These are the assumptions this plan is built on. If the owner overrides one, the affected
items are named so they can be re-scoped.

| # | Question | Decision | Why | Affects |
|---|---|---|---|---|
| 1 | Daily on procedural road or Tourist tiles? | **Procedural road first.** Tourist-tile daily is a later item (P3-6). | Ships in weeks not months; no Maps billing exposure; determinism already proven on procedural road. | P1-*, P3-6 |
| 2 | Is Tourist Mode the headline of the next release or a side mode? | **Headline of the post-Next-Fest release** ("Ride the distance between you"). Not in the Next Fest demo build. | Needs the `main` merge, key-injection workflow on `main`, and a billing bound before it can be public. Demo freeze is too close. | P3-*, store page copy |
| 3 | What is D1/D7 today? | **Unknown and unmeasurable** (no persistent anonymous id). P0-1/P0-2 fix this *first*; read the numbers after two weeks of data. | The assessment says the number should choose between Daily and Tourist. Until it exists, we ship the cheaper one (Daily). | P0-* |
| 4 | Revise persona doc to admit local/VERSUS, or demote them? | **Revise: remote pair stays the ICP; local co-op and VERSUS are named secondary modes** ("same couch, same bike" and "party mode"). | Store copy and clips already show VERSUS; pretending otherwise misleads. But the retention thesis (ritual with a specific person) is unchanged. | P0-3 |
| 5 | Daily ruleset | **One ranked attempt per day, unlimited practice runs, no checkpoint rewind on the ranked attempt, DDA off, Safety allowed but flagged.** | A daily with no stakes has no shareable outcome (assessment §5.1). Safety stays allowed so a non-gamer partner can still finish; the share strip shows a 🛡️ so the outcome is honest. | P1-2, P1-3 |
| 6 | Which difficulty does the daily use? | **Adventurous, fixed.** No difficulty picker on the daily card. | Everyone must ride the same thing for the shared-reference effect (PEAK, §6). | P1-1 |
| 7 | Daily length | **500 m, 4 checkpoints** for practice; ranked attempt ignores checkpoints for rewind but keeps them for the HUD. Loop length is 1200 m (`js/road-path.js` `LOOP_LENGTH`), so 500 m fits. | ~2–4 min on Adventurous; matches the existing session shape. | P1-1 |
| 8 | Daily reset time | **00:00 UTC.** Seed derived from the UTC calendar date. Captain sends the seed to the stoker so a midnight rollover mid-lobby can't desync. | Simplest globally consistent rule; avoids timezone logic. | P1-1, P1-2 |
| 9 | Who counts as a "pair"? | **Two signed-in accounts** (Google or Steam) that finished an online ride together. Guest stokers are counted by a per-device guest id (P2-3) but shown as "Guest" until they sign in. | `score_contributions.player_user_id` already exists for signed-in players; guests currently vanish. | P2-* |

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

## 5. Work items

Item IDs: `P<phase>-<n>`. Phases are ordered by value per unit of work and by the
launch calendar (§6). Within a phase, items are ordered by dependency.

### Phase 0 — Measure, reconcile, freeze (week of 2026-09-08)

#### P0-1 · Persistent anonymous device id for retention

- **Branch:** `feat/analytics-device-id`
- **Goal:** every analytics session carries a stable per-browser `device_id` so
  returning anonymous players can be counted.
- **Files:** `js/analytics.js` (`initSession`, ~`:26`), `worker/migrations/0008_device_id.sql`
  (new), `worker/leaderboard.js` (`handleAnalyticsSession`, and the sessions INSERT it
  performs).
- **Steps:**
  1. In `js/analytics.js` add `getDeviceId()`: read `localStorage['tandemonium_device_id']`;
     if missing, generate `crypto.randomUUID()` and store it. Wrap in `try/catch`
     (private mode) and fall back to the session id.
  2. Include `device_id: getDeviceId()` in the `beacon(...)` payload of `initSession`.
  3. Migration `0008_device_id.sql`: `ALTER TABLE sessions ADD COLUMN device_id TEXT;`
     plus `CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id);`.
  4. In the worker's session insert, read `device_id` from the body and store it
     (nullable). Do not reject sessions without it (old clients).
  5. Also send `device_id` on the `/api/analytics/session/:id` PUT so a session created by
     an old client can be back-filled — optional, skip if the PUT handler doesn't merge
     fields.
- **Acceptance criteria:**
  - Reload the page twice in the same browser → two `sessions` rows share one `device_id`.
  - Incognito window → different `device_id`; no console errors when `localStorage`
    throws.
  - Existing dashboard routes still return 200.
- **Tests:** unit test for `getDeviceId()` with a fake `localStorage` (stable across calls;
  falls back when storage throws). Manual: check D1 rows via `wrangler d1 execute`.
- **Out of scope:** using `device_id` for anything user-facing; merging device ids across
  sign-in (that is `google_uid`, already there).

#### P0-2 · Dashboard: retention and drop-off routes

- **Branch:** `feat/dashboard-retention`
- **Depends on:** P0-1 (needs ≥ 1 day of `device_id` data to show anything).
- **Goal:** the dashboard answers "what is D1/D7 return?", "how many pairs come back?",
  and "at what minute / where do sessions end?".
- **Files:** `worker/leaderboard.js` (`handleDashboard` handlers map `:1037`; add
  `dashRetention`, `dashDropoff`, `dashPairs`), `dashboard/index.html` (three new panels).
- **Steps:**
  1. `retention`: for each cohort day in the window, count distinct `device_id` whose first
     session was that day, and the fraction with any session on day +1 and day +7.
     Return `{ cohorts: [{ day, n, d1, d7 }], overall: { d1, d7 } }`. Apply the existing
     developer-exclusion helper (see comment block at `:1066`).
  2. `dropoff`: from `rides`, group by `level`, `completed`, `abandon_reason`; also a
     histogram of `duration_ms` bucketed to 30 s for abandoned rides; and the share of
     abandoned rides by `checkpoints_passed`. Return counts.
  3. `pairs` (pre-P2, from existing data): from `score_contributions`, build unordered
     pairs of `player_user_id` sharing a `score_id`; return the number of distinct pairs
     and the share with ≥ 2 shared scores. This is the interim "repeat-pair" number.
  4. Render three panels in `dashboard/index.html` following the existing panel pattern
     (find the `overview` fetch and copy its structure). Keep it plain tables + the
     existing KPI tiles; no charting library.
- **Acceptance criteria:**
  - `GET /api/analytics/dashboard/retention?days=30` returns cohorts; totals match a hand
    query on the same data.
  - Developer exclusion parameters apply to all three routes.
  - Dashboard loads with the three panels and no console errors.
- **Tests:** none automated (worker is not unit-tested today). Manual SQL cross-check of
  one cohort.
- **Out of scope:** charts, exports, alerts.

#### P0-3 · Reconcile the persona document with the shipped product

- **Branch:** `docs/persona-local-and-versus`
- **Goal:** `docs/ideal-customer-persona.md` describes the game that exists.
- **Files:** `docs/ideal-customer-persona.md`.
- **Steps:**
  1. Keep "Co-op Casey" (remote pair) as the ICP. Add a boxed note under §1 replacing
     the current "Important: … no local split-screen" note: local co-op (two controllers,
     one screen) and VERSUS (2–4 players, split-screen teams) exist and are **secondary
     modes** — they widen who can play at a party or event; they do not change who the
     product is for.
  2. §10 "Messaging": delete the sentence forbidding "couch co-op" framing. Replace with:
     lead with "send a link, ride together"; mention local/VERSUS second, as "…or grab
     the controllers when you're in the same room".
  3. §11 "Anti-persona": remove the "Couch-co-op-only buyers" bullet.
  4. §13 metrics: add the two new metrics from §2 of this plan (daily share rate, daily
     streak ≥ 2).
  5. Add a §15 "Retention thesis" paragraph summarising the assessment's §4 (mastery vs
     cadence) and pointing at this plan.
- **Acceptance criteria:** no statement in the doc contradicts `README.md` or the lobby.
  A reader of the doc knows Daily Ride and pair records are coming and why.
- **Tests:** none.
- **Out of scope:** store page copy (issue #262 owns that; link it).

#### P0-4 · Unit test harness

- **Branch:** `chore/unit-test-harness`
- **Goal:** `npm test` runs `node --test test/unit/` and passes; CI runs it on PRs.
- **Files:** `package.json` (`"test": "node --test test/unit/"`), `test/unit/.gitkeep` or a
  first trivial test (`test/unit/race-config.test.mjs` asserting `getLevelById('nope')`
  returns the tutorial), `.github/workflows/pr-preview.yml` (add a `npm test` step before
  deploy — this is the one workflow edit this plan allows in Phase 0).
- **Acceptance criteria:** `npm test` exits 0 locally; a PR shows the test step.
- **Out of scope:** browser/DOM tests, puppeteer.

#### P0-5 · Feature freeze note

- **Branch:** part of P0-3's PR.
- **Goal:** `CONTRIBUTING`-style note at the top of `docs/value-and-appeal-plan.md` §0 rule 2
  is the freeze; additionally add a one-line "Surface freeze until Daily Ride ships —
  see docs/value-and-appeal-plan.md" to `README.md` under a "Roadmap" heading so PR
  authors see it.

### Phase 1 — The Daily Ride (target: playable in the Next Fest demo build)

Ordering inside Phase 1 matters: seeds → level → rules → result strip → streaks → server.
Everything through P1-5 is **client-only** and works signed-out. P1-6 is the only server
piece and ships last.

#### P1-1 · Seed plumbing: `World.reseed(seed)` and seeded item managers

- **Branch:** `feat/daily-seed-plumbing`
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
     - `dailyKey(date = new Date())` → `'YYYY-MM-DD'` in **UTC**.
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
    P1-2 when the seed is transmitted; here just ensure nothing reads `Date` inside the
    managers).
  - No new console errors; memory does not grow across 10 reseeds (check
    `renderer.info.memory.geometries` before/after — should return to baseline).
- **Tests:** `test/unit/daily-seed.test.mjs`: `dailyKey` for a fixed `Date` (UTC edge:
  `2026-09-08T23:59:59Z` vs `2026-09-09T00:00:00Z` give different keys; local-time
  midnight does not); `seedFromKey` stable and non-zero; `deriveSeed` distinct across
  salts. Also a test that `new RoadPath(42)` cached points equal a golden sample
  (first 5 points, 3 decimals) to lock the legacy road.
- **Out of scope:** reseeding the ground mesh; changing `LOOP_LENGTH`; touching versus
  team logic beyond the `roadPath` re-point.

#### P1-2 · The Daily Ride level and lobby card

- **Branch:** `feat/daily-ride-level`
- **Depends on:** P1-1.
- **Goal:** a "Daily Ride" card appears in the level list (solo and online co-op), shows
  today's date and the player's status (not played / practice / ranked done), and starts
  a ride on today's seeded 500 m road.
- **Files:** `js/race-config.js`, `js/lobby.js` (`_buildLevelCardsShared`,
  `_updateDifficultyVisibility`, level sync), `js/lobby/room-protocol.js`,
  `js/game.js` (`_startCountdown`), `index.html` (card CSS only), new `js/daily-ride.js`.
- **Steps:**
  1. **Level.** Add to `LEVELS` in `js/race-config.js`, *after* castle:
     ```js
     {
       id: 'daily', name: 'Daily Ride', distance: 500, collectibles: 'presents',
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
       `key`, `seed`, and `name: 'Daily Ride'` set.
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
  - Solo: Daily Ride card visible without any achievement; clicking hides the difficulty
    picker; START RIDE works; the road differs from Grandma's.
  - Two browsers on the same UTC day get the same road (compare first two obstacles).
  - Online co-op: stoker sees the same obstacles as captain, including when the stoker's
    clock is on a different day (simulate by faking `dailyKey` on one side).
  - The VERSUS level list does **not** show Daily Ride (versus has its own rules; add
    it there later if wanted).
  - Tutorial and existing levels unchanged.
- **Tests:** `test/unit/daily-ride.test.mjs` for `resolveDailyLevel`, `dailyStatus`,
  `dailyDescription`, and pruning. Extend `room-protocol` test (create if missing) for
  the extended `levelSync` shape.
- **Out of scope:** streaks (P1-5), share strip (P1-4), ranked-run rules (P1-3), server.

#### P1-3 · Daily rules: practice vs. one ranked attempt

- **Branch:** `feat/daily-ranked-attempt`
- **Depends on:** P1-2.
- **Goal:** on the Daily Ride, the player chooses **Practice** (unlimited, normal rules)
  or **Ranked** (once per day: no checkpoint rewind, DDA off, result recorded locally).
- **Files:** `js/game.js` (`_startCountdown`, `_resetGame`, `_showGameOver`,
  `_showVictory`, `_onTimerExpired`), `js/dda-manager.js` (no change expected — just
  don't construct it), `js/daily-ride.js`, `index.html` (small chooser overlay markup +
  CSS), `js/lobby.js` (START RIDE handler for the daily).
- **Steps:**
  1. **Chooser.** When START RIDE is pressed with `selectedLevel.isDaily`, show a two-button
     overlay `#daily-mode-overlay`: **PRACTICE** and **RANKED RUN** (the latter disabled
     with subtitle "done for today — 2:41" if `dailyStatus(...).ranked` exists). Use the
     existing overlay-button gamepad focus helper (`_setOverlayButtons`, `js/game.js:3850`)
     so controllers can pick. Store the choice as `this._dailyMode = 'practice'|'ranked'`.
     In online co-op the **captain** chooses; send the choice in the existing start
     handshake (add a field to the countdown/start event payload the captain already
     sends — `_startCountdown` sends `this.net.sendEvent(EVT_COUNTDOWN)` at `js/game.js:1767` — the payload is a bare
     byte, so instead add a JSON message `{ type: 'dailyMode', mode }` via `net.sendProfile(...)`
     before the countdown starts).
  2. **Ranked rules** in `_startCountdown` when `this._dailyMode === 'ranked'`:
     - Do **not** create `DDAManager` (`this.ddaManager = null`); guard every
       `this.ddaManager.` call site with `if (this.ddaManager)` (there are a handful:
       `_resetGame`, timer expiry, crash handling; `grep -n ddaManager js/game.js`).
     - `this._noRewind = true`.
  3. **Crash / timeout on ranked.** In `_showGameOver` and `_onTimerExpired` (`:1979`),
     when `_noRewind`: the overlay title becomes "RANKED RUN OVER" and the buttons are
     **PRACTICE AGAIN** (restarts as practice, from beginning) and **END RIDE**. The
     ranked record for today is written as a DNF: `{ dnf: true, distance, crashes }`.
     Do not offer RESTART-from-checkpoint.
  4. **Finish on ranked.** In `_showVictory`, when `_noRewind`, write
     `{ timeMs, collectibles, crashes: 0 (by construction), safety: this.safetyMode, dnf: false }`
     to the daily store for today via `daily-ride.js` `recordRanked(store, key, result)`.
     If a practice run finishes, increment `practice`.
  5. **Safety mode** stays available; it is recorded (`safety: true`) and shown as 🛡️ in
     the strip (P1-4). This is deliberate — see §3 decision 5.
  6. **Guard the tutorial gate.** `_shouldRunTutorial` (`js/game.js:5176`) must not force
     the tutorial for the daily any differently than for Grandma's.
  7. **Analytics:** `analytics.trackEvent('daily_start', { key, mode })`,
     `('daily_finish', { key, mode, time_ms, safety, dnf })`. Also pass
     `daily_mode` in `analytics.startRide({...})` extras (it is stored in `rides` only if
     you add a column — skip the column; the event is enough).
- **Acceptance criteria:**
  - Ranked: a crash ends the run with no checkpoint restart; the card then shows
    "ranked DNF" and RANKED RUN is disabled until the next UTC day.
  - Practice: identical to today's normal rules (rewind, DDA, restart).
  - A ranked finish stores time; reopening the lobby shows it on the card.
  - Online: stoker sees the captain's mode choice reflected in HUD text ("RANKED") and
    crash behaviour matches on both sides.
  - Changing the system clock forward one day re-enables RANKED RUN (manual check).
- **Tests:** unit tests for `recordRanked`, the "already ranked today" predicate, and the
  UTC-day rollover. Manual for overlays.
- **Out of scope:** server submission (P1-6), medals, ghosts.

#### P1-4 · The shareable result strip

- **Branch:** `feat/daily-share-strip`
- **Depends on:** P1-3.
- **Goal:** after a Daily Ride (practice or ranked), the victory/game-over overlay
  shows a Wordle-style text strip and a SHARE button that copies it (desktop) or opens
  the share sheet (mobile).
- **Files:** `js/daily-ride.js` (`buildShareStrip(result, opts)` — pure), `js/game.js`
  (`_showVictory`, `_showGameOver`), `index.html` (markup + CSS for `#daily-strip`,
  `#daily-share-btn`).
- **Strip format** (exact; test it):
  ```
  Tandemonium Daily · Sep 8
  🚴 2:41 · 🎁 9/12 · 💥 0 · 🛡️
  ▰▰▰▰▰▰▰▰▱▱▱▱ 500m
  https://tandemonium.jimandi.love/?daily=2026-09-08
  ```
  - Line 2: time (or `DNF @ 320m` on a DNF), presents `collected/total`, crashes, then
    optional `🛡️` if safety was on, and `🏋️ practice` if it was a practice run.
  - Line 3: 12 blocks, filled = `round(12 * distance / 500)`; ranked finish is all filled.
  - Line 4: deep link. `?daily=YYYY-MM-DD` must open the lobby with the Daily card
    pre-selected (add the query handling next to the existing `?room=` handling (`js/lobby.js:2809`) in
    `js/lobby.js`; if the date is not today, show a toast "That daily has expired — here's
    today's" and select today's).
  - Two-player runs prefix line 2 with `👥 ` and, when both are signed in, append
    `with <partner display name>`.
- **Steps:**
  1. Implement `buildShareStrip` and its unit tests first.
  2. Render the strip in a `<pre>`-styled block inside the overlays when
     `level.isDaily`; hide otherwise.
  3. SHARE button: if `navigator.share` exists and `isMobile` → `navigator.share({ text })`;
     else `navigator.clipboard.writeText(text)` and flash the button label to "COPIED".
     Model on `js/game-recorder.js:1480`.
  4. Gamepad focus: include the button in `_setOverlayButtons`.
  5. Analytics: `analytics.trackEvent('daily_share', { key, mode, method: 'share'|'copy' })`.
  6. Deep link handling: `?daily=` selection + toast.
- **Acceptance criteria:**
  - Strip matches the format exactly for: ranked finish, ranked DNF, practice finish,
    safety on/off, two-player.
  - SHARE copies on desktop Chrome; opens the sheet on iOS Safari and Android Chrome.
  - Pasting the link into a new tab lands on the lobby with Daily selected.
- **Tests:** `buildShareStrip` golden-string tests for the five cases above.
- **Out of scope:** image/clip generation; social-network-specific text.

#### P1-5 · Streaks: personal and pair

- **Branch:** `feat/daily-streaks`
- **Depends on:** P1-3 (P1-4 for the strip line).
- **Goal:** the Daily card and the result strip show a personal streak ("🔥 4-day
  streak") and, in online co-op, a pair streak keyed on the partner.
- **Files:** `js/daily-ride.js`, `js/lobby.js` (card subtitle), `js/game.js`
  (`_showVictory` → write streak), `index.html` (none beyond text).
- **Steps:**
  1. `computeStreak(store, todayKey)`: consecutive UTC days ending today (or yesterday,
     if today isn't played yet — the streak is "alive" until the end of today) with a
     ranked **or** practice finish. Return `{ current, best }`. Store `best` under
     `tandemonium_daily.best`.
  2. Pair streak: key `tandemonium_daily_pairs[partnerKey]` where `partnerKey` is the
     partner's server user id if known (`this._partnerServerId` in `game.js`) else the
     partner's peer display name. Same consecutive-day rule, counted only on finishes
     where both were present.
  3. Card subtitle appends ` · 🔥 4` when `current ≥ 2`. Strip line 2 appends ` · 🔥 4`
     likewise; for two-player, use the pair streak.
  4. Analytics: `analytics.trackEvent('daily_streak', { key, current, best, pair: bool })`
     on finish.
- **Acceptance criteria:** streak increments once per UTC day regardless of run count;
  a missed day resets `current` and keeps `best`; the pair streak survives the partner
  being the stoker one day and the captain the next.
- **Tests:** unit tests over a synthetic store for: consecutive days, gap, "alive until
  end of today", best retention.
- **Out of scope:** server-side streaks; streak-saver items.

#### P1-6 · Daily server board (ships last, behind a flag)

- **Branch:** `feat/daily-server-board`
- **Depends on:** P1-3, P0-4. Ship only after ≥ 2 weeks of P1-3 data show real daily
  players (assessment §6: a dead board is worse than no board).
- **Goal:** ranked daily results from signed-in players are stored server-side; the
  victory overlay shows "You: 2:41 · Friends: … · Everyone: #7 of 23"; nothing global
  is shown when fewer than 5 results exist for the day.
- **Files:** `worker/migrations/0009_daily.sql`, `worker/leaderboard.js`
  (`POST /daily`, `GET /daily?key=`), `js/auth.js` (`submitDaily`), `js/game.js`
  (`_showVictory`), `js/lobby.js` (leaderboard: new sub-tab "Daily").
- **Steps:**
  1. Migration: `daily_results(id, user_id, day_key TEXT, time_ms INTEGER, collectibles,
     safety_used, dnf INTEGER, distance REAL, partner_user_id INTEGER NULL, created_at)`,
     `UNIQUE(user_id, day_key)`; index on `(day_key, time_ms)`.
  2. `POST /daily` (authed, rate-limited like `/score`): upsert-once — reject a second
     submission for the same `(user, day)` with 409. Validate `day_key` is today or
     yesterday UTC (clock skew) and `time_ms` within `[30_000, 900_000]`.
  3. `GET /daily?key=YYYY-MM-DD` (public, rate-limited): `{ count, top: [ {display_name,
     time_ms, safety_used, partner_display_name} × 20 ], me: {rank, time_ms} | null }`
     (`me` requires the optional auth header).
  4. Client: submit on ranked finish when signed in (mirror `_submitScore`'s guard: skip
     demo). Render the three lines on the overlay; hide "Everyone" when `count < 5`.
  5. Lobby leaderboard: add "Daily" under the existing tabs (`_buildLeaderboardTabs`
     `js/lobby.js:2248`) showing today's top 20 with the same row renderer.
  6. Feature flag `DAILY_BOARD_ENABLED` in `js/config.js`, default `false` on merge;
     flip in a follow-up commit when data justifies it.
- **Acceptance criteria:** second ranked submit same day → 409 and client shows the
  stored result; unauthenticated client never calls `/daily` POST; board hides under 5
  results.
- **Tests:** unit test for the client-side guard; manual for the worker.
- **Out of scope:** friends filtering beyond the existing `/partners` list; anti-cheat.

### Phase 2 — Make the pair a first-class object (after the Next Fest demo freeze)

#### P2-1 · `pairs` table and `/pair` endpoints

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
     'daily'` and the submission is ranked (P1-6 adds this flag; before P1-6, use the
     `POST /daily` path instead), update the streak fields with the same consecutive-day
     rule as P1-5.
  3. `GET /pair?with=` returns the row plus both display names/avatars.
  4. `GET /partners` gains `distance_together`, `best_times`, `daily_streak`.
- **Acceptance criteria:** two signed-in accounts finishing Grandma's together produce
  one `pairs` row regardless of who was captain; a solo ride never touches `pairs`.
- **Tests:** manual with two accounts on the PR preview; SQL check.
- **Out of scope:** guest pairs (P2-3), UI (P2-2).

#### P2-2 · "Us" — the pair panel in the lobby room and on the victory screen

- **Branch:** `feat/pair-panel-ui`
- **Depends on:** P2-1.
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
     labelled "Everyone".
  4. Analytics: `pair_panel_view`, `pair_best` events.
- **Acceptance criteria:** the panel appears within 2 s of both profiles arriving; a
  guest stoker sees the sign-in nudge; "NEW PAIR BEST" appears exactly when the time
  beats the stored best.
- **Out of scope:** friends list / invites; notifications.

#### P2-3 · Guest pair continuity

- **Branch:** `feat/guest-pair-id`
- **Depends on:** P0-1, P2-1.
- **Goal:** a stoker who never signs in still accumulates a pair record with a
  signed-in captain, keyed by the guest's `device_id`, and the record merges into their
  account when they later sign in.
- **Files:** `js/lobby.js` (send `device_id` in the room profile), `js/game.js`
  (`_submitScore`: include `guestDeviceId` for the unsigned side), `worker/leaderboard.js`
  (`pairs.user_hi` may reference a `guest:<device_id>` pseudo-id; on `/auth/*` success,
  migrate rows from `guest:<device_id>` to the real user id), `worker/migrations/0011_guest_pairs.sql`
  (change `pairs` key columns to TEXT if they were INTEGER — simpler: create them as
  TEXT in P2-1 from the start; **do that**, and this item becomes client + auth-merge only).
- **Acceptance criteria:** captain signed in + guest stoker → a pair row exists; the
  guest signs in on the same device → the row now names them; a different device does
  not inherit it.
- **Out of scope:** merging across devices without sign-in.

### Phase 3 — Tourist Mode: "Ride the distance between you" (post-Next-Fest headline)

#### P3-1 · Bring `feat/333-tourist-mode-3d-tiles` up to `main`

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

#### P3-2 · Key injection on `main` + Options entry (make it reachable)

- **Branch:** `feat/tourist-entry`
- **Depends on:** P3-1 merged.
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

#### P3-3 · Geocoding two addresses → route → level

- **Branch:** `feat/tourist-route`
- **Depends on:** P3-2.
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
- **Out of scope:** road-following routes; saved addresses (P3-5).

#### P3-4 · Destination, distance-to-go, finish, shareable result

- **Branch:** `feat/tourist-finish`
- **Depends on:** P3-3.
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

#### P3-5 · Remember the pair's route

- **Branch:** `feat/tourist-saved-route`
- **Depends on:** P3-4, P2-1.
- **Goal:** the pair's two addresses (as lat/lon only — never store the raw address
  string server-side) are saved on the `pairs` row so "Ride the distance between you"
  is one click the second time.
- **Files:** migration `0012_pair_route.sql` (`route_json TEXT`), `/pair` PUT,
  `js/lobby.js` tourist step pre-fill.
- **Acceptance criteria:** second session shows "Ride Columbus → Denver again (1,209 km)"
  with one button; either partner can clear it.

#### P3-6 · Daily Ride on tiles (optional, decision 1 revisited)

Only if P1 numbers are good and P3-4 is stable: a daily fixed real-world location
(rotating list of 30 scenic origins in `js/tourist-config.js`), 2 km straight line,
same practice/ranked rules and strip as P1. Bounded billing by construction. Write
requirements when reached; do not start before Phase 3 is merged.

### Phase 4 — Re-aim the reward tissue (after Phases 1–2 are live)

#### P4-1 · Achievements for the new loops

Add exactly these to `js/achievements.js` (and `scripts/sync-steam-achievements.js`):
`daily_first` (finish a ranked daily), `daily_streak_7`, `daily_streak_30`,
`pair_10_rides`, `pair_100km`, `distance_between_us` (finish a Tourist A→B ride
together). No others. Also **retire** the seven per-bike-colour Grandma's achievements
from the *visible* list (keep the ids so earned ones still show) — they reward the
anti-persona.

---

## 6. Timeline against the launch calendar

Dates from the launch plan (`docs/launch-plan` branch / memory): Steam Next Fest demo
submission target **2026-09-21**, hard deadline **2026-10-05**; GDEX Oct 15–18; Next
Fest Oct 19–26.

| Window | Items | Note |
|---|---|---|
| Sep 8 – Sep 14 | P0-1, P0-4, P0-3 (+P0-5), P1-1 | P0-1 first so data accrues while the rest is built. |
| Sep 15 – Sep 21 | P1-2, P1-3, P1-4 | Daily Ride playable, shareable. Demo build candidate. |
| Sep 22 – Oct 5 | P1-5, P0-2, bug-fix only | If P1-4 slipped, Oct 5 is the real deadline for the demo build. |
| Oct 6 – Oct 26 | P3-1, P3-2 groundwork (no public entry until after Next Fest), P2-1 | Freeze the demo; server/pair work doesn't touch the demo build. |
| Nov | P2-2, P2-3, P1-6 (if data), P3-3, P3-4 | "Ride the distance between you" becomes the next release headline; refresh the Steam page (#262). |
| Dec | P3-5, P4-1, decide P3-6 | |

If only one thing ships before Oct 5, it is **P1-1 → P1-4** (Daily Ride with the share
strip). Everything else is sequenced to never block it.

## 7. Testing strategy

- **Unit (Node, `npm test`)**: all pure modules named above — `daily-seed.js`,
  `daily-ride.js` (status, streak, strip), `tourist-route.js`, the extended room
  protocol shape, a golden test on `RoadPath(42)`. Target: every P1/P3 PR adds tests.
- **Determinism check (manual, every P1 PR)**: two browsers, same UTC day, same first
  three obstacle positions; captain + stoker on the daily see the same items.
- **Regression (manual, every PR that touches `world.js` / `game.js`)**: Tutorial,
  Grandma's, Castle, local co-op, VERSUS all start, finish, and restart with no console
  errors; screenshot at the start line matches `main`.
- **Preview deploy**: every PR gets `pr-preview/pr-<n>/`; use it for two-device MP tests.
- **Analytics**: after merge, confirm the new event names appear in the `events` table.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `World.reseed` breaks the legacy road subtly (trees shift) | Golden `RoadPath(42)` test + explicit legacy-seed special case + start-line screenshot diff. |
| Midnight-UTC rollover mid-session | Captain-authoritative seed via `levelSync`; ranked lock keyed on the run's `key`, not the clock at finish. |
| Ranked "one attempt" feels punitive to the non-gamer partner | Practice is unlimited and Safety stays on for ranked; the strip is honest (🛡️) rather than blocking. |
| Empty daily board | P1-6 is last and flag-gated; hidden under 5 results. |
| Tourist billing | Radius cap (P3-2), straight-line routes and 5 km cap (P3-3), no daily-on-tiles until P3-6. Owner sets a Cloud budget alert before P3-2 flips on. |
| Scope creep from the geese/controller tracks | §0 rule 2; reviewers reject unrelated changes in these PRs. |
| Demo freeze collides with P1 | P1-1…P1-4 are the only pre-freeze code items; P0-2 and P1-5 can land after. |

## 9. Definition of done for the plan

- Retention (D1/D7), repeat-pair and drop-off numbers are visible on the dashboard.
- A player can open the game any day, ride today's road, get a shareable strip, and see
  a streak.
- Two signed-in people see their shared history and a pair best.
- Tourist Mode is reachable from the front door with a goal, a finish, and a result.
- The persona doc, README roadmap note, and Steam page (via #262) all describe the same
  game.
