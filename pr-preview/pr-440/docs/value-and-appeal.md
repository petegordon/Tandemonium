# Value & Appeal — where Tandemonium's long-run appeal has to come from

**Status:** assessment, not a decision record. Written 2026-09-09 against `main` at
`8c7d00c`. Captures a working session on the question *"why does the game never feel
like enough, and what should I do about it?"* Nothing here has been implemented.

---

## 1. The question

The felt problem, in the owner's words: Grandma's House plays in 1.5 to under 5
minutes; there are achievements, bike colors, bike rewards, and gems to the King's
castle; and it still never feels like it strikes appeal or long-running play. Tourist
Mode and the Google Map exist and have never been promoted.

## 2. Diagnosis

**The meta-game is being asked to carry the value that the core loop should carry, and
meta cannot do that.**

Achievements, cosmetic unlocks and collectibles are *reward tissue*. They are
excellent at telling a player that a loop they already want to repeat is being
recognised. They are very poor at creating the desire to repeat in the first place.
Right now Tandemonium has a large, well-built reward layer sitting on a loop that
runs out of questions to ask after one clean finish of each level.

Concretely: once a player has finished Grandma's and the Castle once, the game has
asked everything it knows how to ask. The remaining hooks (collect them all, finish it
on the yellow bike) are completionist hooks, and the project's own persona doc lists
lone-wolf completionists in the **anti-persona**. The reward layer is aimed at a player
the game says it is not for.

## 3. What the repo says

### 3.1 The content budget is small, and meta is large relative to it

| Level | Distance (m) | Source |
|---|---|---|
| Tutorial | 225 | `js/race-config.js` |
| Grandma's | 250 | `js/race-config.js` |
| The Castle | 500 | `js/race-config.js` |

That is the whole authored world. Against it sit 19 achievements
(`js/achievements.js`) and 7 named bikes. The ratio is upside-down: the reward layer is
richer than the thing being rewarded.

### 3.2 The persona doc and the code now disagree about who the game is for

`docs/ideal-customer-persona.md` is a genuinely sharp document, and its central claim
is that the product is *a ritual with a specific person you cannot be in a room with*.
It is explicit about the framing to avoid:

> Avoid: "couch co-op" / "2nd controller" / "grab a friend on the couch" framing — the
> game does not support local multiplayer.

Since that was written, local co-op and 2-4 player VERSUS mode have both shipped. The
doc is now out of date with the code. **This is not an argument against local play.**
It is an argument that the positioning document and the product should be reconciled
deliberately rather than drifting apart, because the store page, ad creative and
feature priorities are all supposed to be derived from that doc.

### 3.3 The persona's core promise has no representation in the code

The doc says the product is a ritual between two specific people. The code knows
nothing about pairs:

- Achievements are per-account (`js/achievements.js`).
- The "Together" leaderboard is a global ranking, not a relationship.
- There is no notion of *"you and Sam have ridden 14 times; your best is 2:41."*

The thing the positioning says is the product is the one thing the software does not
model.

### 3.4 Recent effort has gone to breadth, not to the loop

The last stretch of commits is dominated by roadside geese and goose-honk audio
(15 commits), the in-game 3D controller overlay, Steam Input / Steam Controller work,
and VERSUS mode. All of that is real work and some of it is very polished. None of it
gives a returning player a new reason to start a ride.

### 3.5 Tourist Mode is built, deployed, and unmerged

This was initially missed and is important enough to state plainly. Tourist Mode is
**PR #360** on `feat/333-tourist-mode-3d-tiles`, open since 2026-07-07, last pushed
2026-07-26, +1097/-14 across 11 files. It is **not** merged to `main`; `main` contains
no reference to it and `docs/tourist-mode.md` does not exist there.

It is, however, **live and playable right now** on the real domain, because the PR
preview deploy injects the Maps key from the `GOOGLE_MAPS_API_KEY` secret and every
`main` deploy carries existing previews forward:

```
https://tandemonium.jimandi.love/pr-preview/pr-360/?mode=tourist
```

That is almost certainly why it feels shipped. It works, on the real domain, with a
real key. It simply is not reachable from the front door, and
`tandemonium.jimandi.love/?mode=tourist` has never worked because the key-injection
workflow steps live only on the branch.

Two further things reinforce the false memory: the newest merge on `main` reads
*"Merge: in-game controller overlay (live 3D tiles of each rider's pad)"*, so scanning
the log for "3D tiles" produces a recent hit that has nothing to do with Tourist Mode;
and the PR body's own "Branch hygiene" section describes merging `main` in and
resolving conflicts, which reads like the final step before a merge.

The branch is now ~6 weeks behind a `main` that has gained the controller overlay,
geese and VERSUS mode. First step on it is a `main` merge and a report of what breaks.

## 4. Why it never feels like enough

A game with a 1.5-to-5-minute session has two proven retention shapes:

| Shape | Mechanism | Exemplar |
|---|---|---|
| **Mastery** | Same track, shave seconds, medals, ghost of your best run | Trackmania |
| **Cadence** | One shared challenge per period, expires, shareable result | Wordle, PEAK |

Tandemonium currently implements neither. It implements *completion*, which answers
its questions once and then goes quiet. This is the whole explanation for the feeling.

## 5. Recommendation, in priority order

### 5.1 The Daily Ride (highest value per unit of work)

One route per day, identical for every player, derived from a date seed. A medal, a
finish time, and a Wordle-style shareable result strip (presents collected, crashes,
time). Pair and personal streaks.

This directly serves the existing session length, it is exactly the *"same time
tomorrow?"* moment the persona doc's own day-in-the-life scenario ends on, and it costs
**zero authored content per day**.

**It is nearly free in this codebase.** World generation is already fully deterministic
from fixed seeds, because online multiplayer requires both clients to build the same
world:

| What | Where | Current seed |
|---|---|---|
| Road shape | `js/world.js:70` | `new RoadPath(42)` — a literal |
| Obstacles | `js/obstacles.js:165` | derived from `level.id.charCodeAt(0)` |
| Collectibles | `js/collectibles.js:163` | same pattern, different offset |
| Trees / clouds / balloons | `js/world.js` | separate fixed seeds |
| Geese | `js/geese.js:129` | seeded PRNG, commented as "identical placement across clients" |

So a daily route is *threading one date-derived integer through constructors that
already take a seed*. The hard part — determinism across two machines — is already
solved and already shipping.

**But the daily needs its own ruleset, because this game is built to be forgiving.**
Checkpoints, Safety Mode and the dynamic difficulty adjustment in `js/dda-manager.js`
all exist to remove failure. A daily with no stakes has no binary outcome and therefore
nothing to share. Proposed shape: **one ranked attempt, unlimited practice, no
checkpoint rewind, DDA off.**

### 5.2 Make the pair a first-class object

Pair record per level, pair streak, cumulative distance ridden together. The "Together"
leaderboard should be *us against our own past* before it is *us against the world*.
With a small player base, a global daily board reads as empty; a pair streak does not.

### 5.3 Merge Tourist Mode, and give it a goal

Free-roam over photogrammetry is a tech demo. A destination is a feature. The framing
that makes it *this game's* feature rather than a generic map toy:

> **Ride the distance between you.** Enter your address and your partner's. The route
> between your two real houses becomes the level.

For a long-distance couple, or a grandparent and a grandchild in different states, the
distance that separates them becomes the thing they ride together. That is an emotional
hook no competitor has, it is built almost entirely from code already on the branch,
and it is the trailer.

What the branch needs on top of what it has: a destination marker, a distance-to-go
readout, a finish condition, and a shareable result. Roughly a few hundred lines on top
of the ~1,100 already written.

**Practical bonus:** PR #360 warns that tile streaming is *metered and billed by area
explored*. A daily fixed location, or a fixed A-to-B route, bounds the explorable area
by construction. Goal-directed Tourist Mode is both the better design and the cheaper
one.

### 5.4 Measure before building any of it

`js/analytics.js` and `dashboard/` already exist, and the persona doc already names the
targets (stoker-to-captain conversion, D1 return, repeat-pair sessions, cross-device
session share). Pull D1/D7 return, repeat-pair rate, and *where sessions actually end*.
If the numbers are too thin to read, watch five pairs play and note the minute they
stop. "It never feels like enough" is a feeling; retention is a number, and the number
should choose between 5.1 and 5.3 going first.

### 5.5 Stop adding surface

No more bike colors, badges, controller drivers or ambient fauna until the loop has a
reason to return. All of those are good *later*, as reward tissue for a loop that works.

## 6. PEAK as precedent, and where it stops transferring

PEAK (Aggro Crab / Landfall, 2025) is the closest working proof of §5.1: a co-op game
whose headline structure is a **new mountain every day, shared by every player, gone
tomorrow.**

**The important correction it supplies:** PEAK's daily is not really a leaderboard. It
is a *shared reference point*. Everyone is on the same mountain today, so every clip
and every conversation is about the same thing. Ranking is incidental. This matters
here because a daily leaderboard with a handful of players reads as dead, whereas
freshness plus a shared reference does not. Build the daily for freshness and sharing
first, ranking last.

Where the analogy stops:

- PEAK arrived with an existing audience and drop-in matchmaking. Tandemonium has
  neither, and is pair-based by design.
- PEAK runs are long enough that a day's attempt feels like an event; Tandemonium runs
  are minutes. Hence the need for attempt scarcity in §5.1.
- PEAK gets its stakes free from permadeath. Tandemonium has to *choose* stakes,
  against the grain of its own accessibility features.

## 7. What not to do

- Do not ship Tourist Mode as a free-roam toggle. The blank page is the problem.
- Do not lead with a global daily leaderboard. Not enough players to populate it.
- Do not add more achievements to fix engagement. That is the current failure mode.
- Do not resolve the persona/local-play contradiction by quietly ignoring the doc.
  Either update the doc to include local and VERSUS play, or decide that they are
  secondary and say so in the doc.

## 8. Open questions for the owner

1. Does the daily go on procedural road (cheap, ships sooner) or on Tourist Mode tiles
   (far more differentiated, needs the merge and a billing bound first)?
2. Is Tourist Mode the headline feature of the next release, or a side mode? The answer
   changes the store page, not just the backlog.
3. What is the actual D1/D7 return today? Everything above is a hypothesis until this
   is read.
4. Should `docs/ideal-customer-persona.md` be revised to admit local co-op and VERSUS,
   or should those be explicitly demoted to secondary modes?
