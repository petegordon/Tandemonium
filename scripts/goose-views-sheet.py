"""Contact sheets for scripts/goose-views.mjs: renders/goose-views/<outfit>_<frame>.png (rows = crank, cols = views).
  <venv python> scripts/goose-views-sheet.py fancy [cap,sto,pair]"""
import sys
from PIL import Image, ImageDraw

D = "renders/goose-views"
VIEWS = ["front", "q34fl", "left", "q34rl", "rear", "q34rr", "right", "q34fr"]
outfits = sys.argv[1].split(",")
frames = (sys.argv[2] if len(sys.argv) > 2 else "pair,cap,sto").split(",")
T = 420
for o in outfits:
    for fr in frames:
        s = Image.new("RGB", (T * 4, (T + 24) * 4), "white")
        d = ImageDraw.Draw(s)
        i = 0
        for c in ("c0", "c90"):
            for v in VIEWS:
                im = Image.open(f"{D}/{o}_{fr}_{c}_{v}.png").convert("RGB").resize((T, T))
                x, y = (i % 4) * T, (i // 4) * (T + 24)
                s.paste(im, (x, y + 24))
                d.text((x + 6, y + 6), f"{o} {fr} {c} {v}", fill=(0, 0, 0))
                i += 1
        s.save(f"{D}/{o}_{fr}.png")
        print(f"{D}/{o}_{fr}.png")
