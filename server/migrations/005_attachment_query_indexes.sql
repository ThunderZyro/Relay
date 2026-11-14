CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_staged_uploads_created ON staged_uploads(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_visible ON messages(channel_id,created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_dm_visible ON messages(dm_id,created_at DESC) WHERE deleted_at IS NULL;
