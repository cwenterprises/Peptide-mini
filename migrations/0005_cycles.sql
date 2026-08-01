-- Per-peptide cycles: multiple concurrent cycles, each with its own date range
CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  peptide TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cycles_user ON cycles(user_id);
