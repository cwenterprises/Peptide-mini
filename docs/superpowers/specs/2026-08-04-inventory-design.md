# Inventory (On-Hand Stock) — Design

Date: 2026-08-04
Status: Approved (user), implemented same day

## Goal

Track what's on hand: sealed peptide vials and supplies (syringes, needles,
bacteriostatic water, alcohol wipes, nasal bottles), with low-stock warnings
and one-tap flows connecting Orders (intake) and Vials (consumption).

## Decisions (user-confirmed)

- Scope: peptides + supplies
- Integration: both directions (order → inventory intake; vial creation → deduct)
- Low stock: per-item `reorder_at` threshold with red Low badge + Dashboard chip
- Placement: new Inventory tab (after Vials)

## Data model

Migration `0008_inventory.sql`: `inventory(id, user_id, name, category, size,
qty REAL, reorder_at REAL NULL, notes, created_at, updated_at)`.
Categories: Peptide, Syringes, Needles, Bacteriostatic Water, Alcohol Wipes,
Nasal Spray Bottle, Other.

## Worker

Standard CRUD following the orders pattern: `GET/POST /inventory`,
`PUT/DELETE /inventory/:id`. Category whitelist server-side (falls back to
Other).

## Frontend

- **Inventory tab** — stats chips (item count, total peptide vials, Low count);
  items grouped by category; each row has − / + steppers (instant PUT with
  optimistic local update), Low badge when `qty ≤ reorder_at`, edit/delete.
  Add/edit form: category, size, name (library dropdown assist for Peptide),
  qty, reorder point, notes.
- **Orders intake** — Delivered orders show "→ Inventory": per item (shape
  `{peptide, qty, unit}` where qty is vial strength), prompt for vials
  received, upsert by (name, size) into category Peptide, then flip the order
  to status Stored and switch to the Inventory tab.
- **Vials deduct** — after `addVial` succeeds, if a Peptide item matches the
  name (case-insensitive) with qty > 0, confirm-deduct 1.
- **Dashboard** — "⚠️ Low stock: N" chip in the stats row (tap → Inventory tab)
  whenever any item is at/below its reorder point.
- `App.loadAll` fetches `/inventory` with a `.catch(()=>[])` guard so a
  pre-migration DB can't break boot.

## Verification

Playwright against `wrangler dev` + local D1 (12/12): tab render, empty state,
add via form, stepper decrement, Low badge threshold, Dashboard chip, supply
category grouping, Delivered intake button, prompt-driven intake quantities,
order→Stored flip, vial-creation deduct.

Note: local D1 had drifted (missing vials.solution/reset_at from 0006) —
fixed locally with direct ALTERs; production already had them.
