-- Selling through customers: which brand's try-on page a new lead came from (brand slug), and
-- "call me back" requests from the sign-up page.
ALTER TABLE leads ADD COLUMN referred_by TEXT;
ALTER TABLE accounts ADD COLUMN referred_by TEXT;
CREATE TABLE contact_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  brand TEXT,
  referred_by TEXT,
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_contact_open ON contact_requests(handled_at, created_at);
