# RangeLab · ESP32 Configuration Studio

A cross-platform desktop workbench for ESP32-WROOM, ELRS/CRSF telemetry bridges and ESP-FC-style CLI workflows. The application is built with React + TypeScript and packaged as a native desktop app with Tauri 2 and Rust serial I/O. The interface uses system fonts and does not require external font requests at runtime.

## Current capabilities

- Native serial-port discovery, connect/disconnect, baud selection and streamed serial output.
- Live parsing for the ASCII bridge lines `CH,...`, `LINK,...` and `STATUS,...`.
- 16-channel pulse monitor with range status and live update timestamps.
- Range editor for `input_min`, `input_mid` and `input_max`, plus validated profile import/export and profile selection.
- CLI console with session history, Up/Down command recall and log export.
- Firmware-family identification from received output, with a read-only `version` probe. Range writes are blocked when the app identifies Betaflight or a telemetry-only bridge; unknown firmware requires confirmation.
- Editable, cancellable command macros for repeatable read/diagnostic workflows, limited to 100 commands per run and guarded before destructive commands such as `save`, `reboot`, and `defaults`.
- Diagnostics page with raw serial data and transport state.
- GitHub Actions matrix for Windows and Apple Silicon / Intel macOS builds.

## Important protocol note

RangeLab currently supports the ASCII telemetry bridge format emitted by the user's ESP32 monitor sketch. It does **not** claim to decode raw CRSF frames directly from USB. The ESP32 firmware/bridge must decode the receiver UART and forward lines such as:

```text
CH,1500,1500,1000,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500,1500
LINK,-68,92,9
STATUS,receiver online
```

The CLI is a raw serial console. Range writes send `set input_min`, `set input_mid`, and `set input_max` commands, but they do not automatically save or reboot. Review the device's response before issuing `save` manually.

## Requirements

- Node.js 20+ (Node 22 recommended)
- Rust stable toolchain
- Tauri 2 platform prerequisites

See the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the OS-specific native dependencies.

## Run in development

```bash
npm install
npm run desktop:dev
```

For a UI-only browser preview (serial access disabled):

```bash
npm run dev
```

## Build a native installer

```bash
npm install
npm run desktop:build
```

Tauri places the platform-specific installer in `src-tauri/target/release/bundle/`. Windows produces an NSIS installer; macOS produces a DMG. For a distributable signed app, code signing/notarization credentials are still required by the respective platforms.

## Architecture

- `src/App.tsx`: UI, navigation, profile editor, CLI and macro runner.
- `src/lib/protocol.ts`: ASCII bridge parser and telemetry state.
- `src/lib/firmware.ts`: conservative firmware-family detection from received serial output.
- `src-tauri/src/main.rs`: native serial port listing, reader thread and write commands.
- `src-tauri/icons/`: native Windows and macOS application icons.
- `.github/workflows/build-desktop.yml`: CI build matrix.

## Tests

Run the protocol parser tests with Node 22:

```bash
npm test
```

The current test suite contains 12 tests across telemetry parsing, profile validation/import and firmware identification. The GitHub Actions workflow runs these tests before packaging and uploads the generated installer bundles as downloadable workflow artifacts for 14 days.

## Build status

This repository contains the source project and native packaging configuration, not precompiled installers. A build has not been executed in this environment because the Rust toolchain is unavailable and dependency installation did not complete. The included CI workflow can compile macOS (Apple Silicon and Intel) and Windows packages when run in GitHub Actions.

## Next milestones

1. Add an MSP transport and capability handshake so Betaflight-compatible firmware can expose supported tabs and settings without guessing.
2. Add a versioned device adapter interface for ESP-FC, the ASCII bridge, and future custom firmware.
3. Persist profiles and macros to disk, with import validation and schema migrations.
4. Add a verified firmware parameter map, per-channel ranges, AUX mode ranges, and explicit diff/apply/save/rollback workflow.
5. Add tests with recorded serial fixtures and a virtual-device simulator.
