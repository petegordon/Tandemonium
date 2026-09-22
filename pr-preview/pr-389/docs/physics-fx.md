# Crash Physics (Rapier sidecar)

Optional, visual-only rigid-body effects: the crash tumble, knocked pylons, and
goose strikes. Issue [#388](https://github.com/petegordon/Tandemonium/issues/388).

## Why this is a sidecar and not the physics engine

Tandemonium's ride feel is a hand-tuned 1-D inverted pendulum on a spline
(`js/bike-model.js`, the balance block around `TUNE.gravityForce`). Position
isn't simulated at all — the bike rides `roadD` + `_lateralOffset` against
`RoadPath`. Every term in that model (`autoCorrection`, `_balanceAssist`,
low-speed wobble, danger-zone wobble, grass wobble) exists to make the bike feel
good rather than to be correct, and a solver would fight all of them.

Collisions are distance checks with a binary outcome (`bike._fall()`). There is
no stacking, no contact resolution and no momentum transfer — which is exactly
the work a physics engine exists to do, so there was none of it to hand over.

What a solver *is* good for is transient debris nobody wants to hand-animate.
That is all this does.

**Bike-vs-bike contact in versus is deliberately NOT part of this.** It is
already implemented by hand in `Game._resolveVersusBikeContact` — three-circle
sweep, penetration resolution, closing-speed scaling, lean impulse, speed
scrub, audio, haptics, cooldown — and porting it to Rapier would add WASM weight
and regression risk to working code for a worse arcade lean kick.

## Rules the design holds to

| Rule | Where it's enforced |
|---|---|
| Never touches ride state | Nothing in `js/physics/` writes `lean`, `speed`, `position` or `heading` |
| Never reaches the wire | `BikeCodec`'s 46-byte STATE packet is unchanged |
| Loads lazily | `ensureRapier()` — nothing fetched until the first `warm()` |
| Fails open | Every entry point returns `false`/`null` and the game plays as before |
| Budgeted | One world, fixed 1/60 timestep, 24-body cap, per-body lifetime, auto-dispose |
| Opt-out | `getPhysicsFx()`; Options → Crash Physics. Off by default on mobile |

Because none of it reaches the wire, two players in a multiplayer ride can
disagree about this setting with no desync.

## Files

```
js/physics/rapier-runtime.js   lazy, fail-open, single-init Rapier loader
js/physics/debris-world.js     the one Rapier world; spawn/step/retire
js/physics/physics-fx.js       the three effects + billboardRoll()
test/physics-smoke.html        headless assertions (no WebGL, no game)
scripts/smoke-physics-fx.mjs   runner
```

## Billboards

Almost everything here that tumbles is a camera-facing `PlaneGeometry` — pylons
are chromakey video planes, geese are drawn sprites. **A flat plane given a real
3D rotation turns edge-on twice per revolution and disappears.**

So those effects pass `driveRotation: false`. The solver owns the arc, the
bounce, the spin rate and the settle; the mesh keeps facing the camera exactly
as it does today, and takes its roll from `billboardRoll()` — the body's genuine
rotation projected into that camera's screen plane. Split-screen recomputes it
per pass, so the two viewports legitimately differ.

This is why "the geese are generated images, not 3D models" was never an
obstacle: a rigid body drives a transform and doesn't care what is drawn at it.

## Ground patches

The road has elevation, so a single flat plane would float debris above a dip
and bury it on a crest. Tracking one plane to the bike is worse — debris is left
behind within a second.

Each body therefore gets its own 6m ground patch, stamped at the terrain height
where it spawned and destroyed with it. Overlapping patches at different heights
would let a goose land on a neighbour's floor, so each body is isolated to its
own patch by collision group.

The cost is debris-vs-debris contact: two struck geese pass through each other.
That is a deliberate trade — correct ground height shows on every tumble, two
birds clipping for a third of a second mid-scatter does not.

## Goose strikes

Geese flee on approach and that stays exactly as tuned. With `FLEE_RADIUS` at
1.8–3.0m (scaled by each bird's boldness) and a bike closing 0.27m per frame at
top speed, **a goose can never be struck standing** — it is always airborne
first. That is the original design and the reason contact never had to be
handled.

What the scripted flee can't give you is the bird you clip *on the way up*: a
bold one that held until 1.8m, with ~0.13s to clear a bike doing 14m/s, off the
ground but still at bar height. `STRIKE_RADIUS` / `STRIKE_MAX_AGE` /
`STRIKE_MAX_HEIGHT` bound that window. A struck goose enters `STATE_STRUCK`,
keeps its pool slot, tumbles for ~1.15s, then recovers into the existing
`STATE_FLYING` lifecycle from wherever it landed — so pooling, recycling and the
disruption tally are all untouched.

The bike's heading and speed are differenced from the positions `update()`
already receives (`_bikeMotion`), so no call-site signature changed.

## Known limitations

- **Multiplayer stokers see the old canned fall.** `applyRemoteState` sets
  `fallen` straight from the packet and never calls `_fall()`, so the tumble
  hook doesn't fire. Making the stoker tumble would need either a deterministic
  shared sim or new transform fields on the wire — both were ruled out. The
  captain gets the tumble; the stoker sees the same crash, animated the old way.
- **No articulated ragdoll.** The riders GLB is skinned with lean clips; mapping
  a Rapier joint chain onto that armature is a much larger job that would fight
  the rider-lean wiring. The whole bike tumbles as one rigid body, which is what
  reads at speed anyway — on a real tandem the riders go down with the bike.
- **Rapier is ~1.06 MB gzipped** (2.86 MB raw; the WASM is inlined as base64).
  It is fetched during the countdown, so a crash in the first seconds of the
  very first ride of a session may still use the canned fall.

## Testing

```bash
npm i --no-save three@0.161.0 playwright
npm run smoke:physics
# CHROMIUM_PATH=/path/to/chrome  if the preinstalled browser doesn't match
```

Covers the Rapier API surface, patch heights on a slope, collision-group
isolation, CCD against fast debris, the body cap, lifetime/`onExpire` (including
that the final transform is sampled *before* the body is freed — reading a
removed handle is a use-after-free into WASM), billboard roll projection,
`clear()`/`dispose()`, the clamped-accumulator guard, and that every edited game
module still resolves.

Offline runs fall back to `vendor/rapier.mjs` — run `npm run download-vendors`
first.
