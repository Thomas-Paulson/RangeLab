import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCurve, inWindow, isPwmRange, outputRangeForMode, validateMapping, DEFAULT_CURVE, DIGITAL_RANGE, WINDOW_BAND } from '../src/lib/mapping.ts';

const SAFE = [13, 14, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
const base = { inMin: 1000, inMax: 2000, mode: 'OFF' as const, pin: -1, outLow: 1000, outHigh: 2000, curve: DEFAULT_CURVE };

test('switch window is inclusive and bounded', () => {
  assert.equal(inWindow(1500, 1400, 1600), true);
  assert.equal(inWindow(1400, 1400, 1600), true);
  assert.equal(inWindow(1601, 1400, 1600), false);
  assert.equal(inWindow(1000, 1400, 1600), false);
});

test('curve interpolates between points and clamps at ends', () => {
  const c = [1000, 1500, 2000, 1500, 1000];
  assert.equal(evaluateCurve(1000, 1000, 2000, c), 1000);
  assert.equal(evaluateCurve(2000, 1000, 2000, c), 1000);
  assert.equal(evaluateCurve(1250, 1000, 2000, c), 1500);
  assert.equal(evaluateCurve(1500, 1000, 2000, c), 2000);
  assert.equal(evaluateCurve(1125, 1000, 2000, c), 1250);
  assert.equal(evaluateCurve(500, 1000, 2000, c), 1000);
});

test('valid OFF mapping passes; bad input range fails', () => {
  assert.equal(validateMapping(base, SAFE), null);
  assert.ok(validateMapping({ ...base, inMin: 2000, inMax: 1000 }, SAFE));
});

test('switching DIGITAL to PWM replaces the fixed 0-1 range with 0-255', () => {
  // DIGITAL stores outLow 0 / outHigh 1; keeping it in PWM gives ~0.4% duty at full travel.
  assert.deepEqual(outputRangeForMode('PWM', { outLow: 0, outHigh: 1 }), { outLow: 0, outHigh: 255 });
  assert.deepEqual(outputRangeForMode('DIGITAL', { outLow: 0, outHigh: 255 }), { ...DIGITAL_RANGE });
});

test('mode change keeps a range that already suits the new mode', () => {
  assert.deepEqual(outputRangeForMode('PWM', { outLow: 40, outHigh: 200 }), { outLow: 40, outHigh: 200 });
  assert.deepEqual(outputRangeForMode('SERVO', { outLow: 1100, outHigh: 1900 }), { outLow: 1100, outHigh: 1900 });
  assert.deepEqual(outputRangeForMode('WINDOW', { outLow: 1450, outHigh: 1550 }), { outLow: 1450, outHigh: 1550 });
});

test('mode change converts between the pulse and duty scales', () => {
  assert.deepEqual(outputRangeForMode('PWM', { outLow: 1000, outHigh: 2000 }), { outLow: 0, outHigh: 255 });
  assert.deepEqual(outputRangeForMode('SERVO', { outLow: 0, outHigh: 255 }), { outLow: 1000, outHigh: 2000 });
  assert.deepEqual(outputRangeForMode('CURVE', { outLow: 0, outHigh: 255 }), { outLow: 1000, outHigh: 2000 });
  // A band spanning the whole travel would hold a window output high permanently.
  assert.deepEqual(outputRangeForMode('WINDOW', { outLow: 1000, outHigh: 2000 }), { ...WINDOW_BAND });
});

test('isPwmRange rejects the digital 0-1 pair and the pulse scale', () => {
  assert.equal(isPwmRange({ outLow: 0, outHigh: 1 }), false);
  assert.equal(isPwmRange({ outLow: 1000, outHigh: 2000 }), false);
  assert.equal(isPwmRange({ outLow: 0, outHigh: 255 }), true);
  assert.equal(isPwmRange({ outLow: 40, outHigh: 200 }), true);
});

test('a leftover digital 0-1 PWM range is rejected before it is sent', () => {
  const m = { ...base, mode: 'PWM' as const, pin: 33, outLow: 0, outHigh: 1 };
  const problem = validateMapping(m, SAFE);
  assert.ok(problem, 'expected the 0-1 PWM span to be rejected');
  assert.equal(validateMapping({ ...m, outHigh: 255 }, SAFE), null);
  assert.ok(validateMapping({ ...m, outLow: 1000, outHigh: 2000 }, SAFE));
});

test('curve mapping requires five points and a safe pin', () => {
  const m = { ...base, mode: 'CURVE' as const, pin: 13 };
  assert.equal(validateMapping(m, SAFE), null);
  assert.ok(validateMapping({ ...m, curve: [1000, 2000] }, SAFE));
  assert.ok(validateMapping({ ...m, pin: 5 }, SAFE));
});
