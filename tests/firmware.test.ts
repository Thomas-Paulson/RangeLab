import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyFirmware } from '../src/lib/firmware.ts';

test('identifies the ESP-FC banner from received output', () => {
  const result = identifyFirmware(['✓ Connected', '← ESPF ESP32 v0.2.1 120a1a6']);
  assert.equal(result.kind, 'esp-fc');
  assert.equal(result.rangeCliSupported, true);
});

test('does not mistake a sent command for a firmware response', () => {
  assert.equal(identifyFirmware(['→ version']).kind, 'unknown');
});

test('identifies Betaflight and warns against ESP-FC range commands', () => {
  const result = identifyFirmware(['← Betaflight / STM32F405 4.5.0']);
  assert.equal(result.kind, 'betaflight');
  assert.equal(result.rangeCliSupported, false);
});

test('identifies the ASCII receiver bridge separately from configuration firmware', () => {
  const result = identifyFirmware(['← CH,1500,1500,1000,1500']);
  assert.equal(result.kind, 'crsf-bridge');
  assert.equal(result.rangeCliSupported, false);
});
