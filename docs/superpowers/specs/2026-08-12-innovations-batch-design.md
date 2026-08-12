# Innovations Batch — Design

Date: 2026-08-12
Status: Approved via audit-recommendations review, implemented same day

Eight features + hygiene from the app audit. Deferred to follow-up sessions:
index.html file split (risky refactor) and Apple HealthKit (native plugin +
entitlements).

## 1. Active Levels (headline)

`estimateLevels(logs)`: per peptide with a numeric `PEPTIDE_HALFLIFE`, sum
`dose_mcg × 0.5^(hoursSince/t½)` over doses within 6 half-lives. First-order
elimination only — labeled as a tracking estimate. Dashboard card `levels`:
amount, decay progress bar, t½ chip, "near zero in ~X" (time to 10%).

## 2. Peptide notes

Migration 0010 `peptide_notes(user_id, peptide, notes, updated_at, PK
(user_id,peptide))`; GET/PUT `/peptide-notes` (empty notes deletes). "My
Notes" section in the Library detail overlay and the ⓘ sheet with inline
textarea editing; local-copy update avoids full reloads.

## 3. Effects journal

Migration 0011 `checkins(user_id, date PK, weight, energy 1-5, sleep 1-5,
notes)`; GET/PUT `/checkins` upsert. Daily Check-in card on Today; Dashboard
`weight` card: 60-day polyline, dose-day ticks, colored delta.

## 4. AI weekly summary

POST `/ai/summary`: last-14d logs/checkins/cycles/peptide stock → compact
prompt → claude-haiku-4-5 (same key as price import), 4–6 sentence summary,
no medical advice framing. Dashboard `aisummary` card, generate-on-demand.

## 5. Reorder intelligence

`inventoryProjections()`: 28-day mcg burn per peptide ÷ vial size parsed from
inventory `size` ("10 mg") → days of stock; alerts only ≤45 days. Cheapest
`price_per_mg` vendor hinted. Amber banner in Inventory stats card.

## 6. Heat-scaled site dots

Site-card dot radius 5–10px scaled by 90-day frequency (max-normalized);
tooltip gains "N× in 90d". Recency still drives opacity.

## 7. Rest-day-aware streaks

`calcStreak`: days whose weekday has no planner items pass through without
counting or breaking; no planner at all → original behavior.

## 8. Backup & restore

GET `/export`: all 12 user tables (user_id stripped), version 1. POST
`/import`: user-scoped `INSERT OR REPLACE` keyed on original ids —
idempotent for own backups, never deletes. Settings section with download +
file-picker restore.

## Hygiene

- Verify suites now live in `test/e2e/` (three older suites lost to /tmp
  cleanup before the move; innovations/tz/viallevel/reccycles preserved).
- `scripts/reset-local-db.sh` replays all migrations.
- `.assetsignore` gains `test`, `scripts`.
- **Local-dev fix**: D1 writes inside `.wrangler/` were retriggering wrangler
  dev's watcher → endless reload loop (every POST 503). Dev + d1 execute now
  use `--persist-to /tmp/pepos-state`.
- **Known gap**: `/auth/forgot` only console-logs the reset token (DEV
  stub) — real reset emails blocked on CF Email Sending onboarding.

## Verification

`test/e2e/verify-innovations.mjs` 16/16: decay math exact (820/141 mcg
cases), notes roundtrip + delete, check-in persistence, weight delta,
projection math + banner, frequency tooltips, rest-day streak, export
shape, import idempotency, AI card render.
