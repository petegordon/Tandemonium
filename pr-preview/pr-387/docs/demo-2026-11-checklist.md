# Demo cut checklist — tag `demo-2026-11` by 2026-11-30

The demo must be live 2–3 months before **Steam Next Fest, February 2027**. This
is the wall: everything in Phase D ships *after* this tag, on the web build, and
never touches the demo branch.

Owner + engineer walk this together. Nothing here is optional; anything that
cannot be done is written down as "not done, because —" rather than left blank.

## 1. Code

- [ ] All Phase A items merged (A-0, A-2 … A-7, A-9). **A-1 is blocked** on
      `wrangler login`; if it is still blocked, the medal thresholds in
      `js/race-config.js` and the A-5 preset values stay as documented guesses
      and that fact is noted in the release notes.
- [ ] All Phase B items merged (B-2 … B-5). B-1 (GDEX) written up.
- [ ] C-1 dashboard routes deployed; C-2 Today's Road live.
- [ ] `npm test` green. `npm run smoke`, `smoke:boot`, `smoke:ride`,
      `smoke:crash`, `smoke:records`, `smoke:seed`, `smoke:daily`, `smoke:ctas`
      all pass on the release candidate.
- [ ] No console errors at the lobby on: desktop Chrome, iOS Safari, Android
      Chrome, and the Steam build. (`npm run audit:first30` covers the first
      three headlessly; a human checks the Steam build.)

## 2. The gate (B-6)

- [ ] `docs/playtests/2026-11-protocol.md` run with **three** non-gamers.
- [ ] All seven pass conditions met. Any failure is a `demo-blocker` issue and
      the tag waits.

## 3. Numbers, from the dashboard (C-1)

Run these on the last two weeks of data before tagging. If a number is missing
because the data is not there, write "no data" — do not guess.

- [ ] First-ride completion **≥ 70 %** (`dropoff` → first ride of a session).
- [ ] `crash_recover` average **≤ 2.5 s** (`dropoff` → crash recovery).
- [ ] `offset_quality` median **≥ 0.7** on co-op rides — the A-2 rule change
      should move this; if it has not, the beat window is wrong.
- [ ] D1 / D7 recorded, whatever they are. This is the baseline the post-fest
      Phase D work will be judged against, so it has to be written down now.
- [ ] Median seconds to first pedal stroke, per input.

## 4. Content in the demo build

- [ ] Tutorial, Grandma's, Today's Road (practice). Castle **locked**, with a
      wishlist hint rather than a dead lock icon.
- [ ] Today's Road is practice-only: no ranked runs, no streaks, no share strip,
      no partners board. Those are Phase D, on the web build.
- [ ] `?demo=1` is in the demo's launch URL, so `_isDemo` is true and the
      wishlist CTA appears.

## 5. Store and outward-facing (A-8, owner)

- [ ] Steam page (#262) updated: co-op is the pitch, screenshots show two
      riders, the tagline matches the game as it now plays.
- [ ] Hero / capsule art (#357) in place.
- [ ] Wishlist CTA verified **inside the Steam demo build**, not just the web
      build.
- [ ] The store page and `docs/ideal-customer-persona.md` describe the same
      game (C-3 corrected the persona doc; check the page against it).

## 6. Tag

- [ ] `git tag demo-2026-11 <commit>` and push the tag.
- [ ] Record the commit hash here: `________`
- [ ] Record the date the demo went live on Steam: `________`
- [ ] Open a `demo-2026-11-fixes` branch for cherry-picks. **Nothing from Phase
      D goes near it.**

## After the tag

Phase D starts on `main` for the web build: ranked runs, the spoiler-free share
strip, ghosts, streaks with freezes, the partners board, and the pair server.
The demo stays frozen at this tag plus fixes until the fest.
