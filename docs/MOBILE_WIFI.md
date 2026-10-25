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
- Read (and, once unlocked, clear) the link/receiver event log kept in the ESP32's flash,
  and, if the optional rail tap is wired, the live 5V rail voltage and its lowest reading.
- Load the last ~2.4 s of link statistics (`TRACE`) to see how a link was lost: both antenna
  RSSIs, LQ, SNR, antenna, RF mode, TX power and downlink quality.
- Watch the receiver UART's error counters live (**RX UART**), which is what a cable or
  connector fault shows up as. No extra wiring needed — the CRSF frames carry a CRC.

It deliberately does **not** do field-log download — a full dump is ~1.8 MB of ASCII, which
is too much for the bridge and it would stall the RC loop for seconds. `LOG DUMP` is
refused while a phone is connected; use USB for that.

## Link and receiver event log

The firmware records link and receiver trouble as short events — state changes, not
samples — and keeps them in flash, so a fault survives a reboot and can be read from the
phone alone. The page loads the log when it connects; **Load events** re-reads it and
**Clear log** erases it once controls are unlocked. The same lines print over USB, so
`EVENTS` and `EVENTS,CLEAR` work from the desktop app's CLI too.

| Event | Meaning |
| --- | --- |
| `BOOT` | ESP32 started, numbered. A count that keeps climbing means the board itself is resetting (brownout, unstable supply, or a crash). |
| `RX_SILENT` | No CRSF bytes at all for 1 s: the receiver stopped transmitting. |
| `RX_ACTIVE` | Receiver bytes resumed after a long silence, and it did not come back cold — so it never rebooted. |
| `RX_RESTART` | The stream stopped and the receiver came back cold: its first link statistics report 0 dBm on both antennas, which is what a receiver that just booted looks like. This is the event for a supply drop too short to catch on the ADC but long enough to reset the receiver. The pause length, the cold frame, the UART damage around it and the rail are in the detail. |
| `RF_LINK_LOST` | The receiver is still transmitting but its link statistics report 0% LQ. |
| `RF_LINK_OK` | Link quality is back. |
| `RC_LOST` | Channel frames stopped while the receiver kept transmitting. |
| `RC_OK` | Channel frames returned. |
| `RX_GAP` | The CRSF stream paused for 150 ms–1 s and the receiver kept its state (stats came back with a real LQ and RSSI), so it did not reboot: the wire, plug or ground opened while it kept running. RF loss does not look like this, because the receiver keeps transmitting. |
| `PWR_DIP` | Only with the optional rail tap below: the 5V rail fell below the threshold and recovered. Carries the lowest voltage and how long it stayed low. |
| `PWR_GLITCH` | Only with the optional power-good input below: a hardware-latched assertion of the supply supervisor, counted even when the loop was busy. This is what catches a rub shorter than one ADC sample. |
| `PWR_OK` | The power-good line came back high, with how long it had been low. |
| `WIRE_NOISE` | A burst of damaged frames on the receiver UART — bad CRCs, bytes that broke frame sync, or both. Radio cannot corrupt this wire, so it points at the cable, plug or ground. Logged once when the burst goes quiet, with the counts and span. |

Lines look like `EVENT,<uptime ms>,<code>,<detail>`, for example
`EVENT,184312,RX_SILENT,no CRSF bytes for 1000ms; last rssi -88 dBm lq 0 snr 1`.
Timestamps are board uptime, so they restart with the board — use the `BOOT` rows as the
boundary between runs. The file holds roughly 150 entries; when it fills, the oldest half
is dropped and a `LOG_WRAPPED` entry records that.

### What it can and cannot tell apart

`RX_SILENT` means the ESP32 saw *nothing* on GPIO16. Losing the receiver's power, its
ground, or its TX wire all remove the signal, and the ESP32 cannot distinguish those three
— they are the same electrical condition at its pin. What it *can* separate is:

- **Receiver alive, RF link gone** — ExpressLRS keeps sending CRSF frames (failsafe channel
  values and link statistics) while the receiver is powered, so you get `RF_LINK_LOST`
  (usually with `RC_LOST`), with no `RX_SILENT` before it.
- **Receiver stopped transmitting** — all bytes stop, so you get `RX_SILENT` and no
  `RF_LINK_LOST` immediately before it.

A third case is now separable inside that second one: a **scratchy connection**. The CRSF
frames arriving on GPIO16 are CRC-checked, and nothing in the air can corrupt them — the
radio decodes and re-frames before the UART, so the wire carries clean digital bytes or
nothing. Damaged frames therefore mean the wire itself: a plug half out, a crimp that only
makes contact at some angles, a ground that is shared through a loose joint. `RX_SILENT`,
`RX_GAP` and `RX_RESTART` details carry how many UART errors came with the pause (`4 UART
error(s) around it`), which separates a wire opening from a receiver that simply ran out of
power.

If the whole assembly (ESP32 and receiver) loses power, the ESP32 cannot log the moment it
happens; the `BOOT` counter increments when it comes back and now names the reset reason, so
a brownout reset is distinct from a receiver-side dropout.

A receiver that boots with no transmitter powered reports 0% LQ until its first packet;
the firmware only reports `RF_LINK_LOST` after it has seen a real link, so cold boots do
not fill the log with noise.

## Supply (VIN) monitor (optional, for supply troubleshooting)

Without a wire to the rail, the ESP32 can only *infer* a supply problem from CRSF silence.
The board's 3V3 rail is no help — it is regulated down from VIN, so it hides exactly the
dips you are chasing. Measure VIN (the 5V pin) instead, through a divider into an ADC1
input:

```
VIN / 5V ──[10k]──┬── GPIO34 (ADC1)
                  │
                [10k]
                  │
                 GND
```

Then set `#define RANGELAB_RAIL_ADC 34` near the top of the sketch. 10k/10k halves the
rail, so 5.00 V arrives at the pin as 2.50 V — inside the ADC's better 0.5–2.5 V band. Only
ADC1 pins work while WiFi is on (32, 33, 34, 35, 36, 39); 34/35/36/39 are input-only, which
is what this wants. Never connect VIN straight to a GPIO (3.3 V pin), and do not feed this
divider from a rail above ~6 V — 12 V would put 6 V on the pin and destroy the input.

Measure where the load is: the receiver's own 5V pin if it is fed separately, or the board's
5V/VIN pin if the receiver is powered from it, with a common ground.

Expect a little less than 5 V on a dev board: most have a series Schottky diode from USB,
so VIN idles around 4.6–4.8 V. The defaults (`RANGELAB_RAIL_LOW_MV` 4400,
`RANGELAB_RAIL_OK_MV` 4550) are set below that, but if your idle reading differs, set them
about 250–350 mV under the live **5V RAIL** value.

Once enabled:

- VIN is sampled as often as the main loop allows and printed once a second as
  `RAIL,<mV>,<lowest mV since boot>`; the page shows it as **5V RAIL** (green, or red if it
  has ever been low).
- `PWR_DIP` is recorded when VIN falls below `RANGELAB_RAIL_LOW_MV` and recovers above
  `RANGELAB_RAIL_OK_MV`, with the lowest voltage and the time spent low.
- `RX_SILENT`, `RX_GAP` and `BOOT` details carry the VIN voltage at that moment.

That separates the cases you care about: `RX_SILENT` with `rail 4300 mV` is a supply
problem, `RX_SILENT` with `rail 4700 mV` points at the receiver or its wiring, and
`RF_LINK_LOST` with a steady rail is RF, not power.

What this cannot promise:

- Sampling is roughly 1–2 kHz while the loop is free, so a 1 ms dip is recorded only if a
  sample lands inside it and WiFi/flash work is not blocking the loop. Guaranteed capture of
  sub-millisecond events needs a hardware latch — see the next section.
- The ADC measures against an internal ~1.1 V bandgap (11 dB attenuation gives roughly a
  0–3.1 V range), not against the 3V3 rail, so it keeps reading while the chip runs. Its
  accuracy is still poor by instrument standards — a few percent, non-linear near the ends
  and noisy under WiFi — which is enough to see a 100 mV+ sag, not to certify 5.00 V.
- The AMS1117 on most dev boards needs roughly 4.4 V in to hold 3.3 V out. VIN below that
  drags the whole board down with it, and the reading becomes less trustworthy right where
  it matters. Dips that deep usually end in a reset, which is what the `BOOT` counter shows.
- A dip deep enough to reset the ESP32 writes no `PWR_DIP` — the board is rebooting. The next
  `BOOT` entry increments, names the reset reason and shows the rail at start-up.

## Catching a rub that lasts a millisecond

If the fault is a connector rubbing, the rail may be open for microseconds to a few
milliseconds. No amount of ADC code can promise to see that: the sample has to land inside
the gap, and WiFi or flash work can block the loop for far longer than the gap. What *can*
catch it is a hardware threshold, because the ESP32's GPIO peripheral latches an edge even
when the CPU is busy.

Use one of these, powered from the rail you care about, with an **active-low** output:

- **Supply supervisor** (simplest): TCM809/TCM810, MAX809, APX803, MCP131 and similar come
  in 4.5–4.7 V thresholds. VCC to VIN, GND, output to the chosen GPIO with a 10k pull-up to
  3V3 if it is open-drain. Supervisors also add their own reset delay (often 20–200 ms) to
  the reported duration, so the *event* is exact but the time low is the chip's hold time.
- **Comparator** (LM393 and a divider/trimmer): gives the true duration and an adjustable
  threshold, at the cost of a couple more parts and some hysteresis tuning.

Then set the pin near the top of the sketch:

```cpp
#define RANGELAB_PWRGOOD_PIN 35
```

GPIO 34/35/36/39 are input-only and have **no internal pull-up** — fit an external 10k to
3V3 for an open-drain output. Don't reuse the ADC tap pin or one of the SAFE_PINS outputs.

The ISR only counts edges, so it stays safe while flash is being written; the loop turns the
count into `PWR_GLITCH` events. A burst of rubs inside one blocked loop pass still shows up
as "N power-good assertion(s)" rather than being lost.

Two more ways the same fault shows up without that input:

- If the rub resets the receiver but not the ESP32, the CRSF stream stops for its boot time
  and the pause is recorded — as `RX_RESTART` when the receiver comes back cold, `RX_GAP`
  when it never lost power (see the UART section above).
- If it resets the ESP32, `BOOT` now names the reason: `brownout` is a supply reset, while
  `power-on`, `software`, `panic` or `watchdog` point elsewhere. That is the difference
  between "it restarted" and "it restarted because the 5V collapsed".

### How the link was lost

Every link-statistics frame carries more than RSSI/LQ/SNR: the second antenna's RSSI, the
active antenna, the RF mode, the transmitter's power setting and the downlink (RX→TX)
statistics. The firmware keeps the last ~2.4 s of those samples (one every 100 ms, in RAM)
and, when uplink LQ reaches 0, writes a summary into the event log:

```
EVENT,184312,RF_LINK_LOST,lq 100>0 rssi -62>-95 min -96 snr 9>-3 dlq 100>0 ant 1 mode 2 tx 100mW trend -62,-64,-70,-88,-95
```

- `lq 100>0` — uplink LQ at the start of the window and at the loss.
- `rssi -62>-95 min -96` — best-antenna RSSI (dBm) at start, at loss, and lowest seen.
- `snr`, `dlq` — SNR and downlink LQ across the same window.
- `ant`, `mode`, `tx` — active antenna, RF mode and transmitter power at the loss.
- `trend` — up to six best-antenna RSSI samples across the window: the shape of the fade.

`TRACE` (the page's **Load trace** button, or the command over USB) prints the raw points,
one per 100 ms:

```
TRACE,<ms>,<rssi1>,<rssi2>,<lq>,<snr>,<antenna>,<rf mode>,<tx power>,<downlink LQ>,<downlink SNR>
```

`RF_LINK_OK` then reports how long the link was gone and the RSSI/LQ it came back at.

The trace is RAM-only and scrolls continuously; only the summary is persisted. Read it like
this:

- **RSSI slides down before the drop** (`-62,-70,-88,-95`) — range, obstruction, antenna
  orientation or a shielded antenna. Compare `rssi1`/`rssi2`: a large lasting gap suggests one
  antenna is disconnected or damaged.
- **LQ collapses while RSSI stays strong** — interference or packet loss rather than a weak
  signal: co-channel noise, a bad antenna joint, or packets lost on the transmitter side.
- **TX power or RF mode changes at the drop** — the transmitter changed power or rate, which
  can present as a link loss.
- **Downlink LQ falls first** — the return path is failing while control still holds.

What it cannot do: everything here is reported by the receiver. It cannot identify an
interferer, prove the transmitter's antenna or PA is healthy, and records nothing at all if
the receiver stops talking (`RX_SILENT` has no statistics to show).

## Is it the cable? (receiver UART health)

Every CRSF frame carries a CRC over its type, payload and length, and the ESP32 checks it on
arrival. The radio link is decoded by the receiver and re-sent as UART bytes, so nothing in
the air can corrupt them: a failed CRC means the byte was damaged on the wire between the
receiver's TX pin and GPIO16 — cable, plug, solder joint, or the ground return between the
two boards. That is the one direct measurement of the cable the ESP32 can make, and it needs
no extra parts.

The page shows it as **RX UART**; the same numbers stream over USB once a second:

```
WIRE,<bad frames>,<sync errors>,<ignored after loop stalls>
```

- **bad frames** — a complete frame whose CRC did not match. The sharpest cable evidence.
- **sync errors** — bytes that could not begin or continue a frame (the stream lost its
  place). Usually a run right after a bad frame.
- **ignored** — errors seen right after a loop pass that took longer than ~20 ms. The
  firmware's own 1 KB UART buffer is only about 24 ms of 420000-baud traffic, so a WiFi burst
  or a flash write can drop bytes itself. Those are counted apart so they are not blamed on
  the wiring.

A burst of errors is written to the event log as `WIRE_NOISE` once it has been quiet for a
second, with counts and span, so a rubbing plug is one entry rather than hundreds:

```
EVENT,91240,WIRE_NOISE,7 bad frame(s) and 2 sync error(s) in 43ms on the receiver UART; rail 4700 mV
```

### The wiggle test

1. Open the page (or a USB serial monitor) with the link up. **RX UART** should read `clean`.
2. Flex each suspect gently, one at a time: the receiver's TX wire, its ground, the plug at
   the receiver end, the plug at the ESP32 end.
3. Watch the counters. When they climb, that joint is the fault — a number instead of a guess.

Reading the result:

- **Errors climb with the rail steady** — the supply is fine, the signal or ground path is not.
- **Errors and `RX_SILENT` together** — the connection is opening outright.
- **`RX_SILENT` / `RX_GAP` with zero UART errors** — the wire is intact but nothing was being
  sent: receiver power, a receiver reset, or a dead TX driver. Check which event follows:
  `RX_RESTART` means it booted again (below).
- **No UART errors while the radio link drops** — the fault is in the air, not on the bench.

### Did the receiver reboot, or did the wire just open?

A drop too short to see on the rail can still be long enough to reset the receiver. The
receiver's own state answers it: after a pause the firmware waits for the next link
statistics frame, and

- **both antenna RSSIs read 0 dBm** → the receiver has no packets yet because it is booting:
  `RX_RESTART`, with the pause length, the cold frame and the rail at that moment.
- **the stats come back with a real LQ and RSSI** → the receiver never lost power; the wire,
  plug or ground opened while it kept running: `RX_GAP`.

```
EVENT,41208,RX_RESTART,receiver restarted: 180ms of silence, stats 96ms later lq 0 rssi 0/0 ant 1 mode 3; rail 4700 mV
EVENT,41244,RX_GAP,CRSF stream paused for 220ms; receiver kept its state (lq 92 ant 1 mode 3); 3 UART error(s) around it
```

`RX_RESTART` is the signature of the fault you can otherwise miss entirely: a supply drop
perhaps 100 ms long, far too short to notice on the display, long enough to reboot the
receiver.

Two things to keep in mind:

- The ESP32 still cannot see the receiver's supply. `RX_RESTART` says the receiver *booted*;
  the rail sample and the UART counters say whether the cause was power or the wiring.
- If the receiver re-acquires the link before its first statistics frame, that frame reads
  warm and the pause is reported as `RX_GAP`. Cold stats are strong evidence, not a guarantee.
- "No packets" is not the same as "just booted". A receiver whose transmitter is switched
  off, or that cannot hear it, also reports 0 dBm on both antennas; a pause during that would
  be called a restart. Check the events before it: a restart is normally preceded by
  `RX_SILENT` or `RX_GAP` on a link that was working.

A drop that resets a receiver lasts tens to hundreds of milliseconds rather than
microseconds, which is well inside what the ADC tap samples several times per
millisecond — **provided the divider is across the receiver's own 5V pin** rather than
upstream of the bad joint, because a dip after the tap is invisible to it. With both fitted, the pair is conclusive — `RX_RESTART` plus
`PWR_DIP` is the supply, `RX_RESTART` with a steady rail points at the receiver's own
connector or regulator.

What it cannot do:

- It cannot say which end of the cable is at fault, only that bytes were damaged between the
  receiver's output and the ESP32's pin. Swapping the cable separates a bad wire from a
  marginal UART driver or a floating TX line inside the receiver.
- Frames are counted, never stored, and the counters reset on every ESP32 boot (`BOOT` marks
  where).
- After a stream pause the firmware has to find the frame boundary again; those re-sync bytes
  are ignored, because the pause may have been the receiver resetting rather than the wire.
  The damage from *before* the pause is still counted and still appears in the `RX_GAP` detail.
- Bytes dropped while the ESP32 was stalled land in the third column, so a real fault that
  happened during a long stall can be excused rather than counted.
- It says nothing about the transmitter side: damage there shows up as an RF problem in
  `TRACE`, not as UART errors.

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
- The event log is inferred from the CRSF stream, not measured at the receiver's supply:
  an unpowered receiver and an open TX wire both read as `RX_SILENT`. Event timestamps are
  board uptime and reset on every boot.
- `RX_RESTART` is inference from the receiver's own first statistics frame, not a measurement
  of its supply. If the receiver re-acquires the link before that frame, the pause is reported
  as `RX_GAP` instead.
- UART error counters describe the wire to the receiver only. Bytes dropped because the ESP32
  itself stalled (WiFi bursts, flash writes) are counted separately and are not cable evidence,
  and a receiver with a marginal UART driver looks the same as a bad cable.
- Direct rail measurement needs the optional ADC tap; without it a supply dip is invisible
  unless it interrupts the CRSF stream, and then only as `RX_RESTART`, `RX_GAP` or
  `RX_SILENT`. With it, dips
  shorter than one loop pass — WiFi bursts, flash writes, HTTP serving — can still be missed.
- The link trace is the receiver's own view, kept in RAM for ~2.4 s. Only the summary survives
  a reboot or a reconnect, and a receiver that stops transmitting leaves no trace at all.

## USB-only build

Set `#define RANGELAB_WIFI 0` at the top of the sketch to build the original USB-only
firmware. That path needs neither the WebSockets library nor `web_assets.h`, and leaves the
USB behaviour byte-identical to the previous firmware.
