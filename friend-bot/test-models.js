const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

async function listModels() {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const result = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).listModels();
    console.log("Available Models:");
    result.models.forEach(m => console.log(`- ${m.name} (Supports: ${m.supportedGenerationMethods})`));
  } catch (e) {
    // Some versions of the SDK use a different method to list models
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        console.log("Models from API directly:");
        data.models.forEach(m => console.log(`- ${m.name}`));
    } catch (err) {
        console.error("Failed to list models:", err);
    }
  }
}

listModels();
