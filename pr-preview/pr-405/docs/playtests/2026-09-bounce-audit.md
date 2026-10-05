# First-30-seconds bounce audit (#263)

**Date:** 2026-09-08 · **Build:** `feat/value-appeal-impl` (A-0 … A-7) · **Method:**
instrumented headless Chrome (`scripts/` audit runs, four device profiles) plus a
read of the entry flow in code. Raw numbers: `out/bounce-audit.json`.

This is the audit #263 asked for, run before the demo cut. It answers what a
first-time Next Fest visitor hits between opening the page and their first pedal
stroke, and it names what is still in the way.

## What was measured

Four profiles, cold load each time, no cache: desktop Chrome 1440×900, iPhone 13
(390×844, touch), Pixel 7 (412×915, touch), Steam Deck (1280×800). `three` was
served locally so the numbers are the app's, not the CDN's.

| Profile | First paint | Modules booted | Lobby usable | Veil text |
|---|---|---|---|---|
| Desktop Chrome | 1564 ms | 2394 ms | 2483 ms | "Tap to Start" |
| iPhone 13 | 266 ms | 1062 ms | 1107 ms | "Loading Tandemonium…" |
| Pixel 7 | 285 ms | 1065 ms | 1148 ms | "Loading Tandemonium…" |
| Steam Deck | 274 ms | 1292 ms | 1360 ms | "Tap to Start" |

**Time to a usable lobby is not the problem.** Every profile is under 2.5 s, well
inside the 30 s target in #263. The desktop first-paint figure is a cold-process
artifact of the first browser launch in the run, not a real difference.

## The click path from cold load to riding

Measured by driving the real UI (`audit-flow`), desktop keyboard profile:

| # | Action | Required? |
|---|---|---|
| 1 | dismiss the veil ("Tap to Start") | desktop browsers only |
| 2 | click **SOLO RIDE** | yes |
| 3 | pick a level card (Grandma's) | yes |
| 4 | click **START RIDE** | yes |
| — | 3 s countdown | automatic |

**Four deliberate actions** stand between a cold load and the countdown: dismiss
the veil, SOLO RIDE, pick a level, START RIDE. Wall-clock times inside the ride
are not reported here: headless software rendering runs the loop at ~1.4 fps, so
the countdown alone takes ~20 s of wall clock in the harness. Ride-timing numbers
have to come from a human on real hardware (that is B-1, the GDEX playtest).

## What the audit found

### Fixed in this branch

1. **The silent dead end (#350).** A browser without import-map support sat on an
   unresponsive "Tap to Start" forever, with no message and no signal to us. Now
   a preflight names the missing capability, a 12 s watchdog catches a boot that
   never completes, and both paths report `boot_failed` to analytics. Verified by
   `npm run smoke:boot`, which simulates both failures.
2. **No loading indicator (#162).** The veil said "Tap to Start" while the game
   was still loading — on desktop it says nothing about progress at all. It now
   reads "Loading Tandemonium…" with a progress bar that advances on real boot
   milestones.
3. **The clock starting before the player does (A-6).** Verified end to end in the
   harness: at ride start `timerHeld` is true and the HUD shows `⏱ —`; two pedal
   taps release it and the bike moves. A player who spends eight seconds working
   out the controls no longer loses that time.
4. **Nothing telling a keyboard/gamepad/touch player how to pedal (A-6).** The
   coach card is confirmed showing on the first Grandma's ride.

### Still in the way (not fixed here)

1. **The desktop-browser veil is still a content-free click.** Desktop browsers
   keep "Tap to Start" because the click is what dismisses it. It now sits above
   a progress bar, but the word "Tap" on a machine with no touchscreen is wrong.
   *Suggested:* "Click to start" on non-touch, or dismiss on any key/click/pad
   input the way Electron already does. Small, worth doing before the demo.
2. **Two unlabelled controls in the lobby's top row** (`‹`, `›`, `?`) are in the
   visible-button set on every profile. A first-timer cannot tell that `‹ ›`
   browse bikes. *Suggested:* aria-labels plus a one-word caption under the
   carousel.
3. **The level card and START RIDE are two separate actions.** Picking a level
   does not start it; the primary button is elsewhere on the screen. This is the
   most likely place for a visitor to stall in a noisy hall. *Suggested for B-1
   to watch:* does a first-timer press START RIDE without being told?
4. **Difficulty is chosen before anyone knows what the words mean.** "Chill /
   Adventurous / Daredevil" are presented at the same moment as the level, with
   subtitles that describe feel, not consequence. A-5 fixed the *instruction*
   text after the choice; the choice itself is still blind. *Suggested:* say what
   changes ("You can't fall on Chill").
5. **Nothing on the first screen says what the game is.** The lobby leads with a
   bike carousel. The subtitle ("Party Physics Game on a Tandem Bicycle") is the
   only statement of the fantasy, and there is no motion. *Suggested for A-8:*
   the store page carries this weight; consider a looping clip behind the lobby
   later, but not before the demo cut — it is scope.

## New issues to file

- Desktop veil says "Tap" on a machine with no touch, and requires a click that
  teaches nothing (#263 follow-up, small).
- Lobby carousel arrows and the `?` button have no accessible labels.
- Difficulty descriptions describe feel, not consequence.

## Answers to #263's questions

1. **Can a new player get on the bike without reading anything?** Yes — four
   clicks, no text required, and the coach card now names the controls once they
   are riding. Before this branch the answer was "yes, but they will not know
   which keys pedal".
2. **Is time-to-first-pedal-stroke under 30 s?** The lobby is usable in ~1.2 s and
   the path is four clicks plus a 3 s countdown. On real hardware this is
   comfortably inside 30 s; confirm with a human at GDEX (B-1).
3. **Is time-to-first-crash-or-finish under 3 minutes?** Grandma's is ~250 m at a
   cruise of 3 m/s or better, so a completed ride is 1.5–3 min. After A-5 a crash
   is possible on Adventurous and Daredevil; on Chill it still cannot happen, by
   design.
