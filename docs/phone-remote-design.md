# Phone as Remote Controller — design (issue #421)

Status: **Signed off 2026-10-18 (D1–D10 as recommended; D3 landscape grip).**
Phase 1 is built on this branch: see §10.

## 1. What we're building

The game runs on one screen (a laptop, a TV, a Discord Activity window). A
player's **phone is the controller**. The phone shows no game, only a pad:

1. **Motion steer:** tilt the phone to lean the bike, using the same tilt
   pipeline the game already uses when you play on a phone.
2. **Pedal touch:** the left half of the screen is the LEFT pedal and the
   right half is the RIGHT pedal, as on the in-game `#pedal-bar`.
3. **Menu navigation:** move through the menus and pick items from the phone,
   so you never need the keyboard.

The first goal is a demo that plays as a **Discord Activity** with phones as
controllers. A phone remote also helps anywhere a big screen has no gamepad:
Steam on a TV, a party laptop, a booth at a show (GDEX).

## 2. Is this the same as RIDE TOGETHER / local co-op?

**No, but it uses the same plumbing.**

| | RIDE TOGETHER (today) | Phone remote (new) |
|---|---|---|
| What the phone runs | the whole game: renders, physics, its own view | a pad page only (no three.js, no world) |
| What travels | bike state, lean, pedal events, level sync (`bike-codec.js`) | about 12 bytes of input, 30 times a second |
| Who owns the bike | captain simulates, stoker mirrors | the host simulates and the phone is only an input device |
| Join | QR / room code → `?room=CODE` | QR / code → `/remote/?pad=CODE&seat=N` |
| Relay | `TandemRoom` DO, roles captain/stoker only | new `PadRoom` DO, roles host + pad-1..4 |

The two work together. Two friends in RIDE TOGETHER can each steer from their
own phone, so it's two game screens with a phone remote on each. That is the
Discord case, because every Discord participant runs their own copy of the
Activity. Also, **inside Discord the phone remote is the only way to steer by
motion**: Discord blocks motion sensors in Activities (§7).

## 3. How it works

```
 phone  /remote/                     relay (Cloudflare)              host game
 ┌─────────────────────┐   wss    ┌──────────────────────┐  wss   ┌────────────────────────┐
 │ RemotePad           │ ───────▶ │ PadRoom DO  (new)    │ ─────▶ │ RemoteInputSource      │
 │  motion pipeline    │  input   │  roles: host,        │        │  = an InputManager-     │
 │  (reused from       │  frames  │  pad-1 … pad-4       │        │    shaped object bound  │
 │   InputManager)     │ ◀─────── │  fan-in to host,     │ ◀───── │    to a seat            │
 │  pedal halves, nav  │  ui mode │  fan-out of host msgs│  mode  │  FocusController reads  │
 └─────────────────────┘  + cues  └──────────────────────┘  + cues│  it like a gamepad      │
                                                                  └────────────────────────┘
```

### 3.1 Phone page `remote/index.html` (new, small)

- The phone sends its **raw tilt angle**, computed by `js/tilt-math.js`. That
  is the same orientation-to-angle mapping `InputManager` uses when the game
  runs on a phone; it was split out so both sides share it.
- The game runs that angle through its **own** tilt pipeline:
  `InputManager.feedRemoteTilt()` → low-pass → `_applyTilt`, which covers
  calibration, drift, the response curve and the steering-feel tuning from
  #399.
  - This changed from the first draft, where the phone sent a finished lean.
    The game side is where it belongs: the curve scales with bike speed, and
    the tutorial and countdown calibrations already run there.
  - The upshot: a phone remote steers exactly like playing on a phone, and
    the tutorial's tilt lesson works unchanged.
- Pedals: the whole screen is two halves. A tap counter per pedal goes in
  every frame, so a quick tap between frames is never lost (same idea as
  `_leftTapped` / `consumeTaps()`).
- Screen wake lock, full screen, landscape lock where allowed. iOS needs a
  tap for motion permission, so that tap is the "Connect" button.
- Feedback without looking at the phone: a short buzz on Android, plus
  sound, because iPhone Safari has no `navigator.vibrate` (learned on the
  roulette Activity). The player watches the big screen, not the phone.

### 3.2 Input frame (phone → host)

```
u8  type = PAD_INPUT (0x50)
u8  seq                  wraps around; host drops stale frames
i16 tilt ×100            raw tilt degrees (tilt-math.js)
u8  flags                bit0 L pedal, bit1 R pedal, bit2 tilt valid
u8  tapsL, tapsR         running counters (host diffs them)
u8  nav                  bit0 up, 1 down, 2 left, 3 right, 4 OK, 5 back, 6 recenter
```

8 bytes (`js/remote/pad-protocol.js`), sent at 30 Hz and immediately on any
pedal or nav change.
Over the relay WebSocket that's well under 1 KB/s.

### 3.3 Host side `js/remote/remote-input.js` (new)

- `RemoteInputSource` provides what the game and lobby read from an
  `InputManager`: `getMotionLean()`, `getMotionLeanVisual()`,
  `isPressed('ArrowLeft'|'ArrowRight')`, `consumeTaps()`, `isActive()`,
  `recenterGyro()`, `resetLeanState()`, plus the edge state that
  `FocusController` reads (up/down/left/right/a/b).
- Plan: wrap it as a **virtual controller slot**, so seat select (#416),
  `FocusController` and the HUD treat a phone like any other pad and those
  files need no new branches. If that proves too invasive, fall back to
  passing it as `input` where the game builds `new InputManager(...)`.
- If the phone drops: lean eases to 0, pedals release, and the game pauses
  with "Phone disconnected — reopen the page" plus the same QR. The phone
  reconnects with the same `pad` code and `seat`.

### 3.4 Relay `PadRoom` (`worker/pad-relay.js`, its own Worker)

- It's a separate Worker, `tandemonium-pad`, deployed with
  `wrangler-pad.toml`, so `TandemRoom` (RIDE TOGETHER) stays exactly as it is.
- It deploys on its own. A new Durable Object class inside `relay.js`
  deployed from a branch would make the next `main` deploy fail, because
  that build wouldn't have the class.
- Roles `host` and `pad-1` … `pad-4`. A pad's messages go only to the host,
  and host messages go to one pad or all of them. Duplicate roles replace the
  old socket, as `TandemRoom` already does.
- WebSocket only, no WebRTC P2P in v1. Input is tiny and latency-tolerant,
  and Discord's sandbox makes P2P harder (§7). P2P can come later on the
  existing `RoomTransport` fast lane if latency is a problem in testing.
- Pad codes: 6 characters, the same style as room codes, with a 30-minute TTL
  like rooms. Each pad also gets a secret in the QR's `#` fragment, checked by
  the relay as in the dice Activity (§7).

### 3.5 Host → phone messages

The host tells the phone what to show, so the phone screen always matches the
game:

- `mode`: `menu` | `ride` (built). `calibrate`, `paused` and `results` are
  planned; paused and results use `menu` for now.
- `cue`: `crash`, `coin`, `countdown`, `finish` → a buzz or sound on the phone
- `seat`: "You are Player 1 — Captain" (name, colour)

## 4. Phone screens

**Menu mode.** A big D-pad, a big **OK** button and a **Back** button.
`FocusController` already handles every lobby step, popup and overlay from
d-pad + A/B, so this works on every screen with no per-screen phone work.
(See D2 for the alternative.)

**Calibrate mode.** "Hold the phone like handlebars, level." The game's
existing calibration and tutorial lean checks run on the phone side, and the
results go to the host.

**Ride mode.** The whole screen is two pedals, LEFT | RIGHT. Tilt steers.
There's a small **recenter** button at the top. If you lose track of which
pedal is which, the phone flashes the pedal you pressed and the big screen's
pedal HUD shows it too.

**Paused / results.** Back to the menu layout.

## 5. Choosing controllers (settings + first run)

From the issue: *"each of the players are joining with phone or keyboard or
gamepad, starting with the host player; default to QR code to lead the host
player to use their phone."*

- **Options → Controls → "Player 1 controller": Phone (QR) / Keyboard /
  Gamepad / Auto.** Auto means today's behaviour. The *phone-first* setting
  is the default **only in the phone-first build** (D4).
- **Phone-first first run:** title → **"Grab your phone"** screen with a big
  QR, the short URL and the code. The player scans, taps Connect (iOS motion
  permission), and the phone shows OK.
  - On that screen, pressing any key or gamepad button skips the phone and
    uses that device instead.
  - Then calibrate → tutorial → Grandma's.
- **More players:** the Controllers panel from #416 gets **"+ Add phone"**,
  which shows a QR for the next free seat. A phone appears as a joined
  controller and seats like a pad. Couch co-op and VERSUS seats can then be
  any mix of phones, pads and keyboard.

## 6. Demo scope for this build

The issue says tutorial + Grandma's only, Chill (maybe Adventurous). I
propose a third rules set beside `FULL_RULES` / `DEMO_RULES` in
`js/edition.js`:

```js
export const ACTIVITY_RULES = Object.freeze({
  isDemo: true,
  levels: ['tutorial', 'grandma'],
  difficulties: ['chill'],          // new knob (D5)
  weeklyRoad: false, ranked: false,
  slingshot: { enabled: false },    // D6
  tourist: false,
  rideTogether: true,               // D7
  versus: false,                    // D7
  phoneFirst: true,
});
```

It's turned on by `?activity=1` (and later by the Discord wrapper), carried
across join links like `demo`/`media` via `CARRIED_PARAMS`.

## 7. Discord Activity (P5): what the dice/roulette Activities taught us

These are facts from `discord-activity-dice` and `discord-activity-roulette`,
which already ship a phone remote inside Discord.

- **Motion does not work inside a Discord Activity.** Discord's iframe doesn't
  pass the accelerometer and gyroscope permissions through, on desktop or on
  Discord mobile. So a phone remote is **required** for motion steering in
  Discord. Even a player running the Activity on their phone has to steer
  from a page opened in the phone's normal browser.
  - On Discord mobile, an **"Open on this phone"** button calls
    `sdk.commands.openExternalLink(link)`.
  - `capabilities.ts` in dice is the detection to reuse.
- **The phone page runs in the phone's browser, not in Discord.** The QR must
  use the public origin, because `location.origin` inside Discord is
  `*.discordsays.com`. The phone never sees Discord identity; it is bound to a
  seat by a pad id the host gave it.
- **Use the relay, not WebRTC, inside Discord.** P2P through the sandbox isn't
  reliable, and that's why §3.4 is WebSocket-only. Game traffic goes through
  `/.proxy/...` URL mappings in the Discord portal. Note that RIDE TOGETHER's
  PeerJS path would need the same mapping or a relay-only mode.
- **Pairing to copy** (dice `src/remote/link.ts`, `identityKey.ts`):
  - The link is `…/remote/?pad=<id>#k=<secret>`. The secret lives in the `#`,
    so it never reaches servers or link-preview bots; the page moves it to
    `sessionStorage` and removes it from the URL.
  - The relay checks `id = SHA256(secret)`.
  - **New link** issues a new secret, so old QR codes stop working.
  - Make the QR locally (dice uses `uqr`; we already ship `qrcode`), because
    Discord's CSP blocks QR services and an external service would see the
    secret.
- **Phone housekeeping to copy** (dice `src/remote/main.ts`):
  - Call `requestPermission()` inside the "Tap to connect" click before any
    `await`.
  - Re-request the wake lock on `visibilitychange`.
  - Ping every 5 s, and reconnect with backoff (0.5 s doubling, capped at
    8 s).
  - The relay evicts sockets silent for 16 s. (Not built: rooms expire 30
    minutes after the last socket leaves. Instead the phone redials when it
    has heard nothing, not even a pong, for two pings, and when it comes back
    from a lock with a socket that has been quiet for 3 s.)
  - Handle screen rotation with `screen.orientation.angle`. Orientation lock
    isn't available.
- **No text fields on the phone page.** iOS "Shake to Undo" pops up after
  typing, and for us shaking is steering. Roulette had to reload the page
  after the name entry. The pad page has no text input at all; names come
  from the host.
- **Never stall on a dropped phone.** Dice has a "Quick roll" fallback. Ours
  is pause + QR again (§3.3), and keyboard/gamepad still work at any time.
- **Test on the deployed HTTPS site.** Motion and WebCrypto need it. Headless
  e2e uses a stand-in `DeviceMotionEvent` (dice `scripts/e2e-remote.mjs`).
- **Each Discord participant runs their own Activity.** Two friends in a
  voice channel means two game screens, so co-op there is **RIDE TOGETHER
  between the two Activity instances, each with a phone remote**. One shared
  screen with two phones would be couch co-op (P4) and needs only one
  Activity.
- **Reusable code:** the dice relay DO (`worker/src/index.ts`, `peers.ts`,
  `roomTicket.ts`), the client relay (`src/net/relay.ts`), and
  `src/platform/discord.ts` / `env.ts` / `capabilities.ts`. Either port them
  into `worker/relay.js` as `PadRoom`, or point the game at the dice relay
  Worker. That choice is D9.

## 8. Phases (each one a PR, each tested before the next)

| # | Phase | Done when |
|---|---|---|
| P0 | **This design** | Pete signs off D1–D10 |
| P1 | `PadRoom` relay + `remote/` page + `RemoteInputSource` for **Player 1, ride only** | solo tutorial rideable from a real phone; smoke test with synthetic motion frames |
| P2 | Menu mode + host→phone `mode` / `cue` + reconnect/pause | whole lobby → ride → results with no keyboard |
| P3 | Settings + phone-first "Grab your phone" flow + `ACTIVITY_RULES` | `?activity=1` shows the cut-down demo, phone first |
| P4 | Extra seats by phone (#416 Controllers panel) | couch co-op with 2 phones |
| P5 | Discord Activity wrapper: SDK auth, `/.proxy` mappings, "Open on this phone", relay-only RIDE TOGETHER | playable inside Discord with phones |

## 9. Decisions for Pete

| # | Question | Recommendation |
|---|---|---|
| D1 | Phone remote is its own thing (pad room), separate from RIDE TOGETHER, and works alongside it? | **Yes** |
| D2 | Menus from the phone: **D-pad + OK/Back** (works everywhere now) or **mirror the menu buttons as a tappable list** on the phone (nicer, but every screen needs work)? | **D-pad + OK/Back** for v1; mirror later if playtests want it |
| D3 | Ride grip: phone held **landscape like handlebars**, thumbs on the two halves (same as playing on the phone today)? | **Yes** |
| D4 | Phone-first only in the Activity/demo build, with Auto staying the default in the full game? | **Yes** |
| D5 | Difficulty: **Chill only**, or Chill + Adventurous? | **Chill only.** No crashes, so relay lag can't knock you down, and it's simplest to teach |
| D6 | Slingshot in the Activity demo? It has no pedaling, so the phone would need an aim/pull gesture. | **Out** for the Activity build |
| D7 | In the Activity build: RIDE TOGETHER **in**, VERSUS **out** for now? | **Yes**; VERSUS with several phones later (P4+) |
| D8 | Where the phone page lives: `tandemonium.jimandi.love/remote/` (same origin as the game, so the PR preview tests it too) | **Yes** |
| D9 | Relay: a new `PadRoom` in our `worker/relay.js` (porting the dice ideas), or reuse the dice relay Worker as-is? | **New `PadRoom` in our worker.** One deploy, no cross-project coupling |
| D10 | Discord co-op = RIDE TOGETHER between two Activity windows (each with a phone), with one shared screen + two phones (couch) later? | **Yes** |

## 10. Phase 1 — built (this branch)

| Piece | File |
|---|---|
| Wire format, pairing link, codes, secret hash | `js/remote/pad-protocol.js` |
| Tilt mapping shared by game + phone | `js/tilt-math.js` (`InputManager` now uses it) |
| Remote hooks on the seat's input | `InputManager.feedRemoteTilt / setRemotePedals / detachRemote` |
| Game side | `js/remote/phone-pad-host.js`, panel `js/remote/phone-pad-ui.js` |
| Phone page | `remote/index.html` + `js/remote/phone-pad.js` |
| Relay | `worker/pad-relay.js` + `worker/wrangler-pad.toml` |
| Tests | `test/unit/phone-pad.test.mjs`; `npm run smoke:phone-pad` (local relay via `wrangler dev`, two headless browsers) |

**Entry (Phase 1 only):**
- **📱 Phone as controller** on the mode screen opens a QR panel for Player 1.
- The panel closes itself once the phone connects.
- The phone shows CONNECT (the iOS motion prompt), then LEFT | RIGHT pedal
  halves, a ↻ Recenter button, and a "turn sideways" prompt in portrait.

**If the phone drops:** no frame for 1 s, or the phone leaves, releases the
pedals and the lean. Keyboard and gamepad keep working. Phase 2 adds the
pause + QR prompt.

**Deploy:** `cd worker && npx wrangler deploy --config wrangler-pad.toml`.
Until it's live, the preview's QR opens the phone page, but the phone can't
connect.

## 11. Phase 2: built (this branch)

**Menus from the phone.**
- The game tells the phone what to show each frame (`Game._syncPhonePad`):
  - **pedals** in `countdown`, `calibrating`, `playing` and the finish cinematics;
  - the **menu pad** everywhere else, and whenever the options overlay is open (that overlay is the pause).
- **Menu pad layout:** a D-pad on the left, with OK and BACK on the right, like holding a gamepad.
- The phone sends menu buttons as *held* bits. While the menu pad is up, `InputManager.setRemoteNav` makes Player 1's input report a gamepad: `mergeRemoteNavPad` maps the D-pad to 12–15, OK/BACK to A/B (honouring the A/B swap) and Pause to Start.
  - So every lobby step, overlay and the "tap to start" screen work through the existing `FocusController`, with no per-screen phone code.
  - While riding, the phone is *not* a pad, so ride-time checks such as the "Alternate LB/RB" hint are unchanged.
- **Held-button rule:** buttons held when the mode switches are ignored until they're released, so the Pause press that opens the menu can't also press Start and close it.
- **Shortest press:** the phone keeps every menu press down for at least 100 ms, so the once-a-frame menu poll never misses a quick tap.

**Relay hardening (review, 2026-10-19).**
- **Host key:** the first host socket claims the room with a random key (`?k=`, stored as SHA-256). Later host connections must present the same key, so someone with only the 6-letter code can't take the game's place.
- **Same pairing, no kick:** the host re-sends `allow` on every reconnect. The relay drops the seat's phone only when the hash actually changes, so a blip on the game's link doesn't unpair the phone.
- **Rate limit:** a token bucket per socket (90 messages/s, burst 180) drops floods. The room TTL refresh writes storage at most once a minute.
- **Short silences:** after 400 ms with no frame, held pedals and menu buttons are released. Frames resuming take over again. The 2 s rule below still decides a drop.

**Pause and disconnect.**
- **⏸ Pause** on the phone opens the options overlay; BACK resumes.
- **If a connected phone drops** (closed, asleep, or silent for 2 s while the game is running freely; a game freeze or a blip on the game's own relay link does not count):
  - In solo, local or versus play, the ride pauses (options overlay).
  - The QR panel comes back as **PHONE DISCONNECTED**.
- **When the phone returns:** it reconnects by itself on `visibilitychange`, and the panel closes. The game stays paused until the player presses BACK on the phone.
- **Online rides** (captain or stoker) only show the panel. They don't pause, because the partner keeps riding.

**Cues.** The phone plays a short tone and, on Android, a buzz for:
- `countdown` and `go`;
- `crash` (from `_playCrash`);
- `finish` (victory / versus results).

**Tests.**
- `phone-pad.test.mjs` has 23 tests.
- `smoke:phone-pad` now drives the whole SOLO run from the phone: D-pad + OK through the lobby, START RIDE, pedals, Pause/BACK, a mid-ride drop with reconnect, and release on close.
