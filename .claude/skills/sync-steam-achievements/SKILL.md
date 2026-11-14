---
name: sync-steam-achievements
description: Sync Steam achievements from js/achievement-defs.js to the Steamworks dashboard through its Bulk Import/Export CSVs (Puppeteer, saved login)
user-invocable: true
---

Sync Steam achievements from the game code to Steamworks.

When invoked, run the sync script via Bash. It opens a browser with a saved Steamworks login
(`~/.tandemonium-steamworks-profile`). If that login has expired the user signs in once in the
window (QR code or password) and the script carries on.

## How to run

```bash
node scripts/sync-steam-achievements.js [appId] [flags]
```

**App ID** comes from `steam_appid.txt` unless given (4510250 = playtest, 4482940 = main game).

**Flags:**
- `--dry-run`: export, compare, write the CSVs to `steam/achievement-sync/`, upload nothing
- `--icons`: also upload the earned + locked icon for every achievement (new ones always get icons)
- `--no-icons`: never upload icons
- `--headless`: no window (only when the saved login is still good)
- `--self-test [API_NAME]`: prove the whole path works. Appends " [sync test]" to one description
  (default `FIRST_500M`), uploads, saves, verifies; then puts the real text back and verifies again.
  Nothing reaches players without Publish. Ends with "Self-test PASSED" or "Self-test FAILED: …".

**Examples:**
- Check first: `node scripts/sync-steam-achievements.js --dry-run --headless`
- Full sync: `node scripts/sync-steam-achievements.js`
- Does the sync still work? (e.g. after Valve changes the page): `node scripts/sync-steam-achievements.js --self-test`

**Reading the output:** "Pending changes: To Modify (n)" can exceed the planned updates. The upload
rewrites every description from code, so whitespace-only differences on Steamworks (a trailing space)
get normalized too. That's expected.

## What the script does

1. Reads achievements from `js/achievement-defs.js`; Steam text comes from `describeCondition` in the script
2. Opens Steamworks → Achievements → **Bulk Import/Export**, exports the definitions + localization CSVs
3. Plans: new achievements, changed names / descriptions, Hidden (= Steam's `spoiler`)
4. Writes corrected CSVs (plus `<API>_ACHIEVED.png` / `_UNACHIEVED.png` icons) and uploads them
5. Checks Pending Changes (every file accepted, nothing to delete), presses **Save**
6. Re-exports and confirms nothing differs

Pure CSV logic: `scripts/lib/steam-achievement-csv.cjs` (unit tests in `test/unit/steam-achievement-csv.test.mjs`).

## Not done by the script (reported for a person)
- Achievements on Steamworks but not in code: delete by hand (players who earned one lose it)
- API renames (`RENAMED_API_NAMES`): import can't rename, so the script stops; rename by hand in Steamworks

## After running

Remind the user to press **Publish** in Steamworks. Nothing is live until then.

## Important notes
- `js/achievement-defs.js` is the source of truth; never change it to match Steamworks
- Steam API names are always `id.toUpperCase()` (e.g. `first_500m` → `FIRST_500M`)
- Never create Stats with the same API name as an achievement (publish conflicts)
- Steam caps an app at 100 achievements; the script stops before going past it
- Valve replaced the old achievements table in Nov 2026; if the Bulk Import/Export tab or its buttons move again, the script stops with a message rather than guessing
