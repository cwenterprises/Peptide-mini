-- On-hand stock: sealed peptide vials and supplies. qty is REAL so partial
-- stock (e.g. half a box of wipes) can be represented if wanted.
CREATE TABLE inventory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Peptide',
  size TEXT,
  qty REAL NOT NULL DEFAULT 0,
  reorder_at REAL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_inventory_user ON inventory(user_id);
