import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BCRYPT_MAX_PASSWORD_BYTES, passwordWithinBcryptLimit } from './password-policy.js';
test('accepts a password at bcrypt byte limit',()=>assert.equal(passwordWithinBcryptLimit('a'.repeat(BCRYPT_MAX_PASSWORD_BYTES)),true));
test('rejects longer passwords',()=>assert.equal(passwordWithinBcryptLimit('a'.repeat(73)),false));
test('counts UTF-8 bytes rather than characters',()=>{assert.equal(passwordWithinBcryptLimit('😀'.repeat(18)),true);assert.equal(passwordWithinBcryptLimit('😀'.repeat(19)),false);});
