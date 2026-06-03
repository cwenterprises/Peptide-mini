CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE peptides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE planner (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  day INTEGER NOT NULL,
  time TEXT,
  route TEXT NOT NULL,
  dose REAL NOT NULL,
  unit TEXT NOT NULL,
  note TEXT
);

CREATE TABLE vials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  mg REAL NOT NULL,
  ml REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vial_id TEXT REFERENCES vials(id) ON DELETE SET NULL,
  peptide TEXT NOT NULL,
  route TEXT NOT NULL,
  dose_value REAL NOT NULL,
  dose_unit TEXT NOT NULL,
  dose_mcg REAL,
  volume_ml REAL,
  iu REAL,
  taken_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications_sent (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  planner_id TEXT NOT NULL,
  sent_date TEXT NOT NULL,
  UNIQUE(user_id, planner_id, sent_date)
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT,
  cycle_start TEXT,
  cycle_end TEXT,
  theme TEXT DEFAULT 'system'
);
