-- Phase 1 core schema. Money in piastres (INTEGER), AI cost in micro-USD (INTEGER).
-- Timestamps are UTC ISO strings; "day" columns are Africa/Cairo calendar dates (YYYY-MM-DD).
-- PRIVACY: no table may hold shopper photos, shopper inputs, IP addresses or provider user IDs.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('pilot','starter','growth')),
  status TEXT NOT NULL DEFAULT 'onboarding' CHECK (status IN
    ('onboarding','pilot','active','past_due','suspended','archived','paused','cancelled','expired')),
  status_version INTEGER NOT NULL DEFAULT 1,
  platform TEXT,
  cycle_start TEXT,               -- start of the current usage cycle (date)
  paid_through TEXT,              -- date; billing (Phase 3)
  pilot_started_at TEXT,
  pilot_ends_at TEXT,
  button_selector TEXT,           -- optional CSS selector set in the portal
  buy_url TEXT,                   -- hosted-link "Buy" fallback (site or wa.me link)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_accounts_status ON accounts(status);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  prefix TEXT NOT NULL,           -- first 12 chars, for display
  key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the full key
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_api_keys_account ON api_keys(account_id);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  host TEXT NOT NULL UNIQUE,      -- lowercase host[:port], no scheme, no leading www.
  install_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_domains_account ON domains(account_id);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  external_ref TEXT,              -- platform product id (Shopify id, Woo id, SKU)
  url_path TEXT,                  -- canonical path on the brand site, e.g. /products/red-dress
  source TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  description TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  sizes_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'clothing' CHECK (kind IN ('clothing','accessory','decor')),
  includes_headwear INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  provider_synced_at TEXT,        -- product sent inline to the try-on provider
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_account ON products(account_id, enabled, approved);

-- One row per AI call. Deliberately no column for images, inputs, IPs or user ids.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tryon','room','size','fit_read','test','score')),
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_code TEXT,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_usage_account_date ON usage_events(account_id, created_at);
CREATE INDEX idx_usage_date ON usage_events(created_at);

-- Aggregate counters per account per Cairo day. account_id '*' = global.
CREATE TABLE daily_counters (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day, metric)
);
CREATE INDEX idx_daily_day ON daily_counters(day);

-- Preview allowance per usage cycle.
CREATE TABLE cycle_usage (
  account_id TEXT NOT NULL,
  cycle_start TEXT NOT NULL,
  included INTEGER NOT NULL,
  extra INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  warned_80 INTEGER NOT NULL DEFAULT 0,
  warned_100 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, cycle_start)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  actor TEXT NOT NULL,            -- system | cron | admin | brand
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_account ON audit_log(account_id, created_at);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  account_id TEXT,
  message TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_alerts_open ON alerts(resolved_at, created_at);

-- Provider deletes that failed and must be retried. Holds only the random one-time
-- provider id (never linked to a person) until the delete succeeds.
CREATE TABLE pending_deletes (
  provider_ref TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE cron_runs (
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  error TEXT,
  PRIMARY KEY (job, started_at)
);

INSERT INTO settings (key, value_json) VALUES
  ('global_kill', 'false'),
  ('global_daily_cap_usd', '50'),
  ('privacy_claim_verified', 'false');
