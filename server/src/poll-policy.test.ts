import test from 'node:test';
import assert from 'node:assert/strict';
import { isPollClosed, validatePollOptions, validatePollSelection } from './poll-policy.js';

test('accepts polls with between 2 and 10 distinct options', () => {
  assert.equal(validatePollOptions(['Yes', 'No']), null);
  assert.equal(validatePollOptions(Array.from({ length: 10 }, (_, i) => `Choice ${i + 1}`)), null);
});

test('rejects duplicate poll options without case sensitivity', () => {
  assert.match(validatePollOptions(['Yes', 'yes']) || '', /unique/i);
});

test('rejects options outside the allowed count and length', () => {
  assert.match(validatePollOptions(['Only one']) || '', /between 2 and 10/i);
  assert.match(validatePollOptions(['A'.repeat(81), 'B']) || '', /80 characters/i);
});

test('accepts valid single and multiple vote selections', () => {
  const valid = new Set(['a', 'b', 'c']);
  assert.equal(validatePollSelection(['a'], valid, false), null);
  assert.equal(validatePollSelection(['a', 'b'], valid, true), null);
});

test('rejects empty, duplicate, unknown, and disallowed multiple selections', () => {
  const valid = new Set(['a', 'b']);
  assert.match(validatePollSelection([], valid, false) || '', /at least one/i);
  assert.match(validatePollSelection(['a', 'a'], valid, true) || '', /unique/i);
  assert.match(validatePollSelection(['a', 'b'], valid, false) || '', /one answer/i);
  assert.match(validatePollSelection(['missing'], valid, true) || '', /does not belong/i);
});

test('recognizes expired polls and keeps future polls open', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');
  assert.equal(isPollClosed('2026-11-15T11:59:59.000Z', now), true);
  assert.equal(isPollClosed('2026-11-15T12:00:01.000Z', now), false);
  assert.equal(isPollClosed(null, now), false);
});
