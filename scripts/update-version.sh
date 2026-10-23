#!/bin/bash
# Stamp the current commit + time into the lobby footer (#lobby-version) of a
# local checkout, e.g. before a hand-made build. CI does the same in
# deploy.yml, pr-preview.yml and build-windows.yml; without a stamp the footer
# reads "v.dev (local build)". Don't commit the result.

HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
DATETIME=$(date +"%m-%d-%Y %H:%M")
VERSION="v.${HASH} | ${DATETIME}"

# Portable in-place edit (GNU and BSD sed differ on -i).
FILE="$(dirname "$0")/../index.html"
sed -E "s#id=\"lobby-version\">[^<]*#id=\"lobby-version\">${VERSION}#" "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"

echo "Updated version to: ${VERSION}"
