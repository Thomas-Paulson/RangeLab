# Troubleshooting

- **No serial port:** use a USB data cable, install the USB-UART driver required by your board, then refresh ports. Close Arduino Serial Monitor before connecting RangeLab.
- **Port is busy:** only one application can usually own a serial port at a time. Close Serial Monitor and other serial tools.
- **No RC frames:** check receiver CRSF TX -> ESP32 GPIO16, common ground, receiver power, and the receiver's CRSF output configuration.
- **Link statistics absent:** channel data can arrive without every receiver exposing link statistics in the same way. Check raw device log output.
- **Outputs remain disabled:** this is intentional on boot and during receiver loss. Confirm the live channels and mappings before enabling.
- **Native app fails to build:** check Node.js, Rust and the Tauri platform prerequisites in the official Tauri 2 documentation.
