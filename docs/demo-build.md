# The demo as its own build

Pete, 2026-11-17: separate builds for the demo and the full game, so the demo can't be hacked
into the full game.

## Where it stood

The demo was the full game with a switch outside it:

- on the web, `?demo=1` in the address;
- on the desktop, the `--demo` launch option (or `TANDEMONIUM_DEMO=1`).

Every file of the full game shipped in the demo, and the server knew nothing about editions.
Taking the switch away (running the program without the launch option, or deleting `demo=1`)
gave the full game. Note what that means for the web: the address without `?demo=1` is the full
game, free, today.

## Three layers, cheapest first

A game that runs on the player's own machine can always be changed by its owner. The aim is that
turning a demo into the full game takes real work and gets little for it.

### 1. The build says what it is (done)

`js/edition-build.js` holds `BUILD_EDITION`. The repo has `'full'`. A demo build runs

    node scripts/set-build-edition.js demo

before packaging or publishing, and from then on `resolveIsDemo` answers "demo" whatever the
address or the launch options say. A full build still shows the demo with `?demo=1`, for trying
it. With this, getting the full game out of a demo build means unpacking it and editing its code.

### 2. The demo build leaves the full game's files out (to do)

What isn't in the package can't be unlocked. For a demo build, leave out:

- the levels beyond Tutorial, Grandma's and the Daily Ride (their data and props);
- the bike models and paint beyond Grandma's Classic and Marmalade Express, and the reward bikes;
- the outfit geese the demo can't wear;
- World Tourist's code (it also needs the Maps key, which a demo build is never given);
- Versus.

How: an `ignore` list for the demo in `forge.config.js` (desktop) and in the web deploy's staging,
driven by the same stamp. Each left-out file needs its caller to cope with it missing, which the
edition rules already guard in most places (`levelAllowed`, `bikeAllowed`, `rules.tourist`,
`rules.versus`); a smoke run of the demo build with the files gone is the check.

### 3. The server knows who owns the full game (to do)

Anything that matters beyond one machine goes through the API: leaderboards, achievements on the
account, online rooms. The Steam sign-in already proves which Steam app the ticket is for. Once
the demo has its own Steam app id:

- a session from the demo app is marked as demo;
- the API refuses what the demo can't do for a demo session: scores on full-game levels, the 80
  achievements the demo doesn't award, hosting Versus or World Tourist rooms;
- so a hacked demo plays alone and off the record.

## What needs deciding or doing by Pete

- **The demo's Steam app.** `DEMO_STEAM_APP_ID` in `electron/main.js` is still `null`: no demo app
  exists in Steamworks yet. Layers 2 and 3, and a CI job that uploads a demo build, wait on it. A
  demo build must never be uploaded to the full game's or the playtest's depots.
- **The web.** When the full game is sold on Steam, should tandemonium.housetandem.com be the demo
  (a demo build, by layer 1), with the full game on Steam only?
