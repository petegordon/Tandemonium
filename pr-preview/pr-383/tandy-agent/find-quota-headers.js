const dotenv = require('dotenv');
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

async function check(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = { contents: [{ parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    console.log(`
=== [${model}] Status: ${response.status} ===`);
    
    // Log ALL headers that might be relevant
    for (const [key, value] of response.headers.entries()) {
      if (key.startsWith('x-') || key.includes('limit') || key.includes('quota') || key.includes('retry')) {
        console.log(`${key}: ${value}`);
      }
    }

    if (response.status !== 200) {
      const data = await response.json().catch(() => ({}));
      console.log(`Error Body: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.log(`[${model}] Failed: ${e.message}`);
  }
}

async function run() {
  const models = [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash-lite",
    "gemini-flash-latest"
  ];
  
  for (const m of models) {
    await check(m);
    await new Promise(r => setTimeout(r, 1000));
  }
}

run();
