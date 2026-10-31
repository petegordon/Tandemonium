# HID fixtures for `smoke:webhid`

Real WebHID captures, copied from the controller lab so the game's CI does not
need a lab checkout:

- Source: `UsersFirst/tandemonium-controller-lab`, `packages/core/test/fixtures/`
  at commit `87ca1bd0d3e19137216e9cde5684a21069843d1e` (2026-06-12). The lab's
  `fixtures/README.md` describes each capture.
- Trimmed to the steps the smoke replays: `at-rest` for every file, plus
  `face-buttons` for the Steam Controller Puck. Report bytes are untouched.

| File | Device |
|---|---|
| `gamesir-super-nova-ds4_054c-09cc.json` | GameSir Super Nova in DS4 mode (spoofs Sony 054c:09cc), USB |
| `sony-dualshock4-v1-bt_054c-05c4.json` | Sony DualShock 4 v1, Bluetooth (input report 0x11) |
| `steam-controller-puck_28de-1304.json` | Steam Controller 2026 via the wireless Puck, report 0x45 |

There is no real DualSense capture in the lab yet; `smoke:webhid` builds
DualSense USB reports at the driver's documented offsets instead. Replace that
with a capture when one exists.

To refresh: re-run the copy with the same step filter and update the commit above.
