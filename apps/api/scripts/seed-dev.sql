-- Local dev / e2e seed. Resets the demo brand to a known state. Never run against staging or prod.
DELETE FROM products WHERE account_id = 'acc_demo';
DELETE FROM domains WHERE account_id = 'acc_demo';
DELETE FROM api_keys WHERE account_id = 'acc_demo';
DELETE FROM cycle_usage WHERE account_id = 'acc_demo';
DELETE FROM daily_counters WHERE account_id IN ('acc_demo', '*');
DELETE FROM payment_claims WHERE account_id = 'acc_demo';
DELETE FROM payments WHERE account_id = 'acc_demo';
DELETE FROM invoices WHERE account_id = 'acc_demo';
DELETE FROM users WHERE account_id = 'acc_demo';
DELETE FROM accounts WHERE id = 'acc_demo';
UPDATE settings SET value_json = 'false' WHERE key = 'global_kill';

-- Paid well into the future so the Phase 1 tests are unaffected; the Phase 3 test moves it.
INSERT INTO accounts (id, slug, name, plan_id, status, cycle_start, buy_url, paid_through, onboarding_step, email)
VALUES ('acc_demo', 'demo-brand', 'Demo Brand', 'starter', 'active', '2026-11-01', 'http://localhost:8790', '2099-12-31', 'converted', 'owner@demo-brand.example');
INSERT INTO users (id, account_id, email, name) VALUES ('usr_demo', 'acc_demo', 'owner@demo-brand.example', 'Demo Owner');

-- Demo key: gk_test_DemoShopKey0000000000001  (test key, local only)
INSERT INTO api_keys (id, account_id, prefix, key_hash)
VALUES ('key_demo', 'acc_demo', 'gk_test_Demo', '7e32859e4f1108efef247928f1eab7d84cc5fb18aae837296d90d867a45069ff');

INSERT INTO domains (id, account_id, host) VALUES ('dom_demo', 'acc_demo', 'localhost:8790');

INSERT INTO products (id, account_id, external_ref, url_path, title, description, images_json, kind, enabled, approved)
VALUES ('prodRedDress01', 'acc_demo', '1001', '/products/red-dress', 'Red linen dress',
        'Relaxed fit midi dress in red linen.', '["http://localhost:8790/red-dress.svg"]', 'clothing', 1, 1);
