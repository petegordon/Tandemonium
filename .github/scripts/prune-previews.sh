#!/usr/bin/env bash
# Remove pr-preview/pr-<n> folders whose PR is no longer open.
# Usage: prune-previews.sh <pr-preview dir>   (needs GH_TOKEN; GITHUB_REPOSITORY in Actions)
# If the open-PR list can't be read, nothing is removed: a deploy that keeps
# a stale preview is better than one that drops a live one.
set -u
dir="${1:?pr-preview dir}"
[ -d "$dir" ] || { echo "No previews in $dir"; exit 0; }
repo="${GITHUB_REPOSITORY:-}"
if ! open=$(gh pr list ${repo:+--repo "$repo"} --state open --limit 500 --json number --jq '.[].number'); then
  echo "WARNING: could not list open PRs; keeping every preview"
  exit 0
fi
kept=(); dropped=()
for p in "$dir"/pr-*; do
  [ -d "$p" ] || continue
  n="${p##*/pr-}"
  if grep -qx "$n" <<<"$open"; then kept+=("$n"); else rm -rf "$p"; dropped+=("$n"); fi
done
echo "Previews kept (open PRs): ${kept[*]:-none}"
echo "Previews dropped (closed PRs): ${dropped[*]:-none}"
