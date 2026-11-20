#!/usr/bin/env bash
# Remove pr-preview/pr-<n> folders that were staged the old way: a full copy of the game.
# Usage: drop-full-previews.sh <pr-preview dir>
#
# Since #760 a preview holds only the heavy files its PR changed, and has a
# service worker (preview-sw.js) at its root that fetches the rest from the
# live game. A preview without that file predates the change and is a full
# 100-340 MB copy. A few of those plus the live game are over what GitHub Pages
# allows, and nothing shrinks them until their PR is built again. So the deploy
# does not carry them forward: the PR's next push (or a close and reopen)
# publishes a small one in its place. A preview that has the worker is always kept.
set -u
dir="${1:?pr-preview dir}"
[ -d "$dir" ] || { echo "No previews in $dir"; exit 0; }
kept=()
for p in "$dir"/pr-*; do
  [ -d "$p" ] || continue
  n="${p##*/pr-}"
  if [ -f "$p/preview-sw.js" ]; then kept+=("$n"); continue; fi
  mb=$(du -sb "$p" | awk '{printf "%.1f", $1 / 1048576}')
  rm -rf "$p"
  echo "Dropped the preview of PR #$n ($mb MB): it is a full copy of the game from before #760. It will be rebuilt small on that PR's next push or reopen."
done
echo "Previews kept (staged the new way): ${kept[*]:-none}"
