# Five Additions — Design

Date: 2026-08-05
Status: Approved (user), implemented same day

## Decisions (user-confirmed)

- Card reorder: Dashboard only, arrow buttons in an edit mode, synced order
- Theme: quick header/FAB toggle (light/dark already existed in Settings)
- Protocols: Calculator sub-tab + suggested recipe in the ⓘ sheet

## 1. Both Nostrils

`SITES` entry `nostril-both` (front view, centered below the L/R nostril
dots, Intranasal route). Participates in dropdown, diagram, rotation
suggestion, and site card automatically.

## 2. Dashboard card reorder

- Cards keyed: stats, cycles, appsite, calendar, compliance, toppeps
  (`DASH_CARD_KEYS`); `dashCardOrder(settings)` = saved order with unknown
  keys dropped, new keys appended.
- "⇅ Edit layout" toggle shows ↑/↓ per card; `moveDashCard` swaps, renders
  optimistically, PUTs `dash_order` (new `user_settings` column, migration
  0009) so it syncs across devices.

## 3. Theme quick toggle

Fixed bottom-right glass FAB (the app has no header bar) cycling
Light → Dark → System via existing `setTheme`; icon reflects mode
(☀️/🌙/🌗), synced on render and from the Settings picker.

## 4. Reconstitution protocols

- Calculator "Protocols" sub-tab: two step-by-step glass cards (powder-vial
  reconstitution; nasal-spray preparation) with supplies lists, inject-down-
  the-glass / swirl-don't-shake / prime-the-pump guidance, storage notes,
  and links into the Recon and Nasal calculators.
- ⓘ sheet "Suggested recipe": parses the library doseRange (mg/mcg, range
  midpoint), targets the typical dose ≈ 10 units on a U-100, picks a common
  vial size (5/10/15/30 mg) whose water volume lands 0.5–3 mL. Hidden when
  the dose doesn't parse cleanly.

## 5. Favorite vendors

`vendors.favorite` column (migration 0009); star toggle on cards;
"★ Favorites" section pinned above "All Vendors". `saveVendor` carries the
flag through edits (the UPDATE would otherwise zero it).

## Verification

Playwright 15/15: nostril site + dropdown, FAB + full theme cycle,
edit-mode arrows + optimistic move + server-persisted order, protocols
render/visibility, recipe math (Ipamorelin: 5 mg + 2 mL → 250 mcg = 10
units) + sheet integration, star toggle + sections + server persistence.
