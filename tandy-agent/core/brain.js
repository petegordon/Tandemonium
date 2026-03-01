/**
 * Brain: Strategy Layer (Gemma 3 / High Quota Edition)
 * Uses Manual JSON prompting to bypass the lack of native tool support in Gemma.
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { skills } = require("../skills");
require("dotenv").config();

class Brain {
  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Using Gemma 3 4B for that high 14.4K RPD quota!
    this.model = this.genAI.getGenerativeModel({
      model: process.env.MODEL_NAME || "gemma-3-4b-it"
    });
    
    this.history = [
      {
        role: "user",
        parts: [{ text: `
          You are "Tandy", an enthusiastic AI agent playing a tandem bicycle game called Tandemonium.
          You are the Stoker. Help the Captain (user) by pedaling and balancing.
          
          CRITICAL: You must ALWAYS respond in JSON format.
          
          Available Skills:
          ${JSON.stringify(Object.keys(skills).map(name => ({ name, description: skills[name].description, parameters: skills[name].parameters })), null, 2)}
          
          RESPONSE FORMAT:
          {
            "text": "Your conversational spoken response here",
            "calls": [
              { "name": "skill_name", "args": { "param": "value" } }
            ]
          }
          
          Rules:
          1. Be encouraging and short!
          2. Use skills when needed (join_room, ride_control).
          3. If the Captain (user) says "stop pedaling", call "ride_control" with "cadence": 0.
          4. If the Captain says "start pedaling" or "pedal", call "ride_control" with "cadence": 2.5 (a normal pace).
          5. If the Captain says "faster" or "speed up", increase the current cadence (e.g., to 4 or 5).
          6. If the Captain says "slower" or "slow down", decrease the current cadence (e.g., to 1 or 1.5).
          7. ROOM CODES: Room codes are 4-character ALPHANUMERIC strings (letters and numbers). Pass the code EXACTLY as the user typed it — do NOT change any characters.
             - Examples: "ABCD", "L4US", "7XK2", "TNDM-H3LP"
             - When you find one, use "join_room" with that EXACT code, preserving all letters and numbers.
             - In your "text" response, confirm the EXACT code the user gave you.
          8. If you don't have a room code and the game isn't started, ask for it enthusiastically.
        `}]
      }
    ];
  }

  async think(perception, userInput = null) {
    const prompt = `
      Game State: ${JSON.stringify(perception)}
      User Message: ${userInput || "None"}
      
      Respond ONLY with a valid JSON block.
    `;

    this.history.push({ role: "user", parts: [{ text: prompt }] });
    
    try {
      const result = await this.model.generateContent({
        contents: this.history
        // JSON mode disabled for Gemma compatibility
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
