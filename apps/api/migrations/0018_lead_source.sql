-- Where self sign-ups found Garrab: what they told us, and what the browser showed (campaign tags, the site
-- that sent them). Shown in the admin with the brand's contact details.
ALTER TABLE leads ADD COLUMN heard_from TEXT;
ALTER TABLE leads ADD COLUMN tracking_json TEXT;
ALTER TABLE accounts ADD COLUMN found_via TEXT;
