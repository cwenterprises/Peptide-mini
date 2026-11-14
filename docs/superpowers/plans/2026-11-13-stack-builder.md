# Stack Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved, named peptide stacks that generate tagged planner rows + cycles, start on a chosen date and switch themselves off when their cycle ends.

**Architecture:** New D1 table `stacks` plus `stack_id` on `planner`/`cycles`. Pure stack logic (expansion, dates, validation, transitions, cycle ops) lives in a new `worker/stacks.js`, unit-tested with `node --test`; HTTP handlers and the cron hook call it. The SPA (`index.html`, single file — follow its pattern) gets a Stacks tab, a builder with live checks/preview, and templates. Every existing planner consumer stays untouched.

**Tech Stack:** Cloudflare Worker (ES modules, bundled by wrangler), D1 (SQLite), vanilla JS SPA, Playwright 1.58.0 e2e, `node --test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-11-13-stack-builder-design.md`

## Global Constraints

- Working dir `~/Developer/peptide-build`, branch `peptideos-ios-live`. Commit trailer on every commit:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01EJip89izJiF23UmoUdRY2Z`
- Never touch planner rows or cycles with `stack_id IS NULL`; never delete logs; never delete a cycle whose `start_date <= today`.
- All dates `YYYY-MM-DD` strings; "today" is always the stack's local date (client-sent `today`, or `localDateIn(stack.tz, now)` in cron). Never `toISOString()` for a user's day.
- Validation: name 1–60 chars; 1–12 items; item needs `peptide`, `route`, `dose > 0`, `unit`, `days` ⊂ 0–6 non-empty, `times` ≤ 4 each `/^\d{2}:\d{2}$/`; `weeks` null or integer 1–104.
- Status values exactly: `inactive | scheduled | active | completed`.
- Clash warnings never block saving; `severe` requires a `confirm()`-free inline confirm before activation (no browser dialogs — use an inline "Activate anyway" button).
- No push to `main`; a push touching `index.html`/`service-worker.js` starts a TestFlight build — only push in Task 8.
- Remote migration is run by the user via `!` (auto-mode blocks it); apply it BEFORE `wrangler deploy`.

## Review Focus

1. **Two active stacks share a peptide** → both sets of rows exist (doses double on Today). Expect: builder warns "already in active stack 'X'"; deactivating one leaves the other's rows. → test in Task 3.
2. **Deleting an active stack** → its rows and unstarted cycles must go, started cycles end today. → test in Task 3.
3. **Editing an active stack mid-day** must not resend reminders already sent today (row ids of unchanged rows reused). → unit test in Task 2 (`rewritePlannerRows`).
4. **User's peptide named differently than the library** (e.g. "BPC 157") — template uses library name; activation must not create a near-duplicate silently. Expect: the builder's peptide picker resolves library aliases/case-insensitive matches to the user's existing name before save. → test in Task 6.
5. **Stack with `weeks = null`** never auto-completes and shows "Ongoing"; cron never selects it. → unit test in Task 2, e2e in Task 4.

---

### Task 1: Migration + export

**Files:**
- Create: `migrations/0014_stacks.sql`
- Modify: `worker/index.js:1100` (`EXPORT_TABLES`)

**Interfaces:**
- Produces: table `stacks(id, user_id, name, items TEXT JSON, weeks, start_date, end_date, status, tz, template, created_at, updated_at)`; columns `planner.stack_id`, `cycles.stack_id`; index `idx_planner_stack`, `idx_stacks_user`, `idx_stacks_status(status)`.

- [ ] **Step 1:** Write `0014_stacks.sql` exactly per the spec's "Data model" block (the version with `end_date`, `status`, `tz`; no `active` column) plus `CREATE INDEX IF NOT EXISTS idx_stacks_status ON stacks(status);`.
- [ ] **Step 2:** Add `'stacks'` to `EXPORT_TABLES` after `'cycles'`.
- [ ] **Step 3:** Run `scripts/reset-local-db.sh` → expect `local D1 rebuilt from 14 migrations`; then `npx wrangler d1 execute peptideos_db --local --command "PRAGMA table_info(planner)"` → output lists `stack_id`.
- [ ] **Step 4:** Commit `feat(stacks): migration 0014 + export stacks`.

---

### Task 2: Pure stack core (`worker/stacks.js`) with unit tests

**Files:**
- Create: `worker/stacks.js`, `test/unit/stacks.test.mjs`
- Modify: `test/e2e/README.md` (one line: `node --test test/unit/` from repo root)

**Interfaces (all exported, all pure — no env, no I/O):**
- `validateStack(body) -> string|null` — error message or null (rules in Global Constraints).
- `addDays(ymd: string, n: number) -> string`
- `stackEndDate(start: string, weeks: number|null) -> string|null` — `start + weeks*7 - 1`.
- `localDateIn(tz: string|null, now: Date) -> string` — via `Intl.DateTimeFormat('en-CA', {timeZone})`; invalid/missing tz → UTC date.
- `expandItems(items) -> Array<{peptide, day, time, route, dose, unit, note}>` — `days × max(times.length,1)`; `time` null when no times.
- `rewritePlannerRows(existingRows, expanded) -> {keep: id[], remove: id[], add: row[]}` — match key `peptide|day|time|route|dose|unit`; matched rows are kept (ids reused).
- `transitionFor(stack, localToday) -> 'start'|'complete'|null` — `scheduled && start_date <= today` → start; `active && end_date && end_date < today` → complete.
- `cycleOps({stackCycles, otherCycles, peptides, S, E, today}) -> {insert: [{peptide,start_date,end_date}], update: [{id,end_date}], remove: id[]}` — the spec's 3-step "Cycle rules" per peptide.
- `endStackCycles(stackCycles, today) -> {update: [{id,end_date}], remove: id[]}` — deactivate rule.

- [ ] **Step 1: Write failing tests** in `test/unit/stacks.test.mjs` (`node:test` + `node:assert/strict`):
  - `expandItems([{peptide:'BPC-157',route:'Subcutaneous',dose:250,unit:'mcg',days:[0,1,2,3,4,5,6],times:['08:00','20:00']}]).length === 14`; with `times: []` → 7 rows, all `time === null`.
  - `stackEndDate('2026-11-16', 8) === '2027-01-10'`; `stackEndDate('2026-11-16', null) === null`.
  - `localDateIn('America/Chicago', new Date('2026-11-14T03:00:00Z')) === '2026-11-13'`; `localDateIn('Bad/Zone', same) === '2026-11-14'`.
  - `validateStack({name:'', items:[]})` non-null; valid body → `null`; `times:['8am']` → non-null; `weeks: 0` → non-null.
  - `rewritePlannerRows`: existing 2 rows, expanded = one identical + one new → `keep` has the identical id, `remove` the other, `add` length 1.
  - `transitionFor({status:'scheduled',start_date:'2026-11-14'}, '2026-11-14') === 'start'`; `'2026-11-13'` → null; `{status:'active',end_date:'2026-11-13'}` @ `'2026-11-14'` → `'complete'`; `{status:'active',end_date:null}` → null.
  - `cycleOps`: (a) no cycles → one insert `[S,E]`; (b) stack cycle ended today, S = today → update `end_date: E`, no insert; (c) stack cycle `start_date > today` → removed, then insert; (d) other cycle overlapping → no insert.
  - `endStackCycles`: started cycle → update to today; unstarted → remove; already-ended → untouched.
- [ ] **Step 2:** Run `node --test test/unit/` → FAIL (module not found).
- [ ] **Step 3:** Implement `worker/stacks.js` per the interfaces.
- [ ] **Step 4:** Run `node --test test/unit/` → all pass.
- [ ] **Step 5:** Commit `feat(stacks): pure stack core + unit tests`.

---

### Task 3: Stack HTTP endpoints

**Files:**
- Modify: `worker/stacks.js` (add handlers), `worker/index.js` (routes next to Planner block ~line 170; import from `./stacks.js`)
- Create: `test/e2e/verify-stacks.mjs` (API section)

**Interfaces:**
- Consumes: Task 2 functions; existing `requireAuth`, `json`, `err` — pass them in: `stackHandlers({requireAuth, json, err})` returns `{list, create, update, remove, activate, deactivate}` each `(request, env, origin, path)`.
- Produces routes: `GET /stacks?today=` · `POST /stacks` · `PUT /stacks/:id` · `DELETE /stacks/:id?today=` · `POST /stacks/:id/activate {start_date, today, tz}` · `POST /stacks/:id/deactivate {today}`. Responses: stack objects with `items` parsed to an array; activate/deactivate/update return the updated stack.
- Writes go through one `env.DB.batch([...])` per request. Activate/PUT insert missing peptides into `peptides` (case-insensitive name match against the user's rows).

- [ ] **Step 1: Write failing e2e** `verify-stacks.mjs` (same harness as `verify-reccycles.mjs`: login sitetest, then `page.evaluate` with `API`). Checks:
  - create stack A (BPC-157 daily ×1 time, TB-500 Mon/Thu, weeks 6) → status `inactive`.
  - hand-made planner row exists (POST `/planner`) before activation.
  - activate A with start = today → planner rows with `stack_id === A.id` count = 7 + 2; hand row still present; 2 cycles with `stack_id`.
  - create stack B containing BPC-157, activate → deactivate A → B's BPC rows still present.
  - deactivate A then activate A same day → stack cycles for A count still 2 (reopened, not duplicated).
  - PUT active A adding SS-31 and removing TB-500 → SS-31 cycle starts today and ends at A's `end_date`; TB-500 rows gone and its stack cycle `end_date === today`; BPC-157 planner row ids unchanged.
  - PUT active A with `weeks` 6 → 8 → A's unended stack cycles `end_date === stackEndDate(A.start_date, 8)`.
  - activate with start = today+3 → status `scheduled`, 0 planner rows for that stack.
  - DELETE an active stack → its planner rows gone; its started cycle `end_date === today`.
  - activate a stack whose item peptide is not in `/peptides` (use `'SS-31'` after deleting it if present) → `/peptides` now contains it once.
  - `/export` JSON has a `stacks` array.
- [ ] **Step 2:** Run `node test/e2e/verify-stacks.mjs` (with `wrangler dev --port 8791 --local` up) → FAILs (404).
- [ ] **Step 3:** Implement handlers + routes.
- [ ] **Step 4:** Re-run → all PASS; `node --test test/unit/` still passes.
- [ ] **Step 5:** Commit `feat(stacks): stack CRUD, activate/deactivate endpoints`.

---

### Task 4: Automatic start/complete (GET + cron)

**Files:**
- Modify: `worker/stacks.js` (`applyTransitions(env, {userId?, now, todayOverride?}) -> number`), `worker/index.js` (`handleCron` calls it first)
- Test: `test/e2e/verify-stacks.mjs` (transition section), `test/unit/stacks.test.mjs`

**Interfaces:**
- `applyTransitions` selects with `(status='scheduled' AND start_date <= :startMax) OR (status='active' AND end_date IS NOT NULL AND end_date < :endMax)` (bounds from `coarseBounds(now)`, plus `AND user_id = ?` when `userId` is given), then confirms each with `transitionFor(stack, todayOverride ?? localDateIn(stack.tz, now))`. `start` = Task 3's start-now batch; `complete` = delete stack planner rows + `status='completed'`. GET `/stacks` calls it with `{userId, todayOverride: query.today}` before listing.
- Coarse-filter bounds: scheduled uses `<= utcToday + 1`, active uses `< utcToday + 1` (local date can be a day ahead of UTC) — exact check is `transitionFor`.

- [ ] **Step 1: Failing tests:** unit — `transitionFor` already covered; add a test for the bounds helper `coarseBounds(now) -> {startMax, endMax}`. e2e — scheduled stack (start today+3): `GET /stacks?today=<today+3>` → status `active`, planner rows present; active stack weeks 1 started today-10 (activate with past start): `GET /stacks?today=<today>` → `completed`, 0 stack rows, its cycles untouched; open-ended stack (`weeks:null`) stays `active` at `today+400`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; in `handleCron`, wrap `applyTransitions(env, {now})` in try/catch so reminder sending still runs if it throws.
- [ ] **Step 4:** Run unit + e2e → PASS. Also `curl "http://localhost:8791/__scheduled?cron=*/5+*+*+*+*"` with dev started using `--test-scheduled` → 200, no error in the dev log.
- [ ] **Step 5:** Commit `feat(stacks): auto start/complete via cron + on load`.

---

### Task 5: Stacks tab — data load, list, Settings badge

**Files:**
- Modify: `index.html` — nav (`:427-439`, add `<button class="nav-tab" data-tab="stacks">Stacks</button>` after Week), panel `<div id="stacks" class="tab-content"></div>` after `#week` (`:446`), `loadAll()` (`:556`), `renderAllTabs()` (`:730`), Settings planner list (inside `renderSettings` `:6178`).

**Interfaces:**
- `loadAll()`: `await API.get('/stacks?today=' + ymd(new Date())).catch(() => [])` **before** the existing `Promise.all` (transitions may rewrite planner rows), stored as `_data.stacks`.
- `renderStacks()` — list view; `stackStatusLabel(stack, today) -> string` ("Active · week X of Y" / "Active · Ongoing" / "Starts Mon Nov 16" / "Completed Dec 24" / "Off").
- `activateStackUI(id)`, `deactivateStackUI(id)`, `deleteStackUI(id)` — call endpoints with `today: ymd(new Date())`, `tz: Intl.DateTimeFormat().resolvedOptions().timeZone`, then `App.reload()` (use whatever the existing post-mutation refresh is — see how `cyclesAdd` UI refreshes at `:3851`).
- Settings planner rows with `stack_id` show `<span class="chip">📚 {stack name}</span>` with `title="Comes back when the stack is edited or reactivated"`.

- [ ] **Step 1: Failing e2e** (new UI section in `verify-stacks.mjs`): click `[data-tab="stacks"]` → `#stacks` visible, a card per stack, active card text contains "week 1 of"; Settings shows the 📚 chip on a stack row; Today tab shows the stack's peptides.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(stacks): Stacks tab list + planner badge`.

---

### Task 6: Builder, preview, templates

**Files:**
- Modify: `index.html` (new functions near `renderStacks`)

**Interfaces:**
- `STACK_TEMPLATES` — array `{key, name, weeks, items}` for: `wolverine` (BPC-157 + TB-500), `gh-pulse` (CJC-1295 + Ipamorelin), `cognitive` (Semax + Selank), `mito` (SS-31 + MOTS-C + NAD+), `anti-aging` (Epithalon + GHK-Cu), `metabolic` (MOTS-C + 5-amino-1mq). Doses = the low end of each `PEPTIDE_LIBRARY` entry's `protocols` text; names must exist in `PEPTIDE_LIBRARY` (`name` or `aliases`).
- `DAY_PRESETS = {daily:[0..6], weekdays:[1..5], mwf:[1,3,5], monthu:[1,4]}` + weekly (one day) + custom.
- `resolvePeptideName(name, userPeptides) -> string` — case/space/dash-insensitive match against user's names, then library aliases → the user's existing name; else the library canonical name.
- `expandItemsClient(items)` — same contract as Task 2's `expandItems` (small duplicate is intentional: `worker/` is not served as an asset).
- `renderStackBuilder(stackOrTemplate|null)` renders into `#stacks`; `stackPreviewHtml(items)` uses `vialRunouts({planner: expandItemsClient(items), vials, logs})` + `runoutLineHtml`, doses/week per peptide, weekly cost from `prices` when present (cheapest price per mg for the peptide; omit line when none).
- Default cycle weeks = max `parseCycleWeeks(lib.cycleLength)` across items; "No cycle" option → `weeks: null`.
- Save → POST/PUT; "Save & activate" → inline start-date row (default today, any date allowed) → activate.

- [ ] **Step 1: Failing e2e:** open template "Wolverine" → builder shows 2 item rows with library names; choose preset M/W/F on TB-500 → preview shows "3 doses/week" for it; `resolvePeptideName('bpc 157', [{name:'BPC-157'}]) === 'BPC-157'`; save & activate → card appears Active; create via builder with no times → saves.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; check at 390px width that the builder has no horizontal scroll (`document.documentElement.scrollWidth <= 390`).
- [ ] **Step 5:** Commit `feat(stacks): builder, live preview, templates`.

---

### Task 7: Pairing & clash checks

**Files:**
- Modify: `index.html`

**Interfaces:**
- `PEPTIDE_CLASSES` — `{[libraryName]: string[]}` for current library names (classes: `glp1`, `melanocortin`, `ghrh`, `ghrp`, `igf`, `insulin`, `blend:wolverine`, `blend:glow`, `blend:klow`, plus component tags `bpc157`, `tb500`, `ghkcu`, `kpv`).
- `STACK_RULES` — array of `{level:'severe'|'caution'|'tip', kind:'same-class'|'pair'|'blend-overlap'|'synergy', classes|peptides, message, source}` where `source` is the library entry name the statement comes from. Seed **only** from library `stack` text (GLP-1 vs GLP-1, melanocortin vs melanocortin, IGF-1 LR3 + insulin, blend + component, GHRH + GHRP tip).
- `checkStack(items, activeStacks, editingId) -> Array<{level, message, peptides}>` — also emits `caution` "X is already in active stack 'Name'" for overlaps with other active/scheduled stacks.
- Builder renders the result in a Checks panel; with any `severe`, the activate button becomes "Activate anyway" (inline, no dialog).

- [ ] **Step 1: Failing e2e:** items Semaglutide + Tirzepatide → one `severe`; CJC-1295 + Ipamorelin → a `tip`; Wolverine blend + BPC-157 → `caution` blend-overlap; BPC-157 while active stack A has it → overlap caution; builder with severe shows "Activate anyway".
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5 (user contribution):** Pause and show the user `STACK_RULES` (rendered as a readable list with sources). Apply their edits; re-run e2e.
- [ ] **Step 6:** Commit `feat(stacks): pairing and clash rules`.

---

### Task 7b: Recommendations (recommended stacks + suggested partners)

**Files:**
- Modify: `index.html`

**Interfaces:**
- Extend `STACK_TEMPLATES` (Task 6) to the 14 combos listed in the spec's "Recommendations" section; add `goal` and `source` (library entry name whose `stack` text names the combo) to each.
- `STACK_PAIRINGS` — `{[libraryName]: string[]}` partners, symmetric (if A lists B, B lists A).
- `inStockNames(inventory, userPeptides) -> Set<string>` — Peptide-category rows with `qty > 0`, names normalized through `resolvePeptideName`.
- `recommendStacks(templates, inStock) -> Array<{template, have: number, total: number}>` sorted by `have/total` desc, then `have` desc.
- `suggestPartners(items, inStock, activeStacks) -> Array<{peptide, inStock: boolean, because: string}>` — union of partners of current items, minus items already in the stack, minus any partner for which `checkStack([...items, partner])` yields a new `severe`; in-stock first.
- Stacks tab renders "Recommended stacks" cards ("In stock: X of Y"); Builder renders partner chips; chip tap appends an item with route = first route in library entry, unit/dose from that entry's low-end protocol (same helper Task 6 uses for templates).

- [ ] **Step 1: Failing e2e:** with inventory MOTS-C 10, SS-31 10, NAD+ 10 → Mitochondrial card shows "In stock: 3 of 3" and ranks first; builder with BPC-157 shows chips TB-500, GHK-CU, KPV; builder with Semaglutide never suggests Tirzepatide/Retatrutide; tapping a chip adds a row; `STACK_PAIRINGS` symmetry check (`every A→B has B→A`).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(stacks): recommended stacks + suggested partners`.

---

### Task 8: Release

**Files:**
- Modify: `index.html` + `service-worker.js` (`APP_VERSION`), `service-worker.js` (`CACHE_NAME` → next `peptideos-vNN`)

- [ ] **Step 1:** Full local regression: `scripts/reset-local-db.sh`, `wrangler dev`, `node --test test/unit/` and `cd test/e2e && npm test` → all 11 suites PASS.
- [ ] **Step 2:** Bump versions; commit `chore: bump to vNN for stack builder`.
- [ ] **Step 3:** Ask the user to run `! npx wrangler d1 execute peptideos_db --remote --file migrations/0014_stacks.sql`; confirm with `--remote --command "PRAGMA table_info(stacks)"`.
- [ ] **Step 4:** `git push` (starts TestFlight build), `npx wrangler deploy`.
- [ ] **Step 5:** Verify live `index.html` sha256 equals local; `curl -s https://peptideos.cwenterprises.net/stacks` → 401 (route exists, auth required).
- [ ] **Step 6:** Update memory `peptideos-web-deploy.md` (migration 0014 applied, suite count).
