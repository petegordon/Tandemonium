/**
 * Skills Registry
 * Maps LLM-friendly tool definitions to their Playwright/Browser logic.
 */

const skills = {
  join_room: {
    description: "Joins a multiplayer Tandemonium ride using a 4-character alphanumeric room code.",
    parameters: {
      type: "object",
      properties: {
        roomCode: { type: "string", description: "The EXACT 4-character alphanumeric code (e.g. L4US, ABCD, 7XK2). Pass verbatim — do not modify." }
      },
      required: ["roomCode"]
    },
    execute: async (page, { roomCode }) => {
      console.log(`[Skill: join_room] Joining ${roomCode}`);
      return await page.evaluate((code) => {
        if (!window._game || !window._game.lobby) return "Game not initialized";
        const lobby = window._game.lobby;
        lobby._requestMotion();
        lobby._showStep(lobby.joinStep);
        const input = document.getElementById('room-code-input');
        input.value = code;
        document.getElementById('btn-join').click();
        return "Join signal sent";
      }, roomCode);
    }
  },
  ride_control: {
    description: "Sets the physical effort of the bot (pedaling speed and balancing effort). Use this to adjust how Tandy rides. Set cadence to 0 to stop pedaling.",
    parameters: {
      type: "object",
      properties: {
        cadence: { type: "number", description: "Target pedal strokes per second (e.g., 2.0 for slow, 5.0 for fast, 0 to stop)" },
        effort: { type: "string", enum: ["low", "normal", "aggressive"], description: "How aggressively the bot should steer back to center." }
      }
    },
    execute: async (page, { cadence, effort }) => {
      return await page.evaluate(({ c, e }) => {
        if (!window._agent) return "Error: Body script not loaded.";
        if (c !== undefined) window._agent.targetCadence = c;
        if (e !== undefined) window._agent.effortMode = e;
        return `Target cadence set to ${c} and effort to ${e}.`;
      }, { c: cadence, e: effort });
    }
  }
};

module.exports = { skills };
