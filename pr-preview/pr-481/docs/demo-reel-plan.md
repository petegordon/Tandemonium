# Steam trailer — `feat/goose-riders-p5` (PR #406)

A ~95 s 1080p60 Steam trailer of the game as it stands on PR #406, cut to the game's own ride music.

**Decisions (Pete, 2026-10-15):** in-game music · an input bot rides every shot (with plenty of lean) ·
no Tourist mode · audience: Steam trailer.

## Music

"Krampus Workshop" (Kevin MacLeod, CC BY 4.0, `assets/Krampus Workshop.mp3`), the ride music, 94.7 s.
About 122.4 bpm, so a bar is ~1.96 s. The quiet intro runs to 23.6 s, then the band comes in and builds
to a peak around 60–70 s. It drops out at 70.5 s and lands its last hit at ~84 s. The end card credits
the track as the licence asks.

## Cut

| Time | Shot | Caption |
|---|---|---|
| 0:00 | `open`: low front 3/4 push-in on the geese pedalling | (cold open) |
| 0:04 | `track`: side tracking, captain and stoker swaying out of step | TWO GEESE. ONE BIKE. |
| 0:08 | `titlebg`: crane up behind the bike | logo |
| 0:12 | `chase`: the game as played (chase cam, HUD, front-view PiP) | PEDAL TOGETHER |
| 0:16 | `lean`: front 3/4 close-up, the geese leaning against each other | LEAN TOGETHER / ...OR DON'T |
| 0:20 | `outfit-*`: Victorian / Cyclists / Fancy, one bar-third each | DRESS FOR THE RIDE |
| **0:23.6** | *band comes in* `weave`: Today's Road, Adventurous | TODAY'S ROAD / A NEW ROAD EVERY DAY |
| 0:29 | `colours`: a new Goose Colours scheme on every half-bar | PICK YOUR COLOURS |
| 0:33 | `crash`: both lean the same way, the tumble | FALL TOGETHER |
| 0:37 | `sling`: drag back, launch, follow cam over the Chaos Coins | SLINGSHOT! / GRAB THE CHAOS COINS |
| 0:49 | `versus`: split-screen 2v2, four bots | SPLIT-SCREEN 2 v 2 / RACE YOUR FRIENDS |
| 0:59 | `finish`: Grandma's finish line, YOU BOTH MADE IT! | (the game's own) |
| **1:10.5** | *quiet break* `endbg`: slow orbit | RIDE ON ONE COUCH / OR ONLINE WITH A FRIEND |
| **1:24** | *last hit* end card: logo, WISHLIST NOW ON STEAM, music credit | |

## How it's made

All in `scripts/reel/`; output goes to `renders/reel/` (untracked).

- `lib.mjs`: serves the game and opens Chrome **on the real GPU**. It installs a **virtual clock**:
  `performance.now`, `Date.now`, `requestAnimationFrame` and timers advance exactly 1/60 s per captured
  frame, so the footage is a perfect 60 fps however slow capture runs (about 6 s of real time per second
  of footage). Frames are saved as JPEG and encoded with ffmpeg (x264, crf 16).
- `page-bot.js`: runs inside the page.
  - **Input bot.** Each rider pedals on a beat; the stoker taps the opposite foot 80 ms after the
    captain, which the game scores as perfect.
  - **Steering.** A cascade road-follower: lateral offset → wanted heading → wanted lean → input,
    with feed-forward against the bike's self-righting. It dodges pylons, steers for presents
    (or around them in clean shots), and marks the input active so the game doesn't drop P2's lean
    as idle.
  - **Lean.** Each goose sways at its own rhythm (0.31 Hz and 0.43 Hz), so the two drift in and out
    of step. 75% of the shared sway is cancelled so the bike holds its line.
  - **Camera rig.** Keyframed shots in the bike's frame, in bike metres (×1.85 model scale). It
    overrides only the main camera.
  - **Clean mode** hides the HUD and PiP for beauty shots.
- `shots.mjs`: one function per shot, each in a fresh browser.
  - Local co-op (two bot inputs) for most shots.
  - `_onVersusReady` with four bot inputs.
  - Slingshot through its garage, with a mouse drag on the virtual clock.
- `edit.mjs`: builds the cut table above. Captions are in Luckiest Guy (Apache 2.0, downloaded to
  `renders/reel/fonts`). The logo is `images/logo.png`. Music is mixed with loudnorm to -14 LUFS.

```
node scripts/reel/shots.mjs            # every shot (or: shots.mjs open,crash)
node scripts/reel/edit.mjs             # -> renders/reel/tandemonium-trailer.mp4
```
