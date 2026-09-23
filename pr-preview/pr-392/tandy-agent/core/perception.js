/**
 * Perception Layer: Monitoring the environment
 */
class Perception {
  constructor(page) {
    this.page = page;
  }

  async getGameState() {
    return await this.page.evaluate(() => {
      const g = window._game;
      if (!g) return { ready: false };
      return {
        ready: true,
        state: g.state, // 'lobby', 'playing', etc.
        speed: Math.round(g.bike.speed),
        distance: Math.round(g.bike.distanceTraveled),
        fallen: g.bike.fallen,
        connected: g.net ? g.net.connected : false,
        roomCode: g.net ? g.net.roomCode : null
      };
    });
  }

  /**
   * Sets up a listener for when the player speaks.
   * For this MVP, we use the Browser's Web Speech API (SpeechRecognition)
   * to hear the player and pipe it back to the Node Brain.
   */
  async startListening(onSpeech) {
    await this.page.exposeFunction('onBrowserSpeech', (text) => {
      onSpeech(text);
    });

    await this.page.evaluate(() => {
      const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        const text = event.results[event.results.length - 1][0].transcript;
        console.log('Browser Speech Result:', text);
        window.onBrowserSpeech(text);
      };

      recognition.onerror = (event) => {
        console.error('Speech Recognition Error:', event.error);
        if (event.error === 'not-allowed') {
          console.warn('Microphone permission denied or blocked by browser policy.');
        }
      };

      recognition.onend = () => {
        console.log('Speech Recognition service disconnected. Restarting...');
        recognition.start();
      };

      recognition.start();
      console.log('Tandy: Speech Recognition started. Please click the page to ensure audio context is active.');
    });
  }
}

module.exports = { Perception };
