# Non-gamer gate before the demo cut (B-6) — November 2026

**Status:** protocol ready; the session has not happened. Run it against the
release candidate **before** tagging `demo-2026-11` (C-4). Results go in
`docs/playtests/2026-11-results.md`.

**This is a gate.** If it fails, the tag waits and the failures become issues
that block C-4 — up to the 2026-11-30 wall. It exists because the persona this
game is for is a person who does not play games, and every tuning decision in
Phase A was made without one of them in the room.

**Where:** Columbus Code & Coffee (date TBD — pin it by 2026-11-01).

## Recruit three people who have not played a video game this year

Not three developers. Not three people who "used to play". If you cannot find
three, two plus one stranger at the event is acceptable; one is not.

## The session, per person (about 15 minutes)

Hand them the device. Say exactly this and nothing more:

> "This is a bike game for two people. Have a go — I'm going to sit here and
> write things down, and I can't help you."

Then be quiet. Every time you want to explain something, write down what you
wanted to say instead. That list is the output.

1. Let them find their way from the lobby to riding. Time it.
2. Tutorial, then Grandma's on Chill, then one Adventurous ride.
3. Then, if they are willing, one co-op ride with you in the other seat.

## Pass conditions — all of them, for all three people

- [ ] Reaches a ride from a cold load without being told how.
- [ ] Finishes Grandma's on Chill in under 5 minutes.
- [ ] **Zero balance crashes on Chill.** (Plan rule 10. A-5 gave Chill an edge
      band that wobbles but cannot fall; if anyone falls on Chill, that is a bug,
      not a tuning preference.)
- [ ] Is not timed out during their first segment. (A-6's grace should make this
      impossible; if it happens, the grace is not being applied.)
- [ ] Laughs at least once.
- [ ] Can say, unprompted, what makes the bike go faster.
- [ ] In the co-op ride, works out the alternating rule from the screen alone.

## Record per person

- Time from cold load to riding.
- Every question asked, verbatim.
- Every moment they looked stuck for more than five seconds, and what was on
  screen at the time.
- Which difficulty they chose first, and whether they knew what the words meant.
- Crashes, timeouts, whether they asked to go again.
- The one thing they said about the game afterwards, in their words.

## If it fails

File one issue per failed condition, labelled `demo-blocker`, and fix in this
order: anything that stops a ride starting, then anything that ends a ride the
player did not intend to end, then anything they asked about twice.

Do not fix by adding an explanation to the screen if the thing itself can be
made obvious instead.
