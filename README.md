# Tandemonium

<img width="1536" height="1024" alt="image" src="https://github.com/user-attachments/assets/70553ae9-f150-47a7-946a-2dd02b066b9a" />

## Physics Parameters

| # | Parameter | Value | Formula | Description |
|---|-----------|-------|---------|-------------|
| 1 | Input: filter | `0.7` | `gx += (raw - gx) * 0.7` per event | Accelerometer smoothing. 0=frozen, 1=raw |
| 2 | Input: deadZone | `2°` | `if (abs(relative) < 2) relative = 0` | Tilt under this angle is ignored |
| 3 | Input: range | `25°` | `motionLean = clamp(relative / 25, -1, 1)` | Degrees past dead zone for full lean (±1) |
| 4 | Balance: gravity | `4.0` | `sin(lean) * 4.0` | Toppling force from lean angle |
| 5 | Balance: playerLean | `26.0` | `leanInput * 26.0` | Force from device tilt input |
| 6 | Balance: gyro factor | `0.6` | `-lean * min(speed * 0.6, 5.0)` | Gyroscopic stabilization rate per unit speed |
| 7 | Balance: gyro cap | `5.0` | `-lean * min(speed * 0.6, 5.0)` | Max gyroscopic stabilization force |
| 8 | Balance: damping | `1.5` | `-leanVelocity * 1.5` | Resists lean velocity changes |
| 9 | Balance: pedalWobble | `2` | `wobble * (random() - 0.5) * 2` | Random wobble on wrong-foot pedal |
| 10 | Balance: lowSpeedWobble A | `0.3` | `max(0, 1 - speed*0.3) * (sin(t*2.7)*0.3 + sin(t*4.3)*0.15)` | Slow sine wobble amplitude |
| 11 | Balance: lowSpeedWobble B | `0.15` | *(same formula, second term)* | Fast sine wobble amplitude |
| 12 | Balance: lowSpeedWobble fade | `0.3` | `max(0, 1 - speed * 0.3)` | How fast wobble fades with speed |
| 13 | Balance: pedalLeanKick | `0.2` | `(random() - 0.5) * 0.2` | Random lean per pedal stroke |
| 14 | Balance: integration | — | `leanVel += (all forces) * dt; lean += leanVel * dt` | How forces become lean angle |
| 15 | Fall: threshold | `0.85 rad` (49°) | `if (abs(lean) > 0.85) → crash` | Lean angle that triggers crash |
| 16 | Fall: timer | `2.0 s` | seconds before auto-reset | Recovery time after crash |
| 17 | Fall: safetyClamp | `±0.6 rad` (34°) | `lean = clamp(lean, -0.6, 0.6)` | Max lean in safety mode |
| 18 | Speed: friction | `0.6` | `speed *= (1 - 0.6 * dt)` | Speed decay rate per second |
| 19 | Speed: maxSpeed | `16` | `speed = clamp(speed, 0, 16)` | Speed cap |
| 20 | Speed: brakeRate | `2.5` | `speed *= (1 - 2.5 * dt)` | Brake decay rate per second |
| 21 | Speed: brakeStop | `0.05` | `if (speed < 0.05) speed = 0` | Speed snaps to zero below this |
| 22 | Steering: turnRate | `0.35` | `heading += -lean * speed * 0.35 * dt` | How much lean steers the bike |
| 23 | Countdown: previewLean | `11.0` | `leanInput * 11.0` | Tilt force during 3-2-1 countdown |
| 24 | Countdown: previewDamp | `3.5` | `-leanVelocity * 3.5` | Damping during 3-2-1 countdown |
| 25 | Countdown: previewClamp | `±0.6 rad` (34°) | `lean = clamp(lean, -0.6, 0.6)` | Can't crash during countdown |

