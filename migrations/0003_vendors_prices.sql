-- migrations/0003_vendors_prices.sql
CREATE TABLE vendors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  rating INTEGER DEFAULT 3,
  trust TEXT DEFAULT 'unverified',
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_vendors_user ON vendors(user_id);

CREATE TABLE prices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  price_per_mg REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_prices_user ON prices(user_id);
CREATE INDEX idx_prices_vendor ON prices(vendor_id);
CREATE UNIQUE INDEX idx_prices_unique ON prices(user_id, vendor_id, peptide);
