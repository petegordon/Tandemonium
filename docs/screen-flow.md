# Tandemonium Screen Flow

## Lobby Screens

```
#lobby-mode    — Solo / Ride Together
#lobby-role    — Captain / Stoker (multiplayer only)
#lobby-host    — Captain waiting room (room code, QR)
#lobby-join    — Stoker join room (code input)
#lobby-room    — Social room (video, PLAY GAME)
#lobby-level   — Level + difficulty selection (shared by solo + multiplayer)
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

## Multiplayer Captain Flow

```
MODE ──[RIDE TOGETHER]──> ROLE
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
                   [video exchange]
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
   ├─[RETURN TO ROOM]──> sends EVT_RETURN_ROOM                     │
   │         │                                                      │
   │         └──> _returnToRoom() ──> showRoom() ──────────────────>┘
   │
   └─[END RIDE]──> _returnToLobby() ──> MODE (destroys connection)
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
          sends EVT_RETURN_ROOM
                   │
                   v
                 ROOM
           (second ride possible)
```

---

## Multiplayer Stoker Flow

```
MODE ──[RIDE TOGETHER]──> ROLE
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
                   [video exchange]
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
              │ receives EVT_RESET ──> COUNTDOWN                    │
              │                             │                       │
              │ receives EVT_RETURN_ROOM    │ receives              │
              │         │                   │ EVT_RETURN_ROOM       │
              │         v                   │         │             │
              │  _returnToRoom()            │  _returnToRoom()      │
              │         │                   │         │             │
              │         v                   │         v             │
              │      showRoom() ────────────┘──> showRoom() ───────>┘
              │
              └─[END RIDE]──> _returnToLobby() ──> MODE
                              (destroys connection)
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

## Return Flow Summary

| Function | Called By | Keeps Connection | Destination | Re-registers Handlers |
|----------|----------|-----------------|-------------|----------------------|
| `_returnToRoom()` | Captain: RETURN TO ROOM button; Stoker: receives EVT_RETURN_ROOM; Both: `_endTutorialRide()` in multiplayer | Yes | `showRoom()` → roomStep | Yes — onProfileReceived, onRemoteStream, onDisconnected |
| `_returnToLobby()` | END RIDE button (any role, any mode) | No (destroys net) | `show()` → modeStep | N/A (no connection) |
| `_endTutorialRide()` | Captain: Let's RIDE! button; Stoker: Continue button | Multiplayer: Yes (delegates to `_returnToRoom`); Solo: No | Multiplayer: roomStep; Solo: levelStep/modeStep | Multiplayer: Yes (via `_returnToRoom`) |

## Handler Registration Table

| Phase | `onProfileReceived` | `onEventReceived` | Set By |
|-------|--------------------|--------------------|--------|
| Initial room entry | `_handleRoomMessage` | N/A (not in game) | `_startRoomMedia()` lobby.js:2932 |
| During game | Game handler (game.js:716) | Game handler (game.js:598) | `startMultiplayer()` game.js:716 |
| Return to room | `_handleRoomMessage` | Game handler persists | `showRoom()` lobby.js:3348 |

## Message Protocol — Captain → Stoker

| Message | Type | When Sent | Stoker Action |
|---------|------|-----------|---------------|
| `{playGame}` | Profile | Captain clicks PLAY GAME | `_showRoomLevelsStep()` → level step |
| `{levelSync}` | Profile | Captain selects a level | Highlight level, set `_forceWizard` if tutorial |
| `{difficultySync}` | Profile | Captain changes difficulty | Update difficulty selection |
| `{startRide}` | Profile | Captain clicks START RIDE | `_transitionToGame()` → enter game |
| `EVT_COUNTDOWN` | Event | Captain countdown starts (or after calibration) | `_startCountdown()` or resume countdown |
| `EVT_START` | Event | Captain countdown reaches 0 | Set state to `playing` |
| `EVT_CHECKPOINT` | Event | Captain passes checkpoint | Show checkpoint flash |
| `EVT_GAMEOVER` | Event | Captain crashes | Show game-over screen |
| `EVT_FINISH` | Event | Captain finishes race/tutorial | Show victory or stoker tutorial complete |
| `EVT_RESET` | Event | Captain restarts after crash | Reset game, new countdown |
| `EVT_RETURN_ROOM` | Event | Captain clicks RETURN TO ROOM | `_returnToRoom()` → room step |

## Message Protocol — Stoker → Captain

| Message | Type | Frequency | Captain Action |
|---------|------|-----------|----------------|
| Pedal tap | Binary (MSG_PEDAL) | On edge-detect | Feed to SharedPedalController |
| Lean value | Binary (MSG_LEAN) | 20Hz | Average with captain's lean for steering |
| `{cameraToggle}` | Profile | On toggle | Show/hide partner video PiP |
| `{tiltStatus}` | Profile | On motion detect | Track partner's tilt capability |

## State Sync — Captain → Stoker (during gameplay)

| Data | Type | Frequency | Stoker Usage |
|------|------|-----------|-------------|
| Bike state (46 bytes) | Binary (MSG_STATE) | 20Hz | Interpolate for 60fps rendering |
| Captain lean | Binary (MSG_LEAN) | 20Hz | Display on arch indicator |
| Heartbeat | Binary (MSG_HEARTBEAT) | 1Hz | Connection health check |
