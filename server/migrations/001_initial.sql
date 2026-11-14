PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, username TEXT NOT NULL,
 password_hash TEXT NOT NULL, avatar TEXT, banner TEXT, bio TEXT NOT NULL DEFAULT '', status_text TEXT NOT NULL DEFAULT '',
 presence TEXT NOT NULL DEFAULT 'online' CHECK(presence IN ('online','idle','dnd','offline')),
 activity_visible INTEGER NOT NULL DEFAULT 1, dm_privacy TEXT NOT NULL DEFAULT 'friends' CHECK(dm_privacy IN ('everyone','friends','nobody')),
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), last_seen TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, user_agent TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
 expires_at TEXT NOT NULL, last_active TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users (LOWER(email));\nCREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users (LOWER(username));\nCREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS servers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT, owner_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), is_discoverable INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS roles (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL,
 permissions TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0, is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memberships (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
 nickname TEXT, joined_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), UNIQUE(server_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE TABLE IF NOT EXISTS categories (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, name TEXT NOT NULL,
 type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text','voice','announcement')),
 topic TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, slow_mode INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id,position);
CREATE TABLE IF NOT EXISTS dms (
 id TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), last_message_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS dm_members (
 dm_id TEXT NOT NULL REFERENCES dms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 joined_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), PRIMARY KEY(dm_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
 dm_id TEXT REFERENCES dms(id) ON DELETE CASCADE, sender_id TEXT NOT NULL REFERENCES users(id),
 content TEXT NOT NULL DEFAULT '', reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), edited_at TEXT, deleted_at TEXT,
 pinned INTEGER NOT NULL DEFAULT 0, CHECK((channel_id IS NOT NULL AND dm_id IS NULL) OR (channel_id IS NULL AND dm_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(dm_id,created_at DESC);
CREATE TABLE IF NOT EXISTS attachments (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, storage_name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS reactions (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, emoji TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
 UNIQUE(message_id,user_id,emoji)
);
CREATE TABLE IF NOT EXISTS friendships (
 id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')), created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
 UNIQUE(requester_id,addressee_id), CHECK(requester_id <> addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id,status);
CREATE TABLE IF NOT EXISTS blocks (
 blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id <> blocked_id)
);
CREATE TABLE IF NOT EXISTS invites (
 code TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 creator_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0,
 revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', href TEXT NOT NULL DEFAULT '/home',
 read_at TEXT, created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,read_at,created_at DESC);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
 creator_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 starts_at TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
);
CREATE TABLE IF NOT EXISTS event_rsvps (
 event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('going','interested')), created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
 PRIMARY KEY(event_id,user_id)
);
CREATE TABLE IF NOT EXISTS bans (
 server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 moderator_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL DEFAULT '', until_at TEXT,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), PRIMARY KEY(server_id,user_id)
);

CREATE TABLE IF NOT EXISTS message_reports (
 id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text), status TEXT NOT NULL DEFAULT 'open', UNIQUE(message_id,reporter_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_message ON message_reports(message_id,status);
