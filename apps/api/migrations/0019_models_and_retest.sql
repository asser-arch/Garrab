-- Which stock models a fashion brand's products are tested on: 'women' (default), 'men' or 'both'.
ALTER TABLE accounts ADD COLUMN test_models TEXT NOT NULL DEFAULT 'women';
-- "Re-test all products" in the admin starts a fresh product-test budget from this time.
ALTER TABLE accounts ADD COLUMN test_budget_from TEXT;
-- Whether a product shows skin when worn (bare shoulders/arms, short, low neckline, sheer...): 1, 0, or NULL
-- (not checked yet). Products that do are never tested on the veiled stock model.
ALTER TABLE products ADD COLUMN reveals_skin INTEGER;
