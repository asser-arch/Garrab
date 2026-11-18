-- The brand's own look on its try-on pages and website button: main colour (#rrggbb) and logo file
-- (R2 brand/<account>/<file>, served at /v1/brand-logo/<account>/<file>).
ALTER TABLE accounts ADD COLUMN brand_color TEXT;
ALTER TABLE accounts ADD COLUMN brand_logo TEXT;
