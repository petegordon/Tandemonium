# Track Artifacts — Design & Implementation Plan

> Status: Draft
> Branch: `claude/game-progression-world-design-1IoCh`
> Related issues: see "New Track Artifacts" and "Track Builder + UGC" in this repo.

## 1. Motivation

Current races (Grandma's, Castle) are 250–500 m straight rides with only three
content primitives: **checkpoints**, **collectibles**, **obstacles** (pylons).
This produces short, low-variety play sessions. Players see all the mechanics
in ~90 seconds.

This document defines **six new track artifacts** that:

1. Add new verbs to gameplay (jump, accelerate, slow, time, squeeze, sync).
2. Slot into the existing road / pool / chromakey architecture used by
   `obstacles.js` and `collectibles.js`.
3. Expose a parameter surface that can be authored by hand *and* by a future
   user-generated content (UGC) track builder.
4. Work in single-player and tandem multiplayer (one bike, two riders) as
   well as networked multiplayer (multiple bikes).

The artifacts are: **ramps, boost pads, mud patches, drawbridges, choke
points, sync gates.**

## 2. Architectural Fit

### 2.1 Today

```
race-config.js   →   LEVELS[]: { id, distance, collectibles, checkpointInterval, ... }
road-path.js     →   parametric road; getPointAtDistance(d) → {x,y,z,heading}
road-chunks.js   →   streaming road mesh chunks around the player
collectibles.js  →   per-level pool, deterministic seeded placement
obstacles.js     →   per-level pool, deterministic seeded placement, hit radius 0.75m
race-manager.js  →   checkpoints, segment timer, finish
world.js         →   scene root, scenery, race markers (checkpoint/destination billboards)
```

Each content manager exposes the same lifecycle: `constructor(scene, roadPath, level, ...)`,
`update(dt, distanceTraveled, bikePos)`, optional `checkCollision(bikePos)`, and a
shared pool + visibility window pattern (200 m ahead, 40 m behind).

### 2.2 Proposal

Introduce a **single artifact subsystem** that hosts all six new artifact
managers behind a common interface, plus a per-level **track manifest** that
lists artifact instances with their position and per-instance params.

```
js/artifacts/
    artifact-base.js        // shared pool helpers, visibility, collision math
    ramp.js
    boost-pad.js
    mud-patch.js
    drawbridge.js
    choke-point.js
    sync-gate.js
    artifact-manager.js     // owns all six per level, dispatches update/collision
    track-manifest.js       // load + validate manifests (hand-authored or UGC)
```

`game.js` constructs **one** `ArtifactManager` per race instead of N
managers. The manager loads the track manifest for the active level and
spawns the appropriate sub-managers.

`race-config.js` gains a `track` field that either inlines a manifest or
references one in `assets/tracks/<id>.json`.

`race-manager.js` is unchanged except for an optional callback for
artifacts that need to gate finish/checkpoint logic (e.g. drawbridges
extending the timer; sync gates contributing bonus time).

### 2.3 Why one manager, not six

* Lifetime / pool ownership is consistent.
* Collision pass becomes one ordered iteration (important when multiple
  artifacts overlap — e.g. boost pad after a ramp landing).
* Future builder UI iterates over a single registry of artifact types.

## 3. The Six Artifacts

Each spec below lists: **player verb**, **physics effect**, **visual**,
**collision shape**, **data params**, **UGC-safe param ranges**,
**multiplayer rules**.

### 3.1 Ramp

* **Verb:** jump.
* **Effect:** While crossing the ramp footprint, the bike's Y is raised
  along an arc. On launch (last 0.5 m of footprint), apply an upward
  velocity component; bike enters a 0.2–1.5 s airborne state where steering
  is reduced and pedaling does not affect ground speed; landing within
  expected zone gives a small forward boost, landing wide skids and
  optionally crashes.
* **Visual:** Wooden / metal ramp mesh (textured plane + side fascia).
  Trail effect on launch. Future: trick particles in air.
* **Collision shape:** Axis-aligned along road tangent. Footprint width
  defines lateral extent; player must hit center band to launch cleanly.
* **Data params:**

  ```jsonc
  {
    "type": "ramp",
    "d": 120,                // distance along road
    "offset": 0,             // lateral, meters from centerline
    "width": 2.0,            // meters
    "length": 3.0,           // meters
    "angle": 22,             // launch angle degrees
    "airTime": 0.8,          // seconds (auto-clamped from speed + angle)
    "skin": "wood"           // wood | metal | dirt | ugc:<assetId>
  }
  ```

* **UGC-safe ranges:** `width` 1.0–3.5, `length` 1.5–6.0, `angle` 5–35.
* **Multiplayer:** Each bike resolves jump independently. Mid-air bikes
  do not collide. Networked: send `airborne=true/false` in remote state so
  partners see jumps.

### 3.2 Boost Pad

* **Verb:** accelerate.
* **Effect:** While the bike center is on the pad, apply an additive
  forward speed bonus that decays over a configurable duration after exit
  (so chaining pads through a corner feels good). Cap final speed so
  boosts can't break the world.
* **Visual:** Striped chevron pad on the road surface; animated chevrons
  sliding forward. Faint exhaust particles trailing the bike during decay.
* **Collision shape:** Rectangle on ground; trigger volume, no crash.
* **Data params:**

  ```jsonc
  {
    "type": "boost",
    "d": 90,
    "offset": 0,
    "width": 2.5,
    "length": 4.0,
    "strength": 1.4,         // multiplier of base speed at peak
    "decay": 1.0,            // seconds after exit
    "skin": "chevron"
  }
  ```

* **UGC-safe ranges:** `strength` 1.1–1.8, `decay` 0.3–2.0,
  `width` 1.5–4.0, `length` 2.0–8.0. Hard cap on per-segment cumulative
  boost so a builder can't spam pads.
* **Multiplayer:** Per-bike. Visual chevrons sync from the artifact, not
  from each bike.

### 3.3 Mud Patch

* **Verb:** slow.
* **Effect:** While on the patch, multiply forward speed by `friction`
  (0.4–0.8). Pedal input continues to apply but with reduced effectiveness.
  Steering also reduced. Optional spray particles.
* **Visual:** Irregular brown organic decal on the road. Sound: wet
  squelch / splatter.
* **Collision shape:** Rectangle or polygon on ground. For MVP rectangle.
* **Data params:**

  ```jsonc
  {
    "type": "mud",
    "d": 160,
    "offset": -1.2,
    "width": 1.5,
    "length": 3.0,
    "friction": 0.5,
    "skin": "mud"            // mud | sand | ice | ugc:<assetId>
  }
  ```

* **UGC-safe ranges:** `friction` 0.4–0.9, `width` 1.0–3.5,
  `length` 1.0–6.0.
* **Multiplayer:** Per-bike. Other bikes see your spray particles via
  remote state's `surface` field.

### 3.4 Drawbridge

* **Verb:** time it.
* **Effect:** Two-state object that cycles open ↔ closed on a fixed
  period offset by phase. While **down**, treat like normal road. While
  **rising / up**, treat as solid wall (crash) and visually occlude. Half
  an animation cycle is the windowless period.
* **Visual:** Two hinged road planks that lift toward each other (or a
  single plank that drops/lifts). Warning paint on the road approaching.
  Optional siren sound while transitioning.
* **Collision shape:** Two states. Cosmetic mesh + scripted boolean
  collider. When transitioning, collider extends as a wall across both lanes.
* **Data params:**

  ```jsonc
  {
    "type": "drawbridge",
    "d": 300,
    "period": 6.0,           // seconds for a full cycle
    "phase": 0.0,            // seconds offset
    "downRatio": 0.6,        // 0..1 fraction of period spent fully down
    "skin": "wood"
  }
  ```

* **UGC-safe ranges:** `period` 3.0–12.0, `downRatio` 0.4–0.8 (prevents
  unfair "always up" bridges).
* **Multiplayer:** Bridge state is **derived from race wall-clock time
  and seed**, so it is identical for every client without network sync.

### 3.5 Choke Point

* **Verb:** squeeze through.
* **Effect:** Narrows the drivable corridor at this distance. Outside the
  corridor the bike crashes (or scrapes — see param). Used to force
  steering precision and, in multiplayer, to create overtake pressure.
* **Visual:** Pair of opposing scenery objects (cones+barriers,
  haystacks, knight statues) bordering the corridor. Optional flashing
  warning markers ~5 m ahead.
* **Collision shape:** Two opposing rectangles, leaving a `gap` lane.
* **Data params:**

  ```jsonc
  {
    "type": "choke",
    "d": 220,
    "offset": 0,             // centerline of the gap
    "gap": 1.8,              // meters
    "depth": 1.0,            // meters along road
    "mode": "crash",         // crash | scrape  (scrape = slow, no crash)
    "skin": "haystack"       // haystack | barrier | statue | ugc:<assetId>
  }
  ```

* **UGC-safe ranges:** `gap` 1.2–3.5 (bike body is ~0.7 m;
  below 1.2 is unfair). `offset` clamped to road width minus gap/2.
* **Multiplayer:** In networked play, the artifact's mesh is shared; per-bike
  collision is independent so two bikes can pass simultaneously *if* the
  builder placed the gap wide enough. This creates the overtake pressure
  organically without extra logic.

### 3.6 Sync Gate

* **Verb:** coordinate (the tandem-unique mechanic).
* **Effect:** A wide gate the bike must cross. While crossing, sample
  the in-phase metric from `shared-pedal-controller.js` (or the
  single-player equivalent of pedal-vs-target). If both riders are within
  `phaseTolerance` of each other during the crossing window, award a
  **boost** (similar magnitude to boost pad) and play a chime; otherwise no
  effect.
* **Visual:** Two glowing rings on poles arching over the road, like a
  finish gate. Color pulses with the bike's current sync metric so players
  can see whether they're "in tune" before they hit it. Green = synced,
  red = off.
* **Collision shape:** Trigger volume spanning full road width; no crash.
* **Data params:**

  ```jsonc
  {
    "type": "sync",
    "d": 180,
    "phaseTolerance": 30,    // degrees of pedal phase difference allowed
    "rewardStrength": 1.5,   // boost multiplier
    "rewardDuration": 1.2,
    "skin": "neon"
  }
  ```

* **UGC-safe ranges:** `phaseTolerance` 15–60, `rewardStrength` 1.1–1.7,
  `rewardDuration` 0.5–2.0.
* **Multiplayer:** Each bike (each tandem pair) resolves independently.
  In single-player, the second rider's phase is derived from the bot
  pedal-controller; tolerance auto-widens so solo play stays winnable.

## 4. Track Manifest Schema

A track manifest describes ordered artifacts along a level's road. Same
schema is used for built-in tracks and UGC tracks.

```jsonc
{
  "schemaVersion": 1,
  "id": "grandma",
  "name": "Grandma's",
  "distance": 350,
  "collectibles": "presents",
  "checkpointInterval": 70,
  "seed": 4242,
  "author": "official",           // or a player handle for UGC
  "artifacts": [
    { "type": "ramp",        "d":  60, "offset": 0,    "width": 2.0, "length": 3.0, "angle": 18, "skin": "wood" },
    { "type": "boost",       "d":  85, "offset": 0,    "width": 2.5, "length": 4.0, "strength": 1.35, "decay": 0.8 },
    { "type": "mud",         "d": 130, "offset": -1.2, "width": 1.5, "length": 2.5, "friction": 0.55 },
    { "type": "choke",       "d": 180, "offset": 0,    "gap": 2.0, "depth": 1.0, "mode": "crash", "skin": "haystack" },
    { "type": "sync",        "d": 230, "phaseTolerance": 30, "rewardStrength": 1.4, "rewardDuration": 1.0 },
    { "type": "drawbridge",  "d": 290, "period": 5.0, "phase": 0.0, "downRatio": 0.6 }
  ]
}
```

### 4.1 Validation rules (enforced for UGC, advisory for hand-authored)

* `schemaVersion` must match a known version.
* All artifacts must have `d` ≥ 0 and `d` ≤ `distance - 5`.
* `offset` clamped to drivable road half-width.
* Per-type `UGC-safe ranges` (see Section 3) enforced.
* Spacing: any two artifacts of the same type must be ≥ 8 m apart;
  any artifact and a checkpoint ≥ 15 m apart (mirrors the existing
  `cpClearance` in `obstacles.js`).
* Cumulative `(boost.strength - 1) * boost.length` per 100 m segment
  capped to prevent "boost spam".
* Maximum 80 artifacts per track.

Validation lives in `track-manifest.js` and runs:

1. At engine load for built-in manifests (assert).
2. At UGC import time (reject with human-readable error).
3. Server-side at UGC publish time (Cloudflare Worker — see Section 7).

## 5. Visual & Asset Plan

Each artifact ships with **two skins minimum** built-in. UGC skins are
added later (see Section 7.3).

| Artifact     | Built-in skins      | Asset type         | Source |
|--------------|--------------------|--------------------|---|
| Ramp         | wood, metal        | textured mesh      | new |
| Boost pad    | chevron, neon      | tiled decal + shader | new |
| Mud patch    | mud, sand, ice     | ground decal + particles | new |
| Drawbridge   | wood, stone        | hinged mesh        | new |
| Choke point  | haystack, barrier, knight statue | reused obstacle pool + 2 new meshes | partial reuse |
| Sync gate    | neon, festival     | emissive arch mesh | new |

All artifacts reuse the existing **chromakey video shader** pattern from
`obstacles.js` *only* if they have animated visuals (boost pad chevrons,
sync gate pulse). Static artifacts use a plain `MeshBasicMaterial` or
`MeshLambertMaterial`.

## 6. Integration With Existing Races

Updating `race-config.js`:

```jsonc
LEVELS = [
  { id: "tutorial", ..., track: "assets/tracks/tutorial.json" },
  { id: "grandma",  ..., distance: 350, track: "assets/tracks/grandma.json" },
  { id: "castle",   ..., distance: 700, track: "assets/tracks/castle.json" }
]
```

### 6.1 Grandma's (350 m, was 250 m)

Theme: friendly neighborhood. Light challenge.

* 1 ramp (small)
* 2 boost pads
* 1 mud patch
* 1 sync gate
* 1 choke point (gap 2.2, scrape mode)
* No drawbridge (saved for harder levels)

### 6.2 Castle (700 m, was 500 m)

Theme: medieval, moat, drawbridge. Full toolkit.

* 2 ramps (one long jump over a moat)
* 3 boost pads
* 2 mud patches
* 1 drawbridge (over moat)
* 2 choke points (between battlements; tighter gap)
* 2 sync gates (bonus time)

### 6.3 Tutorial — unchanged

Tutorial keeps only the pylon mechanic; we do **not** introduce artifacts
in the tutorial in this phase. (A later phase will add a per-artifact
tutorial scene gated behind first encounter.)

## 7. UGC: Sharing, Validation, Moderation

This section defines the parameter surface only. Builder UI is its own
issue (#TBD: "Track Builder + UGC").

### 7.1 Share format: track codes

A track is a base64url-encoded, gzip-compressed JSON manifest, prefixed
with the schema version: `T1.<base64url>`. Typical 30-artifact manifest
compresses to ~250–400 chars — short enough to paste into a chat.

Importing a code:

1. Decode → JSON.
2. Run full validation (Section 4.1).
3. Render an unmodifiable preview.
4. Player can play it locally or save it to their library.

This requires **no server** for peer-to-peer sharing — important for
launch.

### 7.2 Optional publish: server-side moderation

When a player wants to publish to a public gallery:

1. Client posts the manifest JSON to a new Cloudflare Worker endpoint
   `POST /tracks` (rate-limited by the existing relay/leaderboard
   pattern).
2. Worker re-runs validation server-side.
3. **Automated review** (pre-MVP, cheap):
   * Profanity filter on `name` and `author` (use existing handle
     filter from leaderboard if present).
   * Geometry sanity: at least one checkpoint reachable; finish
     reachable; no artifact past `distance`.
   * No "wall of crashes" — count: artifacts of type `mud` /
     `choke` / `drawbridge` ≤ 40% of total.
4. **Manual review queue**: status defaults to `pending`. Tracks visible
   only to author until approved.
5. Approved tracks land in a paginated gallery keyed by play count, like
   the existing leaderboard.

D1 schema addition:

```sql
CREATE TABLE tracks (
  id           TEXT PRIMARY KEY,
  author_id    TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  name         TEXT NOT NULL,
  manifest     TEXT NOT NULL,  -- raw JSON
  status       TEXT NOT NULL,  -- pending|approved|rejected
  created_at   INTEGER NOT NULL,
  play_count   INTEGER DEFAULT 0,
  rating_avg   REAL DEFAULT 0
);
CREATE INDEX tracks_status_created ON tracks(status, created_at DESC);
```

### 7.3 UGC skins — out of scope for v1

Players choose from built-in skin enums only. Custom textures or meshes
are deferred: they introduce asset hosting, copyright, and texture
budget issues that v1 should not pay for.

## 8. Multiplayer Considerations

* All six artifacts are **deterministic given the manifest**. No need to
  sync per-artifact state across clients.
* Drawbridge phase is computed from `(race_time + manifest.phase) % period`
  — same on every client because race start time is already synced via
  `network-manager.js`.
* Per-bike effects (boost, slow, airborne) are local; the only network
  field added is `airborne: bool` so partners see jumps. Confirm there is
  budget in `remote-bike-state.js` payload before adding.
* Sync gates only resolve when *both* of the local tandem's riders are
  in phase — they do **not** require cross-bike sync.
* In races with multiple bikes, choke points organically gate overtakes
  (intentional design lever, not a bug).

## 9. Implementation Plan

### Phase 1 — Foundation (1 PR)

* `js/artifacts/artifact-base.js` — shared pool helper with the
  visibility window + lateral offset math borrowed from `obstacles.js`.
* `js/artifacts/artifact-manager.js` — owns sub-managers, single
  `update()` and `checkCollision()` entry points.
* `js/artifacts/track-manifest.js` — schema, loader, validator.
* `assets/tracks/grandma.json`, `castle.json`, `tutorial.json` —
  initially **empty** `artifacts: []` to preserve current play.
* Wire `game.js` to construct `ArtifactManager` and call its hooks
  alongside the existing obstacle/collectible managers.
* No gameplay change yet.

### Phase 2 — Static artifacts (1 PR each)

In order of risk:

1. **Boost pad** — pure speed delta, no new physics state.
2. **Mud patch** — same shape, opposite sign.
3. **Choke point** — reuses obstacle collision math with two colliders.

### Phase 3 — Dynamic artifacts (1 PR each)

4. **Drawbridge** — adds a time-driven collider; deterministic from
   race clock.
5. **Ramp** — introduces airborne state in `bike-model.js` /
   `balance-controller.js`; needs care to not break tutorial or DDA.
6. **Sync gate** — depends on phase-difference signal already present
   in `shared-pedal-controller.js`; verify the single-player equivalent
   first.

### Phase 4 — Race content update (1 PR)

* Author the Section 6 manifests for Grandma's and Castle.
* Update level distances in `race-config.js`.
* Adjust segment timer budgets.
* Manual playtest + DDA pass.

### Phase 5 — UGC import (separate epic, see "Track Builder + UGC" issue)

* Track code import + preview screen.
* Worker endpoint + D1 table + moderation queue.

## 10. Risks & Open Questions

* **Ramps + balance**: airborne state interacts with the lean / tilt
  system. Need a spike to confirm `balance-controller.js` can pause
  cleanly during airtime without flipping the bike on landing. **Mitigation:**
  start with very small ramps and short airtimes in Phase 3.
* **Boost stacking**: chained pads through curves could let players
  exceed top speed targets used by DDA. **Mitigation:** absolute speed
  cap; per-segment cumulative boost cap in validator.
* **Mobile perf**: more meshes per scene. **Mitigation:** all artifacts
  share pools, visibility window matches obstacles, fall back to lower
  poly meshes on `lowEnd`.
* **Tutorial impact**: must not break existing tutorial flow.
  Phase 1 ships empty manifests for that reason.
* **Multiplayer payload**: adding `airborne` to remote state. Confirm
  byte budget; if tight, derive from vertical velocity instead.

## 11. Out of Scope (v1)

* Loops, half-pipes, see-saws (Section B from brainstorm)
* Open hub world
* UGC custom skins / meshes
* Cross-bike cooperative switches
* Power-ups (Mario Kart-style items)

These remain in the design backlog and should be re-evaluated after the
six-artifact set ships.
