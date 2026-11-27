-- Real-world size of home décor products (e.g. "height 35 cm, diameter 15 cm"), read from the shop's text or
-- set by the brand, so room previews keep the right scale. size_source: 'auto' (read by Garrab), 'brand'
-- (typed by the brand or Garrab support: never overwritten by an import), NULL (not read yet).
ALTER TABLE products ADD COLUMN size_text TEXT;
ALTER TABLE products ADD COLUMN size_source TEXT;
