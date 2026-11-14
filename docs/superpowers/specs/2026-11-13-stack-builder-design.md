# Stack Builder — Design

Date: 2026-11-13
Status: Draft, awaiting user approval

## Intent

Today a multi-peptide protocol has to be entered as one planner row per
peptide × weekday × time (a 3-peptide daily stack = 21 rows typed by hand in
Settings), and the library's `stack` pairing notes are free text the app never
reads. The Stack Builder lets the user compose a protocol once — pick peptides,
set dose/days/times for each, see pairing tips and clash warnings — save it as
a **named stack**, and switch it on/off as a unit. Switching on writes ordinary
planner rows and cycles, so Today, Week, streaks, push reminders, the
calendar feed and vial runout keep working with zero changes.

## Goals

- Build a stack in one screen instead of N×7 planner rows.
- Saved, named stacks (e.g. "Wolverine", "Cut Q1") that can be activated,
  deactivated, edited and deleted as a unit; more than one can be active.
- Pairing tips and clash warnings driven by structured rules, not free text.
- Starter templates from the well-known combos already described in the library.
- Preview before activating: weekly dose count per peptide, vial runout for the
  stack's schedule, and weekly cost where prices exist.

## Non-goals

- Every-other-day / every-N-days schedules. The planner is weekday-based
  (`day` 0–6); EOD can't be represented without changing every planner consumer.
- Dose titration / ramp schedules (week 1 = 250 mcg, week 2 = 500 mcg).
- Sharing stacks between users.
- Changing how Today/Week/reminders/calendar read the planner.

## Anti-goals

- Activating/deactivating a stack must never touch planner rows the user
  entered by hand, and must never delete logs or past cycle history.
- Clash warnings are informational and never block saving (the app is a
  personal tracker, not a prescriber) — but a "severe" clash needs an explicit
  confirm before activation.

## Approaches considered

- **A. One-shot builder that writes planner rows.** No schema change, but the
  stack stops existing once written; editing/removing means row-by-row cleanup.
- **B. Saved stacks that generate tagged planner rows. ← chosen by user.**
  One small migration; stacks are editable and switchable as a unit;
  every existing consumer of the planner is untouched.
- **C. Stacks as a live layer read directly by every screen.** Rejected:
  Today, Week, the reminder cron, the .ics feed and runout math would all need
  rewriting for no user-visible gain over B.

## Data model — migration `0014_stacks.sql`

```sql
CREATE TABLE IF NOT EXISTS stacks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  items TEXT NOT NULL,          -- JSON array, see below
  weeks INTEGER,                -- cycle length; NULL = open-ended (no cycles, never auto-ends)
  start_date TEXT,              -- YYYY-MM-DD the current/last run starts
  end_date TEXT,                -- start_date + weeks×7 − 1; NULL when weeks is NULL
  status TEXT NOT NULL DEFAULT 'inactive', -- inactive | scheduled | active | completed
  tz TEXT,                      -- IANA zone captured from the client at activation
  template TEXT,                -- template key it was started from, if any
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stacks_user ON stacks(user_id);
ALTER TABLE planner ADD COLUMN stack_id TEXT;
ALTER TABLE cycles  ADD COLUMN stack_id TEXT;
CREATE INDEX IF NOT EXISTS idx_planner_stack ON planner(stack_id);
```

`items` JSON — one entry per peptide in the stack:

```json
{ "peptide": "BPC-157", "route": "Subcutaneous", "dose": 250, "unit": "mcg",
  "days": [0,1,2,3,4,5,6], "times": ["08:00","20:00"], "note": "" }
```

Expansion: each item yields `days.length × max(times.length,1)` planner rows
(`time` null when `times` is empty), each with `stack_id` set.

Add `stacks` to `EXPORT_TABLES` (after `planner`/`cycles` is fine — no FKs on
`stack_id`).

## Worker endpoints (worker/index.js, same auth/json/err helpers)

- `GET /stacks` — list user's stacks (`items` parsed to an array).
- `POST /stacks` — create `{name, items, weeks, template}` (inactive).
- `PUT /stacks/:id` — update name/items/weeks. If the stack is active,
  rewrite its planner rows and adjust its cycles (rules below). If scheduled,
  just store the new items/dates.
- `DELETE /stacks/:id` — deactivates first (below), then deletes the row.
- On activate (and on PUT of an active/scheduled stack), any item peptide not
  in the user's `peptides` table is inserted there (Claude's call: everything
  else — vials, prices, Log Dose, `planMatched` — matches by exact name).
- `POST /stacks/:id/activate` `{start_date, today, tz}` — `start_date` may be
  past, today, or future. Sets `start_date`, `end_date`, `tz`, writes cycles
  (below) and then:
  - `start_date <= today` → **start now** (status `active`, planner rows written);
  - `start_date > today` → status `scheduled`, **no planner rows yet**.
- **Start now** = one `env.DB.batch([...])`: delete `planner WHERE stack_id = ?`,
  insert the expanded rows, `status = 'active'`.
- `POST /stacks/:id/deactivate` `{today}` — one batch: delete the stack's
  planner rows; for the stack's cycles: `start_date > today` → delete (never
  started); `end_date > today` → set `end_date = today`; status `inactive`.

### Cycle rules for a stack's own cycles (user-confirmed approach, details = Claude's call)

Only cycles with this `stack_id` are touched; hand-made/auto cycles never are.
Per peptide, when (re)activating with window `[S, E]`:
1. Delete the stack's cycles for that peptide with `start_date > today`.
2. If the stack has a cycle for that peptide with `end_date >= S − 1`
   (still running, or ended no earlier than the day before S — e.g. turned off
   and on again the same day), **reopen** it: `end_date = E`.
3. Otherwise, if a non-stack cycle overlaps `[S, E]`, skip (existing
   `auto` dedupe rule). Otherwise insert a new cycle `[S, E]` with `stack_id`.

Editing an active stack (`PUT`): added peptide → cycle `[today, E]`; removed
peptide → its stack cycle ended at today (deleted if not started); `weeks`
changed → recompute `E`, set `end_date = E` on the stack's cycles that haven't
ended. Planner rows are rewritten **reusing the ids of unchanged rows**
(same peptide/day/time) so `notifications_sent` dedupe isn't reset mid-day.

### Automatic start and end (user-confirmed: auto turn off)

Status transitions, evaluated per stack using **its own local date**
(`Intl.DateTimeFormat('en-CA', {timeZone: stack.tz})`; `tz` missing → UTC):
- `scheduled` and `start_date <= localToday` → start now (rows written).
- `active` and `end_date` not null and `end_date < localToday` → delete its
  planner rows, status `completed`. Cycles are left as they are (they end on E).

Runs in two places so it's prompt and reliable:
- `handleCron` (every 5 min already): one cheap query
  `SELECT … FROM stacks WHERE (status='scheduled' AND start_date <= ?) OR (status='active' AND end_date < ?)`
  using the earliest/latest plausible local date (UTC ± 1 day) as a coarse
  filter, then the exact per-stack local-date check before acting.
- `GET /stacks?today=YYYY-MM-DD` on app load applies the same transitions for
  the calling user before returning, so the screen is never stale.

`completed` stacks keep their items; the card shows "Completed <date> ·
Run again" (Run again = activate with a new start date).

Validation: name 1–60 chars; 1–12 items; each item needs peptide, route,
dose > 0, unit, ≥1 day in 0–6, ≤4 times matching `HH:MM`.

## Frontend (index.html)

**New top-level tab "Stacks"** placed after "Week" in `.nav-tab` order;
`renderStacks()` registered in `renderAllTabs()`. `App.getData()` loads
`/stacks` alongside the others.

Screen states:

1. **List** — card per stack: name, status badge (Active · Starts <date> ·
   Completed <date> · Off), peptide chips, "N doses/week", "week X of Y"
   when active with a cycle length ("Ongoing" when open-ended); buttons
   Activate / Run again / Deactivate, Edit, Delete. "+ New stack" and
   "Start from template".
2. **Builder** (new or edit) —
   - Name field; cycle length (weeks, prefilled from the longest
     `parseCycleWeeks(cycleLength)` among the items; "No cycle" option).
   - Item rows: peptide picker (user's peptides + library names), route
     (prefilled from the library's first listed route), dose + unit,
     day preset (Daily · Mon–Fri · M/W/F · Mon/Thu · Weekly (pick day) ·
     Custom checkboxes), 1–4 time inputs, note. `peptideInfoBtn()` beside each name.
   - **Checks panel** (live): clash warnings and pairing tips from
     `checkStack(items)`; also "BPC-157 is already in active stack 'X'"
     when a peptide overlaps another active stack.
   - **Preview panel** (live): per peptide doses/week; runout lines from
     `vialRunouts({ planner: expanded, vials, logs })` rendered with
     `runoutLineHtml`; weekly cost from `prices` when a price exists.
   - Save · Save & Activate (activation asks for start date, default today).
     A severe clash shows a confirm before activating.
3. **Templates** — picking one opens the Builder prefilled; user edits
   doses before saving. Starter set (doses = conservative values from each
   library entry's `protocols`; builder chooses exact numbers and cites the
   entry): Wolverine (BPC-157 + TB-500), GH pulse (CJC-1295 no-DAC +
   Ipamorelin), Cognitive (Semax + Selank), Mitochondrial (SS-31 + MOTS-C +
   NAD+), Anti-aging (Epithalon + GHK-Cu), Metabolic (MOTS-C + 5-amino-1mq).

**Settings planner list**: rows with `stack_id` show a small "📚 stack name"
badge; deleting such a row individually is allowed (it comes back on the
next activate/edit — the badge tooltip says so).

## Pairing & clash rules

A `PEPTIDE_CLASSES` map (peptide name → class tags, e.g. `glp1`,
`melanocortin`, `ghrh`, `ghrp`, `igf`, `insulin`, `blend:wolverine`) and a
`STACK_RULES` array in index.html, evaluated by
`checkStack(items) → [{level: 'severe'|'caution'|'tip', message, peptides}]`.
Rule kinds: same-class conflict (two `glp1`), named pair conflict, blend
overlap (a blend + one of its components = duplicate dosing), and synergy
tips (`ghrh` + `ghrp`). **Rule content (Claude's call, user reviews before
release):** seeded only from statements already in the library's `stack`
text — e.g. "Avoid stacking with other GLP-1 agents" (Semaglutide /
Tirzepatide / Retatrutide), "Not stacked with other melanocortins"
(PT-141 / Melanotan), "Pairing with IGF-1 LR3 or insulin compounds
hypoglycemia risk", blend-vs-component duplicates (Wolverine/Glow/Klow vs
BPC-157/TB-500/GHK-Cu/KPV), and GHRH+GHRP synergy tips. Each rule cites the
library entry it came from. Production deploy waits until the user has
reviewed/edited this list.

## Release

Migration first (user runs `! npx wrangler d1 execute peptideos_db --remote
--file migrations/0014_stacks.sql`), then bump `APP_VERSION` (index.html +
service-worker.js) and `CACHE_NAME`, commit, push, `npx wrangler deploy`,
verify live index.html sha256 == local.

## Verification

New `test/e2e/verify-stacks.mjs` against local `wrangler dev`: create from
template → activate → planner has the expected count of `stack_id` rows and
Today/Week show them; a hand-made planner row survives activate/edit/
deactivate; deactivate ends (not deletes) a started cycle and deletes an
unstarted one; off→on the same day reopens the cycle (no duplicate); a
future start stays `scheduled` with no planner rows, then starts when the
transition runs with `today >= start_date`; a stack past `end_date` becomes
`completed` and its rows are gone; GLP-1 + GLP-1 shows a severe warning;
export includes stacks. Existing 10 suites still pass.

## Left to the builder

Exact visual styling (reuse existing glass cards/chips/badges), template
dose numbers (from library `protocols`), copy text, mobile layout details.
