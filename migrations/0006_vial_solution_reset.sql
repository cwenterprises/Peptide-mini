-- Reconstitution solution type per vial + reset marker (refilled with a fresh vial;
-- only doses logged after reset_at count against remaining)
ALTER TABLE vials ADD COLUMN solution TEXT;
ALTER TABLE vials ADD COLUMN reset_at TEXT;
