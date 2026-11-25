-- Invoices Garrab makes by hand in the admin can cover several months (paid up front).
ALTER TABLE invoices ADD COLUMN months INTEGER NOT NULL DEFAULT 1;
-- Paid during the pilot: 1 = the paid months start the day it is paid (the default, as before); 0 = after the pilot ends (chosen in the admin).
ALTER TABLE invoices ADD COLUMN start_now INTEGER NOT NULL DEFAULT 1;
