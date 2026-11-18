-- The brand's second colour: for text and links on its try-on pages (buttons keep brand_color).
-- NULL = automatic (the button colour when it's readable on white, else near-black).
ALTER TABLE accounts ADD COLUMN brand_text_color TEXT;
