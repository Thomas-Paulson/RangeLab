# RangeLab

RangeLab is a standalone native desktop application for monitoring an ExpressLRS/CRSF receiver through an ESP32-WROOM and mapping receiver channels to safe-listed ESP32 GPIO outputs. It is independent of ESP-FC.

## Package contents

- `src/` React + TypeScript desktop interface.
- `src-tauri/` Tauri 2 / Rust native desktop shell and serial-port transport.
- `firmware/RangeLab_ESP32.ino` ESP32-WROOM CRSF receiver bridge and output mapper firmware.
- `mobile/` phone-sized web UI served by the ESP32 over WiFi (no app install).
- `docs/` wiring and build notes.
- `.github/workflows/build-desktop.yml` Windows and macOS build workflow.

## Hardware wiring

1. Flash `firmware/RangeLab_ESP32.ino` to an ESP32-WROOM development board using Arduino IDE 2 and Arduino-ESP32 core 3.x.
2. Connect the receiver's **CRSF TX** to ESP32 **GPIO16 (UART2 RX)** and connect receiver ground to ESP32 ground. Power the receiver from a suitable supply matching its specifications.
3. Connect the ESP32 to the computer over USB. The desktop app communicates at 115200 baud; the receiver UART is configured at 420000 baud.
4. Select the ESP32 serial port in RangeLab and press **Connect**.

The receiver UART wiring is receive-only in this firmware. Do not connect a receiver output to GPIO16 if your board uses that pin for another purpose.

## Run in development

Requirements: Node.js 20 or newer, Rust stable, and the Tauri 2 platform prerequisites for your OS. See https://v2.tauri.app/start/prerequisites/.

```sh
npm install
npm test
npm run desktop:dev
```

## Build a native installer

```sh
npm run desktop:build
```

Installer bundles are created under `src-tauri/target/release/bundle/`. Windows and macOS builds should be built on their respective operating systems. The included GitHub Actions workflow builds Windows and macOS artifacts when run in the repository. The ZIP contains source code and build configuration, not precompiled signed installers.

## Using channel mapping

1. Connect the device and select a channel.
2. Set input min/max, output mode, GPIO and output range.
3. Press **Apply mapping**. The firmware validates and stores each mapping in ESP32 Preferences.
4. Repeat for other channels. One active mapping per GPIO is enforced.
5. Check every mapping and the attached hardware before pressing **Enable outputs**. **Disable now** turns outputs off immediately.
6. Export/import JSON profiles to keep a local copy of settings. Importing a profile changes the editor only; apply mappings to send them to the ESP32.

The supported output modes are `OFF`, `SERVO`, `PWM`, `DIGITAL`, `WINDOW` (output high only while the channel sits inside a user-set band) and `CURVE` (a five-point servo curve you draw per channel). GPIOs are restricted to 13, 14, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32 and 33. The firmware disables outputs on startup and uses a 500 ms receiver timeout. Servo outputs use a 50 Hz LEDC signal, PWM uses 1 kHz 8-bit output, and digital mode switches at the input range midpoint.

## Field logging (no laptop needed)

1. Press **Arm field logging** in the app (or send `LOG START`). Logging is armed immediately and stays armed across ESP32 restarts, so you can unplug it and test in the field.
2. The ESP32 logs channel values and link statistics to its internal flash at 10 Hz.
3. When done, plug it back in and press **Download log**, then **Save CSV**. The file has one row per sample: `millis,ch1…ch16,rssi,lq,snr`.
4. **Clear device log** erases the stored log and disarms logging.

The log wraps at about 1.8 MB (roughly 30–40 minutes at 10 Hz): the oldest data is overwritten and an `OVERFLOW` marker is written, and the app shows a "LOG OVERFLOWED" notice so you know data was replaced. Serial commands: `LOG START`, `LOG STOP`, `LOG DUMP`, `LOG CLEAR`.

## Phone over WiFi (no app, no cable)

This branch adds a WiFi bridge to the firmware so a phone can watch channels and edit
mappings without USB. That matters most for iPhone: iOS has no public USB-serial API, so an
ESP32 plugged into an iPhone can never be read by an app.

1. Flash `firmware/RangeLab_ESP32.ino` (needs the **WebSockets** library by Markus Sattler).
2. On the phone, join the `RANGELAB-XXXX` access point the ESP32 creates (default password
   `rangelab1234` — change `WIFI_AP_PASSWORD` in the sketch).
3. Open **http://192.168.4.1** in Safari or Chrome.

Outputs and mapping writes stay locked until you press **Unlock controls**, and `DISABLE`
is always accepted. The page also shows the link/receiver **event log** the ESP32 keeps in
flash (`RX_SILENT` for a receiver that stopped transmitting, `RF_LINK_LOST` for a lost RF
link, `BOOT` for an ESP32 restart), and can clear it once unlocked. Field-log download
stays on USB. Full setup, safety model and limitations:
[docs/MOBILE_WIFI.md](docs/MOBILE_WIFI.md).

Set `#define RANGELAB_WIFI 0` in the sketch for the original USB-only build.

## Build in the cloud (GitHub Actions)

You do not need a local toolchain. The workflow `.github/workflows/build-desktop.yml` builds everything on GitHub's runners:

1. Push to `main` (or open the Actions tab and run **Build RangeLab desktop apps** manually).
2. Download the artifacts from the completed run: `RangeLab-firmware-esp32` (flashable `.bin`) and `RangeLab-macos-*` / `RangeLab-windows-*` (desktop installers).
3. On first use, the macOS build is unsigned. Either right-click → Open, or clear quarantine with `xattr -dr com.apple.quarantine RangeLab.app`, or add Apple signing secrets (see below) for a fully signed, notarized app.

To sign the macOS app properly, add these repository secrets: `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`. With an Apple Developer account ($99/year) and these set, builds are signed and notarized and open normally.

## Safety and limitations

- This is an RC receiver-to-GPIO mapper, not a flight controller and not a tool for changing ExpressLRS RF/binding settings.
- ESP32 GPIO pins are logic-level signals. Do not power servos, motors, relays or other loads directly from a GPIO. Use suitable driver circuitry and a correctly rated external supply; share ground where required.
- Verify firmware behavior on your specific ESP32 board and receiver before connecting anything capable of causing injury or damage. Test with outputs disconnected first.
- Firmware and application are source-provided; this package has not been compiled and hardware-tested in this environment. The included CI workflow can build the desktop app, but a successful build is not proof of hardware validation.

## Project structure

```text
rangelab/
├── firmware/RangeLab_ESP32.ino
├── firmware/web_assets.h  # generated from mobile/ by `npm run mobile:embed`
├── mobile/               # phone UI served by the ESP32 over WiFi
├── src/                  # React UI and protocol handling
├── src-tauri/            # Native Rust serial transport and Tauri config
├── tests/                # Parser/profile/firmware identification tests
├── docs/                 # Wiring, mobile WiFi and troubleshooting
├── scripts/              # Convenience build scripts
└── README.md
```
