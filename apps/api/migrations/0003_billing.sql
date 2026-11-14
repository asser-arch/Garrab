-- Phase 3: billing. Our ledger is the source of truth; providers only confirm payments.
-- Money in piastres. Dates are Africa/Cairo calendar dates (YYYY-MM-DD).

ALTER TABLE accounts ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN manual_hold INTEGER NOT NULL DEFAULT 0;   -- admin Kill/Pause: billing never lifts it
ALTER TABLE accounts ADD COLUMN setup_fee_due INTEGER NOT NULL DEFAULT 0; -- founding pilots pay no setup fee
ALTER TABLE accounts ADD COLUMN status_changed_at TEXT;

CREATE TABLE invoice_counter (
  year INTEGER PRIMARY KEY,
  last INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  number TEXT NOT NULL UNIQUE,                 -- GRB-2026-0001, gapless per year
  kind TEXT NOT NULL CHECK (kind IN ('plan','pack')),
  plan_id TEXT,
  period_start TEXT,                           -- plan invoices: the month this pays for (indicative for first payment)
  period_end TEXT,
  pack_previews INTEGER,
  lines_json TEXT NOT NULL,                    -- [{ label, amount }]
  subtotal INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL DEFAULT 0,
  vat INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  due_date TEXT NOT NULL,
  pay_token TEXT NOT NULL UNIQUE,              -- capability URL for the pay page (like a hosted invoice link)
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invoices_account ON invoices(account_id, created_at);
CREATE INDEX idx_invoices_open ON invoices(status, due_date);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,                      -- instapay_direct | manual | kashier
  provider_txn_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT,                                 -- instapay | bank_transfer | cash | card | wallet
  reference TEXT,
  note TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, provider_txn_id)            -- idempotent by provider transaction id
);
CREATE INDEX idx_payments_account ON payments(account_id, created_at);

-- "I've paid" notices for direct InstaPay transfers, confirmed by Asser in Telegram.
CREATE TABLE payment_claims (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  account_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  payer_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
  hold_until TEXT NOT NULL,                    -- suspension is held until then while Asser confirms
  last_ping_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_claims_pending ON payment_claims(status, created_at);
CREATE INDEX idx_claims_invoice ON payment_claims(invoice_id);

-- Every inbound webhook is stored before it is processed, so it can be replayed safely.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT,                              -- provider's id when it has one (dedupe)
  signature_ok INTEGER NOT NULL,
  raw_body TEXT NOT NULL,
  processed_at TEXT,
  error TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_webhook_key ON webhook_events(provider, event_key);
CREATE INDEX idx_webhook_date ON webhook_events(received_at);

INSERT OR IGNORE INTO settings (key, value_json) VALUES
  ('billing_provider', '"instapay_direct"'),
  ('egp_per_usd', 'null');
