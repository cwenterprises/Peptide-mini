# Peptide Info Icon (ⓘ) — Design

Date: 2026-08-04
Status: Approved (user), implemented same day

## Goal

An ⓘ beside peptide names, everywhere they appear, opening a brief
research-information breakdown sourced from the existing `PEPTIDE_LIBRARY`
data (43 entries).

## Decisions (user-confirmed)

- Placement: everywhere a peptide name shows — Today planned + logged rows,
  Week rows, Log Dose (beside the selector, follows selection), Vials cards,
  Inventory peptide items, History rows
- Detail: brief breakdown with a "Full details" escape hatch

## Design

- `findLibraryEntry(name)` — case-insensitive match on library names and
  aliases; unknown/custom peptides return null and get no icon.
- `peptideInfoBtn(name)` — the ⓘ button (or '' when no entry); uses
  `data-pep` + `event.stopPropagation()` so it's safe inside clickable rows
  and with names containing quotes.
- `showPeptideInfo(name)` — glass bottom sheet (slide-up animation, dim
  backdrop, tap-outside or × closes): name + aliases, chips for
  half-life / dose range / route, then What it is / Mechanism / Research
  protocol sections, a research-only disclaimer, and a **Full details**
  button that opens the pre-existing `showLibraryDetail` overlay (which adds
  aliases, cycle length, stack notes, Use-in-Calculator).
- No worker or schema changes — data already ships inline in the app.

## Verification

Playwright (12/12): icons render on Today/Inventory/History, alias lookup
(OT → Oxytocin), no icon for custom names, sheet opens with all sections and
chips, Full details chains into the library overlay, backdrop closes, Log
Dose icon follows the selected peptide.

Deploy note: the custom-domain root URL can serve a stale edge copy for a
while after `wrangler deploy` (cf-cache-status HIT); verify deploys with a
unique query string (`/?v=123`) — browsers revalidate per
`max-age=0, must-revalidate`.
