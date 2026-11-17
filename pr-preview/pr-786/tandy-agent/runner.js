const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  return new Promise(resolve => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  console.log('--- Tandemonium Tandy Agent Runner ---');
  
  let input = await ask('Enter Room Code (e.g. ABCD) or Join URL: ');
  let roomCode = '';

  if (input.includes('?room=')) {
    const url = new URL(input);
    roomCode = url.searchParams.get('room').toUpperCase();
  } else {
    roomCode = input.trim().toUpperCase();
    if (!roomCode.startsWith('TNDM-')) {
      roomCode = 'TNDM-' + roomCode;
    }
  }

  const gameUrl = input.includes('http') ? input.split('?')[0] : 'http://localhost:8888/';

  console.log(`Target Room: ${roomCode}`);
  console.log(`Target URL: ${gameUrl}`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext({
    permissions: ['camera', 'microphone']
  });

  const page = await context.newPage();
  
  page.on('console', msg => {
    console.log(`[Browser] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });

  console.log(`Navigating to ${gameUrl}...`);
  await page.goto(gameUrl);

  // Inject agent logic
  const agentScriptPath = path.join(__dirname, 'agent-script.js');
  if (fs.existsSync(agentScriptPath)) {
    const agentScript = fs.readFileSync(agentScriptPath, 'utf8');
    await page.addInitScript(agentScript);
  }

  // Wait for game init
  await page.waitForFunction(() => window._game && window._game.lobby, { timeout: 60000 });

  console.log(`Joining room ${roomCode}...`);
  await page.evaluate((code) => {
    const lobby = window._game.lobby;
    lobby._requestMotion();
    lobby._showStep(lobby.joinStep);
    const input = document.getElementById('room-code-input');
    input.value = code;
    document.getElementById('btn-join').click();
  }, roomCode);

  await page.waitForFunction(() => window._game.state !== 'lobby', { timeout: 30000 });
  console.log('Connected! Bot is active.');

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('Stopping bot...');
    await browser.close();
    process.exit(0);
  });
}

main().catch(console.error);
