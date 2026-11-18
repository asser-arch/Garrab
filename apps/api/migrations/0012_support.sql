-- Support chat between a brand (portal) and Garrab support (admin). The first replies are automatic
-- until a person from Garrab answers.
CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('brand','bot','admin')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_support_account ON support_messages(account_id, created_at);
CREATE INDEX idx_support_created ON support_messages(created_at);

-- When the brand last opened the chat (for its unread badge).
CREATE TABLE support_seen (
  account_id TEXT PRIMARY KEY,
  brand_seen_at TEXT NOT NULL
);

-- Automatic support replies are an AI call too: allow kind 'support' in usage_events.
CREATE TABLE usage_events_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tryon','room','size','fit_read','test','score','support')),
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_code TEXT,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO usage_events_new SELECT id, account_id, kind, provider, ok, error_code, cost_micro_usd, created_at FROM usage_events;
DROP TABLE usage_events;
ALTER TABLE usage_events_new RENAME TO usage_events;
CREATE INDEX idx_usage_account_date ON usage_events(account_id, created_at);
CREATE INDEX idx_usage_date ON usage_events(created_at);
