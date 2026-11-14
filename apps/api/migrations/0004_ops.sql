-- Gaps closed before Phase 4: admin read-only portal view, founding-pilot setting.
ALTER TABLE magic_links ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0;

-- While true, new brands are founding pilots (no setup fee). Turn off to charge the one-off
-- setup fee (plans.ts SETUP_FEE) on a new brand's first invoice.
INSERT OR IGNORE INTO settings (key, value_json) VALUES ('founding_pilots_open', 'true');
