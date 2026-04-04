#!/bin/bash
# Build a polished DMG from the packaged Electron app using native macOS tools.
# Usage: ./scripts/make-dmg.sh
#
# Prerequisites: run `npm run package` first to create the .app bundle in out/

set -euo pipefail

APP_NAME="3D Controller Overlay"
DMG_NAME="3D-Controller-Overlay"
VOLUME_NAME="$APP_NAME"
ICON_PATH="src/assets/icon.icns"
SIZE="300m"

cd "$(dirname "$0")/.."

# Auto-detect the packaged .app (arm64, x64, or universal)
APP_PATH=""
for arch in universal arm64 x64; do
  candidate="out/${APP_NAME}-darwin-${arch}/${APP_NAME}.app"
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "Error: No packaged .app found in out/. Run 'npm run package' first."
  exit 1
fi

DMG_PATH="out/${DMG_NAME}.dmg"
TEMP_DMG="/tmp/${DMG_NAME}-temp.dmg"

echo "Creating DMG from $APP_PATH..."

# Clean up previous builds
rm -f "$DMG_PATH" "$TEMP_DMG"

# Create a temporary DMG
hdiutil create -srcfolder "$APP_PATH" \
  -volname "$VOLUME_NAME" \
  -fs HFS+ \
  -fsargs "-c c=64,a=16,e=16" \
  -format UDRW \
  -size "$SIZE" \
  "$TEMP_DMG"

# Mount the temporary DMG
MOUNT_DIR=$(hdiutil attach -readwrite -noverify -noautoopen "$TEMP_DMG" | \
  awk '/Apple_HFS/ {for(i=3;i<=NF;i++) printf "%s ",$i; print ""}' | \
  sed 's/ *$//')

echo "Mounted at: $MOUNT_DIR"

# Add Applications symlink
ln -sf /Applications "$MOUNT_DIR/Applications"

# Set the volume icon (SetFile may not exist on CI runners)
if [ -f "$ICON_PATH" ]; then
  cp "$ICON_PATH" "$MOUNT_DIR/.VolumeIcon.icns"
  if command -v SetFile &>/dev/null; then
    SetFile -c icnC "$MOUNT_DIR/.VolumeIcon.icns"
    SetFile -a C "$MOUNT_DIR"
  fi
fi

# Set Finder window layout via AppleScript (skipped in headless CI)
if [ -z "${CI:-}" ]; then
  osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLUME_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {100, 100, 640, 480}
    set theViewOptions to icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set position of item "$APP_NAME.app" of container window to {130, 200}
    set position of item "Applications" of container window to {410, 200}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
fi

# Unmount
sync
hdiutil detach "$MOUNT_DIR" -quiet

# Convert to compressed read-only DMG
hdiutil convert "$TEMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH"
rm -f "$TEMP_DMG"

echo ""
echo "DMG created: $DMG_PATH"
ls -lh "$DMG_PATH"
