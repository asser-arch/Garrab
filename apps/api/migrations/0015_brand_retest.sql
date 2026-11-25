-- Brands can ask for a product's test previews to be made again (a few times per product) from the portal.
ALTER TABLE products ADD COLUMN brand_retests INTEGER NOT NULL DEFAULT 0;
