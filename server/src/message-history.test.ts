import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessageHistoryCursor } from './message-history.js';

test('returns no cursor when no timestamp is supplied', () => {
  assert.equal(createMessageHistoryCursor('', ''), null);
  assert.equal(createMessageHistoryCursor(undefined, 'message-id'), null);
});

test('supports timestamp-only cursors from older clients', () => {
  assert.deepEqual(createMessageHistoryCursor('2026-11-15T05:00:00.000Z', undefined), {
    sql: 'm.created_at<?',
    params: ['2026-11-15T05:00:00.000Z']
  });
});

test('uses the message ID as a tie-breaker for equal timestamps', () => {
  assert.deepEqual(createMessageHistoryCursor('2026-11-15T05:00:00.000Z', 'msg_123'), {
    sql: '(m.created_at<? OR (m.created_at=? AND m.id<?))',
    params: ['2026-11-15T05:00:00.000Z', '2026-11-15T05:00:00.000Z', 'msg_123']
  });
});

test('keeps supplied cursor values parameterized and bounded', () => {
  const timestamp = "2026-11-15' OR 1=1 --";
  const cursor = createMessageHistoryCursor(timestamp, 'x'.repeat(200));

  assert.ok(cursor);
  assert.equal(cursor.sql.includes(timestamp), false);
  assert.equal(cursor.params[0], timestamp);
  assert.equal(cursor.params[2].length, 128);
});
