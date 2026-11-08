#!/bin/bash
# macOS only (#192): assets/steam/tandemonium_icon_512x512.png -> assets/icon.icns (icon.ico is only 32 px) for the .app bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
SET="$(mktemp -d)/icon.iconset"
mkdir -p "$SET"
cp assets/steam/tandemonium_icon_512x512.png "$SET/src.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SET/src.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$SET/src.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
rm "$SET/src.png"
iconutil -c icns "$SET" -o assets/icon.icns
echo "wrote assets/icon.icns"
