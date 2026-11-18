# Road to Gold Standard ladder

The bike-unlock ladder for the Steam store page and social posts: Demo at the bottom, Gold Standard at the top.

| File | Size | Use |
| --- | --- | --- |
| `final/ladder_store.png` | 1232×2600 | Steam store description (616 px wide @2x) |
| `final/ladder_vertical.png` | 1080×1920 | Shorts, Reels, TikTok, Stories |
| `final/ladder_wide.png` | 1920×1080 | YouTube, X |
| `final/*_reveal-all.png` | same | Solo Flight, Time Warp and Gold Standard shown in colour (the default teases them as silhouettes) |

Rebuild:

```sh
# 1. stills of every bike from the game's own bike chooser (headless, ~10 min) -> plates/
W=2000 H=900 ANGLE=0.8 PULL=0.8 ZOOM=1.15 node scripts/reel/bike-ladder.mjs
#    one or a few bikes: node scripts/reel/bike-ladder.mjs bike_christmas,solo_flight
# 2. lay out the three sizes -> final/
node scripts/reel/bike-ladder-compose.mjs
REVEAL=solo_flight,time_warp,gold_standard SUFFIX=_reveal-all node scripts/reel/bike-ladder-compose.mjs
```

`PULL` brings a bike's outfit geese in toward the pedestal and `ZOOM` closes the camera in, for the bikes that
stand with geese (the holiday bikes, Solo Flight). Font: Lilita One (SIL OFL, `fonts/OFL.txt`).
