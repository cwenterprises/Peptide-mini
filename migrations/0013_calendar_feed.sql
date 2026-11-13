-- Private calendar subscription (webcal) per user.
-- The app builds the .ics (same code as "Add to Calendar") and uploads it whenever
-- planner/vials/logs change; GET /cal/<token>.ics serves the latest snapshot.
-- Rotating the token (POST /api/calendar-feed) kills the old link immediately.
CREATE TABLE IF NOT EXISTS calendar_feeds (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  ics        TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL
);
