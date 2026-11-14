-- Saved stacks: a named multi-peptide protocol. Turning one on writes ordinary
-- planner rows + cycles tagged with stack_id, so every existing planner consumer
-- (Today, Week, reminders, calendar feed, runout) works unchanged.
CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  items TEXT NOT NULL,                     -- JSON array of {peptide,route,dose,unit,days,times,note}
  weeks INTEGER,                           -- cycle length; NULL = open-ended
  start_date TEXT,                         -- YYYY-MM-DD the current/last run starts
  end_date TEXT,                           -- start_date + weeks*7 - 1; NULL when open-ended
  status TEXT NOT NULL DEFAULT 'inactive', -- inactive | scheduled | active | completed
  tz TEXT,                                 -- IANA zone captured at activation
  template TEXT,                           -- template key it was started from
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stacks_user ON stacks(user_id);
CREATE INDEX IF NOT EXISTS idx_stacks_status ON stacks(status);
ALTER TABLE planner ADD COLUMN stack_id TEXT;
ALTER TABLE cycles  ADD COLUMN stack_id TEXT;
CREATE INDEX IF NOT EXISTS idx_planner_stack ON planner(stack_id);
