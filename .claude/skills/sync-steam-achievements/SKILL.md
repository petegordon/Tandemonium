---
name: sync-steam-achievements
description: Sync Steam achievements between js/achievements.js and the Steamworks dashboard using headful Puppeteer automation
user-invocable: true
---

Sync Steam achievements between the game codebase and the Steamworks dashboard.

This skill uses a Puppeteer script that opens a real browser, lets the user log in to Steamworks, then automatically scrapes, compares, deletes, and adds achievements to match the codebase.

## How to run

Run the sync script via Bash:

```bash
node scripts/sync-steam-achievements.js [appId] [--dry-run] [--no-delete]
```

Arguments:
- `appId` — Steam app ID (default: `4510250` for playtest, use `4482940` for main game)
- `--dry-run` — Compare and report only, don't make changes
- `--no-delete` — Skip deleting achievements not in code

The script will:
1. Parse all achievements from `js/achievements.js` (source of truth)
2. Launch a visible Chrome browser to the Steamworks achievements page
3. Wait for the user to log in if needed (press ENTER when ready)
4. Scrape all currently configured achievements
5. Compare code vs Steamworks and show a sync plan
6. Ask for confirmation, then delete/add achievements to match
7. Verify the final state

## When to use this skill

- After adding, removing, or renaming achievements in `js/achievements.js`
- When setting up a new Steam app (playtest or main game)
- To verify achievements are in sync between code and Steamworks

## After running

Remind the user to:
1. Go to the **Publish** tab in Steamworks and publish the changes
2. Achievement icons must be uploaded manually via the Steamworks UI

## Troubleshooting

If the script fails to find form fields or buttons:
- The Steamworks UI may have changed — check the browser window
- The user can make remaining changes manually in the open browser
- The browser stays open on errors so the user can review and fix

## Important notes
- `js/achievements.js` is the single source of truth
- Steam API Names are ALWAYS `id.toUpperCase()` (e.g. `first_500m` -> `FIRST_500M`)
- Never create Stats with the same API Name as achievements (causes publish conflicts)
- The playtest (4510250) and main game (4482940) have separate configurations
