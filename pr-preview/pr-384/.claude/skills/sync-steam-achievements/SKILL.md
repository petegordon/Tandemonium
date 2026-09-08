---
name: sync-steam-achievements
description: Sync Steam achievements between js/achievements.js and the Steamworks dashboard using headful Puppeteer automation
user-invocable: true
---

Sync Steam achievements between the game codebase and the Steamworks dashboard.

When invoked, run the sync script via Bash. The script opens a headful browser, auto-clicks Sign In, waits for the user to authenticate (QR code), then automatically scrapes, compares, deletes, and adds achievements to match the codebase.

## How to run

```bash
node scripts/sync-steam-achievements.js [appId] [flags]
```

**App ID** is read automatically from `steam_appid.txt` if not provided on the command line.

**Flags:**
- `--dry-run` — Compare and report only, no changes
- `--debug` — Limit to 1 delete + 1 add, screenshots, verbose logging
- `--no-delete` — Only add missing achievements, skip deletes

**Examples:**
- Full sync (uses steam_appid.txt): `node scripts/sync-steam-achievements.js`
- Full sync with explicit app: `node scripts/sync-steam-achievements.js 4482940`
- Dry run: `node scripts/sync-steam-achievements.js --dry-run`
- Test one add/delete: `node scripts/sync-steam-achievements.js --debug`

## What the script does

1. Parses achievements from `js/achievements.js` (source of truth)
2. Opens Chrome to the Steamworks achievements page
3. Clicks "Sign in" and polls until login completes (2 min timeout)
4. Scrapes currently configured achievements
5. Compares code vs Steamworks — shows sync plan
6. Deletes achievements on Steamworks not in code
7. Adds achievements in code not on Steamworks (clicks New Achievement, types API Name/Display Name/Description, clicks Save)
8. Verifies final count matches

## When to use

- After adding, removing, or renaming achievements in `js/achievements.js`
- When setting up a new Steam app (playtest or main game)
- To verify achievements are in sync between code and Steamworks

## After running

Remind the user to:
1. Go to the **Publish** tab in Steamworks and publish the changes
2. Achievement icons (256x256 jpg) must be uploaded manually via the Steamworks UI

## Important notes
- `js/achievements.js` is the single source of truth — never modify it to match Steamworks
- Steam API Names are ALWAYS `id.toUpperCase()` (e.g. `first_500m` → `FIRST_500M`)
- Never create Stats with the same API Name as achievements (causes publish conflicts)
- The playtest and main game have separate configurations — change `steam_appid.txt` or pass the app ID explicitly
- The browser stays open on errors so the user can review and fix manually
