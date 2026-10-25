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

  Safety: outputs are DISABLED on boot and after 500 ms without valid RC frames.
          Over WiFi, outputs and mapping writes stay locked until the app sends
          UNLOCK; DISABLE is always accepted.
  Commands: GET, SET,ch,min,max,mode,pin,outLow,outHigh[,curve x5], ENABLE, DISABLE, PING,
            LOG START|STOP|DUMP|CLEAR (field logging to internal flash, 10 Hz, persists across
            restarts; wraps when full and records an OVERFLOW marker).
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
  Console.println("ERROR,unknown command; use GET, SET, ENABLE, DISABLE, PING, LOG START|STOP|DUMP|CLEAR");
}

#if RANGELAB_WIFI
// ---------------------------------------------------------------------------
// WiFi bridge: access point + phone UI + WebSocket stream
// ---------------------------------------------------------------------------
void handleRemoteCommand(String line) {
  line.trim(); if(!line.length()) return;
  if(line.equalsIgnoreCase("UNLOCK")) { controlsUnlocked=true; lastControlMs=millis(); Console.println("STATUS,CONTROLS_UNLOCKED"); return; }
  if(line.equalsIgnoreCase("LOCK")) { controlsUnlocked=false; Console.println("STATUS,CONTROLS_LOCKED"); return; }
  const bool mutating = line.startsWith("SET,") || line.equalsIgnoreCase("ENABLE") || line.startsWith("LOG");
  if(mutating && !controlsUnlocked) { Console.println("ERROR,controls are locked; unlock in the app before writing"); return; }
  lastControlMs=millis();
  handleCommand(line);
}

void onWebSocketEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t length) {
  if(type==WStype_CONNECTED) {
    Console.println("STATUS,PHONE_CONNECTED");
    emitAll();
    webSocket.sendTXT(client, controlsUnlocked ? "STATUS,CONTROLS_UNLOCKED" : "STATUS,CONTROLS_LOCKED");
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
    if(!client.available()) { delay(1); continue; }
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
  else if(type==CRSF_LINK_STATISTICS&&plen>=10){linkRssi=(int16_t)-(int)p[0];linkLq=p[2];linkSnr=(int8_t)p[3];Console.printf("LINK,%d,%u,%d\n",linkRssi,linkLq,(int)linkSnr);}
}
void pollCrsf(){while(CRSF.available()){uint8_t b=CRSF.read();if(frameLen==0){if(b==0xC8||b==0xEE||b==0xEA||b==0xEC||b==0x00)frame[frameLen++]=b;continue;}if(frameLen>=sizeof(frame)){frameLen=0;continue;}frame[frameLen++]=b;if(frameLen==2){if(frame[1]<2||frame[1]>64){frameLen=0;continue;}}if(frameLen>=2&&frameLen==(size_t)frame[1]+2){size_t n=frameLen;if(crsfCrc(frame+2,n-3)==frame[n-1])parseCrsfFrame(frame,n);frameLen=0;}}}
void setup(){Serial.begin(USB_BAUD);
#if RANGELAB_WIFI
  CRSF.setRxBufferSize(1024);  // absorb a few dropped IRQs while WiFi transmits
#endif
  CRSF.begin(CRSF_BAUD,SERIAL_8N1,CRSF_RX_PIN,-1);for(auto &c:channels)c=1500;loadConfig();loadLogArm();if(logArmed){openLogFile();Console.println("STATUS,LOG_ARMED_FIELD_MODE");}
#if RANGELAB_WIFI
  startWifiBridge();
#endif
  Console.println("READY,RangeLab-ESP32,1");Console.println("STATUS,OUTPUTS_DISABLED_ON_BOOT");}
void loop(){pollCrsf();while(Serial.available()){char c=Serial.read();if(c=='\n'||c=='\r'){if(usbLine.length()){handleCommand(usbLine);usbLine="";}}else if(usbLine.length()<180)usbLine+=c;else usbLine="";}
  bool failsafe=millis()-lastRcMs>RC_TIMEOUT_MS;if(failsafe&&!wasFailsafe){for(int i=0;i<16;i++)writeOutput(i,channels[i]);Console.println("STATUS,RC_FAILSAFE_OUTPUTS_NEUTRAL");}wasFailsafe=failsafe;
  if(logArmed&&millis()-lastLogMs>=LOG_PERIOD_MS){lastLogMs=millis();logSample();}
#if RANGELAB_WIFI
  webSocket.loop();
  serveHttpRequest();
  if(controlsUnlocked && millis()-lastControlMs>CONTROL_IDLE_TIMEOUT_MS){controlsUnlocked=false;Console.println("STATUS,CONTROLS_RELOCKED_IDLE");}
#endif
}
