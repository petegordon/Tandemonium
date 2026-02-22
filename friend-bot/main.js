/**
 * Main Friend-Bot Runner
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Brain } = require('./core/brain');
const { Perception } = require('./core/perception');
const { skills } = require('./skills');
require('dotenv').config();

const URL = process.env.GAME_URL || 'http://localhost:8888/';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '[You]: '
});

// Helper to log without breaking the readline prompt
function safeLog(msg) {
  process.stdout.write('\r\x1b[K'); // Carriage return + Clear line
  console.log(msg);
  rl.prompt(true);
}

async function main() {
  safeLog('--- Tandy Bot: Starting ---');
  
  const brain = new Brain();
  
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  
  const context = await browser.newContext({ 
    permissions: ['camera', 'microphone'] 
  });
  const page = await context.newPage();
  
  // Log browser console messages to Node.js terminal
  page.on('console', msg => {
    const t = msg.text();
    if (t.includes('Tandy') || t.includes('Bike loaded')) {
      safeLog(`[Browser] ${msg.type().toUpperCase()}: ${t}`);
    }
  });

  const perception = new Perception(page);

  // Expose a function for the bot to "speak" via browser TTS
  await page.exposeFunction('botSpeak', (text) => {
    safeLog(`[Tandy]: ${text}`);
    return page.evaluate((t) => {
      const msg = new SpeechSynthesisUtterance(t);
      const voices = speechSynthesis.getVoices();
      msg.voice = voices.find(v => v.name.includes('Google') || v.name.includes('Female')) || voices[0];
      speechSynthesis.speak(msg);
    }, text);
  });

  // Inject agent body script BEFORE navigating
  const agentScript = fs.readFileSync(path.join(__dirname, 'agent-script.js'), 'utf8');
  await page.addInitScript(agentScript);

  safeLog(`Navigating to ${URL}...`);
  await page.goto(URL);
  
  await page.waitForFunction(() => window._game && window._game.lobby, { timeout: 60000 });
  safeLog('Game Ready.');

  // "Hearing" via Terminal Fallback
  rl.on('line', async (text) => {
    if (!text.trim()) { rl.prompt(); return; }
    try {
      const state = await perception.getGameState();
      const thoughts = await brain.think(state, text);
      if (thoughts.text) await page.evaluate(t => window.botSpeak(t), thoughts.text);
      if (thoughts.functionCalls) await handleSkills(thoughts.functionCalls);
    } catch (err) {
      safeLog(`Brain Error: ${err.message}`);
      if (err.message.includes("429")) {
        safeLog("Rate limit hit. Wait a few seconds before typing again.");
      }
    }
    rl.prompt();
  });
  
  rl.prompt();

  async function handleSkills(calls) {
    for (const call of calls) {
      const skill = skills[call.name];
      if (skill) {
        try {
          const result = await skill.execute(page, call.args);
          safeLog(`[Skill] ${call.name}: ${result}`);
        } catch (e) { safeLog(`Skill ${call.name} failed: ${e.message}`); }
      }
    }
  }

  // The Passive Agentic Loop (Perception of game events)
  let lastState = null;
  let lastFallen = false;
  let lastSurpriseTime = Date.now();

  const loop = async () => {
    try {
      const state = await perception.getGameState();
      if (!state || !state.ready) {
        setTimeout(loop, 2000);
        return;
      }

      const now = Date.now();

      // 1. Capture baseline state on first run
      if (lastState === null) {
        lastState = state.state;
        lastFallen = state.fallen;
        setTimeout(loop, 2000);
        return;
      }

      // 2. Events (State changes, Crashes, or Surprises)
      const justFallen = state.fallen && !lastFallen;
      const stateChanged = state.state !== lastState;
      
      const shouldSurprise = state.state === 'playing' && 
                             (now - lastSurpriseTime > 25000) && 
                             (Math.random() > 0.65);

      if (stateChanged || justFallen || shouldSurprise) {
        let eventMsg = stateChanged ? `State is now ${state.state}` : "";
        if (justFallen) eventMsg = "WE CRASHED!";
        if (shouldSurprise) {
          eventMsg = "You feel like being a bit spontaneous. Maybe change the pace (ride_control), suggest a race, or just crack a joke about the ride!";
          lastSurpriseTime = now;
        }

        try {
          const thoughts = await brain.think(state, `System Event: ${eventMsg}`);
          if (thoughts.text) await page.evaluate(t => window.botSpeak(t), thoughts.text);
          if (thoughts.functionCalls) await handleSkills(thoughts.functionCalls);
        } catch (apiErr) {
          if (apiErr.message.includes("429")) {
            safeLog("[Quota] Rate limited. Pausing loop for 30s...");
            await new Promise(r => setTimeout(r, 30000));
          } else {
            safeLog(`Brain Loop Error: ${apiErr.message}`);
          }
        }
        
        lastState = state.state;
        lastFallen = state.fallen;
      }
    } catch (e) {
      safeLog(`Loop Error: ${e.message}`);
    }
    setTimeout(loop, 2000);
  };

  loop();

  process.on('SIGINT', async () => {
    safeLog('Shutting down...');
    await browser.close();
    process.exit(0);
  });
}

main().catch(console.error);
