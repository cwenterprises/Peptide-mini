-- Opt-in: automatically start a cycle (library-recommended length) when a peptide is being logged with no cycle
ALTER TABLE user_settings ADD COLUMN auto_cycles INTEGER DEFAULT 0;
