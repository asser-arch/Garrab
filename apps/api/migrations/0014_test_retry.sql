-- Product tests that hit a temporary AI error (Google overloaded, rate limit, timeout) are retried later
-- instead of failing the product: not before test_retry_at; test_busy_count = temporary failures so far.
ALTER TABLE products ADD COLUMN test_retry_at TEXT;
ALTER TABLE products ADD COLUMN test_busy_count INTEGER NOT NULL DEFAULT 0;
