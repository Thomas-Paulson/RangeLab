# RangeLab project status

Updated: 2026-10-24

## Current implementation
- React + TypeScript interface with Overview, Receiver, Ranges, CLI Console, Automation Lab, Profiles, and Diagnostics pages.
- Tauri 2 / Rust serial backend with port discovery, connect/disconnect, incoming serial events, and serial writes.
- Native macOS and Windows bundle icon assets, including ICNS and ICO formats.
- ASCII bridge telemetry parsing for `CH`, `LINK`, and `STATUS` lines.
- Sixteen-channel display, pulse-range editor, profile export/import, CLI history export, macros, and a hardware-isolated simulator.
- GitHub Actions workflow intended to build macOS Apple Silicon, macOS Intel, and Windows packages.
- Firmware-family identification from received CLI output, distinguishing ESP-FC, Betaflight, an ASCII telemetry bridge, and unknown firmware.
- Read-only firmware probe from the Overview protocol panel.
- Range writes are blocked when the output identifies Betaflight or a telemetry-only bridge; unknown firmware requires explicit confirmation.
- Macro execution is capped at 100 commands, cancellable between commands, and reports how many commands were sent.
- Keyboard shortcuts: Cmd/Ctrl+K focuses the navigation search, Escape closes the mobile navigation, and the CLI input supports Up/Down command history.
- Removed the external Google Fonts import so the app no longer needs a font network request at runtime; the CSP was tightened accordingly.
- Protocol, profile, and firmware-detection tests run with Node 22's built-in test runner.

## Recently improved
- Channel parsing now rejects malformed/non-pulse data instead of filtering bad fields and silently shifting channel positions.
- Parser supports the plain 16-value channel line, `CH,16,<values>`, and indexed channel/value pairs.
- Profile import validates file size, profile count, names, integer ranges, and min < mid < max. It accepts either a profile array or a RangeLab JSON export.
- Profile saving rejects invalid pulse values. Stored browser data is validated before use.
- CLI commands that can save, reboot, reset defaults, erase or flash now require explicit confirmation; macros containing such commands prompt once before running.
- Firmware identification now guards against sending ESP-FC range commands to clearly identified Betaflight or telemetry-only bridge firmware. Unknown firmware prompts before range writes.
- Range commands are sent as separate serial writes rather than a single multi-line payload; execution stops if a write fails.
- Macro execution stops if a command cannot be sent and distinguishes sent commands from confirmed firmware acceptance.
- GitHub Actions runs all Node tests before packaging and uses a dedicated Intel macOS runner for the x86_64 package.

## Important limitations
- This is source code, not a compiled installer.
- The native application has not yet been compiled in this environment. `npm install` did not finish within the available execution window, and Rust tooling is not installed here.
- Real hardware validation has not been performed from RangeLab itself.
- Range writes currently send `set input_min`, `set input_mid`, and `set input_max`. Confirm these parameters exist on the connected firmware before use. ESP-FC support is partial and differs from Betaflight.
- The receiver monitor requires the user's ESP32 ASCII bridge. It does not decode raw CRSF from a USB serial port.

## Next engineering priorities
1. Add a real device-adapter layer with firmware-specific parameter maps and explicit capability negotiation.
2. Add per-command response correlation and report confirmed acceptance versus commands that merely appear to have been sent.
3. Add profile schema/version migration and broader import/export tests.
4. Add recorded serial fixtures and a virtual serial-device test harness.
5. Run GitHub Actions and fix any compile/package errors before treating the app as distributable.
