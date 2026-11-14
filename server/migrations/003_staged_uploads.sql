CREATE TABLE IF NOT EXISTS staged_uploads (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
 storage_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE INDEX IF NOT EXISTS idx_staged_uploads_user ON staged_uploads(user_id);
