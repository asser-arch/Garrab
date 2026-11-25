-- A brand's own monthly price (piastres), e.g. an early-bird deal. NULL = the plan's list price.
-- Used for renewal invoices, MRR, the portal and the pilot emails.
ALTER TABLE accounts ADD COLUMN monthly_price INTEGER;
-- One-off: brands whose last paid plan invoice was at their own price (early bird) keep that price.
UPDATE accounts SET monthly_price = (
    SELECT CAST(json_extract(i.lines_json, '$[0].amount') AS INTEGER) / MAX(i.months, 1) FROM invoices i
     WHERE i.account_id = accounts.id AND i.kind = 'plan' AND i.status = 'paid' ORDER BY i.paid_at DESC LIMIT 1)
 WHERE monthly_price IS NULL AND plan_id IN ('starter', 'growth')
   AND (SELECT CAST(json_extract(i.lines_json, '$[0].amount') AS INTEGER) / MAX(i.months, 1) FROM invoices i
         WHERE i.account_id = accounts.id AND i.kind = 'plan' AND i.status = 'paid' ORDER BY i.paid_at DESC LIMIT 1)
       NOT IN (500000, 850000);
