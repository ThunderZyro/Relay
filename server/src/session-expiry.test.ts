import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TIMER_DELAY_MS, safeTimerDelay } from './session-expiry.js';

test('caps a 30-day session deadline to the maximum safe Node timer delay', () => {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  assert.equal(safeTimerDelay(thirtyDays), MAX_TIMER_DELAY_MS);
  assert.ok(safeTimerDelay(thirtyDays) <= MAX_TIMER_DELAY_MS);
});

test('preserves a normal short timer delay', () => {
  assert.equal(safeTimerDelay(5_000), 5_000);
});

test('rounds fractional delays up and never returns zero or a negative delay', () => {
  assert.equal(safeTimerDelay(0.1), 1);
  assert.equal(safeTimerDelay(-1), 1);
});

test('uses the maximum safe delay for a non-finite remaining interval', () => {
  assert.equal(safeTimerDelay(Number.POSITIVE_INFINITY), MAX_TIMER_DELAY_MS);
});
