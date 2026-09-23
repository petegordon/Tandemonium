const dotenv = require('dotenv');
dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("Error: GEMINI_API_KEY not found in .env");
  process.exit(1);
}

async function checkModelLimit(modelName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${API_KEY}`;
  
  const body = {
    contents: [{ parts: [{ text: "ping" }] }],
    generationConfig: { maxOutputTokens: 1 }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const headers = {
      model: modelName,
      status: response.status,
      rpm_limit: response.headers.get('x-ratelimit-limit-requests'),
      rpm_remaining: response.headers.get('x-ratelimit-remaining-requests'),
      rpd_limit: response.headers.get('x-ratelimit-limit-free-tier-requests') || response.headers.get('x-ratelimit-limit-tokens'),
      retry_after: response.headers.get('retry-after')
    };

    if (response.status === 429) {
      console.log(`[${modelName}] Rate Limited (429). Limits: RPM: ${headers.rpm_limit}, RPD: ${headers.rpd_limit}`);
    } else if (response.status === 200) {
      console.log(`[${modelName}] Success (200). Limits: RPM: ${headers.rpm_limit}, RPD: ${headers.rpd_limit}`);
    } else {
      const data = await response.json();
      const msg = data.error ? data.error.message : JSON.stringify(data);
      console.log(`[${modelName}] Error (${response.status}): ${msg}`);
    }
  } catch (err) {
    console.error(`[${modelName}] Fetch failed:`, err.message);
  }
}

async function run() {
  console.log("Checking Gemini API Rate Limits for your key...\n");
  
  const models = [
    "gemini-1.5-flash",
    "gemini-1.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview"
  ];

  for (const model of models) {
    await checkModelLimit(model);
    await new Promise(r => setTimeout(r, 500));
  }
}

run();
