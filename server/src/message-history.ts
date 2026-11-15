export type MessageHistoryCursor = {
  sql: string;
  params: string[];
} | null;

/**
 * Build a parameterized cursor for older-message pagination.
 * The timestamp plus message ID forms a stable ordering when timestamps match.
 */
export function createMessageHistoryCursor(
  beforeValue: unknown,
  beforeIdValue: unknown
): MessageHistoryCursor {
  const before = typeof beforeValue === 'string' ? beforeValue.slice(0, 80) : '';
  const beforeId = typeof beforeIdValue === 'string' ? beforeIdValue.slice(0, 128) : '';

  if (!before) return null;
  if (!beforeId) {
    // Keep compatibility with older clients that send only a timestamp.
    return { sql: 'm.created_at<?', params: [before] };
  }

  return {
    sql: '(m.created_at<? OR (m.created_at=? AND m.id<?))',
    params: [before, before, beforeId]
  };
}


export type ReadReceiptMessage = {
  id: string;
  sender_id: string;
  read_by?: Array<{ user_id: string }>;
};

/** Select only unread messages from the page actually loaded by the client. */
export function unreadMessagesForUser<T extends ReadReceiptMessage>(
  messages: readonly T[],
  userId: string,
): T[] {
  return messages.filter(message =>
    message.sender_id !== userId &&
    !(message.read_by || []).some(reader => reader.user_id === userId)
  );
}
