# Branching Survey System

Contextual, end-of-ride micro-surveys for Tandemonium. The system asks the
**right two-to-three questions for the experience the player just had**, then
routes answers into the existing telemetry pipeline.

- **Component:** `js/survey.js` (self-contained, no markup or CSS in `index.html`)
- **Telemetry:** routed through `js/analytics.js` via `attachSurveyTelemetry()`
- **Hooks:** `js/game.js` (`_maybeShowSurvey`, called at three lifecycle moments)
- **Test/QA harness:** `test/survey.html`

---

## 1. The six player paths

A ride ends in exactly one of these states. Each maps to a dedicated branch
with its own question tree.

| # | Branch key | Mode | Outcome | Question focus |
|---|------------|------|---------|----------------|
| 1 | `solo_completed`     | solo (`solo`)     | reached finish | controls · difficulty · replay |
| 2 | `solo_abandoned`     | solo (`solo`)     | quit early     | reason · controls · replay |
| 3 | `mp_host_completed`  | host (`captain`)  | reached finish | coordination · fairness · partner |
| 4 | `mp_guest_completed` | guest (`stoker`)  | reached finish | coordination · fairness · partner |
| 5 | `mp_host_abandoned`  | host (`captain`)  | quit early     | reason · coordination · partner |
| 6 | `mp_guest_abandoned` | guest (`stoker`)  | quit early     | reason · fairness · partner |

**Why these dimensions?** Solo play is a player-vs-system experience, so the
friction/delight lives in *controls, difficulty, and whether they'll come
back*. Multiplayer is a player-vs-player-vs-system experience, so the friction
lives in *coordinating with a partner, whether the split of work felt fair, and
how the partner relationship felt*. Captain and stoker share the same three
dimensions but ask from each role's vantage point — the captain steers (and can
feel they're doing all the work), the stoker only pedals (and can feel
powerless), so the fairness and coordination questions are phrased per role.

**Out of scope:** `local` (same-screen co-op) returns no survey — two riders
share one device, so a single-respondent survey would conflate two people.
Tutorials and unknown modes likewise get no survey.

---

## 2. Branching logic

Branch selection is a **pure function** of two inputs — the game mode and
whether the ride completed:

```
resolveBranch(mode, completed):
    if mode == 'solo':     return completed ? SOLO_COMPLETED    : SOLO_ABANDONED
    if mode == 'captain':  return completed ? MP_HOST_COMPLETED : MP_HOST_ABANDONED
    if mode == 'stoker':   return completed ? MP_GUEST_COMPLETED: MP_GUEST_ABANDONED
    return null            # 'local' / tutorial / unknown -> no survey
```

```
                       ride ends
                          │
              ┌───────────┼───────────────┐
           mode=solo   mode=captain     mode=stoker        (mode=local → ∅)
              │            │                │
        ┌─────┴────┐  ┌────┴─────┐    ┌─────┴────┐
     completed  quit completed quit completed  quit
        │         │     │       │       │        │
     SOLO_     SOLO_  MP_HOST_ MP_HOST MP_GUEST MP_GUEST
   COMPLETED ABANDON  COMPLETE ABANDON COMPLETE ABANDON
```

`completed` is `true` only when the player crosses the finish line. Every other
exit — quitting from the pause/lobby button, choosing "END RIDE" on the game-over
screen, partner disconnect, or closing the tab — is an abandon.

---

## 3. Question trees

All questions are single-choice. `value` is the stable token logged to
telemetry; the label is what the player sees. Abandoned branches deliberately
**lead with a "why did you stop" question** to capture the reason while it's
fresh, then narrow into the dimension most implicated by that path.

### 1 · `solo_completed` — "Nice ride! Two quick questions."
1. **controls** — *How did steering and pedaling feel?*
   `clunky` · `awkward` · `good` · `smooth`
2. **difficulty** — *How was the challenge?*
   `too_easy` · `just_right` · `tough_fair` · `too_hard`
3. **replay** — *Up for another ride?*
   `definitely` · `maybe` · `not_now`

### 2 · `solo_abandoned` — "Heading out? Help us improve."
1. **reason** — *What made you stop this ride?*
   `too_hard` · `controls` · `boring` · `just_a_break` · `bug`
2. **controls** — *Were the controls getting in your way?*
   `a_lot` · `a_little` · `no`
3. **replay** — *Would you give it another go?*
   `yes` · `maybe` · `probably_not`

### 3 · `mp_host_completed` — "You made it, captain!"
1. **coordination** — *How in-sync did you feel with your partner?*
   `out_of_sync` · `took_work` · `mostly` · `perfect`
2. **fairness** — *You steered as captain — did the workload feel balanced?*
   `i_did_more` · `slightly_off` · `balanced` · `partner_more`
3. **partner** — *How was riding with your partner?*
   `frustrating` · `okay` · `fun` · `a_blast`

### 4 · `mp_guest_completed` — "You made it, stoker!"
1. **coordination** — *Could you tell what your captain was doing?*
   `no_idea` · `sometimes` · `usually` · `always`
2. **fairness** — *You pedaled as stoker — did your input feel like it mattered?*
   `useless` · `a_little` · `mattered` · `essential`
3. **partner** — *How was riding with your captain?*
   `frustrating` · `okay` · `fun` · `a_blast`

### 5 · `mp_host_abandoned` — "Ride cut short? Help us improve."
1. **reason** — *What ended the ride?*
   `coordination` · `partner_left` · `too_hard` · `lost_interest` · `technical`
2. **coordination** — *Was staying in sync the hard part?*
   `mainly_that` · `partly` · `no`
3. **partner** — *Would you ride with this partner again?*
   `yes` · `maybe` · `no`

### 6 · `mp_guest_abandoned` — "Ride cut short? Help us improve."
1. **reason** — *What ended the ride?*
   `coordination` · `captain_left` · `too_hard` · `lost_interest` · `technical`
2. **fairness** — *Did it feel like your pedaling mattered?*
   `not_at_all` · `a_little` · `yes`
3. **partner** — *Would you ride with this captain again?*
   `yes` · `maybe` · `no`

The trees live as data in `SURVEY_BRANCHES` (`js/survey.js`) — editing copy or
options is a data change, not a code change.

---

## 4. How a survey is shown (pseudocode)

```
on ride end (game.js):
    context = {
        mode, completed,                 # drives branch resolution
        rideId, sessionId,               # telemetry correlation
        level, difficulty, role,         # segmentation
        abandonReason, distance,         # segmentation
    }
    survey.maybeTrigger(context)

SurveyManager.maybeTrigger(context):
    if not enabled:               return        # global kill switch
    if a survey is already open:  return        # never stack
    branch = resolveBranch(context)
    if branch is null:            return        # local / tutorial / unknown
    if not isEligible(branch):    return        # sampling + throttling
    open(branch, context)

isEligible(branch):
    now = clock()
    if now - lastShownAt        < globalCooldown:     return false   # ≤1 survey / 6h
    if now - lastShownFor[branch] < perBranchCooldown: return false   # don't re-ask same path / 7d
    if random() > sampleRate:                          return false   # sample a fraction
    return true

open(branch, context):
    markShown(branch)                       # persist timestamps (localStorage)
    emit('shown', …)                        # → analytics
    render question[0]

on option click / number key:
    record answer {questionId, dimension, value}
    emit('answer', …)                       # → analytics
    if more questions: render next
    else:              emit('complete', …); show thanks; auto-close

on skip / Esc:
    emit('dismiss', {answeredCount})        # → analytics; partial answers kept
    teardown
```

### Eligibility / anti-nag

The manager throttles itself so players aren't surveyed every ride:

| Control | Default | Purpose |
|---------|---------|---------|
| `sampleRate`          | `1.0` (lower in prod) | fraction of eligible ride-ends that surface a survey |
| `cooldownMs`          | 6 h  | minimum gap between *any* two surveys |
| `perBranchCooldownMs` | 7 d  | don't re-ask the *same branch* |
| `pendingMaxAgeMs`     | 24 h | max age of a deferred abandon before it's dropped |
| `enabled`             | `true` | global kill switch |

State persists in `localStorage` under `tandemonium_survey_state`.

---

## 5. Integration hooks (game.js)

The game calls one helper, `_maybeShowSurvey(completed, abandonReason, rideId)`,
at three points. The ride id is captured **before** `analytics.endRide()` (which
clears it), and the survey fires **before** navigating away so `this.mode` still
reflects the ride.

| Lifecycle moment | Call site | completed | When shown | Branches reachable |
|------------------|-----------|-----------|------------|--------------------|
| Finish line crossed | `_showVictory()` | `true`  | same session, +2.8 s | the three `*_completed` branches |
| Quit via lobby/pause button | `lobby-btn` handler | `false` | same session, immediate | `solo_abandoned`, `mp_*_abandoned` |
| "END RIDE" on game-over | `btn-gameover-lobby` handler | `false` | same session, immediate | `solo_abandoned`, `mp_*_abandoned` |
| **Closed tab/app mid-ride** | `beforeunload` + `pagehide` | `false` | **next session** | `solo_abandoned`, `mp_*_abandoned` |

The completed survey is delayed so the player enjoys their result first, and is
suppressed for unlicensed stokers (who get the purchase CTA instead). The survey
overlay renders at `z-index 120`, above the victory/game-over overlays (`z-index 60`).

### Deferred abandons (close-while-riding) — `beforeunload`

When a player closes the tab or quits the app **mid-ride**, the page is being
torn down, so there is no opportunity to render a survey and collect an answer.
Instead the system splits the work across two sessions:

1. **At unload** (`beforeunload` + `pagehide` in `_registerAbandonUnloadHooks`):
   if a ride is still active (`analytics.getCurrentRideId()` is truthy), call
   `survey.recordPendingAbandon(context)`. This does only a **synchronous
   `localStorage` write** and never touches the event object.
2. **On next startup**: `survey.maybeShowPending()` resurfaces the survey (once
   the menu is up), tagged `deferred: true` in telemetry. It is one-shot, only
   fires if the ride ended within `pendingMaxAgeMs` (24 h), and still respects
   normal cooldown/sampling.

The active-ride guard means this fires **only** for genuine close-while-riding
abandons — quitting via a button ends the ride (clearing the id) and shows a
*live* survey, so no pending record is written.

### Will `beforeunload` work in web and Electron/Steam?

Yes, with the deferred design above — the differences are about *which unload
signal fires*, not about whether the approach works, because the survey is shown
next session from persisted state (and `localStorage` persists in all three).

| Environment | `beforeunload` | `pagehide` | Notes |
|-------------|----------------|------------|-------|
| **Desktop web** | reliable | reliable | Either fires on tab/window close. |
| **Mobile web** | unreliable (esp. iOS Safari) | reliable | `pagehide` is the dependable mobile signal; it covers backgrounding into bfcache. |
| **Electron / Steam** | fires on window close / Cmd-Q | fires | Chromium renderer, so both exist. **We never call `preventDefault()` or set `returnValue`** — in Electron, returning a value from `beforeunload` *cancels the quit*, which would trap players in the app. Our handler only writes to storage, so quit proceeds normally. `localStorage` lives in the app's `userData`, so the pending record survives to the next launch. |

**Best-effort, by design.** Hard kills (force-quit, crash, OS terminate, Steam
"Stop") may fire nothing — those rides simply get the existing
`endRide({abandon_reason:'page_close'})` telemetry with no follow-up survey. We
intentionally do **not** use `visibilitychange→hidden` to *record* abandons
(only to flush telemetry, as analytics already does), because it also fires on
ordinary tab-switching and would produce false abandons.

---

## 6. Telemetry schema

`attachSurveyTelemetry(analytics)` maps the manager's abstract events onto
`analytics.trackEvent`. `survey_complete` and `survey_dismiss` are in the
immediate-flush list in `analytics.js`.

| Event | Key fields |
|-------|-----------|
| `survey_shown`    | `branch`, `ride_id`, `level`, `difficulty`, `total_questions` |
| `survey_answer`   | `branch`, `ride_id`, `question_id`, `dimension`, `value`, `question_index` |
| `survey_complete` | `branch`, `ride_id`, `answers[]`, `duration_ms` |
| `survey_dismiss`  | `branch`, `ride_id`, `answered_count`, `total_questions`, `answers[]` |

Answers are emitted per-question as they're chosen, so partial (dismissed)
surveys still yield usable data. `dimension` lets you aggregate across branches
(e.g. all `controls` answers) while `branch` keeps each path separable.

---

## 7. Extending

- **Edit copy / options:** change `SURVEY_BRANCHES` data — no logic changes.
- **Add a path:** add a branch key + tree, then a `resolveBranch` case.
- **A/B test questions:** wrap `SURVEY_BRANCHES[branch].questions` selection, or
  vary `sampleRate` per branch.
- **New trigger moment** (e.g. after N crashes): build a context and call
  `survey.maybeTrigger(...)` — the component handles the rest.
- **Gamepad nav:** the modal supports number-key selection and Esc today; wiring
  it into the existing `_setOverlayButtons` gamepad loop is a natural next step
  for TV/controller play.
