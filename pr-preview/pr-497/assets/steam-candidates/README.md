# Steam store art candidates with the Victorian geese (#357)

Rendered in-engine from the real game (`scripts/reel/steam-art.mjs`, built on the trailer capture
tooling in `scripts/reel/lib.mjs` + `page-bot.js`): one co-op bot ride to Grandma's, the finish
cinematic frozen a moment after the line, and the same staged scene photographed at every Steamworks
slot size with its own camera. The riders are the pair from the 2D key art
(`images/large_action_*.png`): the tweed-and-bowler captain with the lady in the red bustle dress and
feathered hat (in-game that is the `victorian` captain + the `fancy` stoker). Behind them: Grandma
waving at her door, the ride's present pile, her 3D cabin (#478/#479/#481).

- `plates/` — the raw frames, no lettering (use these to place the final logo).
- The files at this level are the Steam-sized candidates: lettering (`images/logo.png`) composited
  by `scripts/reel/steam-art-compose.mjs` (sharp, not a project dependency: `npm i --no-save sharp`
  somewhere and run with `SHARP_DIR=<that dir>`).

Everything here is a candidate, not a pick. Still needs a human: the logo's size and position per
slot (Steam's text-safe margins for the main/vertical capsules, the library logo over the hero), the
small capsule (the lettering crowds the geese at 462x174), the sky/clouds (plain in this build), and
whether the finish-line stripe should be in the shot.

## Candidates

| Steamworks slot | Required | Candidate | Size | Notes |
|---|---|---|---|---|
| Header capsule | 920x430 (+460x215) | `header_920x430.png`, `header_460x215.png` | 0.48 / 0.17 MB | lettering top-left |
| Small capsule | 462x174 (+231x87) | `small_462x174.png`, `small_231x87.png` | 0.14 / 0.04 MB | lettering crowds the heads: needs a human |
| Main capsule | 1232x706 (+616x353) | `main_1232x706.png`, `main_616x353.png` | 0.88 / 0.32 MB | lettering top-left |
| Vertical capsule | 748x896 (+374x448) | `vertical_748x896.png`, `vertical_374x448.png` | 0.89 / 0.29 MB | lettering top-centre |
| Library capsule | 600x900 | `library_600x900.png` | 0.70 MB | lettering top-centre |
| Library header | 920x430 | `libheader_920x430.png` | 0.27 MB | no text (Steam overlays the logo) |
| Library hero | 3840x1240 | `hero_3840x1240.png` | 1.90 MB | no text; riders left of centre so the logo overlay fits |
| Library logo | PNG, transparent | `library_logo_1280x720.png` | 1.56 MB | copy of `assets/steam/tandemonium_title_1280x720.png` (no riders in it) |
| Page background | 1438x810 | `pagebg_1438x810.png` | 0.76 MB | wider view, no text |
| Community icon | 184x184 | `community_icon_184x184.png` | 0.09 MB | from `assets/steam/tandemonium_icon_512x512.png` (pedal) |
| Client icon | 32x32 (.ico wanted) | `client_icon_32x32.png` | 3 KB | PNG; Steamworks wants .ico: convert on upload |
| Screenshots | 1920x1080 | `screenshot1..3_1920x1080.png` | ~1.1 MB each | chase cam + HUD as played (geese, checkpoint, Grandma's house ahead, Hoarder toast) |

All PNGs are under Steam's 5 MB limit.

## Inventory of the existing art (2026-10-26)

What the repo holds today, what it shows, and which Steamworks slot it maps to. Which of these are
the ones actually uploaded to Steamworks is not visible from the repo: check the dashboard.

### `assets/steam/`

| File | Pixels | Shows | Slot |
|---|---|---|---|
| `Tandemonium_3D_Header_Capsule.png` | 920x430 | kids (3D, helmets) on a tandem | header capsule |
| `Tandemonium_3D_Library_Capsule.png` | 600x900 | kids | library capsule |
| `Tandemonium_3D_Library_Header.png` | 920x430 | kids (same bytes as the header capsule) | library header |
| `Tandemonium_3D_Library_Hero.png` | 3840x1240 | kids | library hero (4.67 MB) |
| `Tandemonium_3D_Main_Capsule.png` | 1232x706 | kids | main capsule |
| `Tandemonium_3D_Small_Capsule.png` | 462x174 | kids | small capsule |
| `Tandemonium_3D_Vertical_Capsule.png` | 748x896 | kids | vertical capsule |
| `Tandemonium_Header_Capsule.png` | 920x430 | riderless tandem + logo (older set) | header capsule |
| `Tandemonium_Library_Capsule.png` | 600x900 | riderless tandem + logo | library capsule |
| `Tandemonium_LIbrary_Header.png` | 920x430 | riderless tandem + logo | library header |
| `Tandemonium_Main_Capsule_Test2.png` | 1232x706 | riderless tandem + logo | main capsule |
| `Tandemonium_Small_Capsule_Test2.png` | 462x174 | riderless tandem + logo | small capsule |
| `Tandemonium_Vertical_Capsule_Test2.png` | 748x896 | riderless tandem + logo | vertical capsule |
| `tandemonium_icon_512x512.png` | 512x512 | pedal | source for community icon (184) / client icon (32) |
| `tandemonium_title_1280x720.png` | 1280x720 | logo, transparent | library logo |

### `images/`

| File | Pixels | Shows | Slot |
|---|---|---|---|
| `grandma_house_action.png` | 960x1072 | kids (2D) at a gift-wrapped Grandma's house | none (clip end card, `game-recorder.js`) |
| `header_capsule.png` | 460x215 | kids (2D) | header capsule, half size |
| `hero_graphic.png` | 3840x1240 | kids (2D) | library hero; 5.56 MB, over Steam's 5 MB |
| `library_hero.png` | 3840x1240 | kids (same bytes as `hero_graphic.png`) | library hero; 5.56 MB |
| `large_action_behind.png` | 499x1023 | geese (2D key art, from behind) | none |
| `large_action_facing.png` | 504x1017 | geese (2D key art, facing) | none |
| `large_capsule.png` | 467x181 | logo only | (near small capsule size, not exact) |
| `logo.png` | 940x400 | logo, transparent | lettering source |
| `pedal_left.png`, `pedal_right.png` | 1024x1024 | pedal | none (in-game) |
| `small_capsule.png` | 231x87 | logo only | small capsule, half size |
| `tandemonium_three_actions.png` | 1536x1024 | geese (2D key art triptych) | none |
| `tandemonium_title.png` | 1536x1024 | logo on a dark ground | none (title card) |

### Slots with no file at all

Community icon 184x184, client icon 32x32 / .ico, page background 1438x810, screenshots 1920x1080.
(The library logo slot is covered by `tandemonium_title_1280x720.png`.)

## Regenerating

```
node scripts/reel/steam-art.mjs                 # all slots -> assets/steam-candidates/plates/
node scripts/reel/steam-art.mjs hero,main       # just these
SHARP_DIR=<dir with sharp> node scripts/reel/steam-art-compose.mjs
```

Knobs: `PAST` (metres past the line the bike is held, default 2), `SETTLE` (seconds for the presents to
land and Grandma to reach the door, default 4.6), and the per-slot camera table in `steam-art.mjs`
(`deg` 0 = straight in front of the bike, negative = the side away from the house; `side` negative
pushes the riders left of frame).
