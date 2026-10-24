import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidRange, parseImportedProfiles } from '../src/lib/profiles.ts';

test('range validation enforces field limits, integer values and ordering', () => {
  assert.equal(isValidRange(885, 1500, 2115), true);
  assert.equal(isValidRange(0, 1500, 2000), false);
  assert.equal(isValidRange(885.5, 1500, 2115), false);
  assert.equal(isValidRange(1500, 1400, 2115), false);
  assert.equal(isValidRange(885, 1500, 2300), false);
});

test('imports profile arrays and RangeLab exports', () => {
  const profiles = [{ name: 'My setup', min: 885, mid: 1500, max: 2115, notes: 'test' }];
  assert.deepEqual(parseImportedProfiles(JSON.stringify(profiles)), profiles);
  assert.deepEqual(parseImportedProfiles(JSON.stringify({ app: 'RangeLab', profiles })), profiles);
});

test('rejects invalid profile JSON and malformed ranges', () => {
  assert.throws(() => parseImportedProfiles('{nope'), /valid JSON/);
  assert.throws(() => parseImportedProfiles(JSON.stringify([{ name: 'Bad', min: 0, mid: 1500, max: 2000 }])), /invalid name or pulse range/);
  assert.throws(() => parseImportedProfiles(JSON.stringify([])), /1–100 profiles/);
});
