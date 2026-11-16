-- Phase 4: each brand is either fashion (try-on on a person) or home décor (room preview), never both.
ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'fashion' CHECK (category IN ('fashion', 'home'));
UPDATE accounts SET category = 'home' WHERE niche = 'home_decor';
