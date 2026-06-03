# Vendors & Price List — Design Spec
**Date:** 2026-06-03
**Status:** Approved

---

## Overview

Add two new tabs to PeptideOS: **Vendors** (track peptide suppliers with ratings and trust levels) and **Prices** (compare $/mg across vendors in a matrix table). Both are cloud-synced per-user via D1, consistent with the rest of the app.

---

## Data Model

### New D1 tables — `migrations/0003_vendors_prices.sql`

```sql
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
```

**Field constraints:**
- `rating`: integer 1–5 (validated on server)
- `trust`: one of `verified` | `unverified` | `caution` (validated on server)
- `price_per_mg`: positive real number (validated on server)
- `prices.vendor_id` FK has `ON DELETE CASCADE` — deleting a vendor removes all their prices automatically

---

## API Endpoints

All routes require `Authorization: Bearer <token>`. All follow the existing `json(data, status, origin)` + `err(msg, status, origin)` pattern.

### Vendors

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/vendors` | List all vendors for the authenticated user, ordered by name |
| POST | `/api/vendors` | Create a vendor. Body: `{name, url?, rating?, trust?, notes?}` |
| PUT | `/api/vendors/:id` | Update a vendor. Body: same as POST. Returns 404 if not found/not owned. |
| DELETE | `/api/vendors/:id` | Delete a vendor (cascades to prices). |

### Prices

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/prices` | List all prices for the authenticated user |
| POST | `/api/prices` | Create or update a price (upsert on `user_id + vendor_id + peptide`). Body: `{vendor_id, peptide, price_per_mg}` |
| DELETE | `/api/prices/:id` | Delete a single price entry |

---

## Navigation

Two tabs inserted into the existing nav pill:

**Before:** Today · Week · Log Dose · Vials · Calculator · Library · Settings

**After:** Today · Week · Log Dose · Vials · **Vendors** · **Prices** · Calculator · Library · Settings

The nav pill already uses `overflow-x: auto` with hidden scrollbar — 9 tabs works on all screen sizes.

---

## Vendors Tab

### Layout
Responsive card grid: `repeat(auto-fill, minmax(260px, 1fr))` gap, collapses to 1 column on mobile. "+ Add Vendor" button at top right of tab header.

### Vendor Card
Each card displays:
- Vendor name (bold, 15px)
- URL as a clickable external link (opens in new tab, `rel="noopener"`)
- Star rating: filled ★ characters for rating, empty ☆ for remainder (out of 5)
- Trust badge: `Verified` (green, `badge-done`), `Unverified` (muted, `badge-info`), `Caution` (amber, `badge-pending`)
- Notes (muted text, truncated to 2 lines)
- Edit button (pencil icon `✎`) and Delete button (×, red)

### Add / Edit Form
Inline form rendered at the top of the card grid (not a modal). Fields:
- Name (required text input)
- URL (optional, type="url")
- Rating: segmented pill 1–5 (clicking a number sets rating)
- Trust: select dropdown — Verified / Unverified / Caution
- Notes (optional textarea)
- Save and Cancel buttons

Edit: clicking a card's Edit button pre-fills and re-renders the same inline form. The card being edited is visually indicated (reduced opacity or "editing" label).

### Delete
Clicking × on a card shows an inline confirmation row ("Delete [name] and all their prices? Confirm / Cancel") below the card, not a browser `confirm()` dialog.

---

## Prices Tab

### Layout
Tab header: "+ Add Price" button at top right.

Below: comparison matrix table.

### Comparison Table
- **Rows:** unique peptide names that have at least one price entry, sorted alphabetically
- **Columns:** vendor names (one column per vendor that has at least one price entry), sorted alphabetically, plus a "Peptide" label column on the left
- **Cells:** `$X.XX/mg` if a price exists for that vendor+peptide, else `—` (muted dash)
- **Best price:** the lowest price in each row is highlighted with `badge-done` (green background)
- **Edit cell:** clicking any `$X.XX/mg` cell opens an inline edit field (input replacing the cell text) with Save/Cancel. Saves via `POST /api/prices` (upsert).
- **Delete cell:** a small `×` appears on hover next to the price value. Clicking deletes that price entry.
- **"→ Calc" link:** small link on each price cell calling `priceToCalc(peptide, price_per_mg)`

### Add Price Form
Inline form at top of tab (above the table). Fields:
- Peptide: select from user's peptide list
- Vendor: select from user's vendors list
- Price per mg ($): number input, step=0.01

On submit: `POST /api/prices` (upsert — updates if vendor+peptide already exists). Table refreshes.

### "Use in Calc" integration
Each price cell has a small "→ Calc" link that switches to the Calculator tab, switches to the Cycle Cost sub-tab, and pre-fills:
- The peptide name in the `cDose` context (sets a helper text, since Cycle Cost doesn't have a peptide selector)
- The price in the `cPrice` field

### Empty state
If no vendors exist: prompt "Add vendors first before tracking prices."
If vendors exist but no prices: show the "+ Add Price" form prominently with helper text.

---

## Frontend Functions

### New functions in index.html

| Function | Purpose |
|----------|---------|
| `renderVendors()` | Renders entire Vendors tab; called by `renderAllTabs()` |
| `renderVendorForm(editId)` | Renders inline add/edit form at top of vendor grid |
| `saveVendor()` | POST or PUT to API, reload, re-render |
| `deleteVendorConfirm(id)` | Shows inline confirm row |
| `deleteVendor(id)` | DELETE to API, reload, re-render |
| `renderPrices()` | Renders entire Prices tab; called by `renderAllTabs()` |
| `savePriceEntry()` | POST (upsert) to API, reload, re-render |
| `deletePrice(id)` | DELETE to API, reload, re-render |
| `editPriceCell(id, currentVal)` | Replaces cell text with inline input |
| `priceToCalc(peptide, price)` | Switches to Calculator → Cycle Cost, fills cPrice |

### App.getData() additions
`App.getData()` returns `{ peptides, planner, vials, logs, settings }` — add `vendors` and `prices` to the data loaded in `App.loadAll()`:

```javascript
const [peptides, planner, vials, logs, settings, vendors, prices] = await Promise.all([
  API.get('/peptides'),
  API.get('/planner'),
  API.get('/vials'),
  API.get('/logs'),
  API.get('/settings'),
  API.get('/vendors'),
  API.get('/prices')
]);
_data = { peptides, planner, vials, logs, settings, vendors, prices };
```

---

## Files Changed

| File | Change |
|------|--------|
| `migrations/0003_vendors_prices.sql` | New — vendors + prices tables + indexes |
| `worker/index.js` | Add 6 vendor/price routes + 6 handler functions |
| `index.html` | Add vendors/prices to `App.loadAll()`; add 2 nav tabs; add ~8 render/action functions |

---

## Out of Scope

- Orders tab (separate feature, not requested)
- Vendor images/logos
- Price history / change tracking
- Bulk import
- Sharing vendor lists between users
