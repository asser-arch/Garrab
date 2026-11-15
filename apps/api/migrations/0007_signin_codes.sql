-- 6-digit sign-in codes (link scanners such as Outlook Safe Links can't use them up),
-- with a per-code attempt counter.
ALTER TABLE magic_links ADD COLUMN code_hash TEXT;
ALTER TABLE magic_links ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_magic_links_email ON magic_links(email, created_at);
