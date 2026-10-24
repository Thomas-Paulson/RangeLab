# RangeLab agent instructions

## Product goal
Build RangeLab as a polished native macOS + Windows desktop app for the user's ESP32-WROOM and ELRS/CRSF setup. Use React + TypeScript for UI, Tauri 2 + Rust for native serial access, and GitHub Actions for remote builds so the user does not need to install large toolchains locally.

## Hardware and known-good context
- User has an ESP32-WROOM and RadioMaster Pocket transmitter with an ELRS receiver.
- A custom ESP32 CRSF monitor has previously worked with receiver TX -> ESP32 GPIO16 (RX2), ESP32 GPIO17 (TX2 optional), common ground, and 420000 baud on the receiver UART; USB console used 115200 baud.
- The existing ASCII monitor emits `CH,<16 pulse values>`, `LINK,<numeric stats...>`, and `STATUS,<text>` lines. RangeLab currently parses this bridge protocol, not raw CRSF frames directly over USB.
- Current firmware is ESP-FC v0.2.1. It is not vanilla Betaflight; do not assume all Betaflight MSP tabs or CLI settings exist. Known CLI commands include `help`, `dump`, `get`, `param`, `set`, `cal`, `defaults`, `save`, `reboot`, `scaler`, `mixer`, `stats`, `status`, `devinfo`, `version`, and `logs`.
- Existing user configuration included `serial_2 = 64 115200 0`, RX GPIO16, TX GPIO17, and pulse limits around 885 / 1500 / 2115. Treat these as remembered context, not guaranteed universal defaults.
- A separate `betaflight_2026.12.0-alpha_ESP32WROOM.bin` caused a reboot loop. Never flash it automatically or imply it is safe.

## Safety and correctness
- Never write firmware, reboot, reset defaults, or save settings automatically. Require explicit user action and explain irreversible/destructive commands.
- Clearly label simulation. Never present simulated responses as hardware responses.
- Never claim direct raw CRSF support unless it is implemented and tested.
- Validate imported profile JSON and reject invalid pulse ranges before writing commands.
- Keep CLI raw access available for advanced users, but warn before `save`, `reboot`, `defaults`, and firmware-writing commands.
- Keep all hardware writes explicit. Do not silently save after applying ranges.
- Add tests for parsing, validation, command construction, and device adapters. Do not invent ESP-FC parameters.

## Engineering preferences
- Keep the interface clean, dark, responsive, and intuitive. Avoid placeholder buttons and dead controls.
- Prefer small tested modules for protocol parsing, firmware adapters, and profile validation rather than growing one giant component.
- Run `npm test` and `npm run build` when dependencies are available. Run the native Tauri build in GitHub Actions, not on the user's storage-constrained machine.
- Update README and PROJECT_STATUS.md when capabilities or known limitations change.
