# What to put in front of people this week

Branch `feat/value-appeal-impl` (PR #387). Everything below is on the PR preview
build. This is the sheet for the person running the session — it says what is
new, what to watch, and what to ignore.

**Run the pairs first.** The co-op depth (E-1/E-2/E-3) is the newest and least
observed work in the build, and it is the only part that cannot be evaluated by
one person.

## 1. A pair, online, on Adventurous — 10 minutes

One laptop (captain) + one phone (stoker), separate rooms if you can manage it.
Do **not** explain anything.

| Watch for | Why it matters |
|---|---|
| Does the stoker notice the **road-ahead panel**? | E-1 is the whole "back seat has a job" bet. If they don't see it, the panel is in the wrong place. |
| Do they **call the road** out loud, unprompted? | The point is the sentence, not the panel. Write the words they use. |
| What happens at the first **gust / goose / cobbles**? | E-2. Did the three-second warning arrive in time to say something? |
| Does anyone press **SPRINT**? | E-3. Space on keyboard, X on a pad, the SPRINT button on touch. If nobody finds it, it needs a prompt. |
| Do they use **emotes**? Which ones? | 1-4 on keyboard, hold X + d-pad on a pad. 🐢 and 🫠 are the ones I expect to earn their keep. |
| Does the **sync bar** ever get looked at? | Watch their eyes, not the screen. |

## 2. A first-timer, solo, cold — 10 minutes

Hand it over, say "have a go", then be quiet and write down everything you
wanted to explain.

- Time from page load to riding (target: comfortably under 30 s).
- Do they read the **coach card**? Do they follow it?
- Do they notice the timer showing **⏱ —** until they pedal?
- What happens on their first **crash**? It should be about 2.4 s and no menu.
  If they look confused rather than amused, that is the finding.
- On the victory screen: do they read the **medal / best** line?

## 3. Today's Road, twice

- First ride: does the card's "Same road for everyone today" line get read?
- Second ride: is the **ghost** noticed? Does it help or annoy?
- On the web build (not `?demo=1`) they will be asked **Practice or Ranked**.
  Does that choice make sense to them without explanation?

## 4. Tourist, only if the key is set up

`📍 RIDE THE DISTANCE BETWEEN YOU` in the lobby, or Options → Explore (beta).
The entry is invisible without a Maps key, so if you cannot see it, that is why
— see `docs/tourist-mode.md`. **Check the Google Cloud budget alert exists
before letting a room full of people use it.**

Ask one question afterwards: *"how far apart are you and the person you'd play
this with?"*

## Deliberately not worth your attention this week

- Medal times and the Adventurous/Daredevil crash thresholds are **stated
  guesses**, not measured — A-1 is blocked on `wrangler login`. Note whether
  they feel wrong, but do not tune them at the session.
- The partners board is off (`DAILY_BOARD_ENABLED = false`) and the migrations
  are not applied, so nothing server-side about pairs is live.
- Local co-op has no look-ahead panel by design: one screen, one camera, so
  there is no asymmetry to be had.

## Write it up

`docs/playtests/2026-10-gdex-protocol.md` has the per-player and per-pair
sheets. Use them; the numbers on them are what the next round of tuning cites.
