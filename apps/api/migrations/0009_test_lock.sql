-- One product test at a time: a test claims the product before any paid AI call, so duplicate queue
-- messages (advance runs on every test result, portal visit and approval) can't run it again.
ALTER TABLE products ADD COLUMN test_started_at TEXT;
