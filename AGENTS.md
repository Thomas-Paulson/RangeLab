# RangeLab agent instructions

## Product goal
Build RangeLab as a polished native macOS + Windows desktop app for the user's ESP32-WROOM and ELRS/CRSF setup. Use React + TypeScript for UI, Tauri 2 + Rust for native serial access, and GitHub Actions for remote builds so the user does not need to install large toolchains locally.

## Hardware and known-good context
- User has an ESP32-WROOM and RadioMaster Pocket transmitter with an ELRS receiver.
- The firmware is `firmware/RangeLab_ESP32.ino` in this repository, and it is the only firmware RangeLab works with. There is no flight-controller stack anywhere in the product: the sketch's own command set is the complete interface, and nothing outside this repository has to be compatible with it.
- Known-good wiring: receiver CRSF TX -> ESP32 GPIO16 (RX2), ESP32 GPIO17 (TX2, optional), common ground; 420000 baud on the receiver UART, 115200 on the USB console.
- That firmware emits an ASCII line protocol over USB serial and the WiFi bridge — `CH`, `LINK`, `CFG`, `STATUS`, `DEVICE`, `RAIL`, `WIRE`, `EVENT`, `TRACE` — and accepts `GET`, `SET`, `ENABLE`, `DISABLE`, `PING`, `LOG START|STOP|DUMP|CLEAR`, `EVENTS[,CLEAR]`, `TRACE`. RangeLab parses that protocol; it does not speak raw CRSF over USB.
- Channel limits around 885 / 1500 / 2115 µs were measured on this setup once. Treat them as an observation, never as defaults.
- Only ever flash the sketch in this repository. Never flash an image from anywhere else without the user's explicit confirmation; an unrelated ESP32 image caused a reboot loop once.

## Safety and correctness
- Never write firmware, reboot, reset defaults, or save settings automatically. Require explicit user action and explain irreversible/destructive commands.
- Clearly label simulation. Never present simulated responses as hardware responses.
- Never claim direct raw CRSF support unless it is implemented and tested.
- Validate imported profile JSON and reject invalid pulse ranges before writing commands.
- Keep CLI raw access available for advanced users, but warn before `save`, `reboot`, `defaults`, and firmware-writing commands.
- Keep all hardware writes explicit. Do not silently save after applying ranges.
- Add tests for parsing, validation, command construction, and device adapters. Do not invent firmware commands or parameters; the sketch's command set is the whole truth.

## Engineering preferences
- Keep the interface clean, dark, responsive, and intuitive. Avoid placeholder buttons and dead controls.
- Prefer small tested modules for protocol parsing, firmware adapters, and profile validation rather than growing one giant component.
- Run `npm test` and `npm run build` when dependencies are available. Run the native Tauri build in GitHub Actions, not on the user's storage-constrained machine.
- Update README and PROJECT_STATUS.md when capabilities or known limitations change.
