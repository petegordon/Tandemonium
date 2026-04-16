# Tandemonium Screen Flow

## Lobby Screens (Steps)

```
#lobby-mode    — Solo / Ride Together
#lobby-role    — Captain / Stoker (multiplayer only)
#lobby-host    — Captain waiting room (room code, QR)
#lobby-join    — Stoker join room (code input)
#lobby-room    — Social room (video circles, PLAY GAME)
#lobby-level   — Level + difficulty selection (shared by solo + multiplayer)
```

## Game Overlays

```
#victory-overlay       — Finish screen (YOU MADE IT! + stats)
#gameover-overlay       — Crash screen (RESTART + options)
#stoker-cta-overlay     — Steam wishlist prompt (stoker only, unlicensed)
#demo-end-overlay       — Demo limit (currently disabled)
#tutorial-complete      — Tutorial finish (calibration results + steering feel)
```

## Game States

```
lobby        — lobby visible, game loop renders static scene
instructions — "tap to start" overlay (solo/captain; stoker shows "Waiting for captain...")
waiting      — stoker waiting for captain's EVT_COUNTDOWN (tutorial only)
calibrating  — motion/gyro calibration in progress (both captain + stoker)
countdown    — 3-2-1 countdown
playing      — active gameplay
gameover     — crash overlay or tutorial complete
victory      — finish overlay
```

## Video PiP Architecture

```
PiP elements (#selfie-pip-wrap, #partner-pip-wrap) live in <body> PERMANENTLY.
They are NEVER moved via appendChild. Layout is CSS-only:

  pip-lobby-mode class:  position: fixed, centered on screen, z-index: 56
  No class (in-game):    position: fixed, bottom corners, z-index: 11
  Base CSS:              display: none (hidden until explicitly shown)

Streams are set up ONCE in _startRoomMedia() on initial room entry.
They flow continuously through game → room → game without disruption.
Streams are only torn down on disconnect or END RIDE (_returnToLobby).

  DO NOT: re-assign srcObject during room↔game transitions
  DO NOT: call initiateCall() during game start
  DO NOT: use appendChild to move PiP elements
```

---

## Solo Flow

```
MODE ──[SOLO RIDE click]──> LEVEL/DIFFICULTY
                                │
                     [START RIDE click]
                                │
                                v
                          INSTRUCTIONS
                          "tap to start"
                                │
                          [tap/click]
                                │
                ┌───[has motion?]───┐
                │ yes               │ no
                v                   v
          CALIBRATION          COUNTDOWN
                │               3-2-1
                v                  │
            COUNTDOWN              │
             3-2-1                 │
                │                  │
                v                  v
              PLAYING ◄────────────┘
                │
        ┌───────┴───────┐
        v               v
    GAME OVER         VICTORY
    (crash)           (finish)
        │               │
        ├─[RESTART]──────> COUNTDOWN (same level)
        ├─[END RIDE]─────> MODE
        │               ├─[PLAY AGAIN]──> COUNTDOWN (same level)
        │               ├─[NEXT LEVEL]──> LEVEL/DIFFICULTY
        │               └─[END RIDE]────> MODE
        └───────────────┘
```

## Solo Tutorial Flow

```
MODE ──[SOLO RIDE]──> LEVEL ──[select Tutorial]──[START RIDE]
                                    │
                                    v
                              CALIBRATION
                              (3 phases of measurement)
                                    │
                                    v
                               COUNTDOWN
                                 3-2-1
                                    │
                                    v
                               PLAYING
                        (with coaching UI:
                         phase prompts,
                         dodge arrows,
                         collect indicators,
                         off-road warnings)
                                    │
                           [all 3 phases done]
                                    │
                                    v
                          TUTORIAL COMPLETE
                          "You're ready to ride!"
                          [calibration results]
                          [steering feel slider]
                          [Let's RIDE! button]
                                    │
                              [Let's RIDE!]
                                    │
                                    v
                          _endTutorialRide()
                          (solo: no net)
                                    │
                                    v
                             LEVEL/DIFFICULTY
                           (or MODE for demo)
```

---

## Multiplayer Rejoin Flow

```
MODE ──[RIDE TOGETHER click]──> _handleRejoinCheck()
                                    │
                           [any recent rooms? (5 min)]
                                    │
                    ┌───────────────┴───────────────┐
                    │ yes                           │ no
                    v                               v
            RECENT ROOMS POPUP                  ROLE STEP
            (room cards + New Room)             (normal flow)
                    │
         ┌──────────┴──────────┐
         │ select room         │ New Room
         │                     │
         v                     v
   REJOIN FLOW              ROLE STEP
   (skip role selection)    (normal flow)
         │
    ┌────┴────┐
    │ captain │ stoker
    v         v
   HOST      JOIN
   step      step
    │         │
    v         v
  enterRoom(code, role)
    │
  [partner connects]
    │
    v
   ROOM
```

## Multiplayer Captain Flow

```
MODE ──[RIDE TOGETHER]──> ROLE (or REJOIN if recent rooms)
                            │
                     [START A RIDE]
                            │
                            v
                          HOST
                     "Your room code: XXXX"
                     [QR code + URL]
                     waiting for partner...
                            │
                   [stoker joins relay]
                            │
                            v
                          ROOM
                   [video circles]
                   [PLAY GAME button]       ◄───────────────────────┐
                            │                                       │
                      [PLAY GAME]                                   │
                            │                                       │
                   sends {playGame} to stoker                       │
                   sends {difficultySync}                           │
                            │                                       │
                            v                                       │
                     LEVEL/DIFFICULTY                                │
                   [select level]────> sends {levelSync}            │
                   [select difficulty]─> sends {difficultySync}     │
                            │                                       │
                      [START RIDE]                                   │
                   (blocked if !connected)                          │
                            │                                       │
                   sends {startRide} to stoker                      │
                            │                                       │
                            v                                       │
                      INSTRUCTIONS                                  │
                      "tap to start"                                │
                            │                                       │
                      [tap/click]                                   │
                            │                                       │
              ┌───[has motion?]───┐                                 │
              │ yes               │ no                              │
              v                   v                                 │
        CALIBRATION          COUNTDOWN                              │
              │               3-2-1                                 │
              v                  │                                  │
          COUNTDOWN              │                                  │
           3-2-1                 │                                  │
              │                  │                                  │
              v                  v                                  │
         ┌────┴──────────────────┘                                  │
         │                                                          │
         ├──> sends EVT_COUNTDOWN to stoker                         │
         v                                                          │
       PLAYING                                                      │
         │                                                          │
         ├──[checkpoint]────> sends EVT_CHECKPOINT                  │
         │                                                          │
   ┌─────┴─────┐                                                   │
   v            v                                                   │
GAME OVER    VICTORY                                                │
(crash)      (finish)                                               │
   │            │                                                   │
   │  sends     │  sends {finishStats}                              │
   │  EVT_      │  sends EVT_FINISH                                 │
   │  GAMEOVER  │                                                   │
   │            │                                                   │
   ├─[RESTART]──┴──> sends EVT_RESET ──> COUNTDOWN                 │
   │                                                                │
   ├─[RETURN TO ROOM]──> sends EVT_RETURN_ROOM ¹                   │
   │         │                                                      │
   │         └──> _returnToRoom() ──> showRoom() ──────────────────>┘
   │
   └─[END RIDE]──> _returnToLobby() ──> MODE (destroys connection)

   ¹ EVT_RETURN_ROOM guard: only sent if state !== 'lobby'
     (prevents infinite echo loop between captain and stoker)
```

## Multiplayer Captain Tutorial Flow

```
ROOM ──[PLAY GAME]──> LEVEL ──[select Tutorial]──[START RIDE]
                                    │
                           sends {startRide}
                                    │
                                    v
                          _startTutorialRide()
                                    │
                               SCENE SETUP
                            (_startCountdown)
                     suppress EVT_COUNTDOWN to stoker
                                    │
                        ┌───[has motion?]───┐
                        │ yes               │ no
                        v                   v
                  CALIBRATION          COUNTDOWN
                        │               3-2-1
                        v                  │
                    COUNTDOWN              │
                     3-2-1                 │
                        │                  │
                        v                  v
                   ┌────┴──────────────────┘
                   │
                   ├──> sends EVT_COUNTDOWN to stoker
                   v
                 PLAYING
              (runs _updateTutorial:
               phase checks, coaching UI,
               crash handling, collectibles,
               obstacle pass tracking)
                   │
              [all 3 phases done]
                   │
                   v
            _tutorialComplete()
          sends EVT_FINISH to stoker
                   │
                   v
          TUTORIAL COMPLETE
          "You're ready to ride!"
          [calibration results]
          [steering feel slider]
          [Let's RIDE! button]
                   │
             [Let's RIDE!]
                   │
                   v
          _finishTutorial()
                   │
                   v
          _endTutorialRide()
          (has net → multiplayer)
                   │
                   v
          _returnToRoom()
          sends EVT_RETURN_ROOM ¹
                   │
                   v
                 ROOM
           (second ride possible)
```

---

## Multiplayer Stoker Flow

```
MODE ──[RIDE TOGETHER]──> ROLE (or REJOIN if recent rooms)
                            │
                      [JOIN A RIDE]
                            │
                            v
                          JOIN
                    [enter room code]
                    [JOIN button]
                            │
                     [relay connected]
                            │
                            v
                          ROOM
                   [video circles]
                   "Waiting for captain..."    ◄────────────────────┐
                            │                                       │
                   receives {playGame}                              │
                            │                                       │
                            v                                       │
                     LEVEL/DIFFICULTY                                │
                   (read-only, opacity 0.7)                         │
                   "Waiting for captain..."                         │
                            │                                       │
                   receives {levelSync} ──> highlights level        │
                   receives {difficultySync} ──> highlights diff    │
                            │                                       │
                   receives {startRide}                             │
                            │                                       │
                            v                                       │
                   _transitionToGame()                              │
                   startMultiplayer(net, 'stoker')                   │
                            │                                       │
                            v                                       │
                      INSTRUCTIONS                                  │
                   "Waiting for captain..."                         │
                            │                                       │
                   receives EVT_COUNTDOWN                           │
                            │                                       │
                            v                                       │
                       COUNTDOWN                                    │
                         3-2-1                                      │
                            │                                       │
                   receives EVT_START                               │
                            │                                       │
                            v                                       │
                        PLAYING                                     │
                   (interpolates captain state,                     │
                    sends pedal taps + lean at 20Hz)                │
                            │                                       │
              ┌─────────────┴───────────────┐                       │
              v                             v                       │
    receives EVT_GAMEOVER          receives EVT_FINISH              │
              │                             │                       │
              v                             v                       │
          GAME OVER                      VICTORY                    │
          (crash)                        (finish)                   │
              │                             │                       │
              │                        [6s delay if unlicensed      │
              │                         + not Steam]                │
              │                             │                       │
              │                        STOKER CTA ²                 │
              │                        "Great ride!"                │
              │                        [Steam wishlist]             │
              │                        [CONTINUE]                   │
              │                             │                       │
              │ receives EVT_RESET ──> COUNTDOWN                    │
              │                             │                       │
              │ receives EVT_RETURN_ROOM    │ receives              │
              │         │                   │ EVT_RETURN_ROOM       │
              │         v                   │ (or CONTINUE click)   │
              │  _returnToRoom()            │         │             │
              │         │                   │  _returnToRoom()      │
              │         v                   │         │             │
              │      showRoom() ────────────┘──> showRoom() ───────>┘
              │
              └─[END RIDE]──> _returnToLobby() ──> MODE
                              (destroys connection)

   ² Stoker CTA: only shows for unlicensed stokers (not Steam).
     CONTINUE button calls _returnToRoom() if connected, else _returnToLobby().
     Does NOT block EVT_RETURN_ROOM from captain — if captain returns first,
     stoker auto-returns (CTA is dismissed).
```

## Multiplayer Stoker Tutorial Flow

```
receives {startRide}
(with _forceWizard = true from earlier {levelSync})
              │
              v
       _startTutorialRide()
              │
              v
        SCENE SETUP
       (_startCountdown)
              │
    ┌───[has motion?]───┐
    │ yes               │ no
    v                   v
CALIBRATION          WAITING
(stoker calibrates   "Waiting for
 lean/tilt input)     captain..."
    │                    │
    v                    │
 WAITING                 │
"Waiting for             │
 captain..."             │
    │                    │
    └────────┬───────────┘
             │
    receives EVT_COUNTDOWN
    (captain finished calibrating)
             │
             v
         COUNTDOWN
           3-2-1
             │
    receives EVT_START
             │
             v
          PLAYING
    (stoker coaching UI:
     phase prompts,
     dodge arrows,
     collect indicators)
    (sends pedal + lean)
             │
    receives EVT_FINISH
    (captain completed all 3 phases)
             │
             v
    STOKER TUTORIAL COMPLETE
    "Great teamwork!"
    [steering feel slider]
    [Continue button]
             │
         [Continue]
             │
             v
      _endTutorialRide()
      (has net → multiplayer)
             │
             v
      _returnToRoom()
             │
             v
           ROOM
      (second ride possible)
```

---

## Victory Screen Buttons

| Button | ID | Shown When | Action |
|--------|----|-----------|--------|
| PLAY AGAIN | `btn-play-again` | Always | Captain/solo: `_resetGame()` → COUNTDOWN. Stoker: send EVT_RESET, show "Waiting..." |
| NEXT LEVEL | `btn-next-level` | Next level exists | Load next level, `_resetGame()` → COUNTDOWN |
| RETURN TO ROOM | `btn-victory-room` | Multiplayer (`this.net`) | `_returnToRoom()` → ROOM |
| END RIDE | `btn-victory-lobby` | Always | `_returnToLobby()` → MODE (destroys connection) |

Accent style (green) goes to NEXT LEVEL if visible, otherwise PLAY AGAIN.

## Game Over Screen Buttons

| Button | ID | Shown When | Action |
|--------|----|-----------|--------|
| SAVE CLIP | `btn-gameover-clip` | Recording buffer active | `recorder.saveClip()` |
| RESTART | `btn-restart` | Always (accent) | Captain/solo: `_resetGame()`. Stoker: send EVT_RESET |
| SKIP CHECKPOINT | `btn-skip-checkpoint` | DDA recommends + solo only | Skip to next checkpoint |
| RETURN TO ROOM | `btn-gameover-room` | Multiplayer (`this.net`) | `_returnToRoom()` → ROOM |
| END RIDE | `btn-gameover-lobby` | Always | `_returnToLobby()` → MODE |

---

## Return Flow Summary

| Function | Called By | Keeps Connection | Destination |
|----------|----------|-----------------|-------------|
| `_returnToRoom()` | RETURN TO ROOM button; receives EVT_RETURN_ROOM; `_endTutorialRide()` in MP; Stoker CTA CONTINUE | Yes | `showRoom()` → ROOM |
| `_returnToLobby()` | END RIDE button (any role/mode) | No (destroys net) | `show()` → MODE |
| `_endTutorialRide()` | Let's RIDE! / Continue button | MP: Yes (via `_returnToRoom`); Solo: No | MP: ROOM; Solo: LEVEL/MODE |

## Handler Registration Table

| Phase | `onRemoteStream` | `onProfileReceived` | `onEventReceived` |
|-------|-----------------|--------------------|--------------------|
| Initial room entry | Lobby: set srcObject + play | `_handleRoomMessage` | N/A |
| During game | Game: `recorder.setPartnerStream` | Game handler (game.js) | Game handler (game.js) |
| Return to room | Lobby: set srcObject + play | `_handleRoomMessage` | Game handler persists |

## Message Protocol — Captain → Stoker

| Message | Type | When Sent | Stoker Action |
|---------|------|-----------|---------------|
| `{playGame}` | Profile | Captain clicks PLAY GAME | `_showRoomLevelsStep()` → level step |
| `{levelSync}` | Profile | Captain selects a level | Highlight level, set `_forceWizard` if tutorial |
| `{difficultySync}` | Profile | Captain changes difficulty | Update difficulty selection |
| `{startRide}` | Profile | Captain clicks START RIDE | `_transitionToGame()` → enter game |
| `{bikeSync}` | Profile | Player changes bike | Notify partner of bike selection (display only — each player picks independently) |
| `{cameraToggle}` | Profile | Captain toggles camera | Show/hide partner video PiP |
| `EVT_COUNTDOWN` | Event | Captain countdown starts | `_startCountdown()` |
| `EVT_START` | Event | Captain countdown reaches 0 | Set state to `playing` |
| `EVT_CHECKPOINT` | Event | Captain passes checkpoint | Show checkpoint flash |
| `EVT_GAMEOVER` | Event | Captain crashes | Show game-over screen |
| `EVT_FINISH` | Event | Captain finishes race/tutorial | Show victory or tutorial complete |
| `EVT_RESET` | Event | Captain restarts after crash | Reset game, new countdown |
| `EVT_RETURN_ROOM` | Event | Captain clicks RETURN TO ROOM ¹ | `_returnToRoom()` → ROOM |

¹ Guard: only sent if `state !== 'lobby'` (prevents infinite echo loop)

## Message Protocol — Stoker → Captain

| Message | Type | Frequency | Captain Action |
|---------|------|-----------|----------------|
| Pedal tap | Binary (MSG_PEDAL) | On edge-detect | Feed to SharedPedalController |
| Lean value | Binary (MSG_LEAN) | 20Hz | Average with captain's lean for steering |
| `{cameraToggle}` | Profile | On toggle | Show/hide partner video PiP |
| `{tiltStatus}` | Profile | On motion detect | Track partner's tilt capability |
| `{bikeSync}` | Profile | Player changes bike | Notify partner of bike selection (display only — each player picks independently) |

## State Sync — Captain → Stoker (during gameplay)

| Data | Type | Frequency | Stoker Usage |
|------|------|-----------|-------------|
| Bike state (46 bytes) | Binary (MSG_STATE) | 20Hz | Interpolate for 60fps rendering |
| Captain lean | Binary (MSG_LEAN) | 20Hz | Display on arch indicator |
| Heartbeat | Binary (MSG_HEARTBEAT) | 1Hz | Connection health check |
