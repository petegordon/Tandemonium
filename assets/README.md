# Asset Attributions

## 3D Models

### Lowpoly Pine Tree

- **Source:** https://skfb.ly/o6AIy
- **Author:** Citron Legacy

> "Lowpoly Pine Tree" (https://skfb.ly/o6AIy) by Citron Legacy is licensed under
> Creative Commons Attribution (http://creativecommons.org/licenses/by/4.0/).

---

# Music Assets

All music tracks by [Kevin MacLeod](https://incompetech.com) are licensed under
[Creative Commons: By Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).

## Tracks

### Krampus Workshop

- **Genre:** Holiday
- **Feel:** Dark, Driving, Humorous
- **Instruments:** Bassoons, Cello, Chimes, Flute, French Horns, Glockenspiel, Percussion, Trombones, Trumpet, Tuba, Xylophone
- **Description:** Claymation-style holiday romp
- **ISRC:** USUAN1900029

> "Krampus Workshop" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> https://creativecommons.org/licenses/by/4.0/

### Gold Rush

- **Genre:** Silent Film Score
- **Feel:** Bouncy, Driving, Humorous
- **Instruments:** Piano
- **Description:** Peppy piano duet
- **ISRC:** USUAN1100217

> "Gold Rush" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> https://creativecommons.org/licenses/by/4.0/

### Chee Zee Lab

- **Genre:** Unclassifiable
- **Feel:** Driving, Humorous, Intense
- **Instruments:** Percussion, Synths
- **Description:** Semi-industrial loopable driving piece
- **ISRC:** USUAN1100683

> "Chee Zee Lab" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> https://creativecommons.org/licenses/by/4.0/

### Professor Umlaut

- **Genre:** Unclassifiable
- **Feel:** Driving, Humorous, Suspenseful
- **Instruments:** Bass, Drums, Guitar, Organ
- **Description:** Random-challenge composition from "The Wheels of Doom!" Twitch show
- **ISRC:** USUAN1600020

> "Professor Umlaut" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> https://creativecommons.org/licenses/by/4.0/

### Mischief Maker

- **Genre:** Soundtrack
- **Feel:** Bouncy, Driving, Humorous
- **Instruments:** Bass, Drums, Dulcimer, Virginal, Xylophone
- **Description:** Whimsical, mischievous soundtrack piece
- **ISRC:** USUAN1700009

> "Mischief Maker" Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> https://creativecommons.org/licenses/by/4.0/

---

# Sound Effects

## Goose Calls

- **File:** `goose-honk.mp3`
- **Source:** https://pixabay.com/users/freesound_community-46691455/
- **Author:** freesound_community (via Pixabay)
- **License:** [Pixabay Content License](https://pixabay.com/service/license-summary/)
  — permits commercial use, no attribution required. Credited anyway, in-game
  under Help → Attributions and here.

Processing applied: converted to mono, 24kHz, 64kbps, +3dB
(353KB → 142KB, peak −2.3dB). Headroom is deliberate — the game applies its own
gain on top and up to three honks can overlap.

Used as a *bank* rather than a one-shot: `AudioEngine.loadGooseSample()` scans
for honk onsets at load, and each goose scatter plays a short window from the
recording. This is a continuous flock recording with only one silence gap, so
onset detection finds little and playback falls back to a random window — every
window is geese, so the variety comes for free. See `js/audio-engine.js`.
