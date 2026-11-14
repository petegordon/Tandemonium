#!/usr/bin/env node
/**
 * Sync Steam Achievements — Steamworks Bulk Import/Export (#775)
 *
 * js/achievement-defs.js is the source of truth (#401). Steamworks redesigned the
 * achievements page in Nov 2026 (sets, inline editor, a Bulk Import/Export tab),
 * so this no longer scrapes the table. It:
 *   1. opens Steamworks in a visible browser (login kept in a profile outside the
 *      repo, ~/.tandemonium-steamworks-profile) and waits on the achievements page
 *   2. exports Steam's definitions + localization CSVs from Bulk Import/Export
 *   3. compares them with the code: adds, display name / description / spoiler
 *      (= `hidden: true`) updates, renames (RENAMED_API_NAMES, #575), removals
 *   4. uploads a definitions CSV (new rows + spoiler changes) and a localization
 *      CSV (changed names / descriptions) holding only the rows that differ
 *   5. uploads <API>_ACHIEVED.png / <API>_UNACHIEVED.png icons for the
 *      achievements it added (--icons: all of them; --icons=API_A,API_B: just those)
 *   6. exports again and checks Steam now matches the code
 *
 * Removing an achievement takes it from every player who earned it, so the script
 * never deletes: it lists what Steam has and the code lacks, and you delete
 * those in the editor (the X on the row). Renames edit the API name in place
 * through the inline editor so the unlock carries over.
 * Steam caps an app at 100 achievements; the script stops before adding past it.
 *
 * Usage:
 *   node scripts/sync-steam-achievements.js [appId] [--dry-run] [--icons[=API_A,API_B]] [--no-icons]
 *                                           [--allow-empty] [--keep-open]
 *
 * Default appId: steam_appid.txt. 4510250 = playtest, 4482940 = main game.
 * Nothing is live until someone presses Publish in Steamworks.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderIcons } = require('./achievement-icons');

const STEAM_ACHIEVEMENT_CAP = 100;
const PROFILE_DIR = path.join(os.homedir(), '.tandemonium-steamworks-profile');
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// #575 · API names renamed in code (old → new; js/achievement-defs.js RENAMED_IDS
// in upper case). A Steamworks row still under the old name is edited to the new
// one rather than deleted and re-added, which would reset the unlock for everyone.
const RENAMED_API_NAMES = { TODAYS_LAUNCH: 'DAILY_LAUNCH' };

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Read achievements from the definitions module ────────────────
// #401: all 100 (#500 added look_no_thumbs, sling_500 dropped for Steam's 100 cap). js/achievement-defs.js is ESM, so import it.
async function parseAchievementsFromCode() {
  const { pathToFileURL } = require('url');
  const defs = await import(pathToFileURL(path.join(__dirname, '..', 'js', 'achievement-defs.js')).href);
  const entries = defs.ACHIEVEMENTS.map(a => ({
    id: a.id,
    apiName: a.id.toUpperCase(),
    displayName: a.name,
    description: describeCondition(a.id, a.desc),
    hidden: !!a.hidden,
    icon: a.icon,
  }));

  if (entries.length === 0) {
    console.error('ERROR: Could not read any achievements from js/achievement-defs.js');
    process.exit(1);
  }

  // scripts/steam-sync-self-test.js: mark one description so a sync has something real to save.
  const mark = process.env.STEAM_SYNC_TEST_MARK;
  if (mark) {
    const a = entries.find(e => e.apiName === mark);
    if (!a) { console.error(`STEAM_SYNC_TEST_MARK: no achievement ${mark} in code`); process.exit(1); }
    a.description = `${a.description} [sync test]`;
    console.log(`Self-test: ${mark} description marked "[sync test]".`);
  }

  return entries;
}

// royal and perfect_5k (Castle, #400 D2) and beat_ghost (D3) are gone from the
// code; a sync only removes them from Steamworks when run with --delete.
function describeCondition(id, fallback) {
  const descriptions = {
    first_500m: 'Ride 500 meters total',
    first_km: 'Ride 1,000 meters total',
    five_k: 'Ride 5,000 meters total',
    speed_demon: 'Reach 40 km/h on a ride',
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
    // F-1 · the loops the value & appeal plan built.
    daily_first: "Finish your first Daily Ride",
    daily_streak_7: "Take the Daily Ride seven days running",
    pair_10_rides: 'Ride ten times with the same partner',
    pair_100km: 'Ride 5 km with the same partner',   // #608: 5K Together (was 100 km)
    distance_between_us: 'Ride the distance between you and someone else',
    // #401 · the 77 new ones (#500 look_no_thumbs replaced sling_500: 100 in all, Steam's cap).
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
    rides_10: 'Go on 10 rides of any kind',
    days_3: 'Ride on 3 different days',
    days_7: 'Ride on 7 different days',
    days_30: 'Go on 100 rides of any kind',   // #608: Lifer (was 30 days)
    grandma_bronze: "Reach Grandma's inside the bronze time (the slowest of the three medal times; each difficulty has its own, shown on the road's card)",
    grandma_silver: "Reach Grandma's inside the silver time (the middle medal time; each difficulty has its own, shown on the road's card)",
    grandma_gold: "Reach Grandma's inside the gold time (the fastest medal time; each difficulty has its own, shown on the road's card)",
    daily_gold: "Finish the Daily Ride inside its gold time, on any day (each difficulty has its own time)",
    all_gold: "Win gold on both timed roads: Grandma's and the Daily Ride",
    adventurer: 'Finish any level on Adventurous',
    daredevil: 'Finish any level on Daredevil',
    steady_hands: 'Ride 60 seconds without the bike shaking from leaning too far',
    centerline: "Stay on the road's centre strip for 30 seconds straight",
    no_offroad: 'Finish a level without going off-road',
    no_trees_daily: "Finish the Daily Ride without hitting a tree",
    new_best: 'Set a new personal best',
    look_no_thumbs: 'Finish a ride steering only by tilting your controller',
    assist_free: 'Crash three times at one checkpoint, then finish without the helping hand or the Royal Shortcut',
    terminal_goose: 'Reach 50 km/h on a ride',
    boost_25: 'Trigger 25 boosts',
    afterburner: 'Chain pickups to keep boosting for 10 seconds straight',
    presents_100: 'Collect 100 presents in total',
    daily_haul: "Collect every present on the Daily Ride",
    sling_first: 'Launch from the slingshot',
    sling_stage1: 'Clear Slingshot stage 1 (300 m)',
    sling_stage3: 'Clear Slingshot stage 3',
    sling_25: 'Reach 25 km/h in a Slingshot launch',
    sling_40: 'Reach 40 km/h in a Slingshot launch',
    sling_1000: 'Fly 600 m in one launch',
    big_air: 'Land a Big Air off a ramp',
    frequent_flyer: 'Land 25 Big Airs',
    jackpot: 'Collect the pot of gold',
    double_down: 'Collect the pot of gold on a run that also beats your best distance',
    full_trail: 'Grab all 5 coins in a trail',
    straight_shooter: 'Go 300 m without steering after launch',
    medal_key: "Win the medal that opens a Slingshot stage: bronze on Grandma's for stage 4, gold for stage 7",
    daily_launch: "Fly the Daily Launch, the Slingshot's daily course",
    launch_week: "Fly the Daily Launch on 7 different days",
    coin_first: 'Collect your first Tandem Token',
    coins_1000: 'Earn 1,000 Tandem Tokens in total',
    coins_10000: 'Earn 10,000 Tandem Tokens in total',
    payday: 'Earn 200 Tandem Tokens from one regular (non-Slingshot) ride',
    first_upgrade: 'Buy your first garage upgrade',
    max_upgrade: 'Max out any one upgrade',
    garage_royalty: 'Max out every upgrade',
    big_spender: 'Spend 1,000 Tandem Tokens in the garage',
    rebuilt: 'Rebuild the bike for the first time',
    ship_of_theseus: 'Rebuild the bike 3 times',
    daily_streak_3: "Take the Daily Ride three days running",
    daily_share: "Share a Daily Ride result",
    daily_practice_10: "Finish 10 Daily Rides",
    coop_first: 'Finish a co-op ride',
    social_goose: 'Finish co-op rides with 3 different partners',
    versus_first: 'Finish a versus race',
    versus_win: 'Win a versus race',
    versus_2v2: 'Win a 2v2 versus race',
    versus_comeback: 'Win a versus race after trailing at halfway',
    versus_10: 'Win 10 versus races',
    // #608 · in for century, daily_streak_30, standing_date and versus_close (a sync removes those with --delete).
    versus_underdog: 'Win a versus race riding alone against a two-goose tandem',
    versus_clean: 'Win a versus race without crashing',
    full_house: "Finish a ride in every mode: Grandma's, the Daily Ride, Slingshot, co-op, versus and Tourist",
    rainbow_gold: "Win gold on Grandma's on every bike colour (all 7)",
    // Hidden on Steam (the sync sets the Hidden box from `hidden: true` in the defs):
    crashes_10: 'Crash 10 times in total',
    false_start: 'Crash within 3 seconds of GO',
    so_close: 'Crash after the last checkpoint',
    weathered: 'Ride through a gust without crashing',
    gone_with_wind: 'Get pushed by 10 gusts',
    grand_tour: 'Ride 5 km in total in Tourist',
  };
  return descriptions[id] || fallback || id;
}

// ── CSV (the format Bulk Import/Export reads and writes) ─────────
// UTF-8 with a BOM, CRLF line endings, RFC 4180 quoting.
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f !== ''));
}

const csvField = v => (/[",\r\n]|^\s|\s$/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const writeCsv = (rows) => '﻿' + rows.map(r => r.map(csvField).join(',')).join('\r\n');   // exactly as Steam exports: no final newline

/** Definitions CSV → Map(apiName → { cols, spoiler }) + the header row as Steam wrote it. */
function readDefinitions(file) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf-8'));
  const map = new Map(rows.map(r => [r[0], { cols: r, spoiler: r[3] === 'true' }]));
  return { header, map };
}

/** Localization CSV → Map(apiName → { name, description }) + header. */
function readLocalization(file) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf-8'));
  const map = new Map();
  for (const [api, field, english] of rows) {
    const e = map.get(api) || {};
    e[field] = english;
    map.set(api, e);
  }
  return { header, map };
}

// ── Browser helpers ──────────────────────────────────────────────
const onAchievementsPage = (page) => page.evaluate(() =>
  !!document.querySelector('input[placeholder*="name, description"]')).catch(() => false);

async function openAchievements(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  if (await onAchievementsPage(page)) return;
  console.log('Not logged in. Sign in to Steamworks in the browser window (QR code or password + Steam Guard)...');
  const signIn = await page.$('button#login_btn_signin');
  if (signIn) await signIn.click().catch(() => {});
  const start = Date.now();
  while (Date.now() - start < LOGIN_TIMEOUT_MS) {
    await sleep(3000);
    // Only the achievements page itself counts: a Steam Guard page also says
    // "Steamworks" without "Sign in", which fooled the old check.
    if (await onAchievementsPage(page)) return;
    const loggedIn = await page.evaluate(() => !document.querySelector('button#login_btn_signin')
      && !document.querySelector('input[type=password]') && !/sign in/i.test(document.title)).catch(() => false);
    if (loggedIn && !page.url().includes('/apps/achievements/')) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    }
  }
  throw new Error('Login timeout: never reached the achievements page within 5 minutes.');
}

/** Click the visible element whose own text is exactly `text`. */
async function clickText(page, text) {
  const handle = await page.evaluateHandle((t) => [...document.querySelectorAll('button, a, div, span')]
    .find(e => e.offsetParent && e.textContent.trim() === t
      && (e.tagName === 'BUTTON' || ![...e.children].some(c => c.textContent.trim() === t))), text);
  const el = handle.asElement();
  if (!el) throw new Error(`Could not find "${text}" on the page`);
  await el.click();
}

async function openBulkTab(page) {
  await clickText(page, 'Bulk Import/Export');
  await page.waitForFunction(() => /Export Definitions/.test(document.body.innerText), { timeout: 30000 });
  await sleep(1000);
}

async function waitForDownload(dir, name, timeout = 30000) {
  const file = path.join(dir, name);
  const start = Date.now();
  let lastSize = -1;
  while (Date.now() - start < timeout) {
    await sleep(500);
    if (fs.existsSync(file) && !fs.existsSync(file + '.crdownload')) {
      const size = fs.statSync(file).size;
      if (size > 0 && size === lastSize) return file;
      lastSize = size;
    }
  }
  throw new Error(`Download of ${name} did not finish`);
}

/** Export both CSVs into a fresh folder; returns { definitions, localization } paths. */
async function exportCsvs(page, cdp, appId, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await clickText(page, 'Export Definitions (.csv)');
  const definitions = await waitForDownload(dir, `${appId}-achievements-definitions.csv`);
  await clickText(page, 'Export Localization (.csv)');
  const localization = await waitForDownload(dir, `${appId}-achievements-localization.csv`);
  return { definitions, localization };
}

/** Make sure "Automatically generate unachieved icons" is off: we upload our own locked icons. */
async function autoGrayOff(page) {
  const changed = await page.evaluate(() => {
    // A <div role="checkbox" aria-checked> holding the label text; on by default.
    const box = [...document.querySelectorAll('[role=checkbox]')]
      .find(e => /Automatically generate unachieved icons/.test(e.textContent));
    if (!box) return 'not found';
    if (box.getAttribute('aria-checked') === 'true') { box.click(); return 'turned off'; }
    return 'already off';
  });
  if (changed === 'not found') throw new Error('Could not find "Automatically generate unachieved icons" — Steam would replace our locked icons; stopping');
  await sleep(500);
  const off = await page.evaluate(() => [...document.querySelectorAll('[role=checkbox]')]
    .find(e => /Automatically generate unachieved icons/.test(e.textContent)).getAttribute('aria-checked') !== 'true');
  if (!off) throw new Error('"Automatically generate unachieved icons" would not turn off; stopping');
  console.log(`  "Automatically generate unachieved icons": ${changed}`);
}

/**
 * Upload files through the Bulk Import/Export file input and wait for Steam to
 * finish with them. Anything Steam then asks to confirm (Import / Apply / OK...)
 * is printed and confirmed; Steam's own messages are printed too.
 */
async function uploadFiles(page, files, label) {
  const before = await page.evaluate(() => document.body.innerText);
  const input = await page.$('input[type=file]');
  if (!input) throw new Error('No file input on the Bulk Import/Export tab');
  await input.uploadFile(...files);
  await sleep(3000);
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 60000 }).catch(() => {});
  const confirm = await page.evaluateHandle(() => [...document.querySelectorAll('button')]
    .find(b => b.offsetParent && /^(Import|Apply|Confirm|Upload|Save|OK|Continue)\b/i.test(b.textContent.trim())));
  const btn = confirm.asElement();
  if (btn) {
    console.log(`  Steam asked to confirm: "${(await btn.evaluate(b => b.textContent.trim()))}" — confirming`);
    await btn.click();
    await sleep(3000);
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 60000 }).catch(() => {});
  }
  const after = await page.evaluate(() => document.body.innerText);
  const seen = new Set(before.split('\n').map(s => s.trim()));
  const news = after.split('\n').map(s => s.trim()).filter(s => s && !seen.has(s));
  console.log(`  ${label}: uploaded${news.length ? ` — Steam says: ${news.slice(0, 8).join(' | ')}` : ''}`);
}

/** Rename an API name in place through the inline editor (Manage Achievements). */
async function renameApiName(page, url, from, to) {
  await openAchievements(page, url);
  const filter = await page.$('input[placeholder*="name, description"]');
  await filter.type(from);
  await sleep(2500);
  const edit = (await page.evaluateHandle((api) => {
    const cell = [...document.querySelectorAll('div')].find(e => e.children.length === 0 && e.textContent.trim() === api);
    let row = cell;
    while (row && !row.querySelector('.SVGIcon_Edit')) row = row.parentElement;
    return row ? row.querySelector('.SVGIcon_Edit').closest('button') : null;
  }, from)).asElement();
  if (!edit) throw new Error(`Rename: no row for ${from}`);
  await edit.click();
  await sleep(1500);
  const apiInput = await page.$('input[placeholder="A unique name to be called from the code"]');
  await apiInput.click({ clickCount: 3 });
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(to);
  await clickText(page, 'Save');
  await sleep(3000);
  console.log(`  Renamed ${from} → ${to}`);
}

/** Copy JPG icons to PNGs named the way Bulk Import links them: <API>_ACHIEVED.png / _UNACHIEVED.png. */
async function pngIcons(browser, icons, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
  const out = [];
  for (const { apiName, earned, gray } of icons) {
    for (const [src, suffix] of [[earned, 'ACHIEVED'], [gray, 'UNACHIEVED']]) {
      const b64 = fs.readFileSync(src).toString('base64');
      await page.setContent(`<html><body style="margin:0"><img id="i" src="data:image/jpeg;base64,${b64}" width="256" height="256" style="display:block"></body></html>`);
      await page.waitForFunction(() => document.getElementById('i').complete);
      const file = path.join(dir, `${apiName}_${suffix}.png`);
      await (await page.$('#i')).screenshot({ path: file, type: 'png' });
      out.push(file);
    }
  }
  await page.close();
  return out;
}

// ── Compare code with Steam's export ─────────────────────────────
function plan(code, defs, loc) {
  const codeSet = new Map(code.map(a => [a.apiName, a]));
  const toRename = Object.entries(RENAMED_API_NAMES)
    .filter(([from, to]) => defs.map.has(from) && !defs.map.has(to) && codeSet.has(to))
    .map(([from, to]) => ({ from, to }));
  const renamedFrom = new Set(toRename.map(r => r.from));
  const renamedTo = new Set(toRename.map(r => r.to));
  const toAdd = code.filter(a => !defs.map.has(a.apiName) && !renamedTo.has(a.apiName));
  const stale = [...defs.map.keys()].filter(api => !codeSet.has(api) && !renamedFrom.has(api));
  const onSteam = (a) => (renamedTo.has(a.apiName) ? toRename.find(r => r.to === a.apiName).from : a.apiName);
  const spoilerChanges = code.filter(a => defs.map.has(onSteam(a)) && defs.map.get(onSteam(a)).spoiler !== a.hidden);
  // Steam keeps stray trailing spaces ("Ride 500 meters total "); ignore them.
  const textChanges = code.filter(a => {
    if (toAdd.includes(a)) return true;
    const s = loc.map.get(onSteam(a)) || {};
    return (s.name || '').trim() !== a.displayName.trim() || (s.description || '').trim() !== a.description.trim();
  });
  return { toRename, toAdd, stale, spoilerChanges, textChanges };
}

function printPlan(p, loc) {
  console.log('=== Sync plan ===');
  console.log(`  To add:          ${p.toAdd.length}${p.toAdd.length ? ' — ' + p.toAdd.map(a => a.apiName).join(', ') : ''}`);
  console.log(`  To rename:       ${p.toRename.length}${p.toRename.length ? ' — ' + p.toRename.map(r => `${r.from}→${r.to}`).join(', ') : ''}`);
  console.log(`  Spoiler changes: ${p.spoilerChanges.length}${p.spoilerChanges.length ? ' — ' + p.spoilerChanges.map(a => `${a.apiName}=${a.hidden}`).join(', ') : ''}`);
  console.log(`  Text changes:    ${p.textChanges.length}`);
  for (const a of p.textChanges) {
    const s = loc.map.get(a.apiName);
    if (!s) { console.log(`    + ${a.apiName}: "${a.displayName}" — "${a.description}"`); continue; }
    if ((s.name || '').trim() !== a.displayName.trim()) console.log(`    ${a.apiName} name: "${s.name}" → "${a.displayName}"`);
    if ((s.description || '').trim() !== a.description.trim()) console.log(`    ${a.apiName} description: "${s.description}" → "${a.description}"`);
  }
  if (p.stale.length) {
    console.log(`  On Steam, not in code: ${p.stale.length} — ${p.stale.join(', ')}`);
    console.log('    (never deleted by this script: deleting removes the unlock from every player who earned it;');
    console.log('     if they really should go, delete them in the Steamworks editor with the X on the row)');
  }
  console.log('');
}

const nothingToDo = p => !p.toAdd.length && !p.toRename.length && !p.spoilerChanges.length && !p.textChanges.length;

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  let appId = argv.find(a => /^\d+$/.test(a));
  if (!appId) appId = fs.readFileSync(path.join(__dirname, '..', 'steam_appid.txt'), 'utf-8').trim();
  if (argv.includes('--delete')) {
    console.error('--delete is gone (#775): delete achievements in the Steamworks editor; the sync lists what Steam has and the code lacks.');
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const allowEmpty = argv.includes('--allow-empty');
  const iconsOff = argv.includes('--no-icons');
  const iconsArg = argv.find(a => a === '--icons' || a.startsWith('--icons='));
  const iconsOnly = iconsArg && iconsArg.includes('=') ? new Set(iconsArg.split('=')[1].split(',').map(s => s.trim().toUpperCase())) : null;
  const iconsAll = !!iconsArg;
  const keepOpen = argv.includes('--keep-open');
  const url = `https://partner.steamgames.com/apps/achievements/${appId}`;
  const work = path.join(os.tmpdir(), `tandemonium-steam-sync-${appId}`);

  console.log('=== Steam Achievement Sync (Bulk Import/Export) ===');
  console.log(`App ID: ${appId}${dryRun ? '   DRY RUN — nothing is uploaded' : ''}`);
  const code = await parseAchievementsFromCode();
  console.log(`${code.length} achievements in code.\n`);

  const browser = await puppeteer.launch({
    headless: false, defaultViewport: null, args: ['--start-maximized'], userDataDir: PROFILE_DIR,
  });
  let exitCode = 0;
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    const cdp = await page.createCDPSession();
    await openAchievements(page, url);
    console.log('On the achievements page.');
    await openBulkTab(page);

    const exported = await exportCsvs(page, cdp, appId, path.join(work, 'before'));
    const defs = readDefinitions(exported.definitions);
    const loc = readLocalization(exported.localization);
    console.log(`Steam has ${defs.map.size} achievements (exported to ${path.dirname(exported.definitions)}).\n`);
    if (defs.map.size === 0 && code.length && !allowEmpty) {
      throw new Error('Steam exported 0 achievements. Pass --allow-empty if this app really has none yet.');
    }

    const p = plan(code, defs, loc);
    printPlan(p, loc);
    if (defs.map.size + p.toAdd.length > STEAM_ACHIEVEMENT_CAP) {
      throw new Error(`Adding ${p.toAdd.length} would make ${defs.map.size + p.toAdd.length}, past Steam's cap of ${STEAM_ACHIEVEMENT_CAP}. Delete some in the editor first.`);
    }
    if (dryRun) { console.log('Dry run: stopping here.'); return; }
    if (nothingToDo(p) && !iconsAll) { console.log('Steam already matches the code.'); return; }

    for (const r of p.toRename) await renameApiName(page, url, r.from, r.to);
    if (p.toRename.length) { await openAchievements(page, url); await openBulkTab(page); }

    // Definitions: only new rows and spoiler changes; every other column kept as Steam had it.
    const defRows = [
      ...p.toAdd.map(a => [a.apiName, '', 'Client', String(a.hidden), 'false', '', '0', '0']),
      ...p.spoilerChanges.map(a => { const c = [...defs.map.get(a.apiName).cols]; c[3] = String(a.hidden); return c; }),
    ];
    if (defRows.length) {
      const file = path.join(work, 'upload', `${appId}-achievements-definitions.csv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, writeCsv([defs.header, ...defRows]));
      await uploadFiles(page, [file], `Definitions (${defRows.length} rows)`);
    }

    const locRows = p.textChanges.flatMap(a => [[a.apiName, 'name', a.displayName], [a.apiName, 'description', a.description]]);
    if (locRows.length) {
      const file = path.join(work, 'upload', `${appId}-achievements-localization.csv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, writeCsv([loc.header, ...locRows]));
      await uploadFiles(page, [file], `Localization (${p.textChanges.length} achievements)`);
    }

    const iconFor = iconsOff ? [] : iconsOnly ? code.filter(a => iconsOnly.has(a.apiName)) : iconsAll ? code : p.toAdd;
    if (iconsOnly && iconFor.length !== iconsOnly.size) throw new Error(`--icons names an API name the code lacks: ${[...iconsOnly].filter(n => !code.some(a => a.apiName === n)).join(', ')}`);
    if (iconFor.length) {
      const rendered = await renderIcons(browser, iconFor.map(a => ({ id: a.id, icon: a.icon })));
      const pngs = await pngIcons(browser, rendered.map(r => ({ ...r, apiName: r.id.toUpperCase() })), path.join(work, 'icons'));
      await page.bringToFront();
      await autoGrayOff(page);
      for (let i = 0; i < pngs.length; i += 50) {
        await uploadFiles(page, pngs.slice(i, i + 50), `Icons ${i / 2 + 1}–${Math.min(i + 50, pngs.length) / 2}`);
      }
    }

    // Verify: export again; Steam should now match the code.
    await openAchievements(page, url);
    await openBulkTab(page);
    const again = await exportCsvs(page, cdp, appId, path.join(work, 'after'));
    const left = plan(code, readDefinitions(again.definitions), readLocalization(again.localization));
    if (nothingToDo(left)) {
      console.log(`\nVerified: Steam matches the code (${readDefinitions(again.definitions).map.size} achievements).`);
      console.log('Press Publish in Steamworks to make it live.');
    } else {
      console.error('\nAfter the upload Steam still differs from the code:');
      printPlan(left, readLocalization(again.localization));
      exitCode = 1;
    }
  } catch (e) {
    console.error(`\nERROR: ${e.message}`);
    exitCode = 1;
  } finally {
    if (!keepOpen) await browser.close();
  }
  process.exit(exitCode);
}

if (require.main === module) main();

module.exports = { parseCsv, writeCsv, plan, readDefinitions, readLocalization };
