# Build RangeLab on macOS or Windows

## 1. Install prerequisites

Install Node.js 22 and the current stable Rust toolchain. Then install the platform prerequisites from the official Tauri guide: https://v2.tauri.app/start/prerequisites/.

- **macOS:** Xcode Command Line Tools and the Rust target for your Mac architecture.
- **Windows:** Microsoft C++ Build Tools (MSVC) and WebView2 Runtime. WebView2 is included on most current Windows installations.

## 2. Install JavaScript dependencies

From the `rangelab` folder:

```sh
npm install
```

## 3. Run the native app

```sh
npm run desktop:dev
```

The app should open a native RangeLab window. Connect the ESP32 using USB, choose its serial port at the top-right, select the baud rate under Diagnostics if needed, and press **Connect**.

## 4. Package it

```sh
npm run desktop:build
```

The native installer output is written below `src-tauri/target/release/bundle/`.

## Troubleshooting

- **No serial ports appear:** check the USB cable supports data, install the USB-UART driver for your board, then press refresh.
- **Port opens but no channel bars move:** the current parser expects newline-delimited ASCII `CH,...` lines from the ESP32 USB bridge. Raw binary CRSF is not parsed from the USB connection yet.
- **CLI appears but commands do nothing:** verify the selected port and baud rate. Some ESP-FC builds may need a carriage return or a firmware-specific CLI entry sequence; check the raw output before sending writes.
- **Range commands rejected:** firmware parameter names vary. Inspect the CLI response, and do not issue `save` until the firmware confirms the parameters were accepted.
