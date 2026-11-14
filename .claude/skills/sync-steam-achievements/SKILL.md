---
name: sync-steam-achievements
description: Sync Steam achievements between js/achievement-defs.js and Steamworks (Bulk Import/Export CSVs, headful Puppeteer)
user-invocable: true
---

Sync Steam achievements between the game codebase and the Steamworks dashboard.

When invoked, run the sync script via Bash, `--dry-run` first. The script opens a headful browser with a saved Steamworks login (`~/.tandemonium-steamworks-profile`); if the login has expired it clicks Sign in and waits up to 5 minutes for the user (QR code or password + Steam Guard).

## How to run

```bash
node scripts/sync-steam-achievements.js [appId] [flags]
```

**App ID** comes from `steam_appid.txt` if not given. 4510250 = playtest, 4482940 = main game (has no achievements yet; needs `--allow-empty`).

**Flags:**
- `--dry-run` — export from Steam, compare, print the plan; upload nothing
- `--icons` — re-upload every icon; `--icons=API_A,API_B` — just those
- `--no-icons` — skip icons for new achievements
- `--allow-empty` — proceed when Steam has no achievements yet
- `--keep-open` — leave the browser open at the end

## Does the sync still work? (self-test)

```bash
node scripts/steam-sync-self-test.js [appId] [API_NAME]   # default FIRST_500M
```

Runs the sync twice: first with that description marked " [sync test]" (it must save and verify), then without (real text back, verify again). Ends "Self-test PASSED" or "Self-test FAILED at step N". Use it after Valve changes the Steamworks page. Nothing reaches players without Publish. Passed on 4510250 on 2026-11-14.

## What the script does (#775)

Steamworks redesigned the achievements page in Nov 2026; the script uses its **Bulk Import/Export** tab:

1. Reads `js/achievement-defs.js` (source of truth); descriptions from `describeCondition()` in the script
2. Exports Steam's definitions + localization CSVs
3. Compares: adds, display name / description changes, spoiler (= `hidden: true`) changes, renames (`RENAMED_API_NAMES`, edited in place via the inline editor so unlocks carry over), and rows Steam has that code lacks
4. Uploads CSVs with only the rows that differ, then presses Save (Steam stages them as Pending Changes)
5. Uploads `<API>_ACHIEVED.png` / `<API>_UNACHIEVED.png` icons for new achievements, with Steam's "Automatically generate unachieved icons" turned off
6. Exports again and fails unless Steam matches the code

It never deletes: deleting removes the unlock from every player who earned it. Rows on Steam that aren't in code are listed; delete them in the Steamworks editor (X on the row) only if the user says so. Steam caps an app at 100 achievements; the script stops before adding past it.

## After running

Remind the user to press **Publish** in Steamworks; nothing is live until then.

## Important notes
- `js/achievement-defs.js` is the single source of truth — never modify it to match Steamworks
- Steam API Names are ALWAYS `id.toUpperCase()` (e.g. `first_500m` → `FIRST_500M`)
- Never create Stats with the same API Name as achievements (causes publish conflicts)
- The playtest and main game have separate configurations — pass the app ID explicitly
