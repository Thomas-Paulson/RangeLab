# Wiring quick reference

| Connection | ESP32-WROOM | Receiver |
|---|---|---|
| CRSF serial data | GPIO16 / UART2 RX | TX |
| Ground | GND | GND |
| Power | Use the correct rated supply | Use receiver manufacturer's voltage specification |
| Desktop connection | USB | Not applicable |

CRSF is configured for 420000 baud, 8N1. Desktop USB serial is 115200 baud. The firmware listens for RC channels and link statistics, then emits ASCII `CH,...`, `LINK,...`, `CFG,...`, `DEVICE,...` and `STATUS,...` lines to the desktop app.

Never connect an ESP32 GPIO directly to a servo motor's power lead or a motor. GPIO is for control signals only.
