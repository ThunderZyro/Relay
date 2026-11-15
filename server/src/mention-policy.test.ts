import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldNotifyChannelMention } from './mention-policy.js';

test('does not notify the message author', () => {
  assert.equal(shouldNotifyChannelMention('user-a', 'user-a', true), false);
});

test('does not notify a member who cannot view the channel', () => {
  assert.equal(shouldNotifyChannelMention('user-a', 'user-b', false), false);
});

test('notifies another member who can view the channel', () => {
  assert.equal(shouldNotifyChannelMention('user-a', 'user-b', true), true);
});
