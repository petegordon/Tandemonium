---
name: sync-steam-achievements
description: Sync Steam achievements between js/achievements.js and the Steamworks dashboard — reports mismatches and generates VDF import files
user-invocable: true
---

Sync Steam achievements between the game codebase and the Steamworks dashboard.

## Step 1: Parse the source of truth

Read `js/achievements.js` and extract all entries from the `ACHIEVEMENTS` array. For each, capture:
- `id` (lowercase, e.g. `first_500m`)
- `name` (display name, e.g. "First 500m")
- `icon` (emoji)
- A human-readable description derived from the `condition` function

The Steam API Name is always `id.toUpperCase()` (e.g. `FIRST_500M`).

## Step 2: Get current Steamworks state

The Steamworks partner site requires authentication and cannot be fetched directly. Ask the user to provide the current state by either:
- Pasting a screenshot of the Achievements page
- Listing which achievements are currently configured

Relevant URLs:
- Playtest: `https://partner.steamgames.com/apps/achievements/4510250`
- Main game: `https://partner.steamgames.com/apps/achievements/4482940`

If the user says "none" or "empty", treat Steamworks as having zero achievements configured.

## Step 3: Compare and report

- List achievements in code but NOT on Steamworks (need to be added)
- List achievements on Steamworks but NOT in code (should be removed)
- List any API Name or Display Name mismatches
- Flag any Stats that share an API Name with an achievement (causes publish conflicts on Steamworks)

## Step 4: Generate the VDF import file

Always generate `steam/achievements.vdf` containing ALL achievements from the codebase. Use this exact format:

```
"achievements"
{
  "0"
  {
    "name" "FIRST_500M"
    "displayName" "First 500m"
    "description" "Ride 500 meters total"
    "hidden" "0"
    "icon" ""
    "icon_gray" ""
  }
  "1"
  {
    ...
  }
}
```

Rules for the VDF:
- Sequential numeric keys starting at "0"
- `name` = uppercase API name
- `displayName` = the `name` field from the ACHIEVEMENTS array
- `description` = human-readable description derived from the condition
- `hidden` = "0" for all (none are hidden)
- `icon` and `icon_gray` = empty strings (icons are uploaded separately via the dashboard)

## Step 5: Provide upload instructions

After generating the VDF, tell the user:

1. Go to Steamworks → App Admin → [app] → Stats & Achievements → Achievements
2. Look for an **"Import"** or **"Import from VDF"** option
3. If no import option exists, achievements must be entered manually using the table below
4. After adding/changing achievements, go to the **Publish** tab and publish changes
5. **Important**: Do NOT create Stats with the same API Name as achievements — this causes publish conflicts

Then output a formatted table of all achievements for easy manual entry:

| # | API Name | Display Name | Description |
|---|----------|-------------|-------------|

## Important notes
- `js/achievements.js` is the single source of truth — never modify it to match Steamworks
- Steam API Names are ALWAYS the uppercase version of the `id` field
- Achievement icons (64x64 or 256x256 jpg) must be uploaded manually through the Steamworks UI
- The playtest (4510250) and main game (4482940) have separate achievement configurations
- Changes to Steamworks are not live until published via the Publish tab
