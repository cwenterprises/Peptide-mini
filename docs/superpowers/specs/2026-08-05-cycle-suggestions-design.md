# Cycle Suggestions from Dose Logs — Design

Date: 2026-08-05
Status: Approved (user), implemented same day

## Goal

Suggest cycles for peptides the user is actively logging without a covering
cycle, anchored to their actual entries, created on acceptance so the
existing Cycle Progress tracking takes over. Active cycle rows additionally
show a dose count from the logs.

## Decisions (user-confirmed)

- Placement: inside the Dashboard Cycle Progress card
- Length: library `cycleLength` midpoint (8-week fallback), dates editable
  before saving
- Progress: cycle rows show "· N doses" counted from entries in the window

## Design

All frontend, no schema/worker changes (POSTs to existing `/cycles`):

- `parseCycleWeeks(str)` — "8–12 weeks" → 10 (midpoint), "6 weeks" → 6,
  unparseable/null → 8. Handles both en-dash and hyphen.
- `suggestCycles(logs, cycles)` — per peptide with a log in the last 14
  days: run start = earliest entry date walking back until a >21-day gap
  (tolerates weekly compounds); skip if any existing cycle overlaps
  [runStart, today] or the suggestion (`peptide|runStart`) was dismissed;
  end = start + weeks×7−1 days, floored at today+7 so a suggestion is never
  already over.
- Dismissals persist per device in localStorage (`pepos_cycle_dismissed`).
  Tradeoff accepted: dismissing on one device won't hide on another.
- UI: amber rows under the cycle list — "💡 Peptide ⓘ — logging since DATE,
  no active cycle" with Add (expands inline start/end date editor, prefilled,
  Confirm → POST) and Dismiss.
- Active cycle rows append "· N doses" (logs for that peptide with
  `start_date ≤ taken_at ≤ end_date`).

## Verification

Playwright (11/11): suggestion appears for a seeded weekly run, run-start
and future-end invariants, parseCycleWeeks unit checks, prefilled editor,
confirm creates the cycle, dose count renders, no re-suggestion once
covered, dismiss hides and persists.

Local-dev note: local D1 was missing the cycles table (0005) — the known
local migration drift; applied directly. Production unaffected.
