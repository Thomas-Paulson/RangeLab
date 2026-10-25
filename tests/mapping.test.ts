import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCurve, inWindow, validateMapping, DEFAULT_CURVE } from '../src/lib/mapping.ts';

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

test('curve mapping requires five points and a safe pin', () => {
  const m = { ...base, mode: 'CURVE' as const, pin: 13 };
  assert.equal(validateMapping(m, SAFE), null);
  assert.ok(validateMapping({ ...m, curve: [1000, 2000] }, SAFE));
  assert.ok(validateMapping({ ...m, pin: 5 }, SAFE));
});
