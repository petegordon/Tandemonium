#!/usr/bin/env node
/**
 * Sync Steam Achievements — Puppeteer automation
 *
 * Reads achievements from js/achievements.js (source of truth),
 * opens Steamworks in a visible browser, waits for login,
 * scrapes current achievements, then deletes/adds to match code.
 *
 * Usage:
 *   node scripts/sync-steam-achievements.js [appId] [--dry-run] [--no-delete] [--debug]
 *
 * Default appId: 4510250 (playtest). Use 4482940 for main game.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DEBUG = process.argv.includes('--debug');

// ── Parse achievements from source code ──────────────────────────
function parseAchievementsFromCode() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'achievements.js'), 'utf-8');

  const entries = [];
  const entryRegex = /\{\s*id:\s*'([^']+)'\s*,\s*name:\s*(?:"([^"]+)"|'([^']+)')\s*,\s*icon:\s*(?:'[^']*'|"[^"]*")\s*,\s*condition:\s*s\s*=>\s*([^}]+)\}/g;
  let match;
  while ((match = entryRegex.exec(src)) !== null) {
    const id = match[1];
    const name = match[2] || match[3];
    entries.push({
      id,
      apiName: id.toUpperCase(),
      displayName: name,
      description: describeCondition(id),
    });
  }

  if (entries.length === 0) {
    console.error('ERROR: Could not parse any achievements from js/achievements.js');
    process.exit(1);
  }

  return entries;
}

function describeCondition(id) {
  const descriptions = {
    first_500m: 'Ride 500 meters total',
    first_km: 'Ride 1,000 meters total',
    five_k: 'Ride 5,000 meters total',
    speed_demon: 'Reach 50 km/h',
    perfect_sync: 'Stay in sync for 10 seconds in multiplayer',
    collector: 'Collect 10 items',
    hoarder: 'Collect every item in a level',
    home_sweet: "Finish Grandma's House",
    royal: 'Finish Castle',
    grandma_default: "Finish Grandma's House on the default bike",
    grandma_orange: "Finish Grandma's House on the orange bike",
    grandma_magenta: "Finish Grandma's House on the magenta bike",
    grandma_red: "Finish Grandma's House on the red bike",
    grandma_blue: "Finish Grandma's House on the blue bike",
    grandma_green: "Finish Grandma's House on the green bike",
    grandma_yellow: "Finish Grandma's House on the yellow bike",
    perfect_1k: "Finish Grandma's House with no crashes or restarts",
    perfect_5k: 'Finish Castle with no crashes or restarts',
    team_player: '80%+ safe riding in multiplayer',
  };
  return descriptions[id] || id;
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
        achievements.push({ apiName, displayName });
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
async function deleteAchievement(page, apiName) {
  // Handle the confirmation dialog
  page.once('dialog', async dialog => {
    await dialog.accept();
  });

  const deleted = await page.evaluate((name) => {
    const rows = document.querySelectorAll('tr');
    for (const row of rows) {
      const firstCell = row.querySelector('td');
      if (!firstCell) continue;
      const cellText = firstCell.textContent.trim();
      const apiMatch = cellText.match(/^([A-Z][A-Z0-9_]+)/);
      if (apiMatch && apiMatch[1] === name) {
        const deleteBtn = Array.from(row.querySelectorAll('a, button, input[type="button"], input[type="submit"]'))
          .find(el => (el.textContent || el.value || '').trim() === 'Delete');
        if (deleteBtn) {
          deleteBtn.click();
          return true;
        }
      }
    }
    return false;
  }, apiName);

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
  const appId = process.argv[2] || '4510250';
  const url = `https://partner.steamgames.com/apps/achievements/${appId}`;
  const dryRun = process.argv.includes('--dry-run');
  const skipDelete = process.argv.includes('--no-delete');

  console.log('=== Steam Achievement Sync ===');
  console.log(`App ID: ${appId}`);
  console.log(`URL: ${url}`);
  if (dryRun) console.log('DRY RUN — no changes will be made');
  if (DEBUG) console.log('DEBUG mode enabled');
  console.log('');

  // Parse achievements from code
  const codeAchievements = parseAchievementsFromCode();
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
  console.log('Scraping current achievements from Steamworks...');
  await dumpFormDebug(page, 'initial page');
  const steamAchievements = await scrapeAchievements(page);
  console.log(`Found ${steamAchievements.length} achievements on Steamworks:`);
  for (const a of steamAchievements) {
    console.log(`  ${a.apiName} — "${a.displayName}"`);
  }
  console.log('');

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
      process.stdout.write(`  Deleting ${a.apiName}...`);
      const ok = await deleteAchievement(page, a.apiName);
      console.log(ok ? ' done' : ' FAILED');
    }
    // Reload page after deletes
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1000);
    console.log('');
  }

  // Add achievements from code
  if (addList.length > 0) {
    console.log('Adding achievements...');
    for (const a of addList) {
      process.stdout.write(`  Adding ${a.apiName}...\n`);
      const ok = await addAchievement(page, a);
      console.log(ok ? '  done' : '  FAILED');
    }
    console.log('');
  }

  // Final scrape to verify
  console.log('Verifying...');
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);
  const finalAchievements = await scrapeAchievements(page);
  console.log(`Steamworks now has ${finalAchievements.length} achievements.`);
  console.log(`Code expects ${codeAchievements.length} achievements.`);

  if (finalAchievements.length === codeAchievements.length) {
    console.log('SYNC COMPLETE!');
  } else {
    console.log('WARNING: Count mismatch — review in the browser.');
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
