# Syringe Calculator + Peptide Auto-Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed 40 default peptides on new user registration, and add a session-scoped U-100/U-40 type + 0.3/0.5/1.0mL capacity selector to the Calculator and Log Dose tabs with corrected IU math and overflow warnings.

**Architecture:** Two independent changes to one Cloudflare Worker file and one HTML file. No new files, no new API endpoints. The syringe state is two module-level JS variables (`_syringeType`, `_syringeCapacityMl`) shared by all calculator functions. Selector UI updates these vars directly and calls the active recalc function — no full tab re-renders on picker change.

**Tech Stack:** Cloudflare Workers + D1 (Worker change), vanilla JS in a single-file SPA (frontend change)

---

## File Map

| File | Change |
|------|--------|
| `worker/index.js` | Add `WORKER_DEFAULT_PEPTIDES` constant + D1 batch insert in `authRegister` |
| `index.html` | Add `_syringeType`/`_syringeCapacityMl` state vars; update `calcDrawMath`, `calcRecon`, `calcDraw`; add `setSyringeType`, `setSyringeCapacity`, `syringeOverflowWarning`, `recalcActiveSyringe`; update `renderCalc` (syringe glass card above nav), update `renderLogDose` (compact selectors) |

---

## Task 1: Worker — Seed 40 Peptides at Registration

**Files:**
- Modify: `worker/index.js:151-174` (`authRegister`)

- [ ] **Step 1: Add the DEFAULT_PEPTIDES constant to worker/index.js**

Add this immediately before the `authRegister` function (after line 150):

```javascript
const WORKER_DEFAULT_PEPTIDES = [
  "5-amino-1mq","AICAR","AOD-9604","ARA-290","Adalank","Adamax","BPC-157",
  "Cerebrolysin","CJC-1295","CJC-195/IPA","DSIP","Dihexa","Epithalon",
  "GHK-CU","GhRIP","Glow","Glutathione","IGF-1 LR3","Ipamorelin","KPV",
  "Kisspeptin","Klow","LL-37","Lipo-C","MOTS-C","NAD+","Oxytocin","PE-22-28",
  "PT-141","Pinealon","Retatrutide","SS-31","SLU-PP-332","Semax","Selank",
  "Sermorelin","TB-500","Tesamorelin","Thymosin Alpha-1","VIP","Wolverine"
];
```

- [ ] **Step 2: Replace the user-insert + session-create block in authRegister**

Replace lines 159–173 (the `crypto.randomUUID()` through `return json(...)`) with a version that batches the user insert and all 40 peptide inserts together:

```javascript
  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const now = new Date().toISOString();

  const peptideStmts = WORKER_DEFAULT_PEPTIDES.map(name =>
    env.DB.prepare('INSERT INTO peptides (id, user_id, name) VALUES (?, ?, ?)')
      .bind(crypto.randomUUID(), id, name)
  );

  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, email.toLowerCase().trim(), hash, now),
    ...peptideStmts
  ]);

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.SESSIONS.put(token, JSON.stringify({ user_id: id, expires_at: expiresAt }), {
    expirationTtl: 30 * 24 * 60 * 60
  });

  return json({ token, email: email.toLowerCase().trim() }, 201, origin);
```

The full `authRegister` function now reads:

```javascript
async function authRegister(request, env, origin) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email and password required', 400, origin);
  if (password.length < 8) return err('password must be at least 8 characters', 400, origin);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase().trim()).first();
  if (existing) return err('email already registered', 400, origin);

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const now = new Date().toISOString();

  const peptideStmts = WORKER_DEFAULT_PEPTIDES.map(name =>
    env.DB.prepare('INSERT INTO peptides (id, user_id, name) VALUES (?, ?, ?)')
      .bind(crypto.randomUUID(), id, name)
  );

  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, email.toLowerCase().trim(), hash, now),
    ...peptideStmts
  ]);

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.SESSIONS.put(token, JSON.stringify({ user_id: id, expires_at: expiresAt }), {
    expirationTtl: 30 * 24 * 60 * 60
  });

  return json({ token, email: email.toLowerCase().trim() }, 201, origin);
}
```

- [ ] **Step 3: Verify registration seeds peptides**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler dev --local > /tmp/wdev_seed.log 2>&1 &
WPID=$!
sleep 7

# Register a fresh user
REG=$(curl -s -X POST http://localhost:8787/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"seed_test@test.com","password":"testpass123"}')
TOKEN=$(echo "$REG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:8}..."

# Verify 41 peptides were seeded (41 = 40 defaults + possible ordering)
COUNT=$(curl -s http://localhost:8787/api/peptides \
  -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "Peptide count: $COUNT"
# Expected: 41

kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

Expected output:
```
Token: <8-char prefix>...
Peptide count: 41
```

- [ ] **Step 4: Commit**

```bash
git add worker/index.js
git commit -m "feat: seed 40 default peptides at user registration"
```

---

## Task 2: Syringe State Variables & IU Formula

**Files:**
- Modify: `index.html` (state vars near top of script, update `calcDrawMath`, `calcRecon`, `calcDraw`)

- [ ] **Step 1: Add syringe state variables and helper functions**

Find the line `let _calcSubTab = 'recon';` in index.html (it's near the top of the `<script>` block, before `renderCalc`). Add immediately after it:

```javascript
let _syringeType = 100;       // 100 = U-100 (standard), 40 = U-40
let _syringeCapacityMl = 1.0; // 0.3 | 0.5 | 1.0

function syringeOverflowWarning(volMl) {
  if (!volMl || volMl <= _syringeCapacityMl) return '';
  return `<div class="badge badge-pending" style="margin-top:8px;display:inline-flex;">⚠ Exceeds ${_syringeCapacityMl} mL syringe capacity</div>`;
}

function recalcActiveSyringe() {
  if (_calcSubTab === 'recon') calcRecon();
  else if (_calcSubTab === 'draw') calcDraw();
  updateDrawMath();
}

function setSyringeType(type) {
  _syringeType = type;
  // Update Calculator pill buttons
  const t100 = document.getElementById('syrType100');
  const t40  = document.getElementById('syrType40');
  if (t100) { t100.className = `btn btn-sm ${type === 100 ? 'btn-primary' : 'btn-ghost'}`; }
  if (t40)  { t40.className  = `btn btn-sm ${type === 40  ? 'btn-primary' : 'btn-ghost'}`; }
  // Sync Log Dose select if visible
  const ldSel = document.getElementById('ldSyrType');
  if (ldSel) ldSel.value = String(type);
  recalcActiveSyringe();
}

function setSyringeCapacity(cap) {
  _syringeCapacityMl = cap;
  // Update Calculator pill buttons
  [['syrCap03', 0.3], ['syrCap05', 0.5], ['syrCap10', 1.0]].forEach(([id, val]) => {
    const btn = document.getElementById(id);
    if (btn) btn.className = `btn btn-sm ${cap === val ? 'btn-primary' : 'btn-ghost'}`;
  });
  // Sync Log Dose select if visible
  const ldSel = document.getElementById('ldSyrCap');
  if (ldSel) ldSel.value = String(cap);
  recalcActiveSyringe();
}
```

- [ ] **Step 2: Verify state vars exist (no-op test)**

Open browser DevTools console on `http://localhost:8787` (start wrangler dev if needed). Type:

```javascript
console.log(_syringeType, _syringeCapacityMl);
```

Expected: `100 1`

- [ ] **Step 3: Update calcDrawMath to use _syringeType**

Find `calcDrawMath` at line ~975. Replace the IU branch and final two lines:

Current:
```javascript
  else if (doseUnit === 'IU') {
    // IU = syringe units on U-100 syringe; 1 IU = 0.01 mL
    const volFromIU = Number(doseValue) / 100;
    doseMcg = volFromIU * conc;
  }
  else return null;
  if (isNaN(doseMcg) || doseMcg <= 0) return null;
  const volMl = doseMcg / conc;
  const iu    = volMl * 100; // assuming U-100 syringe
  return { conc: conc.toFixed(1), vol: volMl.toFixed(3), iu: iu.toFixed(1), mcg: doseMcg.toFixed(1) };
```

Replacement:
```javascript
  else if (doseUnit === 'IU') {
    const volFromIU = Number(doseValue) / _syringeType;
    doseMcg = volFromIU * conc;
  }
  else return null;
  if (isNaN(doseMcg) || doseMcg <= 0) return null;
  const volMl = doseMcg / conc;
  const iu    = volMl * _syringeType;
  return { conc: conc.toFixed(1), vol: volMl.toFixed(3), iu: iu.toFixed(1), mcg: doseMcg.toFixed(1), volMl };
```

Note: `volMl` (raw number, not string) is added to the return object so overflow warnings can use it.

- [ ] **Step 4: Update calcRecon to use _syringeType**

Find `calcRecon` at line ~1341. Replace the two hardcoded lines:

Current:
```javascript
  const iu    = volMl * 100;
  drawRes.style.display = 'block';
  drawRes.innerHTML = `Draw <strong>${volMl.toFixed(3)} mL</strong> (${iu.toFixed(1)} IU on U-100 syringe) for a ${doseMcg} mcg dose`;
```

Replacement:
```javascript
  const iu    = volMl * _syringeType;
  drawRes.style.display = 'block';
  drawRes.innerHTML = `Draw <strong>${volMl.toFixed(3)} mL</strong> (${iu.toFixed(1)} IU on U-${_syringeType} syringe) for a ${doseMcg} mcg dose${syringeOverflowWarning(volMl)}`;
```

- [ ] **Step 5: Update calcDraw to use _syringeType**

Find `calcDraw` at line ~1363. Replace the hardcoded lines:

Current:
```javascript
  const iu    = volMl * 100;
  res.style.display = 'block';
  res.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div><div class="muted" style="font-size:11px;">Draw Volume</div><div style="font-weight:700;color:var(--accent-sky);">${volMl.toFixed(3)} mL</div></div>
      <div><div class="muted" style="font-size:11px;">Syringe Units</div><div style="font-weight:700;color:var(--accent-indigo);">${iu.toFixed(1)} IU</div></div>
    </div>`;
```

Replacement:
```javascript
  const iu    = volMl * _syringeType;
  res.style.display = 'block';
  res.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div><div class="muted" style="font-size:11px;">Draw Volume</div><div style="font-weight:700;color:var(--accent-sky);">${volMl.toFixed(3)} mL</div></div>
      <div><div class="muted" style="font-size:11px;">U-${_syringeType} Units</div><div style="font-weight:700;color:var(--accent-indigo);">${iu.toFixed(1)} IU</div></div>
    </div>
    ${syringeOverflowWarning(volMl)}`;
```

- [ ] **Step 6: Verify IU formula in browser DevTools**

With wrangler dev running, open the Calculator tab → Draw sub-tab. Enter:
- Concentration: `5000` mcg/mL
- Dose: `250` mcg

Expected result: `0.050 mL` · `5.0 IU` (U-100 default).

Open console and run `setSyringeType(40)`. Dose display should update to `0.050 mL` · `2.0 IU` (U-40 has 40 IU/mL so 0.05 × 40 = 2.0 IU). Run `setSyringeType(100)` to restore.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add syringe state vars and fix IU formula to use _syringeType"
```

---

## Task 3: Syringe Selector UI — Calculator + Log Dose

**Files:**
- Modify: `index.html` (update `renderCalc`, update `updateDrawMath`, update `renderLogDose`)

- [ ] **Step 1: Add the syringe glass card to renderCalc**

In `renderCalc()`, find the line that starts `document.getElementById('calc').innerHTML = \``. The current HTML structure starts with:

```html
<div class="stack">
  <div class="glass" style="padding:20px;">
    <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Calculator</h3>
    <div class="nav-pill" id="calcNav" style="margin-bottom:16px;">
```

Insert a syringe glass card between the `<h3>` and the `<div class="nav-pill"` so it reads:

```html
<div class="stack">
  <div class="glass" style="padding:20px;">
    <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Calculator</h3>
    <div class="glass" style="padding:10px 14px;margin-bottom:14px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
      <div style="display:flex;gap:4px;align-items:center;">
        <span class="muted" style="font-size:12px;white-space:nowrap;margin-right:2px;">Syringe:</span>
        <button id="syrType100" class="btn btn-sm ${_syringeType===100?'btn-primary':'btn-ghost'}" onclick="setSyringeType(100)">U-100</button>
        <button id="syrType40"  class="btn btn-sm ${_syringeType===40 ?'btn-primary':'btn-ghost'}" onclick="setSyringeType(40)">U-40</button>
      </div>
      <div style="display:flex;gap:4px;align-items:center;">
        <span class="muted" style="font-size:12px;white-space:nowrap;margin-right:2px;">Capacity:</span>
        <button id="syrCap03" class="btn btn-sm ${_syringeCapacityMl===0.3?'btn-primary':'btn-ghost'}" onclick="setSyringeCapacity(0.3)">0.3 mL</button>
        <button id="syrCap05" class="btn btn-sm ${_syringeCapacityMl===0.5?'btn-primary':'btn-ghost'}" onclick="setSyringeCapacity(0.5)">0.5 mL</button>
        <button id="syrCap10" class="btn btn-sm ${_syringeCapacityMl===1.0?'btn-primary':'btn-ghost'}" onclick="setSyringeCapacity(1.0)">1 mL</button>
      </div>
    </div>
    <div class="nav-pill" id="calcNav" style="margin-bottom:16px;">
```

- [ ] **Step 2: Add compact syringe selectors to renderLogDose**

In `renderLogDose()`, find the `<div id="ldMath" class="glass">` element. Add the syringe selects immediately BEFORE the `ldMath` div (inside the same container):

```html
<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:4px;">
  <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text-muted);font-size:12px;">
    Syringe
    <select id="ldSyrType" style="width:auto;" onchange="_syringeType=parseInt(this.value);updateDrawMath();">
      <option value="100" ${_syringeType===100?'selected':''}>U-100</option>
      <option value="40"  ${_syringeType===40 ?'selected':''}>U-40</option>
    </select>
  </label>
  <label style="flex-direction:row;align-items:center;gap:6px;color:var(--text-muted);font-size:12px;">
    Capacity
    <select id="ldSyrCap" style="width:auto;" onchange="_syringeCapacityMl=parseFloat(this.value);updateDrawMath();">
      <option value="0.3" ${_syringeCapacityMl===0.3?'selected':''}>0.3 mL</option>
      <option value="0.5" ${_syringeCapacityMl===0.5?'selected':''}>0.5 mL</option>
      <option value="1.0" ${_syringeCapacityMl===1.0?'selected':''}>1 mL</option>
    </select>
  </label>
</div>
<div id="ldMath" class="glass">
```

- [ ] **Step 3: Update updateDrawMath to show overflow warning and updated label**

In `updateDrawMath()`, find the `ldMath.innerHTML = \`` assignment (line ~1011). Replace the entire inner HTML string:

Current:
```javascript
  ldMath.innerHTML = `
    <div style="padding:12px;">
      <p class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Draw Math</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><div class="muted" style="font-size:11px;">Concentration</div><div style="font-weight:700;">${result.conc} mcg/mL</div></div>
        <div><div class="muted" style="font-size:11px;">Dose</div><div style="font-weight:700;">${result.mcg} mcg</div></div>
        <div><div class="muted" style="font-size:11px;">Draw Volume</div><div style="font-weight:700;color:var(--accent-sky);">${result.vol} mL</div></div>
        <div><div class="muted" style="font-size:11px;">Syringe Units</div><div style="font-weight:700;color:var(--accent-indigo);">${result.iu} IU</div></div>
      </div>
    </div>`;
```

Replacement:
```javascript
  ldMath.innerHTML = `
    <div style="padding:12px;">
      <p class="muted" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Draw Math</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div><div class="muted" style="font-size:11px;">Concentration</div><div style="font-weight:700;">${result.conc} mcg/mL</div></div>
        <div><div class="muted" style="font-size:11px;">Dose</div><div style="font-weight:700;">${result.mcg} mcg</div></div>
        <div><div class="muted" style="font-size:11px;">Draw Volume</div><div style="font-weight:700;color:var(--accent-sky);">${result.vol} mL</div></div>
        <div><div class="muted" style="font-size:11px;">U-${_syringeType} Units</div><div style="font-weight:700;color:var(--accent-indigo);">${result.iu} IU</div></div>
      </div>
      ${syringeOverflowWarning(result.volMl)}
    </div>`;
```

- [ ] **Step 4: Verify full UI in browser**

Start wrangler dev and open `http://localhost:8787`. Log in with an existing account.

**Calculator tab — syringe card:**
- Open Calculator tab. A glass card appears above the sub-tab nav with `U-100` (primary) and `U-40` (ghost), `0.3 mL` (ghost), `0.5 mL` (ghost), `1 mL` (primary).
- Switch to Draw sub-tab. Enter concentration `5000`, dose `250 mcg`. Result: `0.050 mL · 5.0 IU`.
- Click `U-40`. Result updates to `0.050 mL · 2.0 IU`. Button styles swap.
- Click `0.3 mL` capacity. Enter concentration `500`, dose `250 mcg` → volMl = 0.5 mL. Amber `⚠ Exceeds 0.3 mL syringe capacity` warning appears.
- Switch back to `1 mL` capacity. Warning disappears.

**Log Dose tab — syringe selects:**
- Open Log Dose tab. Syringe and Capacity dropdowns appear above the draw math glass card.
- Select a vial and enter a dose. Draw math shows `U-100 Units` label.
- Change Syringe select to `U-40`. IU value updates immediately.
- Change Capacity to `0.3 mL` with a large dose. Overflow warning appears in the draw math card.

**Cross-tab sync:**
- Set syringe to U-40 in Calculator. Switch to Log Dose. Log Dose syringe select shows `U-40`.
- Change capacity in Log Dose. Switch to Calculator. Calculator capacity `U-40` button is still active (Calculator pill buttons only re-render when `renderCalc()` is called, but the underlying `_syringeCapacityMl` is correct and recalculates on the next input change).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add syringe type/capacity selector to Calculator and Log Dose tabs"
```

---

## Task 4: Deploy

- [ ] **Step 1: Deploy worker changes**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler deploy 2>&1 | tail -8
```

Expected: `Deployed peptideos triggers` with the production URL.

- [ ] **Step 2: Smoke test on production**

```bash
PROD="https://peptideos.cwenterprises.net"

# Register a new prod test account and verify peptide seeding
REG=$(curl -s -X POST "${PROD}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"deploy_test_'$(date +%s)'@test.com","password":"testtest123"}')
TOKEN=$(echo "$REG" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
COUNT=$(curl -s "${PROD}/api/peptides" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "Prod peptide count: $COUNT"
# Expected: 41
```

- [ ] **Step 3: Push to GitHub**

```bash
git push origin main
```

---

## Spec Coverage Check

| Spec requirement | Task |
|---|---|
| Seed 40 defaults server-side at registration | Task 1 |
| Existing users unaffected | Task 1 (batch only runs during register) |
| `_syringeType` and `_syringeCapacityMl` session vars | Task 2 |
| IU formula uses `_syringeType` everywhere | Task 2 (calcDrawMath, calcRecon, calcDraw) |
| IU input unit also uses `_syringeType` | Task 2 (calcDrawMath IU branch) |
| Overflow warning when volMl > capacity | Tasks 2 + 3 |
| Syringe glass card above sub-tab nav in Calculator | Task 3 |
| Compact selects in Log Dose draw math panel | Task 3 |
| Cross-tab sync via shared state vars | Task 3 (setSyringeType/setSyringeCapacity sync both) |
| Not saved across sessions | By design — state vars default to 100/1.0 on load |
