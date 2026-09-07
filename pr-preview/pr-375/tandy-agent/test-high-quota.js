const dotenv = require('dotenv');
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

async function check(model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const body = { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    console.log(`[${model}] Status: ${response.status}`);
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      console.log(`    Reason: ${data.error ? data.error.message : 'Unknown'}`);
    }
  } catch (e) {
    console.log(`[${model}] Failed: ${e.message}`);
  }
}

async function run() {
  const models = [
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-flash-latest"
  ];
  
  console.log("Testing high-quota models...");
  for (const m of models) {
    await check(m);
    await new Promise(r => setTimeout(r, 2000));
  }
}

run();
