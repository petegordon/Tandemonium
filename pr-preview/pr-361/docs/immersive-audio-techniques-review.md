# Immersive Audio Techniques Review

A review of Tandemonium's current audio implementation against the "Immersive
Audio Techniques" taxonomy (Spatial, Timbral, Ambient, Referential, Structural),
with concrete recommendations and effort estimates.

Effort key: **XS** < 1h · **S** 1-4h · **M** 1-2d · **L** 3-5d · **XL** 1+ week.

---

## Current State Summary

Tandemonium is a 3D third-person tandem bicycle physics game (solo or P2P
multiplayer over WebRTC). Audio today is minimal and synthetic:

- One looping `<audio>` element playing `assets/Krampus Workshop.mp3`
  (`js/lobby.js` ~line 494, volume presets `[0, 0.10, 0.18, 0.40]`).
- Web Audio API oscillators for UI beeps/chimes (countdown, checkpoint, finish,
  crash, off-road warning) in `js/game.js`.
- Haptics (mobile Vibration + Gamepad `vibrationActuator`) in `js/haptics.js`
  carrying most per-event player feedback.
- Optional WebRTC mic capture between partners (`js/network-manager.js`).
- No `PannerNode`, `StereoPannerNode`, `ConvolverNode`, or distance attenuation
  anywhere.

Taxonomy coverage is roughly 0/5 Spatial, 1/5 Timbral, 1/5 Ambient,
0/4 Referential, and partial Structural. The bike itself is silent - no engine,
tire, wind, chain, pedal, or impact SFX.

---

## Spatial

### Sp1 - Embedded Audio Spatialization
**Status:** Not implemented. Music and beeps are unspatialized.
**Recommendation:** Route the existing `<audio>` element and oscillators through
an `AudioContext` graph with a `StereoPannerNode` master. Most assets can stay
mono/stereo; spatialization is applied at playback via `PannerNode` (HRTF) for
3D sources. Keep a single shared `AudioContext` initialized on first user
gesture (iOS requirement) alongside the existing `_audioDestination` used by
the recorder.
**Effort:** **M** - touches `game.js` beep helpers and `game-recorder.js`
routing, but is mostly plumbing.

### Sp2 - Audio Attenuation
**Status:** Not implemented. Volume is a static preset.
**Recommendation:** For any world-anchored source (checkpoint markers, NPCs,
off-road surface noise), use `PannerNode` with `distanceModel: 'inverse'`,
`refDistance`, and `maxDistance` tuned to the bike's camera distance. Update
`positionX/Y/Z` each frame from the entity's world transform inside the
existing render loop.
**Effort:** **S** once Sp1 is in place.

### Sp3 - Mobile Audio Sources
**Status:** Not implemented. The bike, NPCs, and obstacles are silent.
**Recommendation (high-value):** Add an engine-equivalent continuous loop for
the bike - a low-volume chain/tire loop whose playbackRate and gain scale with
velocity. This is the single biggest immersion win for a riding game. A second
wind loop scaling with speed^2 sells motion. Both live on the local player's
bike via `PannerNode` (or just stereo if Sp1 is deferred).
**Effort:** **M** for the bike loops; **L** if extended to remote partner bike
and environmental NPCs.

### Sp4 - Player-Originated Audio
**Status:** Partially implemented. Mic is sent over WebRTC, but desktop audio
(music, beeps) is not shared. That is typically correct; the gap is that the
local player's bike sounds (Sp3) aren't audible to the remote partner.
**Recommendation:** Once Sp3 lands, add a second WebRTC audio track carrying
the partner-relevant bike sounds mixed via a dedicated `MediaStreamDestination`.
Gate behind the existing `audioEnabled` toggle.
**Effort:** **M** - careful but localized change in `network-manager.js`.

### Sp5 - Game Controller Speakers
**Status:** Not implemented. Haptics only.
**Recommendation:** Low ROI. Web Gamepad API does not expose controller
speakers on any browser today; this would only apply in the Electron/Steam
build and even there support is vendor-specific (DualSense via SDL). Defer
until there is a native controller integration story.
**Effort:** **XL** (and blocked on browser/Electron capability). **Skip.**

---

## Timbral

### Ti1 - Realistic Sound Effects
**Status:** Not implemented. All SFX are square/sine oscillators.
**Recommendation (high-value):** Replace the synthesized crash/checkpoint/
finish/off-road beeps with sampled SFX:
- Crash: bike-on-ground + metallic clatter
- Checkpoint: short positive chime (sampled, not oscillator)
- Finish: crowd/bell cue
- Off-road: gravel/grass surface loop crossfaded by terrain type
Keep the oscillator path as fallback for pre-`AudioContext` states.
**Effort:** **M** - mostly asset sourcing + swapping calls in `game.js`.
Sample licensing (freesound.org CC0 or commercial pack) is the gating item.

### Ti2 - Virtual Acoustic Effects
**Status:** Not implemented.
**Recommendation:** Light touch only. Add a single `ConvolverNode` with a
short outdoor impulse response on the master bus so SFX don't sound bone-dry.
If the world gets distinct zones later (tunnels, indoors), swap IRs on
zone transitions.
**Effort:** **S** for a single IR; **M** for zone-based swapping.

### Ti3 - Audio Occlusion
**Status:** Not implemented.
**Recommendation:** Low priority for an open-air bike game. If an indoor
tunnel/building is added, apply a `BiquadFilterNode` lowpass (~800 Hz)
on occluded sources driven by a simple raycast from listener to source.
**Effort:** **M** when/if indoor geometry exists. Defer.

### Ti4 - Audio Mediation
**Status:** Not implemented.
**Recommendation:** Applies if Tandy-agent voice lines or in-universe radio
chatter are added - filter through a bandpass + slight distortion to signal
"coming through a device." Otherwise skip.
**Effort:** **S** once a source exists.

---

## Ambient

### Am1 - Adaptive Audio
**Status:** Not implemented. Single static loop.
**Recommendation (high-value):** Layered stems driven by game state:
- Base layer: always on
- Intensity layer: gain ramps with bike speed / proximity to obstacles
- Finish-line layer: gain ramps as progress % approaches 1.0
Implement with parallel `<audio>` elements or decoded buffers summed through
gain nodes, synced by `currentTime`. The existing volume preset UI extends
naturally to a master slider.
**Effort:** **L** - biggest win is producing the stems; engineering is modest.

### Am2 - Musicalized Sound Effects
**Status:** Not implemented.
**Recommendation:** Tune checkpoint/finish chimes to the key of the current
music track. Store a per-track root note in the music manifest; pick chime
pitches from that scale. Cheap and noticeable.
**Effort:** **S**.

### Am3 - Indeterminacy By Track Length
**Status:** Not implemented.
**Recommendation:** Couple with Am1 - have ambient stems of coprime lengths
(e.g., 31s, 47s, 53s) so the loop never aligns identically. Minimal code, pure
authoring choice.
**Effort:** **XS** (assuming Am1 is done).

### Am4 - Auxiliary NPC Audio
**Status:** Not implemented.
**Recommendation:** If/when NPCs (pedestrians, other bikes) are added, give
them short positional grunts/bell-rings on proximity. Pair with Sp3.
**Effort:** **M** once NPC entities exist. Defer if none planned.

### Am5 - Ambient Compositional Design
**Status:** Partially present. "Krampus Workshop" is genre-specific, not
ambient.
**Recommendation:** For the adaptive base layer (Am1), commission or source
an actual ambient bed (drone + slow harmonic motion) so intensity layers have
something neutral to ride on top of. Authoring decision, not engineering.
**Effort:** **M** (asset), **XS** (integration).

---

## Referential

### Re1 - Geographic Allusion
**Status:** Not implemented.
**Recommendation:** If courses get regional themes (alpine, coastal, urban),
swap music per course to match - this is Re1 almost for free.
**Effort:** **S** (engineering; artist-driven asset cost separate).

### Re2 - Historical Allusion
**Status:** N/A - no clear era the game is referencing.
**Recommendation:** Skip unless there's narrative intent.

### Re3 - Pre-Existing Audio Repurposed
**Status:** N/A (and risky - licensing).
**Recommendation:** Avoid. Not worth the licensing cost for a small game.

### Re4 - Internally Referential Audio
**Status:** Not implemented.
**Recommendation (cheap win):** Pick one distinctive motif (e.g., the finish-
line chime's first three notes) and reuse it in the lobby, trailer, and
victory screens so players associate it with Tandemonium. Pure authoring
decision.
**Effort:** **XS**.

---

## Structural

### St1 - Player-Controlled Diegetic Audio
**Status:** Not implemented.
**Recommendation:** A "bike radio" that the player can toggle/skip via a
mapped button is a natural fit - moves the existing music picker into the
game world and unlocks attenuation/occlusion behavior when the player moves
away from the bike (e.g., after a crash camera). Good flavor, modest scope.
**Effort:** **M**.

### St2 - Differentiated Menus
**Status:** Partially present. Lobby music continues into gameplay (fully
non-diegetic). No menu vs in-game distinction.
**Recommendation:** Duck music -6dB during gameplay vs lobby, or crossfade
to a different stem. Signals state change without adding assets.
**Effort:** **S**.

### St3 - Audio Transitions
**Status:** Not implemented. Current beeps/music cut in and out hard.
**Recommendation:** Add a small `crossfade(node, targetGain, durationMs)`
helper and use it everywhere music state changes (race start, pause, finish,
menu-return). Prevents the current abrupt stops.
**Effort:** **S**.

---

## Recommended Priorities

Ranked by immersion-per-effort for a bike game:

1. **Sp3 - Bike motion loops (chain/tire + wind)** - **M**. Single largest
   immersion gain. Without this the bike feels floaty.
2. **Ti1 - Sampled SFX for crash/checkpoint/finish** - **M**. Removes the
   "web demo" feel of square-wave beeps.
3. **Am1 + Am3 + Am5 - Adaptive layered ambient bed** - **L**. Scales music
   with intensity; covers Am3 and Am5 as byproducts.
4. **Sp1 + Sp2 - AudioContext graph with panner + attenuation** - **M**.
   Infrastructure unlock for Sp3, Sp4, Ti2, St1.
5. **St2 + St3 - Ducking and crossfades** - **S**. Tiny code, noticeable polish.
6. **Am2 + Re4 - Musical motif + in-key chimes** - **S**. Cheap identity win.
7. **Sp4 - Share bike sounds with partner over WebRTC** - **M**. Only after
   Sp3.
8. **St1 - Diegetic bike radio** - **M**. Flavor; do after the infrastructure.
9. **Ti2 - Single-IR reverb** - **S**. Low cost, modest gain.
10. **Re1 - Per-course music** - **S** + asset cost. Do when courses diversify.

**Skip / defer:** Sp5 (controller speakers - not supported in browser),
Ti3 (occlusion - no indoor geometry), Ti4 (mediation - no in-game devices),
Re2/Re3 (no narrative era; licensing risk), Am4 (no NPCs yet).

A focused two-week audio pass covering items 1-6 would move Tandemonium
from ~1/25 to ~12/25 on the taxonomy and materially change how the game feels
to ride.
