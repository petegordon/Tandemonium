Sync Steam achievements between the game codebase and the Steamworks dashboard.

## What to do

1. **Read the source of truth**: Parse `js/achievements.js` and extract all entries from the `ACHIEVEMENTS` array. For each, capture:
   - `id` (lowercase, e.g. `first_500m`)
   - `name` (display name, e.g. "First 500m")
   - `icon` (emoji)
   - A human-readable description derived from the `condition` function

2. **Derive the Steam API Name**: The code uses `id.toUpperCase()` when calling `window.steam.activateAchievement()`. So the Steam API Name is the uppercase version of the id (e.g. `FIRST_500M`).

3. **Check what's on Steamworks**: Fetch the current achievement configuration from the Steamworks partner site for the relevant app. Use WebFetch to load:
   - Playtest: `https://partner.steamgames.com/apps/achievements/4510250`
   - Main game: `https://partner.steamgames.com/apps/achievements/4482940`

   Note: This may require authentication and might not be fetchable. If it fails, ask the user to paste a screenshot or list of what's currently configured.

4. **Compare and report**:
   - List achievements that exist in code but NOT on Steamworks (need to be added)
   - List achievements on Steamworks that do NOT exist in code (may need to be removed)
   - List any API Name mismatches between code and Steamworks
   - Flag any Stats that have the same API Name as achievements (this causes publish conflicts)

5. **Generate output for the user**:
   - For any achievements that need to be added to Steamworks, output a table with:
     | API Name | Display Name | Description | Hidden? |
   - For achievements that need to be removed from Steamworks, list them
   - Provide step-by-step instructions for making changes in the Steamworks dashboard

6. **Optionally generate a VDF file**: If the user asks, generate a `steam/achievements.vdf` file in Steamworks achievement import format containing all achievements from the codebase. This file can be imported via the Steamworks dashboard.

## Important notes
- The ACHIEVEMENTS array in `js/achievements.js` is the single source of truth
- Steam API Names are ALWAYS the uppercase version of the `id` field
- Never create Stats with the same API Name as an Achievement — they conflict
- Achievement icons (64x64 or 256x256 jpg) must be uploaded manually through the Steamworks UI
- Changes to Steamworks must be published via the Publish tab before they take effect
- The playtest (4510250) and main game (4482940) have separate achievement configurations
