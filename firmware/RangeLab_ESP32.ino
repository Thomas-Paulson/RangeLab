/*
  RangeLab Standalone ESP32-WROOM CRSF bridge + channel-to-pin mapper
  Hardware: ESP32-WROOM DevKit, ExpressLRS receiver CRSF TX -> GPIO16 (RX2), GND common.
  USB serial to desktop: 115200 baud. Receiver UART: 420000 baud.
  Arduino-ESP32 core 3.x recommended (LEDC API v3).

  Two transports share one protocol:
    - USB serial (the desktop RangeLab app), always available.
    - WiFi bridge (this branch): the ESP32 raises its own access point, serves a
      phone-sized UI from flash and streams the same ASCII lines over
      WebSocket, so an iPhone or Android phone needs no app and no cable.
      Set RANGELAB_WIFI to 0 below for the original USB-only build.

  Optional 5V rail monitor: wire the rail through a 1:1 divider into an ADC1 pin
  (5V --[10k]-- GPIO34 --[10k]-- GND) and set RANGELAB_RAIL_ADC to 34 below. The
  firmware then logs PWR_DIP with the lowest voltage and its duration, and prints
  RAIL,<mV>,<min mV> once a second. Without that wire the ESP32 cannot see the
  5V rail at all: receiver silence only proves the CRSF stream stopped, not why.

  Safety: outputs are DISABLED on boot and after 500 ms without valid RC frames.
          Over WiFi, outputs and mapping writes stay locked until the app sends
          UNLOCK; DISABLE is always accepted.
  Commands: GET, SET,ch,min,max,mode,pin,outLow,outHigh[,curve x5], ENABLE, DISABLE, PING,
            LOG START|STOP|DUMP|CLEAR (field logging to internal flash, 10 Hz, persists across
            restarts; wraps when full and records an OVERFLOW marker),
            EVENTS[,CLEAR] (short link/receiver trouble log, also in internal flash),
            TRACE (the last ~2.4 s of link statistics: both antennas, LQ, SNR, RF
            mode and TX power, sampled every 100 ms).
  Modes: OFF, SERVO (microseconds), PWM (0..255), DIGITAL (threshold at midpoint),
         WINDOW (output high inside outLow..outHigh band), CURVE (5-point servo curve).
  Never connect motors/servos directly to GPIO if their current exceeds GPIO capability.
*/
#include <Arduino.h>
#include <Preferences.h>
#include <LittleFS.h>

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
#define RANGELAB_WIFI 1  // 0 = USB-only build (no WiFi, no WebSockets library needed)

// Optional supply (VIN) monitor. The 3V3 rail tells you nothing about the 5V feed,
// so wire a divider from the board's 5V/VIN pin to an ADC1 input and set the pin:
//   VIN (5V) --[R1]--+--[R2]-- GND
//                    |
//                 GPIO34 (ADC1, input-only)
// 10k/10k halves it: 5.00V -> 2.50V, inside the ADC's good 0.5-2.5V band.
// ADC1 only (32, 33, 34, 35, 36, 39): ADC2 cannot be used while WiFi is on, and
// 34/35/36/39 are input-only, which is what this wants.
// Never put VIN straight on a GPIO, and never feed this divider from a rail above
// ~6V: 12V would put 6V on the pin and destroy it.
// Dev boards often sit around 4.7V on VIN (series diode from USB) and the AMS1117
// needs ~4.4V to hold 3.3V, so the defaults trip a little below the idle reading.
// Tune them from the live RAIL value shown on the page (about 250-350mV under it).
#define RANGELAB_RAIL_ADC -1        // ADC1 pin, or -1 when no divider is fitted
#define RANGELAB_RAIL_MULTIPLIER 2  // (R1+R2)/R2: 2 for 10k/10k, 3 for 20k/10k
#define RANGELAB_RAIL_LOW_MV 4400   // a sample below this starts a dip
#define RANGELAB_RAIL_OK_MV 4550    // hysteresis: back above this ends it

#if RANGELAB_WIFI
#include <WiFi.h>
#include <WebSocketsServer.h>
#include "web_assets.h"  // generated from mobile/ by `npm run mobile:embed`
#endif

// ---------------------------------------------------------------------------
// Device state
// ---------------------------------------------------------------------------
// Field logging: armed by LOG START, survives restarts, wraps at LOG_FILE_MAX bytes
// with an OVERFLOW marker so the app can tell data was overwritten.
static constexpr size_t LOG_FILE_MAX = 1800000; // ~30-40 min at 10 Hz
static constexpr const char* LOG_PATH = "/fieldlog.csv";

// Event log: a short, reboot-surviving record of link and receiver trouble, so a
// fault can be read back from a phone with no laptop attached. Entries are rare
// (state changes, not samples), so the file stays small.
static constexpr const char* EVENT_PATH = "/events.log";
static constexpr size_t EVENT_FILE_MAX = 6000;   // ~150 entries before the oldest half is dropped
static constexpr uint32_t RX_SILENT_MS = 1000;   // no CRSF bytes at all for this long
static constexpr uint32_t EVENT_SCAN_MS = 100;   // event state machine cadence

// Rail monitor and short-gap detector (the rail macros live at the top).
static constexpr uint32_t RAIL_REPORT_MS = 1000;   // live RAIL line cadence
static constexpr uint32_t RX_GAP_MS = 250;         // CRSF stream pause worth recording

static constexpr int CRSF_RX_PIN = 16;
static constexpr uint32_t USB_BAUD = 115200;
static constexpr uint32_t CRSF_BAUD = 420000;
static constexpr uint32_t RC_TIMEOUT_MS = 500;
static constexpr uint32_t LOG_PERIOD_MS = 100; // 10 Hz field logging
static constexpr uint8_t CRSF_RC_CHANNELS = 0x16;
static constexpr uint8_t CRSF_LINK_STATISTICS = 0x14;
static constexpr uint8_t SAFE_PINS[] = {13,14,17,18,19,21,22,23,25,26,27,32,33};
static constexpr size_t SAFE_PIN_COUNT = sizeof(SAFE_PINS) / sizeof(SAFE_PINS[0]);

enum OutputMode : uint8_t { MODE_OFF, MODE_SERVO, MODE_PWM, MODE_DIGITAL, MODE_WINDOW, MODE_CURVE };
struct Mapping { uint16_t inMin=1000, inMax=2000; OutputMode mode=MODE_OFF; int8_t pin=-1; uint16_t outLow=1000, outHigh=2000; uint16_t curve[5]={1000,1250,1500,1750,2000}; };
Mapping mappings[16];
uint16_t channels[16];
Preferences prefs;
HardwareSerial CRSF(2);
uint8_t frame[80]; size_t frameLen=0;
uint32_t lastRcMs=0; bool outputsEnabled=false; bool wasFailsafe=true;
String usbLine;
bool logArmed=false; File logFile; uint32_t lastLogMs=0; int16_t linkRssi=0; uint16_t linkLq=0; int8_t linkSnr=0;
// Rest of the CRSF link-statistics frame: second antenna, RF mode, TX power and
// the downlink direction, all of which say more about a loss than RSSI alone.
int16_t linkRssi2=0; uint8_t linkAntenna=0, linkMode=0, linkTxPower=0, linkDownLq=0; int8_t linkDownSnr=0;
// Rolling pre-loss trace. One point per 100 ms, so 24 points cover ~2.4 s.
struct LinkPoint { uint32_t ms; int16_t rssi1, rssi2; int8_t snr, downSnr; uint8_t lq, ant, mode, txPwr, downLq; };
static constexpr size_t LINK_POINTS = 24;
static constexpr uint32_t LINK_POINT_MS = 100;
LinkPoint linkPoints[LINK_POINTS];
size_t linkHead=0, linkCount=0; uint32_t lastLinkPointMs=0; uint32_t rfLostAtMs=0;
// Event detection state. rxSilent stays true until the receiver has sent bytes at
// least once, so a board that boots with no receiver attached logs BOOT only.
uint32_t lastCrsfByteMs=0; uint32_t lastLinkStatMs=0; uint32_t lastEventScanMs=0;
bool rxSilent=true; bool rcLost=false; bool rfLinkLost=false; bool sawLinkQuality=false; bool rxHeard=false;
uint16_t bootCount=0;
// 5V rail monitor and short-gap detector.
int railMv=-1, railMinMv=-1, railDipMinMv=0;
bool railLow=false; uint32_t railLowSinceMs=0, lastRailReportMs=0;
uint32_t pendingGapMs=0; uint32_t lastLoopMs=0, lastIterationMs=0;

// The console printer and its WebSocket capture live below the type
// declarations on purpose: arduino-cli injects auto-generated prototypes just
// before the first function definition, so a function defined above the
// OutputMode enum makes those prototypes fail to compile.
#if RANGELAB_WIFI
// Change this before flashing anything you care about: it is the only thing
// standing between the network and the ENABLE command.
static constexpr const char* WIFI_AP_PREFIX = "RangeLab";
static constexpr const char* WIFI_AP_PASSWORD = "rangelab1234";
static constexpr uint16_t HTTP_PORT = 80;
static constexpr uint16_t WS_PORT = 81;
static constexpr uint32_t CONTROL_IDLE_TIMEOUT_MS = 10UL * 60UL * 1000UL;
static constexpr size_t WS_LINE_MAX = 600;

WebSocketsServer webSocket(WS_PORT);
WiFiServer httpServer(HTTP_PORT);
bool controlsUnlocked = false;
uint32_t lastControlMs = 0;
char wsLine[WS_LINE_MAX];
size_t wsLineLen = 0;
bool wsLineOverflow = false;

// Forward every console line to connected phones, one WebSocket frame per line.
void bridgeCapture(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (wsLineLen > 0 && !wsLineOverflow && webSocket.connectedClients() > 0) {
      // Keep the terminator in the frame: the phone reassembles a byte stream
      // and only emits complete lines, so a bare line would sit in its buffer
      // forever and the UI would never update.
      wsLine[wsLineLen++] = '\n';
      webSocket.broadcastTXT((uint8_t*)wsLine, wsLineLen);
    }
    wsLineLen = 0;
    wsLineOverflow = false;
    return;
  }
  if (wsLineLen >= WS_LINE_MAX - 1) { wsLineOverflow = true; return; }
  wsLine[wsLineLen++] = c;
}
#endif

// Everything the sketch prints goes through here: USB serial always, plus the
// WiFi bridge when it is enabled and a phone is connected.
class DualPrint : public Print {
 public:
  size_t write(uint8_t c) override {
#if RANGELAB_WIFI
    bridgeCapture((char)c);
#endif
    return Serial.write(c);
  }
  size_t write(const uint8_t* buffer, size_t size) override {
#if RANGELAB_WIFI
    for (size_t i = 0; i < size; i++) bridgeCapture((char)buffer[i]);
#endif
    return Serial.write(buffer, size);
  }
  void flush() { Serial.flush(); }
};

DualPrint bridgeConsole;
#define Console bridgeConsole

void closeLogFile(){ if(logFile) logFile.close(); }
void openLogFile(){
  if(!LittleFS.begin(true)){ Console.println("ERROR,logging flash unavailable"); return; }
  logFile=LittleFS.open(LOG_PATH,"a");
  if(!logFile){ Console.println("ERROR,log file could not be opened"); return; }
  logFile.println("SESSION,millis,ch1,ch2,ch3,ch4,ch5,ch6,ch7,ch8,ch9,ch10,ch11,ch12,ch13,ch14,ch15,ch16,rssi,lq,snr");
}
void logSample(){
  if(!logArmed||!logFile) return;
  if(logFile.size()>LOG_FILE_MAX){
    closeLogFile(); LittleFS.remove(LOG_PATH); openLogFile();
    if(logFile) logFile.println("OVERFLOW,flash log was full; earlier sessions were overwritten");
  }
  if(!logFile) return;
  logFile.printf("%lu",(unsigned long)millis());
  for(int i=0;i<16;i++) logFile.printf(",%u",channels[i]);
  logFile.printf(",%d,%u,%d\n",linkRssi,linkLq,(int)linkSnr);
  if(logFile.size()%4096<120) logFile.flush();
}
void loadLogArm(){ prefs.begin("rangelab",true); logArmed=prefs.getBool("logArm",false); prefs.end(); }

// ---------------------------------------------------------------------------
// Event log: link and receiver trouble, kept in flash across restarts.
//   RX_SILENT     no CRSF bytes at all: the receiver stopped transmitting. This
//                 is what an unpowered receiver (or an open TX/ground wire) looks
//                 like from the ESP32.
//   RX_ACTIVE     the receiver is transmitting again.
//   RF_LINK_LOST  the receiver is alive and talking, but reports 0% link quality.
//                 Its detail is a summary of the pre-loss trace: LQ, both-antenna
//                 RSSI, SNR, downlink LQ, RF mode, TX power and an RSSI trend, so
//                 a fade and a cliff can be told apart. TRACE prints the raw points.
//   RF_LINK_OK    link quality is back, with how long it was gone.
//   RC_LOST       channel frames stopped while the receiver keeps transmitting.
//   RC_OK         channel frames are back.
//   RX_GAP        the CRSF stream paused for 250 ms-1 s, then resumed: short
//                 enough that RX_SILENT does not fire, but an RX reset (usually a
//                 brownout) looks exactly like this.
//   PWR_DIP       only when RANGELAB_RAIL_ADC is wired: the 5V rail fell below
//                 RANGELAB_RAIL_LOW_MV and recovered. Carries the lowest measured voltage
//                 and how long it stayed low, so a supply problem is provable
//                 rather than inferred from CRSF silence.
//   BOOT          ESP32 start-up, numbered: a growing count means resets.
// ---------------------------------------------------------------------------
void compactEventLog() {
  File in = LittleFS.open(EVENT_PATH, "r");
  if(!in) return;
  String all = in.readString();
  in.close();
  if(all.length() < 2) return;
  const int cut = all.indexOf('\n', all.length()/2);
  String tail = cut >= 0 ? all.substring(cut+1) : String();
  File out = LittleFS.open(EVENT_PATH, "w");
  if(!out) return;
  out.print("EVENT,0,LOG_WRAPPED,oldest entries dropped to keep the log small\n");
  out.print(tail);
  out.close();
}
void eventAppend(const char* code, const char* detail) {
  char line[192];
  if(detail && *detail) snprintf(line, sizeof(line), "EVENT,%lu,%s,%s", (unsigned long)millis(), code, detail);
  else snprintf(line, sizeof(line), "EVENT,%lu,%s", (unsigned long)millis(), code);
  Console.println(line);              // live view over USB and to every connected phone
  if(!LittleFS.begin(true)) return;   // no flash: the live line is all that can be offered
  File f = LittleFS.open(EVENT_PATH, "a");
  if(!f) return;
  if(f.size() > EVENT_FILE_MAX) { f.close(); compactEventLog(); f = LittleFS.open(EVENT_PATH, "a"); if(!f) return; }
  f.println(line);
  f.close();
}
void dumpEventLog() {
  if(!LittleFS.begin(true)) { Console.println("ERROR,event flash unavailable"); return; }
  Console.println("EVENT_DUMP_BEGIN");
  File f = LittleFS.open(EVENT_PATH, "r");
  if(f) {
    while(f.available()) { String l = f.readStringUntil('\n'); l.trim(); if(l.length()) Console.println(l); }
    f.close();
  }
  Console.println("EVENT_END");
}
int readRailMv() {
#if RANGELAB_RAIL_ADC >= 0
  return (int)analogReadMilliVolts(RANGELAB_RAIL_ADC) * RANGELAB_RAIL_MULTIPLIER;
#else
  return -1;
#endif
}
// Appended to event details so a fault can be read next to the rail voltage.
String railNote() {
  if(railMv < 0) return String();
  return String("; rail ") + railMv + " mV";
}
void railInit() { railMv = readRailMv(); railMinMv = railMv; lastRailReportMs = millis(); }
// One rail sample. Called as often as the main loop allows; a dip is logged when
// it recovers so the entry can carry its depth and length. A dip that kills the
// ESP32 itself is not logged here - the BOOT counter is what shows that.
void pollRail() {
#if RANGELAB_RAIL_ADC >= 0
  const uint32_t now = millis();
  const int mv = readRailMv();
  railMv = mv;
  if(railMinMv < 0 || mv < railMinMv) railMinMv = mv;
  if(!railLow && mv < RANGELAB_RAIL_LOW_MV) {
    railLow = true;
    railLowSinceMs = now;
    railDipMinMv = mv;
  } else if(railLow) {
    if(mv < railDipMinMv) railDipMinMv = mv;
    if(mv >= RANGELAB_RAIL_OK_MV) {
      railLow = false;
      char detail[120];
      snprintf(detail, sizeof(detail), "5V rail dipped to %d mV for %lums (below %d mV)",
               railDipMinMv, (unsigned long)(now - railLowSinceMs), RANGELAB_RAIL_LOW_MV);
      eventAppend("PWR_DIP", detail);
    }
  }
  if(now - lastRailReportMs >= RAIL_REPORT_MS) {
    lastRailReportMs = now;
    Console.printf("RAIL,%d,%d\n", railMv, railMinMv);
  }
#endif
}
// Records one byte arrival. Called for every CRSF byte; a pause longer than the
// previous loop pass plus 100 ms is a real stream stop, while shorter ones are
// loop stalls (HTTP serving, flash writes, WiFi bursts) and must not be logged.
void noteCrsfByte(const uint32_t now) {
  const uint32_t gap = now - lastCrsfByteMs;
  if(rxHeard && gap >= RX_GAP_MS && gap <= RX_SILENT_MS && gap > lastIterationMs + 100) pendingGapMs = gap;
  lastCrsfByteMs = now;
  rxHeard = true;
}
void flushGapEvent() {
  if(!pendingGapMs) return;
  char detail[120];
  snprintf(detail, sizeof(detail), "CRSF stream paused for %lums%s", (unsigned long)pendingGapMs, railNote().c_str());
  pendingGapMs = 0;
  eventAppend("RX_GAP", detail);
}
// ---- link trace: what the receiver itself reported before a loss ----------
// ELRS sends both antenna RSSIs, the active antenna, RF mode, transmitter power
// and the downlink stats. Recording them lets you tell a fade (range, obstruction,
// antenna) from a cliff (interference or packet loss with signal still present).
// 0 is what some receivers report when they have no packet for that antenna, not
// a real -0 dBm reading; ignore it rather than letting it look like a strong link.
int bestRssi(const LinkPoint &p) {
  if(p.rssi1 == 0 && p.rssi2 == 0) return 0;
  if(p.rssi1 == 0) return p.rssi2;
  if(p.rssi2 == 0) return p.rssi1;
  return p.rssi1 > p.rssi2 ? p.rssi1 : p.rssi2;
}
const LinkPoint* linkPointAt(size_t i) {
  if(i >= linkCount) return nullptr;
  return &linkPoints[(linkHead + LINK_POINTS - linkCount + i) % LINK_POINTS];
}
void recordLinkPoint() {
  const uint32_t now = millis();
  if(linkCount && now - lastLinkPointMs < LINK_POINT_MS) return;
  lastLinkPointMs = now;
  LinkPoint &p = linkPoints[linkHead];
  p.ms = now;
  p.rssi1 = linkRssi; p.rssi2 = linkRssi2;
  p.snr = linkSnr; p.downSnr = linkDownSnr;
  p.lq = (uint8_t)linkLq; p.ant = linkAntenna; p.mode = linkMode; p.txPwr = linkTxPower; p.downLq = linkDownLq;
  linkHead = (linkHead + 1) % LINK_POINTS;
  if(linkCount < LINK_POINTS) linkCount++;
}
String lossSummary() {
  const LinkPoint *first = linkPointAt(0);
  const LinkPoint *last = linkCount ? linkPointAt(linkCount - 1) : nullptr;
  int minRssi = 0; bool haveMin = false;
  for(size_t i = 0; i < linkCount; i++) {
    const int r = bestRssi(*linkPointAt(i));
    if(!haveMin || r < minRssi) { minRssi = r; haveMin = true; }
  }
  char head[160];
  snprintf(head, sizeof(head),
           "lq %u>%u rssi %d>%d min %d snr %d>%d dlq %u>%u ant %u mode %u tx %umW",
           (unsigned)(first ? first->lq : 0), (unsigned)(last ? last->lq : 0),
           first ? bestRssi(*first) : 0, last ? bestRssi(*last) : 0, haveMin ? minRssi : 0,
           (int)(first ? first->snr : 0), (int)(last ? last->snr : 0),
           (unsigned)(first ? first->downLq : 0), (unsigned)(last ? last->downLq : 0),
           (unsigned)(last ? last->ant : 0), (unsigned)(last ? last->mode : 0), (unsigned)(last ? last->txPwr : 0));
  String out(head);
  if(linkCount) {
    out += " trend";
    const size_t step = linkCount > 6 ? (linkCount + 5) / 6 : 1;
    size_t printed = 0;
    for(size_t i = 0; i < linkCount && printed < 6; i += step) {
      out += printed == 0 ? " " : ",";
      out += bestRssi(*linkPointAt(i));
      printed++;
    }
  }
  return out;
}
void dumpLinkTrace() {
  Console.println("TRACE_BEGIN");
  for(size_t i = 0; i < linkCount; i++) {
    const LinkPoint *p = linkPointAt(i);
    Console.printf("TRACE,%lu,%d,%d,%u,%d,%u,%u,%u,%u,%d\n",
                   (unsigned long)p->ms, (int)p->rssi1, (int)p->rssi2, (unsigned)p->lq, (int)p->snr,
                   (unsigned)p->ant, (unsigned)p->mode, (unsigned)p->txPwr, (unsigned)p->downLq, (int)p->downSnr);
  }
  Console.println("TRACE_END");
}
void logBootEvent() {
  prefs.begin("rangelab", false);
  bootCount = prefs.getUShort("boots", 0) + 1;
  prefs.putUShort("boots", bootCount);
  prefs.end();
  char detail[64];
  snprintf(detail, sizeof(detail), "esp32 boot #%u%s", (unsigned)bootCount, railNote().c_str());
  eventAppend("BOOT", detail);
}
void scanEvents() {
  const uint32_t now = millis();
  if(now - lastEventScanMs < EVENT_SCAN_MS) return;
  lastEventScanMs = now;

  // Nothing heard since boot is silence, not activity: no RX_ACTIVE until a real byte.
  const bool silentNow = !rxHeard || (now - lastCrsfByteMs) > RX_SILENT_MS;
  if(silentNow != rxSilent) {
    rxSilent = silentNow;
    if(rxSilent) {
      char detail[120];
      snprintf(detail, sizeof(detail), "no CRSF bytes for %lums; last rssi %d dBm lq %u snr %d%s",
               (unsigned long)RX_SILENT_MS, (int)linkRssi, (unsigned)linkLq, (int)linkSnr, railNote().c_str());
      eventAppend("RX_SILENT", detail);
    } else {
      eventAppend("RX_ACTIVE", "receiver is transmitting again");
      lastLinkStatMs = 0;  // wait for fresh statistics before judging link quality
    }
    rcLost = false;
    rfLinkLost = false;
    sawLinkQuality = false;
  }
  if(rxSilent) return;

  // Link quality is only meaningful while the receiver is still sending stats, and
  // only once it has reported a real link: an RX that just booted also reads 0
  // until its first packet, and that is not a loss.
  const bool freshStats = lastLinkStatMs != 0 && (now - lastLinkStatMs) <= RX_SILENT_MS;
  if(freshStats && linkLq > 0) sawLinkQuality = true;
  const bool rfLostNow = freshStats && sawLinkQuality && linkLq == 0;
  if(rfLostNow != rfLinkLost) {
    rfLinkLost = rfLostNow;
    if(rfLostNow) {
      rfLostAtMs = millis();
      eventAppend("RF_LINK_LOST", lossSummary().c_str());
    } else {
      char detail[120];
      snprintf(detail, sizeof(detail), "link back after %lums; rssi %d dBm lq %u%s",
               (unsigned long)(millis() - rfLostAtMs), (int)linkRssi, (unsigned)linkLq, railNote().c_str());
      eventAppend("RF_LINK_OK", detail);
    }
  }

  // Channel frames missing while the receiver is demonstrably alive and talking.
  // Bytes must still be arriving: if the whole UART is quiet, the coming RX_SILENT
  // describes it and a separate RC_LOST event would only add noise.
  const bool uartAlive = (now - lastCrsfByteMs) <= (RC_TIMEOUT_MS / 2);
  const bool rcLostNow = uartAlive && lastRcMs != 0 && (now - lastRcMs) > RC_TIMEOUT_MS;
  if(rcLostNow != rcLost) {
    rcLost = rcLostNow;
    if(rcLostNow) eventAppend("RC_LOST", "no channel frames while the receiver is still transmitting");
    else eventAppend("RC_OK", "channel frames are back");
  }
}

bool safePin(int pin) { for (auto p: SAFE_PINS) if (p == pin) return true; return false; }
const char* modeName(OutputMode m) { switch(m){case MODE_SERVO:return "SERVO";case MODE_PWM:return "PWM";case MODE_DIGITAL:return "DIGITAL";case MODE_WINDOW:return "WINDOW";case MODE_CURVE:return "CURVE";default:return "OFF";} }
OutputMode parseMode(String s) { s.toUpperCase(); if(s=="SERVO")return MODE_SERVO; if(s=="PWM")return MODE_PWM; if(s=="DIGITAL")return MODE_DIGITAL; if(s=="WINDOW")return MODE_WINDOW; if(s=="CURVE")return MODE_CURVE; return MODE_OFF; }
uint8_t crsfCrc(const uint8_t *data, size_t len) { uint8_t crc=0; for(size_t i=0;i<len;i++){crc^=data[i];for(int b=0;b<8;b++)crc=(crc&0x80)?(crc<<1)^0xD5:crc<<1;}return crc; }
void emitConfig(int i) { const auto &m=mappings[i]; Console.printf("CFG,%d,%u,%u,%s,%d,%u,%u,%u,%u,%u,%u,%u\n",i+1,m.inMin,m.inMax,modeName(m.mode),m.pin,m.outLow,m.outHigh,m.curve[0],m.curve[1],m.curve[2],m.curve[3],m.curve[4]); }
void emitAll() { Console.println("DEVICE,RangeLab-ESP32,1"); Console.printf("STATUS,%s\n", outputsEnabled?"OUTPUTS_ENABLED":"OUTPUTS_DISABLED"); for(int i=0;i<16;i++)emitConfig(i); }
void writeOutput(int i, uint16_t value) {
  auto &m=mappings[i]; if(m.mode==MODE_OFF || m.pin<0) return;
  if(!outputsEnabled) {
    if(m.mode==MODE_SERVO || m.mode==MODE_PWM) ledcWrite(m.pin, 0); else digitalWrite(m.pin, LOW);
    return;
  }
  if(millis()-lastRcMs>RC_TIMEOUT_MS) {
    if(m.mode==MODE_SERVO) { uint32_t neutral=((uint32_t)m.outLow+m.outHigh)/2; ledcWrite(m.pin,(uint64_t)neutral*65535/20000); }
    else if(m.mode==MODE_PWM) ledcWrite(m.pin, 0);
    else digitalWrite(m.pin, LOW);
    return;
  }
  long v=constrain((long)value,(long)m.inMin,(long)m.inMax);
  if(m.mode==MODE_SERVO) { uint32_t us=map(v,m.inMin,m.inMax,m.outLow,m.outHigh); uint32_t duty=(uint64_t)us*65535/20000; ledcWrite(m.pin,duty); }
  else if(m.mode==MODE_PWM) ledcWrite(m.pin,map(v,m.inMin,m.inMax,m.outLow,m.outHigh));
  else if(m.mode==MODE_WINDOW) digitalWrite(m.pin, (value>=m.outLow && value<=m.outHigh) ? HIGH : LOW);
  else if(m.mode==MODE_CURVE) {
    float span=(float)(m.inMax-m.inMin); float t=constrain((float)(value-m.inMin)/span,0.0f,1.0f)*4.0f;
    int i=min((int)t,3); float f=t-i; float us=m.curve[i]+(m.curve[i+1]-m.curve[i])*f;
    ledcWrite(m.pin,(uint64_t)(us)*65535/20000);
  }
  else digitalWrite(m.pin, value >= (m.inMin+m.inMax)/2 ? HIGH : LOW);
}
void applyMappingPin(int i, int oldPin) {
  // Reconfigure even when the GPIO stays the same (e.g. SERVO -> PWM).
  if(oldPin>=0) { ledcDetach(oldPin); pinMode(oldPin, INPUT); }
  auto &m=mappings[i]; if(m.mode==MODE_OFF || m.pin<0) return;
  if(!safePin(m.pin)) { m.mode=MODE_OFF; m.pin=-1; return; }
  for(int j=0;j<16;j++) if(j!=i && mappings[j].pin==m.pin && mappings[j].mode!=MODE_OFF) { int duplicate=m.pin; m.mode=MODE_OFF; m.pin=-1; Console.printf("ERROR,pin %d already assigned to channel %d\n",duplicate,j+1); return; }
  if(m.mode==MODE_SERVO) { if(ledcAttach(m.pin,50,16)) ledcWrite(m.pin,0); }
  else if(m.mode==MODE_PWM) { if(ledcAttach(m.pin,1000,8)) ledcWrite(m.pin,0); }
  else pinMode(m.pin,OUTPUT);
}
void saveConfig() { prefs.begin("rangelab",false); for(int i=0;i<16;i++){char k[12]; snprintf(k,sizeof(k),"c%d",i); prefs.putBytes(k,&mappings[i],sizeof(Mapping));} prefs.end(); }
void loadConfig() { prefs.begin("rangelab",true); for(int i=0;i<16;i++){char k[12];snprintf(k,sizeof(k),"c%d",i); if(prefs.getBytesLength(k)==sizeof(Mapping)) prefs.getBytes(k,&mappings[i],sizeof(Mapping)); channels[i]=1500;} prefs.end();
  for(int i=0;i<16;i++){ if(mappings[i].inMin<500 || mappings[i].inMax>2500 || mappings[i].inMin>=mappings[i].inMax || mappings[i].pin>=0&&!safePin(mappings[i].pin) || mappings[i].mode>MODE_CURVE) {mappings[i]=Mapping();} }
  for(int i=0;i<16;i++) if(mappings[i].mode!=MODE_OFF) {int p=mappings[i].pin;applyMappingPin(i,p);}
}
void handleCommand(String line) {
  line.trim(); if(!line.length())return;
  if(line=="GET") {emitAll();return;} if(line=="PING"){Console.println("PONG,RangeLab-ESP32,1");return;}
  if(line=="ENABLE") { outputsEnabled=true; Console.println("STATUS,OUTPUTS_ENABLED"); return; }
  if(line=="DISABLE") { outputsEnabled=false; for(int i=0;i<16;i++)writeOutput(i,channels[i]); Console.println("STATUS,OUTPUTS_DISABLED");return; }
  if(line.startsWith("SET,")) {
    String parts[13]; int count=0,start=0;
    for(int i=0;i<13;i++){int comma=line.indexOf(',',start); if(comma<0){parts[count++]=line.substring(start);break;} parts[count++]=line.substring(start,comma);start=comma+1;}
    // SET,ch,min,max,mode,pin,outLow,outHigh[,c0,c1,c2,c3,c4] => 8 or 13 fields
    if(count!=8&&count!=13){Console.println("ERROR,expected SET,ch,min,max,mode,pin,outLow,outHigh[,curve x5]");return;}
    int ch=parts[1].toInt()-1; if(ch<0||ch>15){Console.println("ERROR,channel must be 1..16");return;}
    Mapping m; m.inMin=parts[2].toInt();m.inMax=parts[3].toInt();m.mode=parseMode(parts[4]);m.pin=parts[5].toInt();m.outLow=parts[6].toInt();m.outHigh=parts[7].toInt();
    if(count==13) for(int i=0;i<5;i++) m.curve[i]=parts[8+i].toInt();
    if(m.inMin<500||m.inMax>2500||m.inMin>=m.inMax){Console.println("ERROR,input range must be 500..2500 and min < max");return;}
    if(m.mode!=MODE_OFF&&!safePin(m.pin)){Console.println("ERROR,pin is not in the safe GPIO allowlist");return;}
    if(m.mode==MODE_SERVO&&(m.outLow<500||m.outHigh>2500||m.outLow>=m.outHigh)){Console.println("ERROR,servo output must be 500..2500us and low < high");return;}
    if(m.mode==MODE_PWM&&(m.outLow<0||m.outHigh>255||m.outLow>=m.outHigh)){Console.println("ERROR,PWM output must be 0..255 and low < high");return;}
    if(m.mode==MODE_WINDOW&&(m.outLow<500||m.outHigh>2500||m.outLow>=m.outHigh)){Console.println("ERROR,window band must be 500..2500us and low < high");return;}
    if(m.mode==MODE_CURVE&&count!=13){Console.println("ERROR,CURVE needs 5 curve points");return;}
    if(m.mode==MODE_CURVE) for(int i=0;i<5;i++) if(m.curve[i]<500||m.curve[i]>2500){Console.println("ERROR,curve points must be 500..2500us");return;}
    if(m.mode==MODE_DIGITAL){m.outLow=0;m.outHigh=1;}
    if(m.mode==MODE_OFF)m.pin=-1;
    for(int i=0;i<16;i++)if(i!=ch&&m.mode!=MODE_OFF&&mappings[i].mode!=MODE_OFF&&mappings[i].pin==m.pin){Console.printf("ERROR,pin %d already assigned\n",m.pin);return;}
    int oldPin=mappings[ch].pin; mappings[ch]=m; applyMappingPin(ch,oldPin); saveConfig(); emitConfig(ch); Console.println("STATUS,CONFIG_SAVED");return;
  }
  if(line.startsWith("LOG")) {
    String sub=line.substring(3); sub.trim(); if(sub.startsWith(","))sub=sub.substring(1); sub.toUpperCase();
    if(sub=="START"){
      prefs.begin("rangelab",false); prefs.putBool("logArm",true); prefs.end();
      logArmed=true; closeLogFile(); openLogFile();
      Console.println("STATUS,LOG_ARMED_RESTARTS_PERSIST"); return;
    }
    if(sub=="STOP"){
      logArmed=false; closeLogFile();
      prefs.begin("rangelab",false); prefs.putBool("logArm",false); prefs.end();
      Console.println("STATUS,LOG_STOPPED_DATA_KEPT"); return;
    }
    if(sub=="CLEAR"){
      logArmed=false; closeLogFile();
      if(!LittleFS.begin(true)){Console.println("ERROR,logging flash unavailable");return;}
      LittleFS.remove(LOG_PATH);
      prefs.begin("rangelab",false); prefs.putBool("logArm",false); prefs.end();
      Console.println("STATUS,LOG_CLEARED"); return;
    }
    if(sub=="DUMP"){
#if RANGELAB_WIFI
      // A full dump is ~1.8 MB of ASCII: too much for the WiFi link, and it would
      // stall the RC loop. Keep that job on USB where it already works.
      if(webSocket.connectedClients()>0){ Console.println("ERROR,field log download needs USB; the WiFi bridge cannot stream the whole log"); return; }
#endif
      closeLogFile();
      if(!LittleFS.begin(true)){Console.println("ERROR,logging flash unavailable");return;}
      File f=LittleFS.open(LOG_PATH,"r");
      if(!f){Console.println("LOG,END,0"); if(logArmed)openLogFile(); return;}
      Console.printf("LOG,SIZE,%lu\n",(unsigned long)f.size());
      while(f.available()){ String l=f.readStringUntil('\n'); l.trim(); if(l.length()) Console.println("LOG,"+l); }
      f.close(); Console.println("LOG,END,1");
      if(logArmed)openLogFile(); return;
    }
  }
  if(line.equalsIgnoreCase("EVENTS")) { dumpEventLog(); return; }
  if(line.equalsIgnoreCase("TRACE")) { dumpLinkTrace(); return; }
  if(line.equalsIgnoreCase("EVENTS,CLEAR")) {
    if(!LittleFS.begin(true)){Console.println("ERROR,event flash unavailable");return;}
    LittleFS.remove(EVENT_PATH);
    Console.println("STATUS,EVENTS_CLEARED");
    return;
  }
  Console.println("ERROR,unknown command; use GET, SET, ENABLE, DISABLE, PING, LOG START|STOP|DUMP|CLEAR, EVENTS[,CLEAR]");
}

#if RANGELAB_WIFI
// ---------------------------------------------------------------------------
// WiFi bridge: access point + phone UI + WebSocket stream
// ---------------------------------------------------------------------------
void handleRemoteCommand(String line) {
  line.trim(); if(!line.length()) return;
  if(line.equalsIgnoreCase("UNLOCK")) { controlsUnlocked=true; lastControlMs=millis(); Console.println("STATUS,CONTROLS_UNLOCKED"); return; }
  if(line.equalsIgnoreCase("LOCK")) { controlsUnlocked=false; Console.println("STATUS,CONTROLS_LOCKED"); return; }
  const bool mutating = line.startsWith("SET,") || line.equalsIgnoreCase("ENABLE") || line.startsWith("LOG")
                     || line.equalsIgnoreCase("EVENTS,CLEAR");
  if(mutating && !controlsUnlocked) { Console.println("ERROR,controls are locked; unlock in the app before writing"); return; }
  lastControlMs=millis();
  handleCommand(line);
}

void onWebSocketEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t length) {
  if(type==WStype_CONNECTED) {
    Console.println("STATUS,PHONE_CONNECTED");
    emitAll();
    // Terminated like every other bridge line, for the same reassembly reason.
    webSocket.sendTXT(client, controlsUnlocked ? "STATUS,CONTROLS_UNLOCKED\n" : "STATUS,CONTROLS_LOCKED\n");
  } else if(type==WStype_DISCONNECTED) {
    if(webSocket.connectedClients()==0) { controlsUnlocked=false; Console.println("STATUS,CONTROLS_LOCKED"); }
  } else if(type==WStype_TEXT) {
    String line; line.reserve(length);
    for(size_t i=0;i<length;i++) line+=(char)payload[i];
    handleRemoteCommand(line);
  }
}

void sendHttp(WiFiClient &client, const char *status, const char *mime, const char *body) {
  const size_t length = strlen(body);
  client.printf("HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
                status, mime, (unsigned)length);
  if(length) client.write((const uint8_t*)body, length);
  client.flush();
  client.stop();
}

void serveHttpRequest() {
  WiFiClient client = httpServer.available();
  if(!client) return;
  client.setTimeout(150);
  String requestLine;
  const uint32_t started = millis();
  while(client.connected() && millis()-started < 250) {
    if(!client.available()) { pollRail(); delay(1); continue; }
    const int c = client.read();
    if(c<0) break;
    if(c=='\n') break;
    if(c!='\r' && requestLine.length()<160) requestLine+=(char)c;
  }
  const int firstSpace = requestLine.indexOf(' ');
  const int secondSpace = firstSpace<0 ? -1 : requestLine.indexOf(' ', firstSpace+1);
  String path = "/";
  if(firstSpace>0 && secondSpace>firstSpace) path = requestLine.substring(firstSpace+1, secondSpace);
  const int query = path.indexOf('?');
  if(query>=0) path = path.substring(0, query);

  if(path=="/"||path=="/index.html") sendHttp(client,"200 OK","text/html; charset=utf-8",INDEX_HTML);
  else if(path=="/bridge.js") sendHttp(client,"200 OK","text/javascript; charset=utf-8",BRIDGE_JS);
  else if(path=="/app.js") sendHttp(client,"200 OK","text/javascript; charset=utf-8",APP_JS);
  else if(path=="/health") sendHttp(client,"200 OK","text/plain","ok");
  else sendHttp(client,"404 Not Found","text/plain","not found");
}

void startWifiBridge() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);  // keeps UART + RC timing steadier while streaming
  String ssid = String(WIFI_AP_PREFIX) + "-" + String((uint16_t)(ESP.getEfuseMac() & 0xFFFF), HEX);
  ssid.toUpperCase();
  if(!WiFi.softAP(ssid.c_str(), WIFI_AP_PASSWORD)) { Console.println("ERROR,wifi access point failed to start"); return; }
  httpServer.begin();
  httpServer.setNoDelay(true);
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);
  Console.printf("STATUS,WIFI_AP_%s_PASSWORD_SET_IN_SKETCH\n", ssid.c_str());
  Console.printf("STATUS,OPEN_http://%s_ON_YOUR_PHONE\n", WiFi.softAPIP().toString().c_str());
  Console.println("STATUS,CONTROLS_LOCKED");
}
#endif

void parseCrsfFrame(const uint8_t *f,size_t n) {
  if(n<4)return; uint8_t type=f[2]; const uint8_t *p=f+3; size_t plen=n-4;
  if(type==CRSF_RC_CHANNELS&&plen>=22){uint32_t bitbuf=0;int bits=0,idx=0;for(size_t i=0;i<22&&idx<16;i++){bitbuf|=((uint32_t)p[i])<<bits;bits+=8;while(bits>=11&&idx<16){uint16_t raw=bitbuf&0x7FF;bitbuf>>=11;bits-=11;channels[idx]=constrain(map(raw,172,1811,988,2012),800,2200);idx++;}} if(idx==16){lastRcMs=millis();for(int i=0;i<16;i++)writeOutput(i,channels[i]);Console.print("CH");for(int i=0;i<16;i++){Console.print(',');Console.print(channels[i]);}Console.println();}}
  else if(type==CRSF_LINK_STATISTICS&&plen>=10){
    linkRssi=(int16_t)-(int)p[0]; linkRssi2=(int16_t)-(int)p[1];
    linkLq=p[2]; linkSnr=(int8_t)p[3];
    linkAntenna=p[4]; linkMode=p[5]; linkTxPower=p[6];
    linkDownLq=p[8]; linkDownSnr=(int8_t)p[9];
    lastLinkStatMs=millis();
    recordLinkPoint();
    Console.printf("LINK,%d,%u,%d\n",linkRssi,linkLq,(int)linkSnr);
  }
}
void pollCrsf(){while(CRSF.available()){noteCrsfByte(millis());uint8_t b=CRSF.read();if(frameLen==0){if(b==0xC8||b==0xEE||b==0xEA||b==0xEC||b==0x00)frame[frameLen++]=b;continue;}if(frameLen>=sizeof(frame)){frameLen=0;continue;}frame[frameLen++]=b;if(frameLen==2){if(frame[1]<2||frame[1]>64){frameLen=0;continue;}}if(frameLen>=2&&frameLen==(size_t)frame[1]+2){size_t n=frameLen;if(crsfCrc(frame+2,n-3)==frame[n-1])parseCrsfFrame(frame,n);frameLen=0;}}}
void setup(){Serial.begin(USB_BAUD);
#if RANGELAB_WIFI
  CRSF.setRxBufferSize(1024);  // absorb a few dropped IRQs while WiFi transmits
#endif
  CRSF.begin(CRSF_BAUD,SERIAL_8N1,CRSF_RX_PIN,-1);for(auto &c:channels)c=1500;loadConfig();loadLogArm();
  railInit();
  logBootEvent();
  if(logArmed){openLogFile();Console.println("STATUS,LOG_ARMED_FIELD_MODE");}
#if RANGELAB_WIFI
  startWifiBridge();
#endif
  Console.println("READY,RangeLab-ESP32,1");Console.println("STATUS,OUTPUTS_DISABLED_ON_BOOT");}
void loop(){const uint32_t loopNow=millis();lastIterationMs=loopNow-lastLoopMs;lastLoopMs=loopNow;pollRail();pollCrsf();flushGapEvent();
  while(Serial.available()){char c=Serial.read();if(c=='\n'||c=='\r'){if(usbLine.length()){handleCommand(usbLine);usbLine="";}}else if(usbLine.length()<180)usbLine+=c;else usbLine="";}
  bool failsafe=millis()-lastRcMs>RC_TIMEOUT_MS;if(failsafe&&!wasFailsafe){for(int i=0;i<16;i++)writeOutput(i,channels[i]);Console.println("STATUS,RC_FAILSAFE_OUTPUTS_NEUTRAL");}wasFailsafe=failsafe;
  if(logArmed&&millis()-lastLogMs>=LOG_PERIOD_MS){lastLogMs=millis();logSample();}
  scanEvents();
#if RANGELAB_WIFI
  webSocket.loop();
  serveHttpRequest();
  if(controlsUnlocked && millis()-lastControlMs>CONTROL_IDLE_TIMEOUT_MS){controlsUnlocked=false;Console.println("STATUS,CONTROLS_RELOCKED_IDLE");}
#endif
}
