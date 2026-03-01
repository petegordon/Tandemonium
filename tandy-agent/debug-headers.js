const dotenv = require('dotenv');
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

async function debugModel(modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
  const body = { contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 1 } };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  console.log(`
--- [${modelName}] ---`);
  console.log(`Status: ${response.status}`);
  for (const [key, value] of response.headers.entries()) {
    if (key.includes('ratelimit') || key.includes('quota') || key.includes('retry')) {
      console.log(`${key}: ${value}`);
    }
  }
}

async function run() {
  const models = ["gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-pro-preview"];
  for (const m of models) await debugModel(m);
}

run();
