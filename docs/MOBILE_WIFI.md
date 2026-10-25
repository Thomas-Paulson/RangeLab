# RangeLab on a phone over WiFi

This branch adds a **WiFi bridge** to the ESP32 firmware so the phone in your pocket can
watch live channels and change mappings without a cable, an app or an App Store account. It
is the only way to get RangeLab onto an iPhone at all — see [Why not USB](#why-not-usb).

The ESP32 raises its own access point, serves a small phone-sized page from flash, and
streams the same ASCII line protocol it already prints over USB. The desktop app is
unchanged and still works over USB.

## Why not USB

iOS has no public USB-serial API. The only supported route is an MFi-certified accessory
(`ExternalAccessory`), and a generic CP210x/CH340 USB-UART bridge is not one. The ESP32-WROOM
has no native USB device either, so nothing on the wire is MFi. Safari — and every other
iOS browser, since they are all WebKit — also lacks Web Serial and WebUSB.

Android *can* do it: Chrome for Android supports Web Serial. That is a different transport
and not implemented here.

## What you need

- ESP32-WROOM dev board, already wired to the ELRS receiver as described in
  [WIRING.md](WIRING.md).
- Arduino IDE 2 with Arduino-ESP32 core 3.x.
- The **WebSockets** library by Markus Sattler (Library Manager → search `WebSockets`,
  install version 2.4.1 or newer). This is the only extra dependency.
- An iPhone or Android phone. Nothing to install on it.

## Flash the firmware

1. Open `firmware/RangeLab_ESP32.ino`.
2. Select **ESP32 Dev Module** as the board and the correct serial port.
3. Change `WIFI_AP_PASSWORD` near the top if you want anything other than the default
   `rangelab1234`. It must be at least 8 characters.
4. Upload.

`firmware/web_assets.h` — the embedded phone UI — is committed, so you do not need Node.js
to build the firmware. If you edit anything under `mobile/`, regenerate it with:

```sh
npm run mobile:embed
```

## Connect from the phone

1. On the ESP32, the access point is named `RANGELAB-XXXX` (last two bytes of its MAC).
2. Phone → Settings → WiFi → join `RANGELAB-XXXX` with your password.
3. Open Safari or Chrome and go to **http://192.168.4.1**.
4. The page connects back over WebSocket on port 81 and starts showing channel frames.

If the phone shows "No internet connection", that is expected: there is no route to the
internet on this network, and none is needed. On iOS you can use Share → **Add to Home
Screen** for a full-screen icon.

Nothing here needs a router or a cellular signal. The ESP32 is the network.

## What the phone page can do

- Live 16-channel display with pulse widths, link stats (RSSI/LQ/SNR), device identity and
  output state.
- Read the stored configuration from the ESP32 (`GET`).
- Per-channel mapping editor: input min/max, mode (`OFF`, `SERVO`, `PWM`, `DIGITAL`,
  `WINDOW`, `CURVE`), GPIO, output range and the five curve points.
- Enable and disable GPIO outputs.

It deliberately does **not** do field-log download — a full dump is ~1.8 MB of ASCII, which
is too much for the bridge and it would stall the RC loop for seconds. `LOG DUMP` is
refused while a phone is connected; use USB for that.

## Safety model

- Outputs are still disabled on boot and after 500 ms without valid RC frames.
- The phone page starts locked. Mapping writes, `ENABLE` and `LOG` commands are rejected
  until it sends `UNLOCK`, and controls relock after 10 minutes idle or when the last phone
  disconnects. `DISABLE` and `GET` are always accepted.
- The lock prevents accidental writes. It is **not** authentication: anyone who joins the
  access point can unlock and send `ENABLE`. The WPA2 password is the only real boundary,
  and it is compiled into the sketch. Bench-test with outputs disconnected, and do not
  leave a model powered with something dangerous attached to a GPIO.
- Verify wiring and every mapping before enabling outputs from a phone.

## Known limitations

- WiFi activity shares the radio with the CRSF UART. The firmware turns off WiFi power save
  and enlarges the UART2 receive buffer, but heavy traffic can still drop a receiver frame.
  A dropped frame is safe — the 500 ms failsafe neutralises outputs — but expect the
  occasional gap in the channel display. If WiFi is off (or no phone is connected) there is
  no bridge traffic and no added jitter.
- One access point, no station mode: the ESP32 does not join your home network.
- The bridge speaks the ASCII line protocol, not raw CRSF over the network.
- The phone page is a monitor and mapping editor. Profile import/export stays in the
  desktop app.

## USB-only build

Set `#define RANGELAB_WIFI 0` at the top of the sketch to build the original USB-only
firmware. That path needs neither the WebSockets library nor `web_assets.h`, and leaves the
USB behaviour byte-identical to the previous firmware.
