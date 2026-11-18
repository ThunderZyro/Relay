import test from 'node:test';
import assert from 'node:assert/strict';
import { dmPreferencePatchSchema, mergeDmPreferences } from './dm-preferences.js';

test('accepts only supported boolean preference patches', () => {
  assert.equal(dmPreferencePatchSchema.safeParse({ is_pinned: true }).success, true);
  assert.equal(dmPreferencePatchSchema.safeParse({ is_archived: false, is_muted: true }).success, true);
  assert.equal(dmPreferencePatchSchema.safeParse({}).success, false);
  assert.equal(dmPreferencePatchSchema.safeParse({ is_pinned: 'yes' }).success, false);
  assert.equal(dmPreferencePatchSchema.safeParse({ is_locked: true }).success, false);
});

test('merges a partial patch without resetting other chat preferences', () => {
  const current = { is_pinned: 1, is_archived: 0, is_muted: 1, is_favorite: 0 };
  assert.deepEqual(mergeDmPreferences(current, { is_favorite: true }), {
    is_pinned: true, is_archived: false, is_muted: true, is_favorite: true,
  });
});

test('uses safe false defaults for a new chat preference record', () => {
  assert.deepEqual(mergeDmPreferences(null, { is_archived: true }), {
    is_pinned: false, is_archived: true, is_muted: false, is_favorite: false,
  });
});
