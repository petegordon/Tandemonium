# GDEX playtest protocol (B-1) — 2026-10-15 → 18

**Status:** protocol ready; the event has not happened yet. After GDEX, write the
results into `docs/playtests/2026-10-gdex.md` and file the issues it produces.

**Why this exists:** the Phase A tuning numbers (A-5's crash thresholds especially)
are stated guesses. GDEX is the first time strangers touch the Phase A build, and
every preset change after it must cite a line of the results doc. It is a gate,
not an event.

**Setup:** guerrilla, no booth (see the launch plan). One laptop with a gamepad,
one phone as a second seat, headphones for the observer. Build: the Phase A/B
branch deployed to the web, opened at `?demo=1` so the demo CTAs are live.

## Target: at least 8 observed players, of whom at least 3 have never played

## Per player — fill one row, on paper, while they play

| Field | Notes |
|---|---|
| Input used | keyboard / gamepad / touch / gyro |
| Ever played Tandemonium? | y/n; ever played a "gamer" game this year? |
| Seconds to first pedal stroke | stopwatch from the countdown ending |
| Seconds to first *perfect* stroke | the A-2 number; co-op only |
| Did the coach card get read? | eyes on it y/n, and did they follow it |
| First ride finished? | y/n, and the time |
| Balance crashes | count, and on which difficulty |
| Timeouts | count |
| Moments they laughed | write the trigger, not "laughed" |
| Moments they asked a question | verbatim, including "wait, what do I do?" |
| Did they ask to go again? | y/n — the single most important field on this sheet |
| Would they send a link to someone? | y/n, and **who** — a name, not "a friend" |

## Per pair (run at least two)

- Same laptop + phone. Do **not** explain the pedalling rule; the game now says
  it (A-4 coaching line). Note whether they work it out, and how.
- Do they talk about the beat? Write down the words they use for it — that
  vocabulary is what the HUD copy should be using.
- Does the CRANK FIGHT stamp make sense to them without the hint?
- Does the sync bar ever get looked at? (Watch their eyes, not the screen.)

## The non-gamer protocol (#261) — run with three people

In order, no coaching beyond what the game says:

1. Tutorial.
2. Grandma's on Chill.
3. One Adventurous ride.

Pass conditions (all three must hold for all three people):

- Finishes Grandma's Chill in under 5 minutes.
- **Zero** balance crashes on Chill. (Plan rule 10. If this fails, A-5 is wrong
  and the tuning gets reverted before anything else ships.)
- At least one laugh.
- Can say, unprompted, what makes the bike go faster.

## What to bring back

1. `docs/playtests/2026-10-gdex.md` with every sheet transcribed and a
   one-paragraph "what this says" at the top.
2. Median and worst seconds-to-first-pedal-stroke, per input.
3. Crash-per-ride, per preset — this is the number A-5's follow-up PR cites.
4. Every question anyone asked, grouped. Repeats are the priority list.
5. Issues filed for anything that stopped someone twice.

## What NOT to do

- Do not fix anything during the event. Write it down.
- Do not explain the controls to a player before they have tried for 30 seconds;
  the point is to find out what the game fails to say.
- Do not count a player who has seen the game before in the "never played" bucket
  just because they don't remember it.
