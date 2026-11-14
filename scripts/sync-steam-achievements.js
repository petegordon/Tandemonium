#!/usr/bin/env node
/**
 * Sync Steam Achievements — Steamworks Bulk Import/Export
 *
 * Reads achievements from js/achievement-defs.js (source of truth, #401), opens
 * Steamworks in a visible browser (the login is kept between runs), then:
 *   1. exports the achievement definitions + localization CSVs
 *      (Stats & Achievements → Achievements → Bulk Import/Export)
 *   2. plans against the code: names, descriptions, Hidden (= spoiler), new achievements
 *   3. writes corrected CSVs to steam/achievement-sync/ and uploads them, plus the
 *      earned + locked icons for new achievements (--icons: every achievement)
 *   4. checks Steamworks' Pending Changes, presses Save, re-exports and confirms
 *      nothing is left to change
 *
 * Valve replaced the old achievements table in Nov 2026; the row-by-row editor
 * this script used to drive is gone, and CSV import is the supported route.
 *
 * Not done by import, so the script only reports them for a person to handle:
 *   - achievements on Steamworks that the code no longer has (deleting takes the
 *     unlock away from every player who earned it)
 *   - API renames (RENAMED_API_NAMES, #575): importing would add a second, empty
 *     achievement, so the script stops instead
 * Steam caps an app at 100 achievements; the script stops before adding past it.
 *
 * Usage:
 *   node scripts/sync-steam-achievements.js [appId] [--dry-run] [--icons] [--no-icons] [--headless] [--self-test [API_NAME]]
 *
 * --self-test [API_NAME] (default FIRST_500M): changes that achievement's description,
 * syncs and verifies, then syncs the real text back and verifies again. Proves the
 * whole upload → Save → verify path; nothing reaches players without Publish.
 *
 * Default appId: steam_appid.txt. 4510250 = playtest, 4482940 = main game.
 * Nothing is live until someone presses Publish in Steamworks.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { renderIcons } = require('./achievement-icons');
const { parseCsv, toCsv, planSync } = require('./lib/steam-achievement-csv.cjs');

const STEAM_ACHIEVEMENT_CAP = 100;

// #575 · API names renamed in code (old → new; js/achievement-defs.js RENAMED_IDS
// in upper case). Import can't rename, so a pending one stops the sync.
const RENAMED_API_NAMES = { TODAYS_LAUNCH: 'DAILY_LAUNCH' };

const OUT_DIR = path.join(__dirname, '..', 'steam', 'achievement-sync');
const PROFILE_DIR = path.join(os.homedir(), '.tandemonium-steamworks-profile');

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

// ── Steamworks page helpers ──────────────────────────────────────

const onAchievementsPage = async (page) =>
  /^Achievements:/.test(await page.title().catch(() => ''));

/**
 * Wait for a signed-in achievements page. The login form is left alone while
 * someone types: the page is only re-opened when the browser has clearly left
 * the sign-in flow (a Steamworks page that isn't the achievements one), and no
 * more than once every 20 s.
 */
async function ensureSignedIn(page, url, timeoutMs = 300000) {
  if (await onAchievementsPage(page)) return true;
  console.log('Not signed in — please sign in to Steamworks in the browser window (QR code or password)...');
  const btn = await page.$('button#login_btn_signin').catch(() => null);
  if (btn) await btn.click().catch(() => {});
  const start = Date.now();
  let lastNav = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    if (await onAchievementsPage(page)) return true;
    const u = page.url();
    const inLogin = /login|openid|steamcommunity|store\.steampowered/i.test(u);
    if (!inLogin && /partner\.steamgames\.com/.test(u) && Date.now() - lastNav > 20000) {
      lastNav = Date.now();
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    }
  }
  return false;
}

async function openBulkPanel(page) {
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => {
      const tab = [...document.querySelectorAll('div,a,button')].find(e => e.textContent.trim() === 'Bulk Import/Export');
      if (!tab) return false;
      tab.click();
      return true;
    });
    if (ok) {
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.innerText.trim() === 'Export Definitions (.csv)'), { timeout: 15000 });
      return;
    }
    await sleep(1000);
  }
  throw new Error('Could not find the Bulk Import/Export tab — has the Steamworks page changed again?');
}

async function clickButton(page, label) {
  const ok = await page.evaluate(l => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === l);
    if (b) b.click();
    return !!b;
  }, label);
  if (!ok) throw new Error(`No "${label}" button on the page`);
}

/** Download one export into dir and return its text. */
async function exportCsv(page, dir, label, name) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  await clickButton(page, label);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (fs.existsSync(file) && !fs.existsSync(file + '.crdownload') && fs.statSync(file).size > 0) {
      await sleep(300);
      return fs.readFileSync(file, 'utf-8');
    }
  }
  throw new Error(`Export "${label}" did not download ${name}`);
}

async function exportBoth(page, cdp, appId) {
  const dir = path.join(OUT_DIR, 'export');
  fs.mkdirSync(dir, { recursive: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  const defs = await exportCsv(page, dir, 'Export Definitions (.csv)', `${appId}-achievements-definitions.csv`);
  const loc = await exportCsv(page, dir, 'Export Localization (.csv)', `${appId}-achievements-localization.csv`);
  return { defRows: parseCsv(defs), locRows: parseCsv(loc) };
}

/** Steam wants PNGs named <API>_ACHIEVED.png / <API>_UNACHIEVED.png; ours render as JPG. */
async function iconPngs(browser, achievements) {
  const dir = path.join(OUT_DIR, 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const files = await renderIcons(browser, achievements.map(a => ({ id: a.id, icon: a.icon })));
  const page = await browser.newPage();
  const out = [];
  for (const f of files) {
    const api = f.id.toUpperCase();
    for (const [src, suffix] of [[f.earned, 'ACHIEVED'], [f.gray, 'UNACHIEVED']]) {
      const dest = path.join(dir, `${api}_${suffix}.png`);
      const b64 = fs.readFileSync(src).toString('base64');
      await page.setViewport({ width: 256, height: 256 });
      await page.setContent(`<body style="margin:0"><img id="i" src="data:image/jpeg;base64,${b64}" style="display:block;width:256px;height:256px"></body>`);
      await page.waitForFunction(() => document.getElementById('i').complete);
      await (await page.$('#i')).screenshot({ path: dest, type: 'png' });
      out.push(dest);
    }
  }
  await page.close();
  return out;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  let appId = process.argv.find(a => /^\d+$/.test(a));
  if (!appId) {
    try {
      appId = fs.readFileSync(path.join(__dirname, '..', 'steam_appid.txt'), 'utf-8').trim();
      console.log(`Read app ID ${appId} from steam_appid.txt`);
    } catch (e) {
      console.error('No app ID provided and steam_appid.txt not found.');
      console.error('Usage: node scripts/sync-steam-achievements.js [appId] [--dry-run] [--icons] [--no-icons] [--headless] [--self-test [API_NAME]]');
      process.exit(1);
    }
  }
  const url = `https://partner.steamgames.com/apps/achievements/${appId}`;
  const dryRun = process.argv.includes('--dry-run');
  const iconsOff = process.argv.includes('--no-icons');
  const stIdx = process.argv.indexOf('--self-test');
  const selfTest = stIdx < 0 ? null
    : (/^[A-Z0-9_]+$/.test(process.argv[stIdx + 1] || '') ? process.argv[stIdx + 1] : 'FIRST_500M');
  if (selfTest && process.argv.includes('--dry-run')) { console.error('--self-test and --dry-run do not mix.'); process.exit(1); }
  const iconsAll = process.argv.includes('--icons');
  const headless = process.argv.includes('--headless');   // only works once the saved login is good

  console.log('=== Steam Achievement Sync ===');
  console.log(`App ID: ${appId}`);
  if (dryRun) console.log('DRY RUN — nothing is uploaded');
  console.log('');

  const code = await parseAchievementsFromCode();
  console.log(`Found ${code.length} achievements in code.`);
  if (code.length > STEAM_ACHIEVEMENT_CAP) {
    console.error(`Code defines ${code.length}; Steam allows ${STEAM_ACHIEVEMENT_CAP} per app. Nothing changed.`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless, defaultViewport: null, args: ['--start-maximized'], userDataDir: PROFILE_DIR,
  });
  const fail = async (msg) => { console.error(msg); await browser.close(); process.exit(1); };
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    const cdp = await page.createCDPSession();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!await ensureSignedIn(page, url)) await fail('Not signed in after 5 minutes. Nothing changed.');

    // One full pass: export, plan, upload, save, verify. Returns 'in-sync' | 'dry-run' | 'saved'.
    const runSync = async (code, iconsOff) => {
    await openBulkPanel(page);
    const before = await exportBoth(page, cdp, appId);
    const onSteam = before.defRows.length - 1;
    console.log(`Steamworks has ${onSteam} achievements.`);
    if (onSteam === 0 && code.length > 0 && !process.argv.includes('--allow-empty')) {
      await fail('The export came back empty — not trusting it (pass --allow-empty for a brand-new app). Nothing changed.');
    }

    const plan = planSync(code, before.defRows, before.locRows, { renames: RENAMED_API_NAMES });
    const after = onSteam + plan.add.length;
    console.log('');
    console.log('=== Sync Plan ===');
    console.log(`  To add:    ${plan.add.length}`);
    console.log(`  To update: ${plan.update.length} (name / description / hidden)`);
    console.log(`  Not in code (left alone): ${plan.remove.length}`);
    for (const a of plan.add) console.log(`  + ${a.apiName} "${a.displayName}" — ${a.description}${a.hidden ? ' [hidden]' : ''}`);
    for (const u of plan.update) console.log(`  ~ ${u.apiName}: ${u.parts.join('; ')}`);
    for (const r of plan.remove) console.log(`  - ${r.apiName} "${r.displayName}" (delete by hand in Steamworks if it should go)`);
    console.log('');

    if (plan.renamed.length) {
      await fail(`Pending API rename(s): ${plan.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}.\n`
        + 'Import cannot rename; it would add an empty second achievement. Rename it by hand in Steamworks, then re-run. Nothing changed.');
    }
    if (after > STEAM_ACHIEVEMENT_CAP) {
      await fail(`That would make ${after} achievements; the cap is ${STEAM_ACHIEVEMENT_CAP}. Delete the old ones by hand first. Nothing changed.`);
    }

    const iconList = iconsOff ? [] : (iconsAll ? code : plan.add);
    if (!plan.defsChanged && !plan.locChanged && iconList.length === 0) {
      console.log('Everything is in sync. Nothing to do.');
      return 'in-sync';
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const uploads = [];
    if (plan.defsChanged) {
      const f = path.join(OUT_DIR, `${appId}-achievements-definitions.csv`);
      fs.writeFileSync(f, toCsv(plan.defRows));
      uploads.push(f);
    }
    if (plan.locChanged) {
      const f = path.join(OUT_DIR, `${appId}-achievements-localization.csv`);
      fs.writeFileSync(f, toCsv(plan.locRows));
      uploads.push(f);
    }
    if (iconList.length) {
      console.log(`Rendering icons for ${iconList.length} achievements...`);
      uploads.push(...await iconPngs(browser, iconList));
    }
    console.log(`Files ready in ${OUT_DIR} (${uploads.length}).`);

    if (dryRun) {
      console.log('DRY RUN complete. Run without --dry-run to upload and save.');
      return 'dry-run';
    }

    console.log('Uploading...');
    const input = await page.$('input[type=file][name=upload]');
    if (!input) await fail('No upload field on the Bulk Import/Export panel. Nothing changed.');
    await input.uploadFile(...uploads);
    const n = uploads.length;
    try {
      await page.waitForFunction(k => new RegExp(`Successful \\(${k} files?\\)`).test(document.body.innerText), { timeout: 60000 }, n);
    } catch (e) {
      const t = await page.evaluate(() => document.body.innerText);
      const i = t.indexOf('Uploaded Files');
      await fail(`Steamworks did not accept every file:\n${t.slice(i, i + 1500)}\nNothing saved — the browser's pending changes are discarded.`);
    }
    const pending = await page.evaluate(() => {
      const t = document.body.innerText;
      return [...t.matchAll(/^(To [A-Z][a-z]+(?: [a-z]+)*|Unmodified) \((\d+)\)$/gm)].map(m => `${m[1]} (${m[2]})`);
    });
    console.log(`Pending changes: ${pending.join(', ') || '(none listed)'}`);
    if (/To Delete \(|To Remove \(/.test(pending.join(' '))) {
      await fail('Steamworks wants to delete achievements — the sync never does that. Nothing saved.');
    }

    await clickButton(page, 'Save');
    await page.waitForFunction(() => !/Pending Changes/.test(document.body.innerText) || /saved|success/i.test(document.body.innerText), { timeout: 60000 }).catch(() => {});
    await sleep(3000);

    // Confirm from a fresh export.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await openBulkPanel(page);
    const check = planSync(code, ...Object.values(await exportBoth(page, cdp, appId)));
    if (check.add.length || check.update.length) {
      await fail(`Saved, but Steamworks still differs:\n${[...check.add.map(a => `  + ${a.apiName}`), ...check.update.map(u => `  ~ ${u.apiName}: ${u.parts.join('; ')}`)].join('\n')}`);
    }
    console.log('Saved and verified.');
    return 'saved';
    };

    if (!selfTest) {
      const r = await runSync(code, iconsOff);
      if (r === 'saved') console.log('\nPress Publish in Steamworks to make it live.');
    } else {
      // --self-test: prove upload + Save + verify end to end without touching what players see.
      // Change one description, sync, then sync the real text back. Nothing goes live without Publish.
      const target = code.find(a => a.apiName === selfTest);
      if (!target) await fail(`--self-test: no achievement ${selfTest} in code.`);
      const marked = code.map(a => a === target ? { ...a, description: `${a.description} [sync test]` } : a);
      console.log(`\n=== Self-test 1/2: mark ${target.apiName}'s description ===`);
      const r1 = await runSync(marked, true);
      if (r1 !== 'saved') await fail(`Self-test FAILED: step 1 returned ${r1}, expected saved.`);
      console.log(`\n=== Self-test 2/2: put ${target.apiName} back ===`);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      const r2 = await runSync(code, true);
      if (r2 !== 'saved') await fail(`Self-test FAILED: step 2 returned ${r2}, expected saved. ${target.apiName} may still say "[sync test]" — re-run the sync.`);
      console.log('\nSelf-test PASSED: upload, Save and verify all work. Steamworks is back to matching the code.');
    }
    await browser.close();
  } catch (e) {
    await fail(`Fatal error: ${e && e.stack || e}`);
  }
}

main();
