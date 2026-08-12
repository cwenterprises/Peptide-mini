-- Daily effects journal: one row per user per local date
CREATE TABLE checkins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  weight REAL,
  energy INTEGER,
  sleep INTEGER,
  notes TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);
