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
