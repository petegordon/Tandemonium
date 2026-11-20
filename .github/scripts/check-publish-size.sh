#!/usr/bin/env bash
# Measure the tree about to be published to GitHub Pages and fail if it is too big.
# Usage: check-publish-size.sh <publish dir> [limit in MB, default 900]
#
# GitHub Pages allows 1 GB per site, and going over it does not fail loudly:
# the push to gh-pages succeeds and the site just stops updating. That is how
# publishing broke for days in November 2026 (#760) with nobody told. So the
# deploy stops here, with the numbers in the log, while there is still room.
# The limit is under 1 GB on purpose: previews are published between deploys
# and are not checked by this script.
set -u
dir="${1:?publish dir}"
limit_mb="${2:-900}"
[ -d "$dir" ] || { echo "::error::Nothing to measure: $dir does not exist"; exit 1; }

# File sizes as published (du -b), not blocks used on this runner's disk.
mb() { du -sb "$1" | awk '{printf "%.1f", $1 / 1048576}'; }
bytes() { du -sb "$1" | cut -f1; }

total_bytes=$(bytes "$dir")
total_mb=$(mb "$dir")
preview_bytes=0
echo "Publish tree: $dir"
if [ -d "$dir/pr-preview" ]; then
  preview_bytes=$(bytes "$dir/pr-preview")
  for p in "$dir"/pr-preview/pr-*; do
    [ -d "$p" ] || continue
    echo "  preview ${p##*/}: $(mb "$p") MB"
  done
else
  echo "  no previews"
fi
echo "  live game: $(awk -v t="$total_bytes" -v p="$preview_bytes" 'BEGIN{printf "%.1f", (t - p) / 1048576}') MB"
echo "  total: $total_mb MB (limit $limit_mb MB; GitHub Pages allows 1024 MB)"

if [ "$total_bytes" -gt $((limit_mb * 1048576)) ]; then
  echo "::error::The site to publish is $total_mb MB, over the $limit_mb MB limit (GitHub Pages stops updating past 1 GB). Nothing was deployed. Sizes of each preview are in this step's log: close or shrink the largest pull-request previews, or trim the game's assets, then re-run this deploy."
  exit 1
fi
