CREATE TABLE IF NOT EXISTS message_bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_bookmarks_user_created
  ON message_bookmarks(user_id, created_at DESC);
