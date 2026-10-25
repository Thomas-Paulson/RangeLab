# RangeLab project status

Updated: 2026-10-25

## Current implementation
- Standalone React + TypeScript desktop interface (single mapping studio view), independent of ESP-FC/Betaflight.
- Tauri 2 / Rust serial backend with port discovery, connect/disconnect, incoming serial events, and serial writes.
- ASCII bridge telemetry parsing for `CH`, `LINK`, `CFG`, `STATUS`, `DEVICE`, and `LOG` lines.
- Sixteen-channel display, per-channel mapping editor, profile export/import (RangeLab-profile-v1).
- Output modes: `OFF`, `SERVO`, `PWM`, `DIGITAL`, `WINDOW` (output high while the channel is inside a band), `CURVE` (5-point servo curve).
- Field logging: arm once over USB (`LOG START`), the ESP32 then logs channel/link samples to internal flash at 10 Hz across restarts, with no laptop attached. `LOG DUMP` reads it back and the app saves it as CSV. When the log fills (~1.8 MB, roughly 30–40 minutes at 10 Hz) the oldest data is overwritten and an `OVERFLOW` marker is recorded and shown in the app.
- Serial ports auto-detect: the app prefers a USB serial device (CP210x/CH340/FTDI/…) and picks it automatically when no port is chosen or the selected one disappears.
- GitHub Actions builds: ESP32 firmware compile (arduino-cli, uploads the `.bin`), and macOS (Apple Silicon + Intel) and Windows desktop bundles.
- macOS signing/notarization is wired in; builds stay unsigned until the Apple secrets are added to the repository.
- Protocol and mapping-validation tests run with Node 22's built-in test runner (`npm test`).
- **WiFi phone bridge (branch `mobile-wifi`):** the firmware raises its own WPA2 access point, serves a phone-sized UI from flash (`mobile/`, embedded into `firmware/web_assets.h` by `scripts/embed-mobile.mjs`) and streams the same ASCII protocol over WebSocket on port 81. The page runs in Safari or Chrome with nothing installed, which is the only route onto an iPhone: iOS exposes no USB-serial API to third-party apps. Outputs and mapping writes stay locked until the page sends `UNLOCK`; `DISABLE` and `GET` are always accepted; controls relock after 10 idle minutes or when the last phone disconnects. `LOG DUMP` is refused while a phone is connected because a full dump is far too large for the bridge.

## Important limitations
- This is source code; the native app and firmware have not been compiled or hardware-tested in this environment. The GitHub Actions workflow is the build path.
- The app talks to the ESP32 over the ASCII bridge protocol only; it does not decode raw CRSF over USB.
- Field logging duration is limited by flash size; the log wraps and marks overflow rather than growing indefinitely.
- LittleFS is used for the field log; use a flash/partition layout that includes a LittleFS partition (default 4 MB boards with the standard scheme work).
- The WiFi bridge has been compiled for `esp32:esp32:esp32` but not run on hardware. Expect some frame loss while WiFi is transmitting; the 500 ms failsafe keeps that safe, but the assumption is unverified.
- The WiFi lock is an accidental-write guard, not authentication. Anyone who joins the access point can unlock and send `ENABLE`; the compiled-in WPA2 password is the only boundary.
- No USB-serial support for phones: Android could use Chrome's Web Serial, iOS cannot use USB at all.

## Next engineering priorities
1. Run GitHub Actions and fix any compile/package errors before treating the app as distributable.
2. Hardware-validate window/curve outputs and field logging with the user's ESP32 + ELRS receiver.
3. Add recorded serial fixtures and a virtual serial-device test harness.
4. Profile schema/version migration for the new `curve` field.
