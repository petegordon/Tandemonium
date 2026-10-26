# Steam store art candidates with the Victorian geese (#357)

Rendered in-engine from the real game (`scripts/reel/steam-art.mjs`, built on the trailer capture
tooling in `scripts/reel/lib.mjs` + `page-bot.js`): one co-op bot ride to Grandma's, the finish
cinematic frozen a moment after the line, and the same staged scene photographed at every Steamworks
slot size with its own camera. The riders are the pair from the 2D key art
(`images/large_action_*.png`): the tweed-and-bowler captain with the lady in the red bustle dress and
feathered hat (in-game that is the `victorian` captain + the `fancy` stoker). Behind them: Grandma
waving at her door, the ride's present pile, her 3D cabin (#478/#479/#481).

- `plates/` — the raw frames, no lettering.
- The files at this level are the Steam-sized candidates, made by `scripts/reel/steam-art-compose.mjs`
  (sharp, not a project dependency: `npm i --no-save sharp` somewhere and run with `SHARP_DIR=<that dir>`).
- `checks/hero_safe_area.png` — the hero at 1920x620 with Steam's safe box and logo zone drawn on it.

## Steam's rules, as applied

From partner.steamgames.com/doc/store/assets/standard and /libraryassets:

- **Capsules (header, main, vertical, library capsule):** the title lettering is the dominant, legible
  element: the Tandemonium-with-pedals sticker (`images/logo.png`) at 58-60% of the width on header/main
  and 86-88% on vertical/library capsule, placed over open sky, off the geese's faces and Grandma, with
  a soft drop shadow so it reads against the sky. The plates were re-staged for it (riders low and
  right, aim raised for sky). No text beyond the title.
- **Small capsule:** logo-first. The sticker nearly fills it (77% of the width, height-bound by its
  2.35:1 shape) over a blurred, darkened crop of the art; the 231x87 stays readable, so 120x45 should.
- **Library hero:** no text, no logo. The riders and Grandma sit inside the centred 860x380 safe box
  (1720x760 at full size), right of centre, clear of the bottom-left zone where Steam's library logo
  lands; the art fills the whole frame.
- **Library header:** no text (Steam overlays the logo), a balanced frame.
- **Library logo:** transparent PNG, 1280x720: the existing title (logotype + the pedals logomark).
- **Page background:** ambient, no text: the wide plate blurred and darkened.
- **Screenshots:** gameplay as played, chase cam + HUD, no overlays; Steam wants at least five (six here).
- **Icons:** community 184x184; client 32x32 as PNG and as `.ico` (16/32/48, PNG-compressed entries).
- Every file is under Steam's 5 MB limit.

## Candidates and checklist

| Steamworks slot | Required | Candidate | Size | Text rule | Safe area / notes |
|---|---|---|---|---|---|
| Header capsule | 920x430 (+460x215) | `header_920x430.png`, `header_460x215.png` | 0.49 / 0.16 MB | title only, 58% width, shadowed | faces clear of the sticker |
| Small capsule | 462x174 (+231x87) | `small_462x174.png`, `small_231x87.png` | 0.16 / 0.05 MB | logo-first, nearly fills | readable at 231x87 |
| Main capsule | 1232x706 (+616x353) | `main_1232x706.png`, `main_616x353.png` | 1.01 / 0.32 MB | title only, 60% width, shadowed | faces and Grandma clear |
| Vertical capsule | 748x896 (+374x448) | `vertical_748x896.png`, `vertical_374x448.png` | 0.86 / 0.26 MB | title only, 86% width, top | faces clear |
| Library capsule | 600x900 | `library_600x900.png` | 0.65 MB | title only, 88% width, top | faces clear |
| Library header | 920x430 | `libheader_920x430.png` | 0.30 MB | no text | balanced frame |
| Library hero | 3840x1240 | `hero_3840x1240.png` | 1.65 MB | no text, no logo | riders + Grandma inside 1720x760 centred box (`checks/hero_safe_area.png`) |
| Library logo | 1280 wide / 720 tall, transparent | `library_logo_1280x720.png` | 1.56 MB | logotype + logomark | 1280x720, alpha: yes |
| Page background | 1438x810 | `pagebg_1438x810.png` | 0.50 MB | no text, blurred + darkened | ambient |
| Community icon | 184x184 | `community_icon_184x184.png` | 0.08 MB | n/a | from the pedal icon |
| Client icon | 32x32 .ico | `client_icon.ico` (+`client_icon_32x32.png`) | 10 KB | n/a | 16/32/48 entries |
| Screenshots | 1920x1080, at least 5 | `screenshot1..6_1920x1080.png` | 1.0-2.1 MB | gameplay only | 1 checkpoint + boost, 2 mid-ride, 3 Grandma's house ahead, 4 the crash, 5 Versus split screen, 6 the start at Your Home |

## Still needs a human

- Final picks, and the lettering's exact position per slot (it is placed by the compose script's
  fractions; Steam gives no numeric text-safe margin for capsules, only "legible and not cropped by
  the gallery crop" for the main capsule).
- The sky is plain in this build (no clouds behind the lettering on the capsule plates).
- Screenshot 6 shows two achievement toasts and the sprint prompt; a curated screenshot set is a
  separate pass.
- Which files are currently uploaded to Steamworks: not visible from the repo, check the dashboard.

## Inventory of the existing art (2026-10-26)

What the repo holds today, what it shows, and which Steamworks slot it maps to.

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

### Slots with no file at all (before this PR)

Community icon 184x184, client icon 32x32 / .ico, page background 1438x810, screenshots 1920x1080.
(The library logo slot is covered by `tandemonium_title_1280x720.png`.)

## Regenerating

```
node scripts/reel/steam-art.mjs                 # all slots + the crash and versus screenshots
node scripts/reel/steam-art.mjs hero,main       # just these slots (one ride)
node scripts/reel/steam-art.mjs crash,versus    # just these screenshot sessions
SHARP_DIR=<dir with sharp> node scripts/reel/steam-art-compose.mjs
```

Knobs: `PAST` (metres past the line the bike is held, default 2), `SETTLE` (seconds for the presents to
land and Grandma to reach the door, default 4.6), `CRASH_AT` (seconds after the lean before the crash
still), and the per-slot camera table in `steam-art.mjs` (`deg` 0 = straight in front of the bike,
negative = the side away from the house; `look` raises the aim so the riders drop in frame; `side` > 0
pushes the riders right). Lettering size and position per slot: the `SLOTS` table in the compose script.
