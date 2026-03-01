/**
 * Ride Control Skill
 * Bridge between Brain (LLM) and Body (Agent Script)
 */
const rideControl = {
  description: "Sets the physical effort of the bot (pedaling speed and balancing effort). Use this to adjust how Tandy rides.",
  parameters: {
    type: "object",
    properties: {
      cadence: { type: "number", description: "Target pedal strokes per second (e.g., 2.0 for slow, 5.0 for fast)" },
      effort: { type: "string", enum: ["low", "normal", "aggressive"], description: "How aggressively the bot should steer back to center." }
    }
  },
  execute: async (page, { cadence, effort }) => {
    return await page.evaluate(({ c, e }) => {
      if (!window._agent) return "Error: Body script not loaded.";
      if (c) window._agent.targetCadence = c;
      if (e) window._agent.effortMode = e; // We'll add this to the body
      return `Target cadence set to ${c} and effort to ${e}.`;
    }, { c: cadence, e: effort });
  }
};

module.exports = { rideControl };
