import test from 'node:test';
import assert from 'node:assert/strict';
import { applySerialLine, EMPTY_TELEMETRY, pulseLabel } from '../src/lib/protocol.ts';

test('parses the normal 16-channel bridge format', () => {
  const values = Array.from({ length: 16 }, (_, i) => 1000 + i * 50);
  const result = applySerialLine(EMPTY_TELEMETRY, `CH,${values.join(',')}`);
  assert.deepEqual(result.channels, values);
  assert.notEqual(result.channelUpdatedAt, null);
});

test('parses a channel count prefix and indexed pairs', () => {
  const values = Array.from({ length: 16 }, (_, i) => 1000 + i);
  assert.deepEqual(applySerialLine(EMPTY_TELEMETRY, `CH,16,${values.join(',')}`).channels, values);
  const pairs = values.flatMap((value, index) => [index + 1, value]);
  assert.deepEqual(applySerialLine(EMPTY_TELEMETRY, `CH,${pairs.join(',')}`).channels, values);
});

test('rejects malformed channel data without corrupting channel positions', () => {
  const prior = applySerialLine(EMPTY_TELEMETRY, 'CH,' + Array(16).fill(1500).join(','));
  const malformed = applySerialLine(prior, 'CH,1000,not-a-number,1200');
  assert.deepEqual(malformed.channels, prior.channels);
  assert.equal(malformed.channelUpdatedAt, prior.channelUpdatedAt);
  assert.equal(malformed.rawLines.at(-1), 'CH,1000,not-a-number,1200');
});

test('keeps link stats and status lines bounded and parseable', () => {
  let state = applySerialLine(EMPTY_TELEMETRY, 'LINK,-68,92,9');
  assert.deepEqual(state.link?.values, [-68, 92, 9]);
  state = applySerialLine(state, 'STATUS,receiver online');
  assert.equal(state.statusLines.at(-1), 'receiver online');
});

test('labels common pulse positions', () => {
  assert.equal(pulseLabel(880), 'LOW');
  assert.equal(pulseLabel(1500), 'CENTRE');
  assert.equal(pulseLabel(2115), 'HIGH');
});
