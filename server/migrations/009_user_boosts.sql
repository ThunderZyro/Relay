CREATE TABLE IF NOT EXISTS user_boosts (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 stripe_customer_id TEXT,
 stripe_subscription_id TEXT UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('active','trialing','past_due','canceled','inactive')),
 current_period_end TIMESTAMPTZ,
 last_event_created BIGINT NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_boosts_status_expiry ON user_boosts(status,current_period_end);
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
 id TEXT PRIMARY KEY,
 created TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
