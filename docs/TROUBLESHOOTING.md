# Troubleshooting

- **No serial port:** use a USB data cable, install the USB-UART driver required by your board, then refresh ports. Close Arduino Serial Monitor before connecting RangeLab.
- **Port is busy:** only one application can usually own a serial port at a time. Close Serial Monitor and other serial tools.
- **No RC frames:** check receiver CRSF TX -> ESP32 GPIO16, common ground, receiver power, and the receiver's CRSF output configuration.
- **Link statistics absent:** channel data can arrive without every receiver exposing link statistics in the same way. Check raw device log output.
- **PWM output is barely visible / almost off at full input:** check the output low/high in the mapping. PWM uses duty values 0–255, so a range like 0–1 is about 0.4% duty and looks nearly off. DIGITAL mode is fixed at 0–1 by the firmware; switching a channel from DIGITAL to PWM now resets the range to 0–255, and apply it again to update the ESP32. The device log shows the exact command, e.g. `SET,3,1000,2000,PWM,33,0,1`.
- **Digital output switches fully on at half stick:** this is intended. DIGITAL is a switch, not a dimmer: it goes high at the input midpoint and low below it.
- **Outputs remain disabled:** this is intentional on boot and during receiver loss. Confirm the live channels and mappings before enabling.
- **Native app fails to build:** check Node.js, Rust and the Tauri platform prerequisites in the official Tauri 2 documentation.
