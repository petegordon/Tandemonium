// Generates index.html for the Tandemonium screen-flow review.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));

const S = {
  'boot-electron-gate': 'First launch (desktop app)', 'boot-browser-gate': 'First launch (browser)',
  'lobby-mode': 'Mode select', 'lobby-mode-d4': 'D-pad ↓ past the last button',
  'lobby-help': 'Help', 'lobby-leaderboard': 'Leaderboard', 'lobby-profile': 'Profile (signed out)',
  'lobby-settings': 'Settings', 'lobby-phone': 'Phone as controller', 'lobby-garage': 'Garage',
  'lobby-garage-closed': 'Garage after ◯', 'lobby-credits': '© Credits',
  'first-solo-click': 'First-time SOLO: tutorial starts', 'first-solo-6s': 'Tutorial ride',
  'first-tut-complete': 'Tutorial complete', 'solo-level': 'Level select', 'solo-start': 'Countdown',
  'solo-playing': 'Riding (HUD)', 'solo-pause-options': 'Start button mid-ride', 'solo-gameover': 'Game over',
  'solo-victory': 'Victory', 'solo-demo-end': 'Demo end', 'solo-disconnect': 'Partner left',
  'mp-role': 'Choose your seat', 'mp-host': 'Captain: room code', 'mp-join': 'Stoker: enter code',
  'mp-room': 'Room (no partner yet)', 'coop-host-3pads': 'Captain with 3 controllers',
  'vs-v4-empty': 'Versus: before anyone joins', 'vs-v4-j4': 'Versus: 4 seated', 'vs-v4-level': 'Versus level select',
  'vs-v4-race': 'Versus 2v2 split screen', 'vs-v4-results': 'Versus results', 'vs-v2-race': 'Versus 1v1',
  'hot-unplug': 'Controller unplugged mid-ride', 'web-mode': 'Browser: mode select', 'web-versus': 'Browser: versus',
  'join-puck-join': 'Join code: Steam Controller', 'join-switch-join': 'Join code: Switch Pro',
  'join-supernova-join': 'Join code: Super Nova', 'join-xbox-join': 'Join code: Xbox',
  'join-puck-mode-a': 'Mode select: Steam Controller', 'join-switch-role': 'Seat: Switch Pro',
  'join-supernova-role': 'Seat: Super Nova', 'join-xbox-role': 'Seat: Xbox',
};

// Lanes: [label, sub, nodes]; a node is [screenId, edgeLabelLeadingIntoIt]
const LANES = [
  ['Start', 'Every path begins here', [['boot-electron-gate', ''], ['lobby-mode', 'any button'],
    ['lobby-help', '? toggle'], ['lobby-leaderboard', '☆ toggle'], ['lobby-profile', 'profile toggle'],
    ['lobby-settings', '⚙ footer'], ['lobby-phone', 'Phone as controller'], ['lobby-garage', 'GARAGE']]],
  ['Solo, first time', 'No tutorial on record', [['lobby-mode', ''], ['first-solo-click', 'SOLO RIDE'],
    ['first-solo-6s', 'auto countdown'], ['first-tut-complete', 'finish tutorial'], ['solo-level', 'NEXT: GRANDMA’S / LOBBY']]],
  ['Solo ride', 'Returning player', [['lobby-mode', ''], ['solo-level', 'SOLO RIDE'], ['solo-start', 'START RIDE'],
    ['solo-playing', 'GO!'], ['solo-pause-options', 'Start button'], ['solo-gameover', 'crash'],
    ['solo-victory', 'finish'], ['solo-demo-end', 'demo limit']]],
  ['Ride together (online)', 'Captain hosts, stoker joins by code', [['lobby-mode', ''], ['mp-role', 'RIDE TOGETHER'],
    ['mp-host', 'START A RIDE'], ['mp-join', 'JOIN A RIDE'], ['mp-room', 'partner connects'], ['solo-level', 'PLAY GAME'],
    ['solo-disconnect', 'partner drops']]],
  ['Local co-op', 'Second controller on the same screen', [['mp-role', ''], ['coop-host-3pads', 'START A RIDE'], ['solo-level', 'JOIN AS PLAYER 2']]],
  ['Versus', '2–4 players, split screen', [['mp-role', ''], ['vs-v4-empty', 'VERSUS'], ['vs-v4-j4', 'each presses A'],
    ['vs-v4-level', 'CHOOSE LEVEL'], ['vs-v4-race', 'START RIDE'], ['vs-v4-results', 'finish']]],
];

const SEV = { high: 'High', med: 'Medium', low: 'Low' };
const F = [
  ['high', ['tv', 'bug'], 'Level select puts START RIDE below the screen and keeps focus on it',
    'At 1920×1080 the level list is 1345px tall. Difficulty sits at y=1069 and START RIDE at y=1218, both below the fold. START RIDE holds controller focus anyway, so the player sees no highlight. D-pad ↓ didn’t move focus or scroll. Same in versus.',
    'Fit the step to the screen. Put cards in a row or grid on wide screens, and keep difficulty and START RIDE in a fixed action bar. Scroll the focused item into view.', ['solo-level', 'vs-v4-level']],
  ['high', ['bug', 'controller'], 'Versus: the last player to join becomes Player 1',
    'With several controllers connected at launch, the game leaves P1 empty on purpose. In versus the DualSense pressed ✕ first and was seated as P2, then the Steam Controller P3 and the Switch Pro P4. The Super Nova pressed last and filled the empty P1 seat.',
    'Seat players in join order: first ✕/A is Player 1. Check on real hardware; this ran with simulated pads.', ['vs-v4-j4']],
  ['high', ['tv', 'bug', 'controller'], 'Captain screen breaks with 2+ controllers',
    'With DualSense, Switch Pro and Steam Controller connected: the room code is drawn over the bike preview, and the three JOIN AS PLAYER 2 buttons run under the footer. It says “Player 1: —” and “2nd controller detected!” with three connected. The join buttons use the danger red.',
    'Use the versus controllers list here too, with the same seat states. Name the captain’s controller, and give joining the positive (accent) style.', ['coop-host-3pads', 'mp-host']],
  ['high', ['tv', 'controller'], 'Versus join instructions are unreadable',
    'The hint under the teams is 9.9px black text on the dark card. It also hard-codes “Press A … B leave your seat” whatever controller P1 holds (✕/◯ on a DualSense). Team titles are 12px.',
    'Make this the step’s main instruction, at full size, with the controller’s real glyphs.', ['vs-v4-j4', 'vs-v4-empty']],
  ['high', ['bug', 'inconsistency'], 'The Back hint overlaps other controls',
    '“◯ Back” is positioned on its own and lands on top of whatever sits there: JOIN AS PLAYER 2 on the captain screen, the P4 row in versus, CHOOSE LEVEL in the browser versus, and the footer in the room.',
    'Give every step one footer row for its Back/hint, laid out with the step, not absolutely positioned.', ['mp-host', 'vs-v4-j4', 'web-versus', 'mp-room']],
  ['high', ['flow'], 'First-time SOLO drops straight into the tutorial',
    'A player with no tutorial on record who presses SOLO RIDE lands in a 3-2-1 countdown with no screen saying what’s happening. SKIP TUTORIAL is small, top-right, and shows no button glyph. A returning player gets level select instead, so the same button does two different things.',
    'Show level select with the Tutorial card focused and labelled “Start here”. Or show one short interstitial (“First ride: a 60-second tutorial · ✕ Start · ◯ Skip”).', ['first-solo-click', 'solo-level']],
  ['high', ['controller', 'flow'], 'Unplugging the controller mid-ride does nothing',
    'The DualSense was removed during a solo ride. The ride kept going with no pause and no “Reconnect your controller” prompt. Plugging it back in also showed nothing.',
    'Pause and show a reconnect overlay naming the seat and controller. Resume on any button from that controller.', ['hot-unplug']],
  ['med', ['tv'], 'Type is too small for a TV, and the footer is the biggest text',
    'Main buttons are 18px, card descriptions and hints 10–14px, end-screen buttons smaller still. The footer credits are 35px and the version label 29px, the largest text on the lobby. The Tandemonium logo and subtitle are hidden at this resolution.',
    'Set a 10-foot type scale (body ≥ 24px at 1080p, primary actions ≥ 28px). Shrink the footer, and bring the logo back in place of the bike name.', ['lobby-mode', 'solo-gameover', 'vs-v4-j4']],
  ['med', ['tv', 'inconsistency'], 'Lobby is a narrow phone-style column on a 16:9 screen',
    'Every lobby step shares one ~970px column under a bike preview that takes ~45% of the height. The side art is decoration only. Steps that need room (level select, captain, versus) overflow because they compete with the carousel.',
    'On wide screens, show the bike on one side and the step on the other. Or hide the carousel on steps that aren’t about the bike.', ['lobby-mode', 'vs-v4-j4', 'coop-host-3pads']],
  ['med', ['inconsistency', 'controller'], 'Initial focus lands somewhere different on every step',
    'Captain, room and versus all open with focus on the Help “?” toggle. Level select focuses the off-screen START RIDE. Game over focuses SAVE CLIP instead of RESTART. The focus ring on round toggles is about twice as thick as on buttons.',
    'One rule: focus the step’s primary action. One focus-ring style for every focusable.', ['mp-host', 'mp-room', 'vs-v4-j4', 'solo-gameover']],
  ['med', ['inconsistency', 'controller'], '◯ closes every popup except the Garage',
    'Help, leaderboard, profile, settings, phone and credits all closed on ◯. The Garage stayed open. It also uses its own small centered layout over the 3D scene, unlike every other screen.',
    'Treat the Garage as a step or a sheet with the shared Back behaviour.', ['lobby-garage', 'lobby-garage-closed']],
  ['med', ['flow', 'controller'], 'Start opens Settings, not a pause menu',
    'Start (Options on a DualSense) mid-ride opened the Settings list over the running ride. No Resume / Restart / End ride menu appeared, and Create/View did nothing visible.',
    'Map Start to a pause menu: Resume, Restart, Settings, End ride. Pause the ride while it’s open in solo.', ['solo-pause-options']],
  ['med', ['controller', 'inconsistency'], 'Button glyphs are right for DualSense and Xbox only',
    'DualSense shows ✕/◯ and Xbox shows A/B. Switch Pro and the Steam Controller fall back to a generic 4-dot diamond, though the Steam Controller has A/B printed on it. The ride hint says “alternate LB and RB (or LT/RT)” even with a DualSense (L1/R1). The Super Nova shows ✕/◯ because in DS4 mode it reports as a DualShock 4; it can’t be told apart.',
    'One glyph component fed by the controller registry, with Steam Controller → A/B and Switch → B/A-position glyphs. Use it in every hint.', ['join-puck-join', 'join-switch-join', 'mp-join', 'join-xbox-join', 'solo-playing']],
  ['med', ['controller', 'bug'], 'The Puck’s Steam Controller is labelled “Direct USB-C”',
    'In the versus controllers list and the captain join buttons, a Steam Controller connected through the Puck (28de:1304) reads “STEAM CONTROLLER 2026 (DIRECT USB-C)”, the name of the 28de:1302 entry.',
    'Name it from the WebHID product id, not the shared gamepad-id pattern.', ['vs-v4-j4', 'coop-host-3pads']],
  ['med', ['inconsistency', 'tv'], 'End screens each lay out their actions differently',
    'Game over puts five differently styled buttons in one row (SAVE CLIP, RESTART, END RIDE, GARAGE →, SEND A LINK…). Victory splits a giant headline from small stacked buttons. Tutorial complete puts a Steam store widget between the results and its buttons. Demo end and Partner left use tiny centered buttons.',
    'One result-screen layout: headline, stats, then one action bar with the same order and the primary action first.', ['solo-gameover', 'solo-victory', 'first-tut-complete', 'solo-demo-end', 'solo-disconnect', 'vs-v4-results']],
  ['med', ['flow'], 'Desktop app first launch says “Loading…” after loading',
    'In the desktop app the first-launch veil keeps saying “Loading Tandemonium…” once loading is done. It waits for a button press but never asks for one.',
    'Switch the label to “Press any button” (with the glyph) when boot completes.', ['boot-electron-gate', 'boot-browser-gate']],
  ['low', ['inconsistency'], 'Version label is hard-coded and stale',
    'The footer reads “v.351-versus | 07-02-2026” straight from index.html. There is no version.json, so it no longer matches what’s running.',
    'Generate it at build time, or hide it behind the ⚙ settings.', ['lobby-mode']],
  ['low', ['inconsistency'], '© opens the Help modal',
    'The © button in the footer opens the same Help modal as “?”.',
    'Scroll to a credits section, or drop the button.', ['lobby-credits', 'lobby-help']],
  ['low', ['tv'], 'Profile popup and room seats are cramped',
    'The signed-out profile popup sits over the carousel and the left toggles. In the room, empty seats are black boxes with tiny labels, and PLAY GAME uses a bigger font than other accent buttons.',
    'Same sheet shell as the other popups; seats at TV size.', ['lobby-profile', 'mp-room']],
];
const CATS = { tv: 'TV readability', bug: 'Bug', controller: 'Controllers', inconsistency: 'Inconsistency', flow: 'Flow' };

const refs = {};
F.forEach((f, i) => f[5].forEach((id) => { (refs[id] ||= []).push({ i, sev: f[0] }); }));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const worst = (id) => (refs[id] || []).reduce((w, r) => (w === 'high' || r.sev === 'high' ? 'high' : w === 'med' || r.sev === 'med' ? 'med' : 'low'), null);

const node = (id) => {
  const w = worst(id);
  const n = (refs[id] || []).length;
  return `<button class="node" data-shot="${id}" type="button" aria-label="Open ${esc(S[id])}">
    <img src="img/${id}.jpg" alt="${esc(S[id])}" loading="lazy" width="288" height="162">
    <span class="node-cap"><span>${esc(S[id])}</span>${w ? `<span class="flag flag-${w}" title="${n} finding${n > 1 ? 's' : ''}">${n}</span>` : ''}</span></button>`;
};
const lanes = LANES.map(([label, sub, nodes]) => `<section class="lane"><header class="lane-head"><h3>${label}</h3><p>${sub}</p></header>
  <div class="lane-track">${nodes.map(([id, edge], k) => `${k ? `<div class="edge"><span>${esc(edge)}</span></div>` : ''}${node(id)}`).join('')}</div></section>`).join('\n');

const PADS = [
  ['DualSense', 'Gamepad API', 'SONY DUALSENSE', '✕', '◯', 'mp-join', 'ok'],
  ['Steam Controller (Puck)', 'WebHID 28de:1304', 'STEAM CONTROLLER 2026 (DIRECT USB-C)', '4-dot diamond', '4-dot diamond', 'join-puck-join', 'bad'],
  ['Switch Pro', 'Gamepad API', 'NINTENDO SWITCH PRO', '4-dot diamond', '4-dot diamond', 'join-switch-join', 'warn'],
  ['GameSir Super Nova', 'Gamepad API (DS4 mode)', 'SONY DUALSHOCK 4 V2', '✕', '◯', 'join-supernova-join', 'warn'],
  ['Xbox', 'Gamepad API', 'XBOX SERIES X|S', 'A', 'B', 'join-xbox-join', 'ok'],
];
const padRows = PADS.map(([n, via, shown, c, b, shot, st]) => `<tr><th scope="row">${n}<small>${via}</small></th><td class="mono">${esc(shown)}</td><td>${c}</td><td>${b}</td><td><span class="chip chip-${st}">${st === 'ok' ? 'Correct' : st === 'warn' ? 'Generic' : 'Wrong'}</span></td><td>${node(shot)}</td></tr>`).join('');

const findings = F.map(([sev, cats, title, saw, fix, shots], i) => `<article class="finding" id="f${i + 1}" data-cats="${cats.join(' ')}">
  <div class="finding-head"><span class="sev sev-${sev}">${SEV[sev]}</span><h3><span class="fnum">${i + 1}</span>${esc(title)}</h3></div>
  <div class="finding-tags">${cats.map((c) => `<span class="tag">${CATS[c]}</span>`).join('')}</div>
  <p>${esc(saw)}</p><p class="fix"><b>Direction</b> ${esc(fix)}</p>
  <div class="finding-shots">${shots.map((id) => `<button class="mini" type="button" data-shot="${id}"><img src="img/${id}.jpg" alt="" loading="lazy" width="128" height="72"><span>${esc(S[id])}</span></button>`).join('')}</div></article>`).join('\n');

const counts = { high: 0, med: 0, low: 0 }; F.forEach((f) => counts[f[0]]++);

const html = `<title>Tandemonium Screen Flow Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a field report. Header + summary, then horizontally scrolling flow lanes of real screenshots, then the controller matrix, findings and reuse plan. Brass accent from the tandem's fittings. */
:root{
  --bg:#eef0ec; --surface:#fbfcfa; --sunk:#e3e6e0; --fg:#1b221e; --muted:#5b665f; --line:#cdd3cb;
  --accent:#8a5a14; --accent-ink:#fff;
  --high:#b3361f; --med:#a36a12; --low:#56656c; --ok:#2f7a45;
  --high-bg:#f6dfd9; --med-bg:#f5e8cf; --low-bg:#e2e7e9; --ok-bg:#dcefe1;
  --f-display:"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif;
  --f-body:"IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --f-mono:"IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#121614; --surface:#1a201d; --sunk:#232a26; --fg:#e4e9e5; --muted:#9aa69e; --line:#2f3833;
  --accent:#d9a650; --accent-ink:#1a1408;
  --high:#ef7a62; --med:#e0aa52; --low:#98a9b0; --ok:#6cc488;
  --high-bg:#3a1f19; --med-bg:#362a14; --low-bg:#242c30; --ok-bg:#1b3223; color-scheme:dark }}
:root[data-theme="dark"]{
  --bg:#121614; --surface:#1a201d; --sunk:#232a26; --fg:#e4e9e5; --muted:#9aa69e; --line:#2f3833;
  --accent:#d9a650; --accent-ink:#1a1408;
  --high:#ef7a62; --med:#e0aa52; --low:#98a9b0; --ok:#6cc488;
  --high-bg:#3a1f19; --med-bg:#362a14; --low-bg:#242c30; --ok-bg:#1b3223; color-scheme:dark }
*{box-sizing:border-box}
body{background:var(--bg);color:var(--fg);font:16px/1.55 var(--f-body);
  padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:32px 64px}
.wrap{max-width:1180px;margin:0 auto;display:flex;flex-direction:column;gap:56px}
h1,h2,h3{font-family:var(--f-display);text-wrap:balance;margin:0;line-height:1.15}
h1{font-size:clamp(2rem,4.5vw,3.1rem);font-weight:700;letter-spacing:-.01em}
h2{font-size:1.65rem;font-weight:700}
h3{font-size:1.08rem;font-weight:700}
p{margin:0}
.eyebrow{font:500 .78rem var(--f-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.mono{font-family:var(--f-mono);font-size:.82rem}
header.top{display:flex;flex-direction:column;gap:14px}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:.9rem}
.meta b{color:var(--fg);font-weight:600}
.lede{max-width:68ch;font-size:1.08rem}
.tally{display:flex;flex-wrap:wrap;gap:10px}
.tally a{display:flex;gap:10px;align-items:baseline;padding:10px 16px;border-radius:10px;background:var(--surface);border:1px solid var(--line);color:inherit;text-decoration:none}
.tally strong{font:700 1.6rem var(--f-display);font-variant-numeric:tabular-nums}
.tally .t-high strong{color:var(--high)} .tally .t-med strong{color:var(--med)} .tally .t-low strong{color:var(--low)}
.sec-head{display:flex;flex-direction:column;gap:8px;margin-bottom:18px}
.sec-head p{color:var(--muted);max-width:72ch}
/* flow lanes */
.lanes{display:flex;flex-direction:column;gap:22px}
.lane{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 0 18px}
.lane-head{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap;padding:0 18px 12px}
.lane-head p{color:var(--muted);font-size:.9rem}
.lane-track{display:flex;align-items:center;overflow-x:auto;padding:4px 18px 8px;scrollbar-width:thin}
.node{flex:0 0 auto;width:232px;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--sunk);cursor:zoom-in;color:inherit;font:inherit;text-align:left;overflow:hidden}
.node img{display:block;width:100%;height:auto;aspect-ratio:16/9;object-fit:cover}
.node-cap{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;font-size:.84rem;font-weight:500}
.node:hover,.node:focus-visible{border-color:var(--accent);outline:none;box-shadow:0 0 0 2px var(--accent)}
.flag{flex:0 0 auto;min-width:22px;height:22px;border-radius:11px;display:grid;place-items:center;font:600 .75rem var(--f-mono);color:var(--surface)}
.flag-high{background:var(--high)} .flag-med{background:var(--med)} .flag-low{background:var(--low)}
.edge{flex:0 0 auto;width:112px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:0 6px;position:relative}
.edge::before{content:"";display:block;width:100%;height:2px;background:var(--accent);
  mask:linear-gradient(90deg,#000 0 calc(100% - 9px),transparent 0)}
.edge::after{content:"";position:absolute;right:4px;top:-5px;border:6px solid transparent;border-left:9px solid var(--accent)}
.edge span{order:-1;font:500 .72rem/1.25 var(--f-mono);color:var(--muted);text-align:center;text-wrap:balance}
/* matrix */
.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
table{border-collapse:collapse;width:100%;min-width:860px}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
thead th{font:600 .75rem var(--f-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
tbody th{font-weight:600}
tbody th small{display:block;font:400 .78rem var(--f-mono);color:var(--muted)}
td .node{width:176px}
.chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.78rem;font-weight:600;white-space:nowrap}
.chip-ok{background:var(--ok-bg);color:var(--ok)} .chip-warn{background:var(--med-bg);color:var(--med)} .chip-bad{background:var(--high-bg);color:var(--high)}
/* findings */
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.filters button{font:500 .86rem var(--f-body);padding:6px 13px;border-radius:999px;border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer}
.filters button[aria-pressed="true"]{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.filters button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.findings{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:14px}
.finding{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:10px;min-width:0}
.finding-head{display:flex;gap:10px;align-items:flex-start}
.fnum{font:500 .8rem var(--f-mono);color:var(--muted);margin-right:8px}
.sev{flex:0 0 auto;font:600 .72rem var(--f-mono);text-transform:uppercase;letter-spacing:.06em;padding:3px 8px;border-radius:6px;margin-top:1px}
.sev-high{background:var(--high-bg);color:var(--high)} .sev-med{background:var(--med-bg);color:var(--med)} .sev-low{background:var(--low-bg);color:var(--low)}
.finding-tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:.74rem;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.finding p{font-size:.95rem}
.fix{color:var(--muted)} .fix b{color:var(--accent);font-weight:600;margin-right:4px}
.finding-shots{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.mini{display:flex;flex-direction:column;gap:3px;width:128px;padding:0;border:0;background:none;color:var(--muted);font:500 .72rem var(--f-body);text-align:left;cursor:zoom-in}
.mini img{width:128px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--line)}
.mini:hover img,.mini:focus-visible img{outline:2px solid var(--accent)}
.mini:focus-visible{outline:none}
/* reuse */
.reuse{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:8px;min-width:0}
.card ul{margin:0;padding-left:18px;color:var(--muted);font-size:.92rem}
.card .mono{color:var(--accent)}
.inventory{display:flex;flex-wrap:wrap;gap:6px}
.inventory span{font:400 .78rem var(--f-mono);background:var(--sunk);border-radius:6px;padding:2px 8px}
.inventory span b{color:var(--accent);font-weight:500}
.keep{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;padding:0;margin:0;list-style:none}
.keep li{background:var(--ok-bg);color:var(--fg);border-radius:10px;padding:12px 14px;font-size:.92rem}
.keep li b{color:var(--ok)}
.caveats{color:var(--muted);font-size:.92rem;max-width:80ch;display:flex;flex-direction:column;gap:8px}
.caveats code{font-family:var(--f-mono);font-size:.84rem;color:var(--fg)}
/* lightbox */
dialog{border:0;padding:0;background:transparent;max-width:min(96vw,1600px);width:100%}
dialog::backdrop{background:rgba(8,10,9,.86)}
dialog figure{margin:0;display:flex;flex-direction:column;gap:10px}
dialog img{width:100%;height:auto;border-radius:8px;display:block}
dialog figcaption{display:flex;justify-content:space-between;gap:12px;color:#e4e9e5;font:500 .95rem var(--f-body)}
dialog figcaption .mono{color:#9aa69e}
dialog button{font:600 .9rem var(--f-body);background:#e4e9e5;color:#121614;border:0;border-radius:8px;padding:6px 14px;cursor:pointer}
@media (prefers-reduced-motion:no-preference){.node,.mini img{transition:box-shadow .15s,border-color .15s}}
</style>

<div class="wrap">
<header class="top">
  <span class="eyebrow">UI review · desktop / TV</span>
  <h1>Tandemonium screen flow review</h1>
  <div class="meta"><span><b>Build</b> main @ 467dc8b</span><span><b>Screen</b> 1920×1080, desktop-app profile</span><span><b>Controllers</b> DualSense · Steam Controller via Puck (WebHID) · Switch Pro · GameSir Super Nova · Xbox</span><span><b>Date</b> 19 Oct 2026</span></div>
  <p class="lede">I drove every lobby step, popup and ride state with 1–4 simulated controllers and captured each screen. The core flows work. On a TV they mostly fall down for three reasons: the lobby is a phone-width column that overflows 1080p, the Back hint and controller glyphs are handled differently on every screen, and several steps put focus somewhere the player can’t see.</p>
  <div class="tally"><a class="t-high" href="#findings"><strong>${counts.high}</strong> high</a><a class="t-med" href="#findings"><strong>${counts.med}</strong> medium</a><a class="t-low" href="#findings"><strong>${counts.low}</strong> low</a><a href="#flow"><strong>${Object.keys(S).length}</strong> screens</a></div>
</header>

<section id="flow">
  <div class="sec-head"><span class="eyebrow">Flow map</span><h2>How the screens connect</h2><p>Each row is one path through the game, left to right. Arrow labels name the button or event that moves you on. A numbered badge means findings reference that screen; click any screen to see it full size.</p></div>
  <div class="lanes">${lanes}</div>
</section>

<section id="controllers">
  <div class="sec-head"><span class="eyebrow">Controllers</span><h2>What each controller is called and shown</h2><p>The stoker’s code-entry screen with each controller alone. The confirm/back hints should match what’s printed on the controller.</p></div>
  <div class="table-scroll"><table><thead><tr><th>Controller</th><th>Name the game shows</th><th>Confirm hint</th><th>Back hint</th><th>Glyphs</th><th>Screen</th></tr></thead><tbody>${padRows}</tbody></table></div>
</section>

<section id="findings">
  <div class="sec-head"><span class="eyebrow">Findings</span><h2>Ranked by impact on a TV player</h2><p>High means a player gets stuck, can’t read it, or loses their seat. Each finding links to the screens it’s about.</p></div>
  <div class="filters" role="group" aria-label="Filter findings">
    <button type="button" data-f="all" aria-pressed="true">All</button>${Object.entries(CATS).map(([k, v]) => `<button type="button" data-f="${k}" aria-pressed="false">${v}</button>`).join('')}
  </div>
  <div class="findings">${findings}</div>
</section>

<section id="reuse">
  <div class="sec-head"><span class="eyebrow">Reusable controls</span><h2>Where one component should replace many</h2><p>The lobby steps already use <span class="mono">@usersfirst/ui</span> (<span class="mono">uf-flow</span>, <span class="mono">uf-step</span>, <span class="mono">uf-button</span>, <span class="mono">uf-seat</span>). The in-ride overlays and popups mostly don’t. index.html has 57 <span class="mono">uf-button</span>s and 100 raw <span class="mono">&lt;button&gt;</span>s across 25 class names, and game.js builds 7 more by hand.</p></div>
  <div class="reuse">
    <div class="card"><h3>Button inventory today</h3><div class="inventory"><span><b>57</b> uf-button (14 accent · 12 ghost · 1 versus)</span><span><b>35</b> opt-btn</span><span><b>9</b> lobby-toggle</span><span><b>9</b> qm-item</span><span><b>5</b> side-btn</span><span><b>5</b> ping-btn</span><span><b>4</b> vol-btn</span><span><b>4</b> profile-popup-*</span><span><b>3</b> clip-btn</span><span><b>3</b> lobby-credits-btn</span><span><b>3</b> difficulty-btn</span><span><b>2</b> bike-carousel-nav</span><span><b>2</b> tourist-*</span><span><b>7</b> built in game.js</span></div></div>
    <div class="card"><h3><span class="mono">uf-glyph</span>: one controller-glyph component</h3><ul><li>Glyph logic lives in 8 places in lobby.js. The ride hints in hud.js and game.js hard-code “LB/RB”, and the versus hint hard-codes “A/B”.</li><li>Feed it from the controller registry so the Back hint, spinner hints, versus join line, ride hints and SKIP TUTORIAL all agree (fixes finding 13).</li></ul></div>
    <div class="card"><h3>Step footer slot</h3><ul><li>A <span class="mono">uf-step</span> footer row holding Back + the controller hint, laid out with the step.</li><li>Removes every overlap in finding 5 and gives each step one place to look for “how do I go back”.</li></ul></div>
    <div class="card"><h3>Controller list / seat</h3><ul><li>Versus has a good controllers list (CONNECTED → SEATED). The captain step builds its own red JOIN buttons for the same job.</li><li>One component for both, and for the lab lobby, using <span class="mono">uf-seat</span> states (findings 3, 14).</li></ul></div>
    <div class="card"><h3>Result screen + action bar</h3><ul><li>Game over, victory, tutorial complete, demo end, partner left and versus results each lay out actions differently.</li><li>One layout: headline, stats, one action bar with the primary action first and focused (findings 10, 15).</li></ul></div>
    <div class="card"><h3>Sheet / modal shell</h3><ul><li>Help, leaderboard, profile, settings, phone, garage and disconnect each have their own close button and focus handling.</li><li>One shell with a focus trap, ◯/B and Esc to close, and TV-size type (findings 11, 19).</li></ul></div>
    <div class="card"><h3>Icon button</h3><ul><li>The round lobby toggles (<span class="mono">lobby-toggle</span>), carousel arrows and footer icons are three different kinds of icon button.</li><li>One <span class="mono">uf-icon-button</span> with the same focus ring as <span class="mono">uf-button</span> (finding 10).</li></ul></div>
  </div>
</section>

<section id="keep">
  <div class="sec-head"><span class="eyebrow">Keep</span><h2>Decisions worth building on</h2></div>
  <ul class="keep">
    <li><b>Focus is easy to see.</b> The green ring on buttons reads clearly from across a room.</li>
    <li><b>DualSense and Xbox glyphs are right.</b> ✕/◯ and A/B appear in the hints and the code spinner.</li>
    <li><b>The versus controllers list</b> shows every controller with its state and team, the model the captain step should copy.</li>
    <li><b>Code entry by spinner</b> lets a stoker join a room without a keyboard.</li>
    <li><b>The Steam Controller over the Puck navigates menus</b> through WebHID, with no Steam Input needed.</li>
    <li><b>Level cards show your record</b> (“No ride yet · at 0:58”), giving each ride a goal before you start.</li>
  </ul>
</section>

<section id="method">
  <div class="sec-head"><span class="eyebrow">Method</span><h2>How this was captured, and what it didn’t cover</h2></div>
  <div class="caveats">
    <p>Headless Chrome on the RTX 5070 Ti at 1920×1080, with the desktop app’s user agent so the game takes its desktop-app path. Controllers were simulated: a fake Gamepad API for DualSense, Switch Pro, Super Nova and Xbox, and a fake WebHID Puck sending Steam Controller 0x45 state reports. A few states (game over, victory, demo end, partner left, tutorial complete, versus finish) were triggered through the game’s own functions rather than ridden.</p>
    <p>Not covered: real hardware and Steam Input (the desktop app’s <code>window.steam</code> bridge isn’t present), a real online partner (the room is shown empty), Tourist (needs a Maps key), Slingshot runs and the daily-mode chooser. Re-check findings 2 and 7 on real controllers before fixing.</p>
    <p>Tracked in issue #428. The capture scripts are in <code>scripts/ui-audit/</code> and this report in <code>docs/ui-review-2026-10-19/</code> on branch <code>review/ui-nav-audit</code>. Re-shoot with <code>node scripts/ui-audit/capture.mjs &lt;outDir&gt; [scenario…]</code>.</p>
  </div>
</section>
</div>

<dialog id="lb" aria-label="Screenshot"><figure><img id="lb-img" alt=""><figcaption><span><span id="lb-cap"></span> <span class="mono" id="lb-id"></span></span><button type="button" id="lb-close">Close</button></figcaption></figure></dialog>
<script>
(() => {
  const NAMES = ${JSON.stringify(S)};
  const lb = document.getElementById('lb'), img = document.getElementById('lb-img');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shot]'); if (!b) return;
    const id = b.dataset.shot; img.src = 'img/' + id + '.jpg'; img.alt = NAMES[id] || id;
    document.getElementById('lb-cap').textContent = NAMES[id] || id; document.getElementById('lb-id').textContent = id;
    if (lb.showModal) lb.showModal();
  });
  document.getElementById('lb-close').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  const btns = document.querySelectorAll('.filters button');
  btns.forEach((b) => b.addEventListener('click', () => {
    btns.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const f = b.dataset.f;
    document.querySelectorAll('.finding').forEach((el) => { el.hidden = f !== 'all' && !el.dataset.cats.split(' ').includes(f); });
  }));
})();
</script>`;
fs.writeFileSync(path.join(DIR, 'index.html'), html);
console.log('ok', F.length, 'findings', Object.keys(S).length, 'screens');
