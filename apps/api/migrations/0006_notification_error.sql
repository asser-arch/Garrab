-- Why an email failed (provider status and error name/message; email addresses removed).
ALTER TABLE notifications ADD COLUMN error TEXT;
