import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES,
  applyLine,
  createState,
  emptyMapping,
  prepareMapping,
  pulsePercent,
  splitLines,
  validateMapping,
} from '../mobile/bridge.js';

const filled = (value: number) => Array.from({ length: 16 }, (_, i) => value + i);

test('mobile: reassembles lines split across websocket frames', () => {
  let { lines, rest } = splitLines('', 'CH,1500,15');
  assert.deepEqual(lines, []);
  ({ lines, rest } = splitLines(rest, '00,1500\nLINK,-62,88,7\nCF'));
  assert.deepEqual(lines, ['CH,1500,1500,1500', 'LINK,-62,88,7']);
  assert.equal(rest, 'CF');
});

test('mobile: parses live channels and keeps previous values on a corrupt frame', () => {
  const values = filled(1000);
  let state = applyLine(createState(), `CH,${values.join(',')}`);
  assert.deepEqual(state.channels, values);
  assert.notEqual(state.channelUpdatedAt, null);

  const corrupt = applyLine(state, 'CH,1000,oops,1200');
  assert.deepEqual(corrupt.channels, values);
  assert.equal(corrupt.channelUpdatedAt, state.channelUpdatedAt);
});

test('mobile: parses link stats and device identity', () => {
  let state = applyLine(createState(), 'LINK,-71,90,6');
  assert.deepEqual(state.link, { rssi: -71, lq: 90, snr: 6 });
  state = applyLine(state, 'DEVICE,RangeLab-ESP32,1');
  assert.equal(state.device, 'RangeLab-ESP32 1');
});

test('mobile: parses the receiver UART health counters', () => {
  assert.equal(createState().wire, null);
  let state = applyLine(createState(), 'WIRE,0,0,0');
  assert.deepEqual(state.wire, { bad: 0, junk: 0, ignored: 0 });
  state = applyLine(state, 'WIRE,12,3,2');
  assert.deepEqual(state.wire, { bad: 12, junk: 3, ignored: 2 });
  // A truncated or impossible line keeps the last good reading.
  assert.deepEqual(applyLine(state, 'WIRE,12,3').wire, { bad: 12, junk: 3, ignored: 2 });
  assert.deepEqual(applyLine(state, 'WIRE,-1,0,0').wire, { bad: 12, junk: 3, ignored: 2 });
  assert.deepEqual(applyLine(state, 'WIRE,1.5,0,0').wire, { bad: 12, junk: 3, ignored: 2 });
});

test('mobile: applies CFG lines including the five curve points', () => {
  const state = applyLine(createState(), 'CFG,7,900,1100,CURVE,19,1000,2000,700,900,1500,1800,2300');
  const mapping = state.mappings[6];
  assert.equal(mapping.mode, 'CURVE');
  assert.equal(mapping.pin, 19);
  assert.equal(mapping.inMin, 900);
  assert.deepEqual(mapping.curve, [700, 900, 1500, 1800, 2300]);
  // Untouched channels keep their defaults.
  assert.equal(state.mappings[0].mode, 'OFF');
});

test('mobile: tracks output and control lock state from STATUS lines', () => {
  let state = applyLine(createState(), 'STATUS,OUTPUTS_ENABLED');
  assert.equal(state.outputsEnabled, true);
  state = applyLine(state, 'STATUS,CONTROLS_UNLOCKED');
  assert.equal(state.controlsUnlocked, true);
  state = applyLine(state, 'STATUS,CONTROLS_RELOCKED_IDLE');
  assert.equal(state.controlsUnlocked, false);
  state = applyLine(state, 'STATUS,OUTPUTS_DISABLED');
  assert.equal(state.outputsEnabled, false);
});

test('mobile: logs bridge chatter but drops field-log size and end markers', () => {
  let state = applyLine(createState(), 'LOG,SIZE,1800000');
  const afterSize = state.lineCount;
  assert.equal(state.logs.at(-1), 'Waiting for the ESP32 WiFi bridge.');
  state = applyLine(state, 'LOG,END,1');
  assert.equal(state.logs.at(-1), 'Waiting for the ESP32 WiFi bridge.');
  state = applyLine(state, 'ERROR,controls locked');
  assert.equal(state.logs.at(-1), 'ERROR,controls locked');
  assert.equal(state.lineCount, afterSize + 2);
});

test('mobile: collects live link events and replaces them with the device dump', () => {
  let state = applyLine(createState(), 'EVENT,1200,RX_SILENT,no CRSF bytes for 1000ms; last rssi -80 dBm lq 0 snr 2');
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0], {
    at: 1200,
    code: 'RX_SILENT',
    detail: 'no CRSF bytes for 1000ms; last rssi -80 dBm lq 0 snr 2',
  });
  assert.equal(state.eventsVersion, 1);

  // A dump is authoritative: it replaces what was shown and keeps flash order.
  state = applyLine(state, 'EVENT_DUMP_BEGIN');
  assert.deepEqual(state.eventDraft, []);
  state = applyLine(state, 'EVENT,400,BOOT,esp32 boot #3');
  state = applyLine(state, 'EVENT,900,RF_LINK_LOST,link quality 0% rssi -90 dBm snr -4');
  state = applyLine(state, 'EVENT,1400,RF_LINK_OK,receiver reports link quality again');
  state = applyLine(state, 'EVENT_END');
  assert.equal(state.eventDraft, null);
  assert.deepEqual(state.events.map((event) => event.code), ['BOOT', 'RF_LINK_LOST', 'RF_LINK_OK']);
});

test('mobile: an empty dump keeps live events, and clearing empties the list', () => {
  let state = applyLine(createState(), 'EVENT,50,RX_ACTIVE,receiver is transmitting again');
  assert.equal(state.events.length, 1);

  state = applyLine(state, 'EVENT_DUMP_BEGIN');
  state = applyLine(state, 'EVENT_END');
  assert.equal(state.events.length, 1);

  state = applyLine(state, 'STATUS,EVENTS_CLEARED');
  assert.deepEqual(state.events, []);

  // Malformed events are ignored rather than rendered.
  state = applyLine(state, 'EVENT,not-a-time,RX_SILENT,detail');
  state = applyLine(state, 'EVENT,10,RX_SILENT');
  assert.deepEqual(state.events.map((event) => event.code), ['RX_SILENT']);
  assert.equal(state.events[0].detail, '');
});

test('mobile: replaces the link trace when the device replays one', () => {
  let state = createState();
  state = applyLine(state, 'TRACE_BEGIN');
  state = applyLine(state, 'TRACE,1200,-62,-64,100,9,1,2,100,88,-3');
  state = applyLine(state, 'TRACE,1300,-95,-96,0,-2,1,2,100,0,-12');
  state = applyLine(state, 'TRACE_END');
  assert.equal(state.traceDraft, null);
  assert.deepEqual(state.trace, [
    { at: 1200, rssi1: -62, rssi2: -64, lq: 100, snr: 9, ant: 1, mode: 2, txPwr: 100, downLq: 88, downSnr: -3 },
    { at: 1300, rssi1: -95, rssi2: -96, lq: 0, snr: -2, ant: 1, mode: 2, txPwr: 100, downLq: 0, downSnr: -12 },
  ]);

  // Points outside a dump are ignored, and a new dump replaces the old trace.
  state = applyLine(state, 'TRACE,1400,-60,-61,100,8,1,2,100,90,2');
  assert.equal(state.trace.length, 2);
  state = applyLine(state, 'TRACE_BEGIN');
  state = applyLine(state, 'TRACE_END');
  assert.deepEqual(state.trace, []);
});

test('mobile: shows the optional 5V rail reading and ignores nonsense', () => {
  // The firmware sends the threshold this build uses, so a tuned board still
  // colours the reading correctly.
  let state = applyLine(createState(), 'RAIL,4980,4712,4400');
  assert.deepEqual(state.rail, { mv: 4980, minMv: 4712, lowMv: 4400 });

  // Older firmware omits it: the page then falls back to its own constant.
  state = applyLine(state, 'RAIL,4980,4712');
  assert.deepEqual(state.rail, { mv: 4980, minMv: 4712, lowMv: null });

  state = applyLine(state, 'RAIL,garbage,4712');
  assert.deepEqual(state.rail, { mv: 4980, minMv: 4712, lowMv: null });
  state = applyLine(state, 'RAIL,99000,4712');
  assert.deepEqual(state.rail, { mv: 4980, minMv: 4712, lowMv: null });
  state = applyLine(state, 'RAIL,4980,4712,0');
  assert.deepEqual(state.rail, { mv: 4980, minMv: 4712, lowMv: null });

  // No ADC tap wired means no RAIL lines, and the page says "not monitored".
  assert.equal(createState().rail, null);
});

test('mobile: a real firmware session fills the RX and power views', () => {
  // Exactly the lines firmware/RangeLab_ESP32.ino prints, in the order it prints
  // them, including the ones a link drop and a supply dip produce.
  const session = [
    'DEVICE,RangeLab-ESP32,1',
    'STATUS,OUTPUTS_DISABLED_ON_BOOT',
    'STATUS,CONTROLS_LOCKED',
    'EVENT,120,BOOT,esp32 boot #3 (power-on); rail 4712 mV',
    'RAIL,4712,4712,4400',
    'WIRE,0,0,0',
    'CH,' + filled(1000).join(','),
    'LINK,-64,100,9',
    'EVENT,9100,WIRE_NOISE,4 bad frame(s) and 1 sync error(s) in 12ms on the receiver UART; rail 4705 mV',
    'EVENT,9480,RX_GAP,CRSF stream paused for 210ms; receiver kept its state (lq 96 ant 1 mode 4); 4 UART error(s) around it',
    'EVENT,9521,RF_LINK_LOST,lq 96>0 rssi -78>-92 min -95 snr 4>-1 dlq 100>0 ant 1 mode 4 tx 100mW trend -78,-82,-86,-90,-92,-95',
    'EVENT,9930,RF_LINK_OK,link back after 409ms; rssi -71 dBm lq 88; rail 4700 mV',
    'RAIL,4300,4300,4400',
    'EVENT,10440,PWR_DIP,5V rail dipped to 4300 mV for 8ms (below 4400 mV)',
    'RAIL,4698,4300,4400',
    'WIRE,9,2,0',
    'TRACE_BEGIN',
    'TRACE,9800,-78,-80,96,4,1,4,100,100,-2',
    'TRACE,9900,-82,-84,60,2,1,4,100,96,-3',
    'TRACE,10000,-88,-90,12,0,1,4,100,80,-4',
    'TRACE_END',
  ];
  let state = createState();
  for (const line of session) state = applyLine(state, line);

  // Receiver view.
  assert.equal(state.device, 'RangeLab-ESP32 1');
  assert.deepEqual(state.link, { rssi: -64, lq: 100, snr: 9 });
  assert.deepEqual(state.channels, filled(1000));
  assert.equal(state.trace.length, 3);
  assert.deepEqual(state.trace.at(-1), {
    at: 10000, rssi1: -88, rssi2: -90, lq: 12, snr: 0, ant: 1, mode: 4, txPwr: 100, downLq: 80, downSnr: -4,
  });

  // Power view: live value, the worst since boot, and the threshold in use.
  assert.deepEqual(state.rail, { mv: 4698, minMv: 4300, lowMv: 4400 });
  // UART health view.
  assert.deepEqual(state.wire, { bad: 9, junk: 2, ignored: 0 });

  // Both kinds of trouble reach the event list, newest last.
  const codes = state.events.map((e) => e.code);
  assert.deepEqual(codes, ['BOOT', 'WIRE_NOISE', 'RX_GAP', 'RF_LINK_LOST', 'RF_LINK_OK', 'PWR_DIP']);
  assert.equal(state.events.at(-1).detail, '5V rail dipped to 4300 mV for 8ms (below 4400 mV)');
});

test('mobile: rejects unsafe or nonsensical mappings', () => {
  const ok = { ...emptyMapping(1), mode: 'SERVO', pin: 13, outLow: 1000, outHigh: 2000 };
  assert.equal(validateMapping(ok).ok, true);

  assert.equal(validateMapping({ ...ok, inMin: 400 }).ok, false);
  assert.equal(validateMapping({ ...ok, inMax: 2600 }).ok, false);
  assert.equal(validateMapping({ ...ok, inMin: 1800, inMax: 1800 }).ok, false);
  assert.equal(validateMapping({ ...ok, pin: 4 }).ok, false);
  assert.equal(validateMapping({ ...ok, inMin: 1000.5 }).ok, false);
  assert.equal(validateMapping({ ...ok, outLow: 1500, outHigh: 1200 }).ok, false);

  const dims = { ...emptyMapping(2), mode: 'PWM', pin: 21, outLow: 0, outHigh: 255 };
  assert.equal(validateMapping({ ...dims, outHigh: 300 }).ok, false);

  const curved = { ...emptyMapping(3), mode: 'CURVE', pin: 22, curve: [1000, 1250, 1500, 1750, 2000] };
  assert.equal(validateMapping(curved).ok, true);
  assert.equal(validateMapping({ ...curved, curve: [1000, 1250, 1500, 1750] }).ok, false);
  assert.equal(validateMapping({ ...curved, curve: [1000, 1250, 1500, 1750, 3000] }).ok, false);
});

test('mobile: refuses a GPIO that another active channel already owns', () => {
  const other = { ...emptyMapping(2), mode: 'SERVO', pin: 19 };
  const mine = { ...emptyMapping(1), mode: 'PWM', pin: 19, outLow: 0, outHigh: 255 };
  const result = validateMapping(mine, [mine, other]);
  assert.equal(result.ok, false);
  // An inactive channel holding the same pin is not a conflict.
  assert.equal(validateMapping(mine, [mine, emptyMapping(2)]).ok, true);
});

test('mobile: builds the exact SET line the firmware parses', () => {
  const servo = prepareMapping({ ...emptyMapping(4), mode: 'SERVO', pin: 17, inMin: 900, inMax: 2100, outLow: 1000, outHigh: 2000 });
  assert.deepEqual(servo, { ok: true, command: 'SET,4,900,2100,SERVO,17,1000,2000' });

  const off = prepareMapping({ ...emptyMapping(5), mode: 'OFF', pin: 17 });
  assert.deepEqual(off, { ok: true, command: 'SET,5,1000,2000,OFF,-1,1000,2000' });

  const curve = prepareMapping({
    ...emptyMapping(6),
    mode: 'CURVE',
    pin: 18,
    curve: [1000, 1200, 1500, 1800, 2000],
  });
  assert.deepEqual(curve, { ok: true, command: 'SET,6,1000,2000,CURVE,18,1000,2000,1000,1200,1500,1800,2000' });

  const rejected = prepareMapping({ ...emptyMapping(7), mode: 'SERVO', pin: 99 });
  assert.equal(rejected.ok, false);
  assert.equal('command' in rejected, false);
});

test('mobile: exposes every firmware mode and clamps the channel meter', () => {
  assert.deepEqual(MODES, ['OFF', 'SERVO', 'PWM', 'DIGITAL', 'WINDOW', 'CURVE']);
  assert.equal(pulsePercent(800), 0);
  assert.equal(pulsePercent(2200), 100);
  assert.equal(pulsePercent(1500), 50);
  assert.equal(pulsePercent(3000), 100);
});
