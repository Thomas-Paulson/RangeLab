/*
  RangeLab Standalone ESP32-WROOM CRSF bridge + channel-to-pin mapper
  Hardware: ESP32-WROOM DevKit, ExpressLRS receiver CRSF TX -> GPIO16 (RX2), GND common.
  USB serial to desktop: 115200 baud. Receiver UART: 420000 baud.
  Arduino-ESP32 core 3.x recommended (LEDC API v3).

  Safety: outputs are DISABLED on boot and after 500 ms without valid RC frames.
  Commands over USB: GET, SET,ch,min,max,mode,pin,outLow,outHigh[,curve x5], ENABLE, DISABLE, PING,
                     LOG START|STOP|DUMP|CLEAR (field logging to internal flash, 10 Hz, persists across restarts;
                     wraps when full and records an OVERFLOW marker).
  Modes: OFF, SERVO (microseconds), PWM (0..255), DIGITAL (threshold at midpoint),
         WINDOW (output high inside outLow..outHigh band), CURVE (5-point servo curve).
  Never connect motors/servos directly to GPIO if their current exceeds GPIO capability.
*/
#include <Arduino.h>
#include <Preferences.h>
#include <LittleFS.h>

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

void closeLogFile(){ if(logFile) logFile.close(); }
void openLogFile(){
  if(!LittleFS.begin(true)){ Serial.println("ERROR,logging flash unavailable"); return; }
  logFile=LittleFS.open(LOG_PATH,"a");
  if(!logFile){ Serial.println("ERROR,log file could not be opened"); return; }
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
void emitConfig(int i) { const auto &m=mappings[i]; Serial.printf("CFG,%d,%u,%u,%s,%d,%u,%u,%u,%u,%u,%u,%u\n",i+1,m.inMin,m.inMax,modeName(m.mode),m.pin,m.outLow,m.outHigh,m.curve[0],m.curve[1],m.curve[2],m.curve[3],m.curve[4]); }
void emitAll() { Serial.println("DEVICE,RangeLab-ESP32,1"); Serial.printf("STATUS,%s\n", outputsEnabled?"OUTPUTS_ENABLED":"OUTPUTS_DISABLED"); for(int i=0;i<16;i++)emitConfig(i); }
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
  for(int j=0;j<16;j++) if(j!=i && mappings[j].pin==m.pin && mappings[j].mode!=MODE_OFF) { int duplicate=m.pin; m.mode=MODE_OFF; m.pin=-1; Serial.printf("ERROR,pin %d already assigned to channel %d\n",duplicate,j+1); return; }
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
  if(line=="GET") {emitAll();return;} if(line=="PING"){Serial.println("PONG,RangeLab-ESP32,1");return;}
  if(line=="ENABLE") { outputsEnabled=true; Serial.println("STATUS,OUTPUTS_ENABLED"); return; }
  if(line=="DISABLE") { outputsEnabled=false; for(int i=0;i<16;i++)writeOutput(i,channels[i]); Serial.println("STATUS,OUTPUTS_DISABLED");return; }
  if(line.startsWith("SET,")) {
    String parts[13]; int count=0,start=0;
    for(int i=0;i<13;i++){int comma=line.indexOf(',',start); if(comma<0){parts[count++]=line.substring(start);break;} parts[count++]=line.substring(start,comma);start=comma+1;}
    // SET,ch,min,max,mode,pin,outLow,outHigh[,c0,c1,c2,c3,c4] => 8 or 13 fields
    if(count!=8&&count!=13){Serial.println("ERROR,expected SET,ch,min,max,mode,pin,outLow,outHigh[,curve x5]");return;}
    int ch=parts[1].toInt()-1; if(ch<0||ch>15){Serial.println("ERROR,channel must be 1..16");return;}
    Mapping m; m.inMin=parts[2].toInt();m.inMax=parts[3].toInt();m.mode=parseMode(parts[4]);m.pin=parts[5].toInt();m.outLow=parts[6].toInt();m.outHigh=parts[7].toInt();
    if(count==13) for(int i=0;i<5;i++) m.curve[i]=parts[8+i].toInt();
    if(m.inMin<500||m.inMax>2500||m.inMin>=m.inMax){Serial.println("ERROR,input range must be 500..2500 and min < max");return;}
    if(m.mode!=MODE_OFF&&!safePin(m.pin)){Serial.println("ERROR,pin is not in the safe GPIO allowlist");return;}
    if(m.mode==MODE_SERVO&&(m.outLow<500||m.outHigh>2500||m.outLow>=m.outHigh)){Serial.println("ERROR,servo output must be 500..2500us and low < high");return;}
    if(m.mode==MODE_PWM&&(m.outLow<0||m.outHigh>255||m.outLow>=m.outHigh)){Serial.println("ERROR,PWM output must be 0..255 and low < high");return;}
    if(m.mode==MODE_WINDOW&&(m.outLow<500||m.outHigh>2500||m.outLow>=m.outHigh)){Serial.println("ERROR,window band must be 500..2500us and low < high");return;}
    if(m.mode==MODE_CURVE&&count!=13){Serial.println("ERROR,CURVE needs 5 curve points");return;}
    if(m.mode==MODE_CURVE) for(int i=0;i<5;i++) if(m.curve[i]<500||m.curve[i]>2500){Serial.println("ERROR,curve points must be 500..2500us");return;}
    if(m.mode==MODE_DIGITAL){m.outLow=0;m.outHigh=1;}
    if(m.mode==MODE_OFF)m.pin=-1;
    for(int i=0;i<16;i++)if(i!=ch&&m.mode!=MODE_OFF&&mappings[i].mode!=MODE_OFF&&mappings[i].pin==m.pin){Serial.printf("ERROR,pin %d already assigned\n",m.pin);return;}
    int oldPin=mappings[ch].pin; mappings[ch]=m; applyMappingPin(ch,oldPin); saveConfig(); emitConfig(ch); Serial.println("STATUS,CONFIG_SAVED");return;
  }
  if(line.startsWith("LOG")) {
    String sub=line.substring(3); sub.trim(); if(sub.startsWith(","))sub=sub.substring(1); sub.toUpperCase();
    if(sub=="START"){
      prefs.begin("rangelab",false); prefs.putBool("logArm",true); prefs.end();
      logArmed=true; closeLogFile(); openLogFile();
      Serial.println("STATUS,LOG_ARMED_RESTARTS_PERSIST"); return;
    }
    if(sub=="STOP"){
      logArmed=false; closeLogFile();
      prefs.begin("rangelab",false); prefs.putBool("logArm",false); prefs.end();
      Serial.println("STATUS,LOG_STOPPED_DATA_KEPT"); return;
    }
    if(sub=="CLEAR"){
      logArmed=false; closeLogFile();
      if(!LittleFS.begin(true)){Serial.println("ERROR,logging flash unavailable");return;}
      LittleFS.remove(LOG_PATH);
      prefs.begin("rangelab",false); prefs.putBool("logArm",false); prefs.end();
      Serial.println("STATUS,LOG_CLEARED"); return;
    }
    if(sub=="DUMP"){
      closeLogFile();
      if(!LittleFS.begin(true)){Serial.println("ERROR,logging flash unavailable");return;}
      File f=LittleFS.open(LOG_PATH,"r");
      if(!f){Serial.println("LOG,END,0"); if(logArmed)openLogFile(); return;}
      Serial.printf("LOG,SIZE,%lu\n",(unsigned long)f.size());
      while(f.available()){ String l=f.readStringUntil('\n'); l.trim(); if(l.length()) Serial.println("LOG,"+l); }
      f.close(); Serial.println("LOG,END,1");
      if(logArmed)openLogFile(); return;
    }
  }
  Serial.println("ERROR,unknown command; use GET, SET, ENABLE, DISABLE, PING, LOG START|STOP|DUMP|CLEAR");
}
void parseCrsfFrame(const uint8_t *f,size_t n) {
  if(n<4)return; uint8_t type=f[2]; const uint8_t *p=f+3; size_t plen=n-4;
  if(type==CRSF_RC_CHANNELS&&plen>=22){uint32_t bitbuf=0;int bits=0,idx=0;for(size_t i=0;i<22&&idx<16;i++){bitbuf|=((uint32_t)p[i])<<bits;bits+=8;while(bits>=11&&idx<16){uint16_t raw=bitbuf&0x7FF;bitbuf>>=11;bits-=11;channels[idx]=constrain(map(raw,172,1811,988,2012),800,2200);idx++;}} if(idx==16){lastRcMs=millis();for(int i=0;i<16;i++)writeOutput(i,channels[i]);Serial.print("CH");for(int i=0;i<16;i++){Serial.print(',');Serial.print(channels[i]);}Serial.println();}}
  else if(type==CRSF_LINK_STATISTICS&&plen>=10){linkRssi=(int16_t)-(int)p[0];linkLq=p[2];linkSnr=(int8_t)p[3];Serial.printf("LINK,%d,%u,%d\n",linkRssi,linkLq,(int)linkSnr);}
}
void pollCrsf(){while(CRSF.available()){uint8_t b=CRSF.read();if(frameLen==0){if(b==0xC8||b==0xEE||b==0xEA||b==0xEC||b==0x00)frame[frameLen++]=b;continue;}if(frameLen>=sizeof(frame)){frameLen=0;continue;}frame[frameLen++]=b;if(frameLen==2){if(frame[1]<2||frame[1]>64){frameLen=0;continue;}}if(frameLen>=2&&frameLen==(size_t)frame[1]+2){size_t n=frameLen;if(crsfCrc(frame+2,n-3)==frame[n-1])parseCrsfFrame(frame,n);frameLen=0;}}}
void setup(){Serial.begin(USB_BAUD);CRSF.begin(CRSF_BAUD,SERIAL_8N1,CRSF_RX_PIN,-1);for(auto &c:channels)c=1500;loadConfig();loadLogArm();if(logArmed){openLogFile();Serial.println("STATUS,LOG_ARMED_FIELD_MODE");}Serial.println("READY,RangeLab-ESP32,1");Serial.println("STATUS,OUTPUTS_DISABLED_ON_BOOT");}
void loop(){pollCrsf();while(Serial.available()){char c=Serial.read();if(c=='\n'||c=='\r'){if(usbLine.length()){handleCommand(usbLine);usbLine="";}}else if(usbLine.length()<180)usbLine+=c;else usbLine="";}
  bool failsafe=millis()-lastRcMs>RC_TIMEOUT_MS;if(failsafe&&!wasFailsafe){for(int i=0;i<16;i++)writeOutput(i,channels[i]);Serial.println("STATUS,RC_FAILSAFE_OUTPUTS_NEUTRAL");}wasFailsafe=failsafe;
  if(logArmed&&millis()-lastLogMs>=LOG_PERIOD_MS){lastLogMs=millis();logSample();}
}
