#!/usr/bin/env node
/**
 * Sync Steam Achievements — Puppeteer automation
 *
 * Reads achievements from js/achievement-defs.js (source of truth, #401),
 * opens Steamworks in a visible browser, waits for login,
 * scrapes current achievements, then deletes/adds to match code.
 *
 * Usage:
 *   node scripts/sync-steam-achievements.js [appId] [--dry-run] [--no-delete] [--allow-empty] [--debug]
 *
 * Default appId: 4510250 (playtest). Use 4482940 for main game.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DEBUG = process.argv.includes('--debug');

// ── Read achievements from the definitions module ────────────────
// #401: all 100 (the 7 retired colours included — they stay on Steam so
// nobody loses one). js/achievement-defs.js is ESM, so import it.
async function parseAchievementsFromCode() {
  const { pathToFileURL } = require('url');
  const defs = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'achievement-defs.js')).href);
  const entries = defs.ACHIEVEMENTS.map(a => ({
    id: a.id,
    apiName: a.id.toUpperCase(),
    displayName: a.name,
    description: describeCondition(a.id, a.desc),
    hidden: !!a.hidden,
  }));

  if (entries.length === 0) {
    console.error('ERROR: Could not read any achievements from js/achievement-defs.js');
    process.exit(1);
  }

  return entries;
}

// royal and perfect_5k (Castle, #400 D2) and beat_ghost (D3) are gone from the
// code; with --no-delete left off, a sync removes them from Steamworks.
function describeCondition(id, fallback) {
  const descriptions = {
    first_500m: 'Ride 500 meters total',
    first_km: 'Ride 1,000 meters total',
    five_k: 'Ride 5,000 meters total',
    speed_demon: 'Reach 50 km/h',
    perfect_sync: 'Stay in sync for 10 seconds in multiplayer',
    collector: 'Collect 10 items',
    hoarder: 'Collect every item in a level',
    home_sweet: "Finish Grandma's House",
    grandma_default: "Finish Grandma's House on the default bike",
    grandma_orange: "Finish Grandma's House on the orange bike",
    grandma_magenta: "Finish Grandma's House on the magenta bike",
    grandma_red: "Finish Grandma's House on the red bike",
    grandma_blue: "Finish Grandma's House on the blue bike",
    grandma_green: "Finish Grandma's House on the green bike",
    grandma_yellow: "Finish Grandma's House on the yellow bike",
    perfect_1k: "Finish Grandma's House with no crashes or restarts",
    team_player: '80%+ safe riding in multiplayer',
    // F-1 · the loops the value & appeal plan built. The seven grandma_* entries
    // above are retired from the in-game list but stay here: a Steam
    // achievement that already exists must not be deleted out from under the
    // people who earned it.
    daily_first: "Ride Today's Road",
    daily_streak_7: "Ride Today's Road seven days running",
    daily_streak_30: "Ride Today's Road thirty days running",
    pair_10_rides: 'Ride ten times with the same partner',
    pair_100km: 'Ride 100 km with the same partner',
    distance_between_us: 'Ride the distance between you and someone else',
    // #401 · the 77 new ones (100 in all).
    first_pedal: 'Pedal for the first time',
    tutorial_done: 'Finish the Tutorial',
    tutorial_clean: 'Finish the Tutorial without a single retry',
    first_finish: 'Finish any level',
    first_crash: 'Crash for the first time',
    first_remount: 'Crash, get back on, and finish that same ride',
    first_boost: 'Trigger a boost by grabbing a present or gem',
    ten_k: 'Ride 10 km total',
    half_marathon: 'Ride 21.1 km total',
    marathon: 'Ride 42.2 km total',
    century: 'Ride 100 km total',
    rides_10: 'Go on 10 rides of any kind',
    days_3: 'Ride on 3 different days',
    days_7: 'Ride on 7 different days',
    days_30: 'Ride on 30 different days',
    grandma_bronze: "Win bronze on Grandma's",
    grandma_silver: "Win silver on Grandma's",
    grandma_gold: "Win gold on Grandma's",
    daily_gold: "Win gold on Today's Road (practice counts)",
    all_gold: 'Win gold on every level',
    adventurer: 'Finish any level on Adventurous',
    daredevil: 'Finish any level on Daredevil',
    steady_hands: 'Ride 60 seconds without the bike shaking from leaning too far',
    centerline: "Stay on the road's centre strip for 30 seconds straight",
    no_offroad: 'Finish a level without going off-road',
    no_trees_daily: "Finish Today's Road without hitting a tree",
    new_best: 'Set a new personal best',
    assist_free: 'Turn down ASSIST when it is offered, then finish',
    terminal_goose: 'Reach 65 km/h',
    boost_25: 'Trigger 25 boosts',
    afterburner: 'Chain pickups to keep boosting for 10 seconds straight',
    presents_100: 'Collect 100 presents in total',
    daily_haul: "Collect every present on Today's Road",
    sling_first: 'Launch from the slingshot',
    sling_stage1: 'Clear Slingshot stage 1 (300 m)',
    sling_stage3: 'Clear Slingshot stage 3',
    sling_stage5: 'Clear Slingshot stage 5',
    sling_stage7: 'Clear Slingshot stage 7 (1,050 m)',
    sling_500: 'Fly 500 m in one launch',
    sling_1000: 'Fly 1,000 m in one launch',
    big_air: 'Land a Big Air off a ramp',
    frequent_flyer: 'Land 25 Big Airs',
    jackpot: 'Hit the jackpot billboard',
    double_down: 'Hit the jackpot on a run that also beats your best distance',
    full_trail: 'Grab all 5 coins in a trail',
    straight_shooter: 'Go 300 m without steering after launch',
    medal_key: 'Win a regular-ride medal that unlocks a Slingshot stage',
    todays_launch: "Fly Today's Launch, the daily Slingshot course",
    launch_week: "Fly Today's Launch on 7 different days",
    coin_first: 'Earn your first Chaos Coin',
    coins_1000: 'Earn 1,000 Chaos Coins in total',
    coins_10000: 'Earn 10,000 Chaos Coins in total',
    payday: 'Earn 200 coins from one regular (non-Slingshot) ride',
    first_upgrade: 'Buy your first garage upgrade',
    max_upgrade: 'Max out any one upgrade',
    garage_royalty: 'Max out every upgrade',
    big_spender: 'Spend 1,000 coins in the garage',
    rebuilt: 'Rebuild the bike for the first time',
    ship_of_theseus: 'Rebuild the bike 5 times',
    daily_streak_3: "Ride Today's Road three days running",
    daily_share: "Share a Today's Road result",
    daily_practice_10: "Finish 10 practice rides on Today's Road",
    coop_first: 'Finish a co-op ride',
    social_goose: 'Finish co-op rides with 3 different partners',
    standing_date: 'Keep a 4-week pair streak',
    versus_first: 'Finish a versus race',
    versus_win: 'Win a versus race',
    versus_2v2: 'Win a 2v2 versus race',
    versus_close: 'Win a versus race by less than 1 second',
    versus_comeback: 'Win a versus race after trailing at halfway',
    versus_10: 'Win 10 versus races',
    // Hidden on Steam (set "Hidden" by hand in Steamworks — this script cannot):
    crashes_10: 'Crash 10 times in total',
    false_start: 'Crash within 3 seconds of GO',
    so_close: 'Crash within 10 m of the finish',
    weathered: 'Ride through a gust without crashing',
    gone_with_wind: 'Get pushed by 10 gusts',
    grand_tour: 'Ride 5 km in total in Tourist',
  };
  return descriptions[id] || fallback || id;
}

// ── Wait for user to press ENTER ─────────────────────────────────
function waitForEnter() {
  return new Promise(resolve => {
    if (process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.once('data', () => {
      resolve();
    });
  });
}

// ── Wait for the achievements table to finish rendering ──────────
// "Achievement Configuration" appears before the rows do. Scraping at that
// moment read 0 rows and the sync re-added all 25 as duplicates (Sept 2026),
// so wait until the row count holds steady across several polls.
async function waitForTable(page, { timeout = 30000, interval = 1500, stablePolls = 3 } = {}) {
  const start = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - start < timeout) {
    await sleep(interval);
    const n = await page.evaluate(() =>
      document.querySelectorAll('tr[id] input[value="Delete"]').length
    ).catch(() => -1);
    stable = (n === last && n >= 0) ? stable + 1 : 0;
    last = n;
    // A non-empty table settles fast; an empty one might still be loading, so
    // it has to hold for the whole timeout before we believe it.
    if (n > 0 && stable >= stablePolls) return n;
  }
  return last;
}

// ── Scrape current achievements from Steamworks ──────────────────
async function scrapeAchievements(page) {
  // First dump the table structure for debugging
  if (DEBUG) {
    const tableDebug = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr');
      const info = [];
      let count = 0;
      for (const row of rows) {
        if (count >= 25) break;
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        const cellInfo = Array.from(cells).slice(0, 4).map((c, i) => {
          return `[${i}]="${c.textContent.trim().substring(0, 60).replace(/\n/g, '|')}"`;
        });
        info.push(`  row(${cells.length} cells): ${cellInfo.join('  ')}`);
        count++;
      }
      return info.join('\n');
    });
    console.log(`\n  [DEBUG] Table rows:\n${tableDebug}\n`);
  }

  return page.evaluate(() => {
    const achievements = [];
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;

      // Only look at rows that have Edit/Delete links
      const rowHTML = row.innerHTML;
      if (!rowHTML.includes('Edit') || !rowHTML.includes('Delete')) continue;

      // Skip header row
      const firstCellText = cells[0].textContent.trim();
      if (firstCellText === 'API Name' || firstCellText === '') continue;

      // Get API Name: first line of first cell text
      const firstLines = firstCellText.split('\n').map(l => l.trim()).filter(l => l);
      const apiName = firstLines[0] || '';

      // Get Display Name: first line of second cell text
      const secondCellText = cells[1].textContent.trim();
      const secondLines = secondCellText.split('\n').map(l => l.trim()).filter(l => l);
      const displayName = secondLines[0] || '';

      if (apiName && apiName !== 'API Name') {
        // row.id is Steam's stat/bit id (e.g. "a20_3") — unique even when two
        // rows share an API name, so deletes can target one row exactly.
        achievements.push({ apiName, displayName, rowId: row.id || null });
      }
    }
    return achievements;
  });
}

// ── Dump page HTML for debugging ─────────────────────────────────
async function dumpFormDebug(page, label) {
  if (!DEBUG) return;
  const html = await page.evaluate(() => {
    // Find ALL input-like elements
    const inputs = document.querySelectorAll('input, textarea, select, [contenteditable]');
    const info = [];
    for (const el of inputs) {
      info.push({
        tag: el.tagName,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        value: (el.value || el.textContent || '').substring(0, 80),
        placeholder: el.placeholder || '',
        className: (el.className || '').substring(0, 40),
        contentEditable: el.contentEditable,
      });
    }
    // Also look for the last table row which should be the new one
    const rows = document.querySelectorAll('tr');
    const lastRows = Array.from(rows).slice(-3);
    const rowHTML = lastRows.map(r => {
      const cells = r.querySelectorAll('td');
      return Array.from(cells).map((c, i) => `[${i}] ${c.innerHTML.substring(0, 200)}`).join('\n      ');
    }).join('\n    ---\n    ');

    return { inputs: info, lastRowsHTML: rowHTML };
  });
  console.log(`\n  [DEBUG ${label}] All inputs/selects (${html.inputs.length}):`);
  for (const inp of html.inputs) {
    console.log(`    <${inp.tag} type="${inp.type}" name="${inp.name}" id="${inp.id}" value="${inp.value.substring(0, 50)}" editable="${inp.contentEditable}">`);
  }
  console.log(`\n  [DEBUG ${label}] Last table rows HTML:`);
  console.log(`    ${html.lastRowsHTML}`);
  console.log('');
}

// ── Delete an achievement by clicking its Delete button ──────────
// Targets the row by its Steam row id, never by API name: with duplicates
// present, "first row with this name" is the ORIGINAL — the one players'
// unlocks are attached to.
async function deleteAchievement(page, rowId, apiName) {
  if (!rowId) return false;

  // Handle the confirmation dialog
  page.once('dialog', async dialog => {
    await dialog.accept();
  });

  const deleted = await page.evaluate((id, name) => {
    const row = document.getElementById(id);
    if (!row) return false;
    const firstCell = row.querySelector('td');
    if (!firstCell || firstCell.textContent.trim().split('\n')[0].trim() !== name) return false;
    const deleteBtn = Array.from(row.querySelectorAll('a, button, input[type="button"], input[type="submit"]'))
      .find(el => (el.textContent || el.value || '').trim() === 'Delete');
    if (!deleteBtn) return false;
    deleteBtn.click();
    return true;
  }, rowId, apiName);

  if (deleted) {
    await sleep(2000);
  }

  return deleted;
}

// ── Add an achievement via the New Achievement form ──────────────
async function addAchievement(page, achievement) {
  // Click "New Achievement" button
  const newBtn = await page.evaluate(() => {
    const links = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
    for (const el of links) {
      const text = (el.textContent || el.value || '').trim();
      if (text === 'New Achievement') {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!newBtn) {
    console.error(`  Could not find "New Achievement" button`);
    return false;
  }

  await sleep(2000);

  // Scroll to bottom so new form is visible
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(500);

  try {
    // Find the editable API Name input — it has an id like "ach20_10_apiname"
    // Use evaluateHandle to get a direct reference to the DOM element
    const apiId = await page.evaluate(() => {
      const all = document.querySelectorAll('input');
      for (const inp of all) {
        if (inp.id && inp.id.match(/^ach\d+_\d+_apiname$/)) {
          // Check if it's currently visible (in the editable form)
          const rect = inp.getBoundingClientRect();
          if (rect.height > 0 && rect.width > 0) {
            return inp.id;
          }
        }
      }
      return null;
    });

    if (!apiId) {
      console.error(`  Could not find visible API Name input`);
      if (DEBUG) {
        await page.screenshot({ path: 'debug-add-failed.png', fullPage: true });
        console.log('  [DEBUG] Screenshot saved to debug-add-failed.png');
        // Dump all input IDs for debugging
        const allIds = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('input'))
            .filter(i => i.id)
            .map(i => ({ id: i.id, type: i.type, visible: i.getBoundingClientRect().height > 0 }))
            .filter(i => i.id.includes('ach'));
        });
        console.log(`  [DEBUG] Achievement inputs: ${JSON.stringify(allIds)}`);
      }
      return false;
    }

    if (DEBUG) console.log(`  [DEBUG] Found API Name input: #${apiId}`);

    // 1. Click API Name, select all text, type new value
    await page.click(`#${apiId}`, { clickCount: 3 });
    await sleep(100);
    await page.keyboard.type(achievement.apiName, { delay: 15 });
    if (DEBUG) console.log(`  [DEBUG] Typed API Name: ${achievement.apiName}`);

    // 2. Display Name — derive its ID from the API Name ID pattern
    //    API Name id: ach20_10_apiname → base is "ach20_10"
    //    But Display Name doesn't have an ID — it uses name="english"
    //    From the screenshot, the visible english inputs are right after the API row
    //    Just click on each one by finding them via evaluateHandle
    const displayEl = await page.evaluateHandle(() => {
      const inputs = document.querySelectorAll('input[name="english"]');
      for (const inp of inputs) {
        const rect = inp.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0 && inp.type === 'text') {
          return inp;  // First visible english input = Display Name
        }
      }
      return null;
    });

    if (displayEl.asElement()) {
      await displayEl.asElement().click({ clickCount: 3 });
      await sleep(100);
      await page.keyboard.type(achievement.displayName, { delay: 15 });
      if (DEBUG) console.log(`  [DEBUG] Typed Display Name: ${achievement.displayName}`);
    } else {
      console.error(`  Could not find Display Name field`);
    }

    // 3. Description — second visible english input
    const descEl = await page.evaluateHandle(() => {
      const inputs = document.querySelectorAll('input[name="english"]');
      const visible = [];
      for (const inp of inputs) {
        const rect = inp.getBoundingClientRect();
        if (rect.height > 0 && rect.width > 0 && inp.type === 'text') {
          visible.push(inp);
        }
      }
      return visible.length >= 2 ? visible[1] : null;  // Second visible = Description
    });

    if (descEl.asElement()) {
      await descEl.asElement().click({ clickCount: 3 });
      await sleep(100);
      await page.keyboard.type(achievement.description, { delay: 15 });
      if (DEBUG) console.log(`  [DEBUG] Typed Description: ${achievement.description}`);
    } else {
      console.error(`  Could not find Description field`);
    }

    // Screenshot before save
    if (DEBUG) {
      await page.screenshot({ path: 'debug-before-save.png', fullPage: true });
      console.log('  [DEBUG] Screenshot saved to debug-before-save.png');
    }

    // 4. Click Save
    await sleep(300);
    const saveEl = await page.evaluateHandle(() => {
      const inputs = document.querySelectorAll('input[type="submit"]');
      for (const inp of inputs) {
        if (inp.value === 'Save') {
          const rect = inp.getBoundingClientRect();
          if (rect.height > 0 && rect.width > 0) return inp;
        }
      }
      return null;
    });

    if (saveEl.asElement()) {
      await saveEl.asElement().click();
    } else {
      console.error(`  Could not find Save button`);
      return false;
    }

    await sleep(2000);
    return true;

  } catch (e) {
    console.error(`  Error: ${e.message}`);
    if (DEBUG) {
      await page.screenshot({ path: 'debug-error.png', fullPage: true });
    }
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  // App ID: from CLI arg, or read from steam_appid.txt, or prompt
  let appId = process.argv.find(a => /^\d+$/.test(a));
  if (!appId) {
    try {
      appId = fs.readFileSync(path.join(__dirname, '..', 'steam_appid.txt'), 'utf-8').trim();
      console.log(`Read app ID ${appId} from steam_appid.txt`);
    } catch (e) {
      console.error('No app ID provided and steam_appid.txt not found.');
      console.error('Usage: node scripts/sync-steam-achievements.js [appId] [--dry-run] [--debug] [--no-delete] [--allow-empty]');
      process.exit(1);
    }
  }
  const url = `https://partner.steamgames.com/apps/achievements/${appId}`;
  const dryRun = process.argv.includes('--dry-run');
  const skipDelete = process.argv.includes('--no-delete');
  const allowEmpty = process.argv.includes('--allow-empty');

  console.log('=== Steam Achievement Sync ===');
  console.log(`App ID: ${appId}`);
  console.log(`URL: ${url}`);
  if (dryRun) console.log('DRY RUN — no changes will be made');
  if (DEBUG) console.log('DEBUG mode enabled');
  console.log('');

  // Parse achievements from code
  const codeAchievements = await parseAchievementsFromCode();
  console.log(`Found ${codeAchievements.length} achievements in code:`);
  for (const a of codeAchievements) {
    console.log(`  ${a.apiName} — "${a.displayName}"`);
  }
  console.log('');

  // Launch browser
  console.log('Launching browser — please log in to Steamworks if needed...');
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Check if we're on the achievements page or need to log in
  const isOnPage = await page.evaluate(() => {
    return document.body.textContent.includes('Achievement Configuration');
  });

  if (!isOnPage) {
    // Click the "Sign in" button (button#login_btn_signin)
    console.log('Not logged in — clicking Sign in...');
    try {
      const loginBtn = await page.$('button#login_btn_signin');
      if (loginBtn) {
        await loginBtn.click();
        console.log('Clicked Sign in — please authenticate (QR code or credentials)...');
      } else {
        console.log('Could not find Sign in button — please log in manually...');
      }
    } catch (e) {
      console.log('Please log in manually in the browser window...');
    }

    // Poll until we reach the achievements page (check every 3 seconds, timeout 2 minutes)
    console.log('Waiting for login to complete...');
    const loginTimeout = 120000;
    const pollInterval = 3000;
    const startTime = Date.now();
    let loggedIn = false;

    while (Date.now() - startTime < loginTimeout) {
      await sleep(pollInterval);
      try {
        const currentUrl = page.url();
        const onAchPage = await page.evaluate(() => {
          return document.body.textContent.includes('Achievement Configuration');
        });
        if (onAchPage) {
          loggedIn = true;
          break;
        }
        // Check if login completed but we're on a different page — navigate to achievements
        const onSteamworks = await page.evaluate(() => {
          return document.body.textContent.includes('Steamworks') &&
                 !document.body.textContent.includes('Sign in');
        });
        if (onSteamworks) {
          console.log('Login detected — navigating to achievements page...');
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
          await sleep(2000);
          loggedIn = true;
          break;
        }
        process.stdout.write('.');
      } catch (e) {
        // Page might be navigating, just wait
      }
    }

    if (!loggedIn) {
      console.error('\nLogin timeout — could not reach achievements page within 2 minutes.');
      await browser.close();
      process.exit(1);
    }
    console.log('\nLogged in successfully!');
    console.log('');
  }

  // Scrape current achievements
  console.log('Waiting for the achievements table to load...');
  await waitForTable(page);
  console.log('Scraping current achievements from Steamworks...');
  await dumpFormDebug(page, 'initial page');
  const steamAchievements = await scrapeAchievements(page);
  console.log(`Found ${steamAchievements.length} achievements on Steamworks:`);
  for (const a of steamAchievements) {
    console.log(`  ${a.apiName} — "${a.displayName}"`);
  }
  console.log('');

  // An empty read is far more likely to be a page that hasn't rendered than an
  // app with no achievements — and acting on it re-adds everything as
  // duplicates. Only proceed on an explicitly empty app.
  if (steamAchievements.length === 0 && codeAchievements.length > 0 && !allowEmpty) {
    console.error('Read 0 achievements from Steamworks — the table probably had not loaded.');
    console.error('Nothing changed. Re-run, or pass --allow-empty if this app really has none yet.');
    await browser.close();
    process.exit(1);
  }

  // Duplicate API names on Steamworks mean something already went wrong; the
  // name-keyed plan below can't reason about them safely.
  const seen = new Map();
  for (const a of steamAchievements) seen.set(a.apiName, (seen.get(a.apiName) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
  if (dupes.length > 0) {
    console.error(`Steamworks has duplicate API names: ${dupes.join(', ')}`);
    console.error('Nothing changed. Remove the extra rows by hand (keep the lowest id — the original) and re-run.');
    await browser.close();
    process.exit(1);
  }

  // Compare
  const codeSet = new Map(codeAchievements.map(a => [a.apiName, a]));
  const steamSet = new Map(steamAchievements.map(a => [a.apiName, a]));

  const toAdd = codeAchievements.filter(a => !steamSet.has(a.apiName));
  const toDelete = steamAchievements.filter(a => !codeSet.has(a.apiName));
  const existing = codeAchievements.filter(a => steamSet.has(a.apiName));

  console.log('=== Sync Plan ===');
  console.log(`  Already synced: ${existing.length}`);
  console.log(`  To add:         ${toAdd.length}`);
  console.log(`  To delete:      ${toDelete.length}`);
  console.log('');

  if (toAdd.length === 0 && toDelete.length === 0) {
    console.log('Everything is in sync! Nothing to do.');
    await browser.close();
    return;
  }

  if (toDelete.length > 0) {
    console.log('Achievements to DELETE (on Steamworks but not in code):');
    for (const a of toDelete) console.log(`  - ${a.apiName} ("${a.displayName}")`);
    console.log('');
  }

  if (toAdd.length > 0) {
    console.log('Achievements to ADD (in code but not on Steamworks):');
    for (const a of toAdd) console.log(`  + ${a.apiName} ("${a.displayName}") — ${a.description}`);
    console.log('');
  }

  const hiddenOnes = codeAchievements.filter(a => a.hidden).map(a => a.apiName);
  if (hiddenOnes.length > 0) {
    console.log('Mark these HIDDEN by hand in Steamworks (the form fill does not): ' + hiddenOnes.join(', '));
    console.log('');
  }

  if (dryRun) {
    console.log('DRY RUN complete. Run without --dry-run to apply changes.');
    await browser.close();
    return;
  }

  console.log('Applying changes...');
  console.log('');

  // In debug mode, limit to 1 delete and 1 add for testing
  const deleteList = DEBUG ? toDelete.slice(0, 1) : toDelete;
  const addList = DEBUG ? toAdd.slice(0, 1) : toAdd;

  if (DEBUG && (toDelete.length > 1 || toAdd.length > 1)) {
    console.log(`DEBUG: limiting to ${deleteList.length} delete(s) and ${addList.length} add(s)`);
    console.log('');
  }

  // Delete achievements not in code
  if (!skipDelete && deleteList.length > 0) {
    console.log('Deleting achievements...');
    for (const a of deleteList) {
      process.stdout.write(`  Deleting ${a.apiName} (${a.rowId})...`);
      const ok = await deleteAchievement(page, a.rowId, a.apiName);
      console.log(ok ? ' done' : ' FAILED');
    }
    // Reload page after deletes
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForTable(page);
    console.log('');
  }

  // Add achievements from code
  if (addList.length > 0) {
    console.log('Adding achievements...');
    for (const a of addList) {
      // Re-check against the live table right before each add: never create
      // a second row with an API name that already exists.
      const live = await scrapeAchievements(page);
      if (live.some(x => x.apiName === a.apiName)) {
        console.log(`  Skipping ${a.apiName} — already on Steamworks`);
        continue;
      }
      process.stdout.write(`  Adding ${a.apiName}...\n`);
      const ok = await addAchievement(page, a);
      console.log(ok ? '  done' : '  FAILED');
    }
    console.log('');
  }

  // Final scrape to verify
  console.log('Verifying...');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForTable(page);
  const finalAchievements = await scrapeAchievements(page);
  console.log(`Steamworks now has ${finalAchievements.length} achievements.`);
  console.log(`Code expects ${codeAchievements.length} achievements.`);

  // Compare by name, not count — a count can match while names are wrong.
  const finalNames = finalAchievements.map(a => a.apiName);
  const missing = codeAchievements.filter(a => !finalNames.includes(a.apiName)).map(a => a.apiName);
  const extra = finalNames.filter(n => !codeSet.has(n));
  const doubled = finalNames.filter((n, i) => finalNames.indexOf(n) !== i);
  if (missing.length) console.log(`  Missing:    ${missing.join(', ')}`);
  if (extra.length) console.log(`  Not in code: ${extra.join(', ')}`);
  if (doubled.length) console.log(`  DUPLICATED: ${[...new Set(doubled)].join(', ')}`);

  if (!missing.length && !doubled.length && (skipDelete || !extra.length)) {
    console.log('SYNC COMPLETE!');
  } else {
    console.log('WARNING: Steamworks does not match the code — review in the browser.');
    console.log('Press ENTER to close the browser...');
    await waitForEnter();
  }

  console.log('');
  console.log('IMPORTANT: Go to the Publish tab in Steamworks to publish these changes!');

  await browser.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
