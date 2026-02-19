#!/bin/bash
# Manually updates the version stamp in lobby screens
# The post-commit hook does this automatically, but this script
# can be run manually if needed.

HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
DATETIME=$(date +"%m-%d-%Y %H:%M")
VERSION="v.${HASH} | ${DATETIME}"

# Update both HTML files (use # delimiter to avoid conflicts with | and /)
sed -i '' "s#>v\.[^<]*<#>${VERSION}<#" portrait-game/index.html
sed -i '' "s#>v\.[^<]*<#>${VERSION}<#" index.html

echo "Updated version to: ${VERSION}"
