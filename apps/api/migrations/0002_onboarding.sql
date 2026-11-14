-- Phase 2: onboarding automation. Brand (business) data only; still no shopper data anywhere.

ALTER TABLE accounts ADD COLUMN target_plan_id TEXT CHECK (target_plan_id IN ('starter','growth'));
ALTER TABLE accounts ADD COLUMN contact_name TEXT;
ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN whatsapp TEXT;
ALTER TABLE accounts ADD COLUMN website TEXT;
ALTER TABLE accounts ADD COLUMN instagram TEXT;
ALTER TABLE accounts ADD COLUMN niche TEXT;
ALTER TABLE accounts ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'invited';
ALTER TABLE accounts ADD COLUMN onboarding_step_at TEXT;
ALTER TABLE accounts ADD COLUMN approved_at TEXT;
ALTER TABLE accounts ADD COLUMN installed_at TEXT;
ALTER TABLE accounts ADD COLUMN notes TEXT;

-- Widget keys are publishable (they sit in the brand's page HTML), so the plain key is kept
-- for the install snippet. Lookups still go through key_hash.
ALTER TABLE api_keys ADD COLUMN key_public TEXT;

ALTER TABLE products ADD COLUMN selected INTEGER NOT NULL DEFAULT 0;   -- chosen for testing / pilot
ALTER TABLE products ADD COLUMN price_piastres INTEGER;
ALTER TABLE products ADD COLUMN product_url TEXT;                      -- full URL on the brand site
ALTER TABLE products ADD COLUMN brand_decision TEXT CHECK (brand_decision IN ('approved','hidden'));
ALTER TABLE products ADD COLUMN test_score INTEGER;
CREATE UNIQUE INDEX idx_products_ref ON products(account_id, external_ref);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  brand_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  website TEXT,
  instagram TEXT,
  platform TEXT NOT NULL,
  niche TEXT NOT NULL,
  plan TEXT NOT NULL,
  account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_leads_date ON leads(created_at);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_users_account ON users(account_id);

CREATE TABLE magic_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email TEXT NOT NULL,                 -- bound to the email it was sent to
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE onboarding_steps (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  step TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','done','overridden')),
  entered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  note TEXT,
  PRIMARY KEY (account_id, step)
);

-- Automatic quality tests: stock test models only (never shoppers). Images live in R2.
CREATE TABLE product_tests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  fixture TEXT NOT NULL,
  r2_key TEXT,
  score INTEGER,
  rubric_json TEXT,
  reason TEXT,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_tests_product ON product_tests(product_id);
CREATE INDEX idx_tests_account ON product_tests(account_id, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  template TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  dedupe_key TEXT UNIQUE,              -- e.g. pilot_day_7:<account>; makes every send idempotent
  status TEXT NOT NULL,                -- sent | failed | skipped
  provider_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_account ON notifications(account_id, created_at);

-- Local dev and tests only: captured outgoing emails (brand emails, never shopper data).
CREATE TABLE dev_outbox (
  id TEXT PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
