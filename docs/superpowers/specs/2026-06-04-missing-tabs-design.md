# Dashboard (Analytics), Orders & History Tabs — Design Spec
**Date:** 2026-06-04
**Status:** Approved

---

## Overview

Three new tabs for PeptideOS:

1. **Dashboard** — analytics view with streak calendar, 7-day compliance bars, top peptides chart, and stat chips. No new API — all data from existing `App.getData()`.
2. **Orders** — track peptide orders with status pipeline. One new D1 table + CRUD API.
3. **History** — full searchable/filterable dose log table with per-row delete and CSV export. One new `DELETE /api/logs/:id` endpoint.

---

## Deployment note

The live site is served by the **Cloudflare Pages project** `peptideos-cwenterprises`, not the Worker's assets binding. All deploys must use:
```bash
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main
```
The Worker handles `/api/*` routes. Pages handles static HTML/JS/CSS.

---

## Tab 1: Dashboard (Analytics)

### No new API needed
All data comes from `App.getData()`: `logs`, `planner`, `peptides`, `settings`.

### Layout — 4 panels in a `stack`

#### Panel 1: Stats row
Four glass chips in a flex row:
- 🔥 **Streak:** N days (consecutive days with ≥1 log)
- 🏆 **Best streak:** all-time best
- 💉 **Total doses:** all-time log count
- 🧪 **Peptides used:** count of distinct peptides ever logged

#### Panel 2: Streak calendar (CSS grid, no canvas)
A 13-column × 7-row CSS grid showing the last 91 days (13 weeks), oldest left to newest right. Each cell is a 12×12px square:

| Doses that day | Color |
|---|---|
| 0 | `var(--input-border)` (empty) |
| 1–2 | `rgba(14,165,233,0.4)` (light sky) |
| 3+ | `var(--accent-sky)` (full sky) |

Row labels: Mon/Wed/Fri on the left side. Week column labels: month abbreviation every ~4 weeks at top. Tooltip on hover showing date + dose count (via `title` attribute).

#### Panel 3: 7-day compliance bars (Canvas)
A `<canvas>` 500×120px (responsive via `style="width:100%;height:auto"`). For each of the last 7 days:
- X-axis: day label (Mon, Tue, …)
- Two bars per day: planned (grey) and done (sky-blue gradient)
- Bar height proportional to max planned count across 7 days
- Labels above bars: "N/M" (done/planned)

If no planner items exist: muted text "Add planner items to see compliance."

Drawing uses `CanvasRenderingContext2D`: `fillRect`, `fillText`, linear gradient via `createLinearGradient`.

#### Panel 4: Top peptides (Canvas)
A `<canvas>` 500×200px (responsive). Horizontal bar chart showing the 8 most-logged peptides by total dose count, sorted descending. Each bar:
- Label on left (peptide name, truncated to 14 chars)
- Bar drawn right, color `var(--accent-sky)` with opacity gradient
- Count label at bar end

If fewer than 2 unique peptides logged: muted text "Log more doses to see your top peptides."

### Functions
- `renderDashboard()` — renders all 4 panels; after `innerHTML` is set, calls `setTimeout(drawDashboardCharts, 0)`
- `drawDashboardCharts()` — gets canvas elements by id and calls both draw functions
- `drawComplianceChart(canvas)` — draws 7-day compliance bars on the given canvas element
- `drawTopPeptidesChart(canvas)` — draws horizontal top-8 bars on the given canvas element
- `calcStreak(logs)` already exists in the codebase — reuse it unchanged
- `calcBestStreak(logs)` — new helper, iterates all log dates and returns all-time max streak length

---

## Tab 2: Orders

### D1 Schema — `migrations/0004_orders.sql`

```sql
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
```

`items` is a JSON string — array of `{peptide, qty, unit}` objects. Stored as TEXT, parsed client-side.

### Status pipeline

8 statuses in order:
`Ordered` → `Processing` → `Shipped` → `In Transit` → `Delivered` → `Stored` → `Used` → `Cancelled`

Status badge colors (using existing badge classes):
| Status | Class |
|---|---|
| Ordered | `badge-info` |
| Processing | `badge-pending` |
| Shipped | `badge-info` |
| In Transit | `badge-info` |
| Delivered | `badge-done` |
| Stored | `badge-done` |
| Used | `badge-done` |
| Cancelled | `badge-pending` |

### API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/orders` | List all orders for user, newest first |
| POST | `/api/orders` | Create order. Body: `{vendor_id?, vendor_name, status?, ordered_at?, items, notes?, tracking?, total_cost?}` |
| PUT | `/api/orders/:id` | Update order |
| DELETE | `/api/orders/:id` | Delete order |

`items` is passed and stored as a JSON string. Worker validates it is valid JSON array before storing.

### UI

**Pipeline filter bar:** horizontal scrollable row of status chips. "All" + each of 8 statuses, each showing a count badge. Clicking filters the order list.

**Order cards:** glass card grid (`auto-fill minmax(300px,1fr)`). Each card:
- Vendor name (bold) + order date
- Status badge
- Item tags: each `{peptide} · {qty} {unit}` as a chip
- Tracking number (if set) — muted
- Total cost (if set) — right-aligned
- Notes — muted, 2-line truncate
- Edit ✎ and Delete × buttons (same inline confirm pattern as Vendors)

**Add/Edit form:** inline at top (same pattern as Vendors). Fields:
- Vendor: select from vendors list or type free-text override (if vendor_id selected, vendor_name auto-fills)
- Order date (type="date", default today)
- Status: select dropdown
- Items: dynamic rows — each row has peptide select, qty input, unit select (mg/mcg/IU). "+ Add item" button adds a row. × removes a row.
- Tracking number (text, optional)
- Total cost (number, optional)
- Notes (textarea, optional)

### Functions
- `renderOrders()` — renders pipeline + filtered cards
- `renderOrderForm(editId)` — inline add/edit form
- `saveOrder(editId)` — POST or PUT
- `deleteOrderConfirm(id)` / `deleteOrder(id)` — inline confirm
- `ORDER_STATUSES` constant — array of 8 status strings
- `ORDER_STATUS_BADGE` constant — map status → badge class

---

## Tab 3: History

### One new API endpoint

Add to worker: `DELETE /api/logs/:id` — deletes a single log entry by ID, scoped to `user_id`. This is distinct from the existing `DELETE /api/logs/last` (which deletes the most recent entry). The new endpoint matches the regex `/^\/logs\/[^/]+$/` and the existing `/logs/last` route must be checked FIRST in the router to avoid ambiguity.

### UI

**Filter bar** (always visible at top of tab):
- Peptide select (`<select>`, options from `App.getData().peptides`)
- Date from (type="date")
- Date to (type="date")  
- Text search input (searches peptide name + notes)
- "Clear" button — resets all filters

Filtering is purely client-side on the `App.getData().logs` array. No API calls for filtering.

**Table:** full-width, scrollable. Columns:
- Date/Time (`taken_at` formatted as locale date + time)
- Peptide (as a `badge badge-info` chip)
- Dose (value + unit)
- Route
- mL / IU (formatted as `0.050 mL / 5.0 IU`, or `—` if not available)
- Notes (truncated, `max-width:180px;overflow:hidden;text-overflow:ellipsis`)
- Delete `×` button → calls `deleteHistoryEntry(id)`

`deleteHistoryEntry(id)`: calls `API.delete('/logs/' + id)`, then `App.loadAll()` + `renderAllTabs()`.

**Export CSV button:** downloads currently-filtered rows as CSV (same escaping logic as existing `exportCSV()`). Button in the filter bar row.

**Empty state:** if no logs match filters, show muted "No logs match your filters." If no logs at all, show "No doses logged yet."

### Functions
- `renderHistory()` — applies filters and renders table
- `deleteHistoryEntry(id)` — DELETE + reload
- `exportHistoryCSV()` — download filtered rows

---

## Navigation

Current tabs: Today · Week · Log Dose · Vials · Vendors · Prices · Calculator · Library · Settings

New tabs inserted at the front and end:
**Dashboard** · Today · Week · Log Dose · **History** · Vials · Vendors · Prices · Calculator · Library · Settings · **Orders**

Rationale: Dashboard is the home screen (first), History is near Log Dose (logical flow), Orders is at the end (admin-level feature).

---

## Files Changed

| File | Change |
|------|--------|
| `migrations/0004_orders.sql` | New — orders table + index |
| `worker/index.js` | Add 4 order routes + `DELETE /logs/:id` route; add 5 handler functions |
| `index.html` | Add 3 nav tabs + 3 content divs; extend `renderAllTabs`; add `~12` new functions; add `ORDER_STATUSES`, `ORDER_STATUS_BADGE` constants |

---

## Out of Scope

- Order receipt scanning / AI import (separate feature)
- Order notifications / reminders
- Linking orders to vials (order fulfillment tracking)
- History pagination (200-log limit from existing API is sufficient)
