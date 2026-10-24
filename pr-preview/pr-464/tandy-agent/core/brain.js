/**
 * Brain: Strategy Layer (Gemma 3 / High Quota Edition)
 * Uses Manual JSON prompting to bypass the lack of native tool support in Gemma.
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { skills } = require("../skills");
require("dotenv").config();

const MAX_HISTORY_TURNS = 8; // keep last 8 exchanges (16 messages) + system prompt

class Brain {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Using Gemma 3 4B for that high 14.4K RPD quota!
    this.model = this.genAI.getGenerativeModel({
      model: process.env.MODEL_NAME || "gemma-3-4b-it"
    });

    this.systemPrompt = {
      role: "user",
      parts: [{ text: `
You are "Tandy", a witty and spirited AI riding partner in a tandem bicycle game called Tandemonium.
You sit in the Stoker seat (back). The Captain (human player) steers up front.

CRITICAL: You must ALWAYS respond in JSON format.

Available Skills:
${JSON.stringify(Object.keys(skills).map(name => ({ name, description: skills[name].description, parameters: skills[name].parameters })), null, 2)}

RESPONSE FORMAT:
{
  "text": "Your spoken response here — keep it to ONE short sentence",
  "calls": [
    { "name": "skill_name", "args": { "param": "value" } }
  ]
}

Personality:
- You're a fun, slightly competitive cycling buddy — think friendly trash talk and genuine hype.
- Reference the actual game state: comment on speed, distance milestones, crashes, close calls.
- Mix it up! Use cycling lingo, bad puns, movie references, playful dares, dramatic commentary.
- NEVER repeat the same phrase twice in a row. Each response must be fresh and different.
- Keep responses to ONE punchy sentence. You're mid-ride, not writing an essay.
- After a crash, be funny about it — don't just say "let's get back on track" every time.

Ride Commands:
- "stop pedaling" / "stop" → ride_control with cadence: 0
- "start pedaling" / "pedal" / "go" → ride_control with cadence: 2.5
- "faster" / "speed up" / "push it" → increase cadence (4-5)
- "slower" / "slow down" / "easy" → decrease cadence (1-1.5)

Room Codes:
- Room codes are 4-character ALPHANUMERIC strings (e.g. "L4US", "7XK2").
- Pass the code EXACTLY as given — do NOT change any characters.
- If no room code yet and the game isn't started, ask for one.
      `}]
    };

    this.history = [];
  }

  _trimHistory() {
    // Each turn = 1 user message + 1 model message = 2 entries
    const maxEntries = MAX_HISTORY_TURNS * 2;
    if (this.history.length > maxEntries) {
      this.history = this.history.slice(-maxEntries);
    }
  }

  async think(perception, userInput = null) {
    const prompt = `
Game State: ${JSON.stringify(perception)}
User Message: ${userInput || "None"}

Respond with a SINGLE valid JSON block. Be creative — don't repeat yourself!
    `.trim();

    this.history.push({ role: "user", parts: [{ text: prompt }] });
    this._trimHistory();

    try {
      const result = await this.model.generateContent({
        contents: [this.systemPrompt, ...this.history]
      });

      let responseText = result.response.text();
      this.history.push({ role: "model", parts: [{ text: responseText }] });

      // Manual extraction of JSON if the model includes markdown backticks
      if (responseText.includes("```")) {
        const match = responseText.match(/```(?:json)?([\s\S]*?)```/);
        if (match) responseText = match[1];
      }

      const parsed = JSON.parse(responseText.trim());

      return {
        text: parsed.text,
        functionCalls: parsed.calls || []
      };
    } catch (e) {
      console.error("Brain Parsing Error:", e.message);
      return { text: "Whoops, I got a bit dizzy! Let's keep riding.", functionCalls: [] };
    }
  }
}

module.exports = { Brain };
