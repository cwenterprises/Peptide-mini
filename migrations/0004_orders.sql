-- migrations/0004_orders.sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id TEXT REFERENCES vendors(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Ordered',
  ordered_at TEXT,
  items TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  tracking TEXT,
  total_cost REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_orders_user ON orders(user_id);
