-- Application site tracking: where each dose was administered (nullable —
-- old doses and skipped picks display as "Site not recorded").
ALTER TABLE logs ADD COLUMN site TEXT;
