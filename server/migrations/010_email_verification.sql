-- Existing accounts remain trusted. New signups explicitly set email_verified=FALSE.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS email_verification_codes (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 resend_after TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 5),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_expiry ON email_verification_codes(expires_at);
