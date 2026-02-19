#!/bin/bash
# Updates the version stamp in lobby screens with current commit hash and datetime
# Called by the pre-commit git hook

HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
# For pre-commit, HEAD is the previous commit. Use the index tree hash instead.
# We'll use a placeholder that gets replaced after commit by post-commit hook.
DATETIME=$(date +"%m-%d-%Y %H:%M")
VERSION="v.${HASH} | ${DATETIME}"

# Update portrait-game/index.html
sed -i '' "s|>v\.[^<]*<\/p>|>${VERSION}<\/p>|" portrait-game/index.html

# Update index.html
sed -i '' "s|>v\.[^<]*<\/p>|>${VERSION}<\/p>|" index.html
