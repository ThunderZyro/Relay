import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEmailCode, hashEmailCode, matchesEmailCode } from './email-verification.js';

test('generates a six-digit code', () => {
  for (let i = 0; i < 100; i++) assert.match(generateEmailCode(), /^[0-9]{6}$/);
});

test('verification hashes are keyed to the account and code', () => {
  const secret = 'a-secret-that-is-not-stored-with-the-code';
  const hash = hashEmailCode(secret, 'user-1', '004291');
  assert.notEqual(hash, '004291');
  assert.equal(matchesEmailCode(secret, 'user-1', '004291', hash), true);
  assert.equal(matchesEmailCode(secret, 'user-2', '004291', hash), false);
  assert.equal(matchesEmailCode(secret, 'user-1', '004292', hash), false);
  assert.equal(matchesEmailCode('a-different-secret', 'user-1', '004291', hash), false);
});
