-- Asser (14 Nov): paid plans have no product limit; a per-brand limit can be set by the admin.
-- NULL = use the plan's limit (pilot 10, paid plans unlimited).
ALTER TABLE accounts ADD COLUMN max_products INTEGER;
