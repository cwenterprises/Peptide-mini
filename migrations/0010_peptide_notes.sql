-- Personal notes per library peptide
CREATE TABLE peptide_notes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  notes TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, peptide)
);
