# Vendors & Price List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Vendors and Prices tabs to PeptideOS — track peptide suppliers with ratings, compare $/mg in a matrix table, and import price data from any file using Claude AI.

**Architecture:** Three sequential layers: D1 schema migration → Worker API endpoints → Frontend tabs. The frontend extends the existing `App.loadAll()` + `renderAllTabs()` pattern already used by all other tabs. The AI import endpoint calls Claude's API from the Worker using `ANTHROPIC_API_KEY` secret.

**Tech Stack:** Cloudflare D1, Cloudflare Workers, Claude API (claude-haiku-4-5-20251001), vanilla JS, existing PeptideOS glass design system

---

## File Map

| File | Status | Change |
|------|--------|--------|
| `migrations/0003_vendors_prices.sql` | Create | vendors + prices tables, indexes |
| `worker/index.js` | Modify | 7 new routes + 7 handler functions |
| `index.html` | Modify | loadAll extension, 2 nav tabs, 2 tab divs, 11 new functions |

---

## Task 1: D1 Migration — vendors + prices tables

**Files:**
- Create: `migrations/0003_vendors_prices.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- migrations/0003_vendors_prices.sql
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

- [ ] **Step 2: Run migration locally**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler d1 execute peptideos_db --local --file=migrations/0003_vendors_prices.sql
```

Expected: `Successfully executed SQL file`

- [ ] **Step 3: Commit**

```bash
git add migrations/0003_vendors_prices.sql
git commit -m "feat: add vendors and prices D1 tables"
```

---

## Task 2: Worker — Vendor & Price CRUD Endpoints

**Files:**
- Modify: `worker/index.js` (add routes to `handleAPI` at line 148, add 6 handler functions at end of file)

- [ ] **Step 1: Add routes to the router in handleAPI**

In `handleAPI`, add these lines immediately before `return err('Not found', 404, origin);` (line 148):

```javascript
  // Vendors
  if (path === '/vendors' && method === 'GET')  return vendorsList(request, env, origin);
  if (path === '/vendors' && method === 'POST') return vendorsAdd(request, env, origin);
  if (path.match(/^\/vendors\/[^/]+$/) && method === 'PUT')    return vendorsUpdate(request, env, origin, path);
  if (path.match(/^\/vendors\/[^/]+$/) && method === 'DELETE') return vendorsDelete(request, env, origin, path);

  // Prices
  if (path === '/prices' && method === 'GET')  return pricesList(request, env, origin);
  if (path === '/prices' && method === 'POST') return pricesUpsert(request, env, origin);
  if (path.match(/^\/prices\/[^/]+$/) && method === 'DELETE') return pricesDelete(request, env, origin, path);
```

- [ ] **Step 2: Add vendor handler functions**

Add to the end of `worker/index.js` (before the `handleCron` function):

```javascript
async function vendorsList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM vendors WHERE user_id = ? ORDER BY name'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function vendorsAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.name?.trim()) return err('name required', 400, origin);
  const rating = Number(b.rating) || 3;
  if (rating < 1 || rating > 5) return err('rating must be 1–5', 400, origin);
  const trust = ['verified','unverified','caution'].includes(b.trust) ? b.trust : 'unverified';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vendors (id, user_id, name, url, rating, trust, notes, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(id, userId, b.name.trim(), b.url || null, rating, trust, b.notes || null, now).run();
  return json({ id, name: b.name.trim(), url: b.url || null, rating, trust, notes: b.notes || null, created_at: now }, 201, origin);
}

async function vendorsUpdate(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  const existing = await env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!existing) return err('not found', 404, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.name?.trim()) return err('name required', 400, origin);
  const rating = Number(b.rating) || 3;
  if (rating < 1 || rating > 5) return err('rating must be 1–5', 400, origin);
  const trust = ['verified','unverified','caution'].includes(b.trust) ? b.trust : 'unverified';
  await env.DB.prepare(
    'UPDATE vendors SET name=?, url=?, rating=?, trust=?, notes=? WHERE id=? AND user_id=?'
  ).bind(b.name.trim(), b.url || null, rating, trust, b.notes || null, id, userId).run();
  return json({ ok: true }, 200, origin);
}

async function vendorsDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM vendors WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}
```

- [ ] **Step 3: Add price handler functions**

```javascript
async function pricesList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM prices WHERE user_id = ? ORDER BY peptide, price_per_mg'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function pricesUpsert(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.vendor_id || !b.peptide?.trim() || !b.price_per_mg) return err('vendor_id, peptide, price_per_mg required', 400, origin);
  const price = Number(b.price_per_mg);
  if (!Number.isFinite(price) || price <= 0) return err('price_per_mg must be a positive number', 400, origin);
  // Verify vendor belongs to this user
  const vendor = await env.DB.prepare('SELECT id FROM vendors WHERE id = ? AND user_id = ?').bind(b.vendor_id, userId).first();
  if (!vendor) return err('vendor not found', 404, origin);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO prices (id, user_id, vendor_id, peptide, price_per_mg, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, vendor_id, peptide) DO UPDATE SET price_per_mg=excluded.price_per_mg, updated_at=excluded.updated_at`
  ).bind(id, userId, b.vendor_id, b.peptide.trim(), price, now).run();
  return json({ ok: true }, 201, origin);
}

async function pricesDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM prices WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}
```

- [ ] **Step 4: Verify all endpoints with curl**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler dev --local > /tmp/wdev_vp.log 2>&1 &
WPID=$!
sleep 7

# Get auth token
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"newpassword123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:8}..."

# Add vendor
VID=$(curl -s -X POST http://localhost:8787/api/vendors \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"PepTrek","url":"https://peptrek.com","rating":4,"trust":"verified","notes":"Fast shipping"}' \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Vendor ID: ${VID:0:8}..."

# List vendors
curl -s http://localhost:8787/api/vendors -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Vendors:', len(d))"
# Expected: Vendors: 1

# Add price
curl -s -X POST http://localhost:8787/api/prices \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"vendor_id\":\"$VID\",\"peptide\":\"BPC-157\",\"price_per_mg\":2.50}" | grep -o '"ok":true'
# Expected: "ok":true

# List prices
curl -s http://localhost:8787/api/prices -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Prices:', len(d))"
# Expected: Prices: 1

# Delete vendor (should cascade-delete prices)
curl -s -X DELETE "http://localhost:8787/api/vendors/$VID" -H "Authorization: Bearer $TOKEN" | grep -o '"ok":true'
curl -s http://localhost:8787/api/prices -H "Authorization: Bearer $TOKEN" | python3 -c "import sys,json; d=json.load(sys.stdin); print('Prices after vendor delete:', len(d))"
# Expected: Prices after vendor delete: 0

kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add worker/index.js
git commit -m "feat: add vendor and price CRUD endpoints to worker"
```

---

## Task 3: Worker — AI Price Import Endpoint

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Store ANTHROPIC_API_KEY secret**

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# Paste your Anthropic API key when prompted
```

Add to `.dev.vars` for local testing:
```bash
echo "ANTHROPIC_API_KEY=your-key-here" >> /Users/coreywashington/Documents/GitHub/Peptide-mini/.dev.vars
```

- [ ] **Step 2: Add the parse-price-file route to handleAPI**

Add immediately before `return err('Not found', 404, origin);`:

```javascript
  if (path === '/parse-price-file' && method === 'POST') return parsePriceFile(request, env, origin);
```

- [ ] **Step 3: Add parsePriceFile handler**

Add to `worker/index.js` after the `pricesDelete` function:

```javascript
async function parsePriceFile(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);

  if (!env.ANTHROPIC_API_KEY) return err('AI parsing not configured', 503, origin);

  let fileBase64, mediaType;
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData().catch(() => null);
    if (!formData) return err('invalid form data', 400, origin);
    const file = formData.get('file');
    if (!file) return err('file field required', 400, origin);
    const bytes = await file.arrayBuffer();
    fileBase64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    mediaType = file.type || 'application/octet-stream';
  } else {
    return err('Content-Type must be multipart/form-data', 400, origin);
  }

  // Normalize media type for Claude vision
  const visionTypes = ['image/jpeg','image/png','image/gif','image/webp','application/pdf'];
  const isVision = visionTypes.includes(mediaType);

  const prompt = `Extract peptide vendor pricing data from this document.
Return ONLY a JSON object with this exact shape:
{"vendors":[{"name":"string","url":"string or null"}],"prices":[{"vendor_name":"string","peptide":"string","price_per_mg":number}]}
For price_per_mg: if you see price per vial, divide by vial mg to get price per mg.
If you cannot determine price per mg, omit that price entry.
Normalize peptide names to title case. Return valid JSON only, no explanation.`;

  const messageContent = isVision
    ? [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }, { type: 'text', text: prompt }]
    : [{ type: 'text', text: `${prompt}\n\nFile content (base64):\n${fileBase64}` }];

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: messageContent }]
    })
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    console.error('Claude API error:', claudeRes.status, errText);
    return err('AI parsing failed', 422, origin);
  }

  const claudeData = await claudeRes.json().catch(() => null);
  const rawText = claudeData?.content?.[0]?.text || '';

  // Extract JSON from response (Claude may wrap it in markdown)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return err('Could not parse file', 422, origin);

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return err('Could not parse file', 422, origin);
  }

  const vendors = Array.isArray(parsed.vendors) ? parsed.vendors : [];
  const prices  = Array.isArray(parsed.prices)  ? parsed.prices  : [];

  return json({ vendors, prices }, 200, origin);
}
```

- [ ] **Step 4: Verify the endpoint starts without errors**

```bash
npx wrangler dev --local > /tmp/wdev_ai.log 2>&1 &
WPID=$!
sleep 7
grep -i "error\|syntax" /tmp/wdev_ai.log | head -5 || echo "No errors"
# Expected: "No errors"
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add worker/index.js .dev.vars
git commit -m "feat: add AI price file import endpoint using Claude haiku"
```

---

## Task 4: Frontend — Extend loadAll + Add Nav Tabs + Tab Divs

**Files:**
- Modify: `index.html`

This task does the plumbing — extending data loading and adding the tab infrastructure — before implementing the tab content.

- [ ] **Step 1: Extend App.loadAll() to fetch vendors and prices**

Find the `loadAll` function (around line 426). It currently fetches 5 resources. Update `_data` initialization (line 393) and the `loadAll` function:

Find:
```javascript
  let _data  = { peptides: [], planner: [], vials: [], logs: [], settings: {} };
```
Replace with:
```javascript
  let _data  = { peptides: [], planner: [], vials: [], logs: [], settings: {}, vendors: [], prices: [] };
```

Find the `logout` function's reset line:
```javascript
    _data = { peptides: [], planner: [], vials: [], logs: [], settings: {} };
```
Replace with:
```javascript
    _data = { peptides: [], planner: [], vials: [], logs: [], settings: {}, vendors: [], prices: [] };
```

Find the `loadAll` function body and replace:
```javascript
  async function loadAll() {
    const [peptides, planner, vials, logs, settings] = await Promise.all([
      API.get('/peptides'),
      API.get('/planner'),
      API.get('/vials'),
      API.get('/logs'),
      API.get('/settings')
    ]);
    _data = { peptides, planner, vials, logs, settings };
    applyTheme(settings.theme || 'system');
    return _data;
  }
```
With:
```javascript
  async function loadAll() {
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
    applyTheme(settings.theme || 'system');
    return _data;
  }
```

- [ ] **Step 2: Add Vendors and Prices nav tabs and tab divs**

In the HTML body, find the nav pill and tab divs. Currently:
```html
        <button class="nav-tab" data-tab="vials">Vials</button>
        <button class="nav-tab" data-tab="calc">Calculator</button>
```
Replace with:
```html
        <button class="nav-tab" data-tab="vials">Vials</button>
        <button class="nav-tab" data-tab="vendors">Vendors</button>
        <button class="nav-tab" data-tab="prices">Prices</button>
        <button class="nav-tab" data-tab="calc">Calculator</button>
```

Find the tab content divs. Currently:
```html
      <div id="vials"    class="tab-content"></div>
      <div id="calc"     class="tab-content"></div>
```
Replace with:
```html
      <div id="vials"    class="tab-content"></div>
      <div id="vendors"  class="tab-content"></div>
      <div id="prices"   class="tab-content"></div>
      <div id="calc"     class="tab-content"></div>
```

- [ ] **Step 3: Add renderVendors and renderPrices placeholders to renderAllTabs**

Find `renderAllTabs()`:
```javascript
function renderAllTabs() {
  renderToday();
  renderWeek();
  renderLogDose();
  renderVials();
  renderCalc();
  renderLibrary();
  renderSettings();
}
```
Replace with:
```javascript
function renderAllTabs() {
  renderToday();
  renderWeek();
  renderLogDose();
  renderVials();
  renderVendors();
  renderPrices();
  renderCalc();
  renderLibrary();
  renderSettings();
}
```

Add placeholder functions after `renderSettings`:
```javascript
function renderVendors() { document.getElementById('vendors').innerHTML = '<p class="muted" style="padding:20px;">Vendors loading...</p>'; }
function renderPrices()  { document.getElementById('prices').innerHTML  = '<p class="muted" style="padding:20px;">Prices loading...</p>'; }
```

- [ ] **Step 4: Verify tabs appear and switch correctly**

```bash
npx wrangler dev --local > /tmp/wdev_tabs.log 2>&1 &
WPID=$!
sleep 7
curl -s http://localhost:8787/ | grep -c "data-tab" 
# Expected: 9 (9 nav tab buttons)
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add vendors/prices to loadAll, nav tabs, and renderAllTabs"
```

---

## Task 5: Frontend — Vendors Tab

**Files:**
- Modify: `index.html` (replace `renderVendors` placeholder with full implementation)

- [ ] **Step 1: Replace renderVendors placeholder with full implementation**

Replace the placeholder `function renderVendors()` with:

```javascript
let _vendorFormId = null; // null = adding new, string = editing existing

function renderVendors() {
  const { vendors } = App.getData();

  const cards = vendors.length ? vendors.map(v => {
    const stars = '★'.repeat(v.rating) + '☆'.repeat(5 - v.rating);
    const trustClass = { verified: 'badge-done', unverified: 'badge-info', caution: 'badge-pending' }[v.trust] || 'badge-info';
    const trustLabel = { verified: 'Verified', unverified: 'Unverified', caution: 'Caution' }[v.trust] || 'Unverified';
    return `
      <div class="glass" style="padding:16px;" id="vcard-${escHtml(v.id)}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="min-width:0;">
            <div style="font-weight:700;font-size:15px;">${escHtml(v.name)}</div>
            ${v.url ? `<div style="font-size:12px;margin-top:2px;"><a href="${escHtml(v.url)}" target="_blank" rel="noopener" style="color:var(--accent-sky);">${escHtml(v.url)}</a></div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn btn-ghost btn-sm" onclick="startEditVendor('${escHtml(v.id)}')">✎</button>
            <button class="btn btn-danger btn-sm" onclick="deleteVendorConfirm('${escHtml(v.id)}')">×</button>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;">
          <span style="color:var(--accent-amber);letter-spacing:2px;">${stars}</span>
          <span class="badge ${trustClass}">${trustLabel}</span>
        </div>
        ${v.notes ? `<div class="muted" style="margin-top:8px;font-size:12px;">${escHtml(v.notes)}</div>` : ''}
        <div id="vdelete-${escHtml(v.id)}" style="display:none;margin-top:10px;">
          <span class="muted" style="font-size:13px;">Delete <strong>${escHtml(v.name)}</strong> and all their prices?</span>
          <div style="display:flex;gap:8px;margin-top:6px;">
            <button class="btn btn-danger btn-sm" onclick="deleteVendor('${escHtml(v.id)}')">Confirm</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('vdelete-${escHtml(v.id)}').style.display='none'">Cancel</button>
          </div>
        </div>
      </div>`;
  }).join('') : `<div class="glass" style="padding:24px;text-align:center;"><div style="font-size:32px;">🏪</div><p style="margin-top:8px;font-weight:600;">No vendors yet</p><p class="muted" style="margin-top:4px;">Add your first vendor below.</p></div>`;

  document.getElementById('vendors').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:18px;" id="vendorFormWrap">
        ${_vendorFormId !== undefined ? vendorFormHTML(_vendorFormId) : vendorFormHTML(null)}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">${cards}</div>
    </div>`;
}

function vendorFormHTML(editId) {
  const { vendors } = App.getData();
  const v = editId ? vendors.find(x => x.id === editId) : null;
  const title = v ? `Edit: ${escHtml(v.name)}` : 'Add Vendor';
  const ratingBtns = [1,2,3,4,5].map(n =>
    `<button type="button" class="btn btn-sm ${(v?.rating||3)===n?'btn-primary':'btn-ghost'}" onclick="document.getElementById('vRating').value=${n};this.closest('.rating-row').querySelectorAll('button').forEach((b,i)=>b.className='btn btn-sm '+(i+1===${n}?'btn-primary':'btn-ghost'))">${'★'.repeat(n)}</button>`
  ).join('');
  return `
    <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">${title}</h3>
    <div class="stack" style="gap:10px;">
      <div class="row2">
        <label>Name <input id="vName" type="text" value="${escHtml(v?.name||'')}" placeholder="e.g. PepTrek" /></label>
        <label>URL <input id="vUrl" type="url" value="${escHtml(v?.url||'')}" placeholder="https://..." /></label>
      </div>
      <div class="row2">
        <label>Rating
          <div class="rating-row" style="display:flex;gap:4px;margin-top:4px;">
            ${ratingBtns}
            <input type="hidden" id="vRating" value="${v?.rating||3}" />
          </div>
        </label>
        <label>Trust
          <select id="vTrust">
            <option value="verified"   ${v?.trust==='verified'  ?'selected':''}>✓ Verified</option>
            <option value="unverified" ${!v||v.trust==='unverified'?'selected':''}>? Unverified</option>
            <option value="caution"    ${v?.trust==='caution'   ?'selected':''}>⚠ Caution</option>
          </select>
        </label>
      </div>
      <label>Notes <input id="vNotes" type="text" value="${escHtml(v?.notes||'')}" placeholder="optional notes" /></label>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" onclick="saveVendor(${v?`'${escHtml(v.id)}'`:'null'})">
          ${v ? 'Save Changes' : '+ Add Vendor'}
        </button>
        ${v ? `<button class="btn btn-ghost btn-sm" onclick="_vendorFormId=null;renderVendors()">Cancel</button>` : ''}
      </div>
    </div>`;
}

function startEditVendor(id) {
  _vendorFormId = id;
  renderVendors();
  document.getElementById('vendorFormWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveVendor(editId) {
  const name  = document.getElementById('vName')?.value?.trim();
  const url   = document.getElementById('vUrl')?.value?.trim() || null;
  const rating = Number(document.getElementById('vRating')?.value) || 3;
  const trust = document.getElementById('vTrust')?.value || 'unverified';
  const notes = document.getElementById('vNotes')?.value?.trim() || null;
  if (!name) { alert('Vendor name is required.'); return; }
  try {
    if (editId) {
      await API.put(`/vendors/${editId}`, { name, url, rating, trust, notes });
    } else {
      await API.post('/vendors', { name, url, rating, trust, notes });
    }
    _vendorFormId = null;
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('vendors');
  } catch (e) { alert('Failed: ' + e.message); }
}

function deleteVendorConfirm(id) {
  document.getElementById(`vdelete-${id}`)?.style && (document.getElementById(`vdelete-${id}`).style.display = 'block');
}

async function deleteVendor(id) {
  try {
    await API.delete(`/vendors/${id}`);
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('vendors');
  } catch (e) { alert('Failed: ' + e.message); }
}
```

- [ ] **Step 2: Verify vendors tab renders and CRUD works**

Open `http://localhost:8787`, log in, switch to Vendors tab:
- "Add Vendor" form shows at top
- Fill in name "TestVendor", rating 4, trust Verified → click "+ Add Vendor"
- Card appears in grid with ★★★★☆, Verified badge
- Click ✎ → form re-renders with pre-filled values → change name → Save Changes → card updates
- Click × → inline confirm row appears → Confirm → card disappears

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add Vendors tab with CRUD card grid"
```

---

## Task 6: Frontend — Prices Tab + AI Import

**Files:**
- Modify: `index.html` (replace `renderPrices` placeholder with full implementation)

- [ ] **Step 1: Replace renderPrices placeholder with full implementation**

Replace the placeholder `function renderPrices()` with:

```javascript
let _parsedImport = null; // holds AI-parsed preview data

function renderPrices() {
  const { vendors, prices, peptides } = App.getData();

  // Build comparison matrix
  const allVendors = vendors; // only vendors with prices will appear as columns
  const priceVendorIds = [...new Set(prices.map(p => p.vendor_id))];
  const activeCols = allVendors.filter(v => priceVendorIds.includes(v.id));
  const rowPeptides = [...new Set(prices.map(p => p.peptide))].sort();

  // Map: peptide → {vendor_id → {id, price_per_mg}}
  const matrix = {};
  prices.forEach(p => {
    if (!matrix[p.peptide]) matrix[p.peptide] = {};
    matrix[p.peptide][p.vendor_id] = { id: p.id, price: p.price_per_mg };
  });

  const peptideOpts = peptides.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');
  const vendorOpts  = vendors.map(v => `<option value="${escHtml(v.id)}">${escHtml(v.name)}</option>`).join('');

  // Comparison table
  let tableHTML = '';
  if (rowPeptides.length && activeCols.length) {
    const headerCols = activeCols.map(v => `<th style="white-space:nowrap;">${escHtml(v.name)}</th>`).join('');
    const rows = rowPeptides.map(peptide => {
      const rowPrices = matrix[peptide] || {};
      const values = activeCols.map(v => rowPrices[v.id]?.price).filter(x => x != null);
      const best = values.length ? Math.min(...values) : null;
      const cells = activeCols.map(v => {
        const entry = rowPrices[v.id];
        if (!entry) return `<td style="color:var(--text-muted);">—</td>`;
        const isBest = entry.price === best;
        return `<td>
          <span id="pcell-${escHtml(entry.id)}" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="${isBest?'badge badge-done':''}" style="cursor:pointer;" onclick="editPriceCell('${escHtml(entry.id)}',${entry.price})">
              $${entry.price.toFixed(2)}/mg
            </span>
            <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:11px;" onclick="deletePrice('${escHtml(entry.id)}')">×</button>
            <button class="btn btn-ghost btn-sm" style="padding:1px 5px;font-size:11px;" onclick="priceToCalc('${escHtml(peptide)}',${entry.price})">→ Calc</button>
          </span>
        </td>`;
      }).join('');
      return `<tr><td style="font-weight:600;white-space:nowrap;">${escHtml(peptide)}</td>${cells}</tr>`;
    }).join('');
    tableHTML = `
      <div style="overflow-x:auto;">
        <table>
          <thead><tr><th>Peptide</th>${headerCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } else if (!vendors.length) {
    tableHTML = `<div style="text-align:center;padding:20px;"><p class="muted">Add vendors first before tracking prices.</p><button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="Tabs.switchTo('vendors')">Go to Vendors →</button></div>`;
  } else {
    tableHTML = `<div style="text-align:center;padding:20px;"><div style="font-size:32px;">💰</div><p style="margin-top:8px;font-weight:600;">No prices yet</p><p class="muted" style="margin-top:4px;">Add your first entry above.</p></div>`;
  }

  // Import preview
  const importPreview = _parsedImport ? buildImportPreview(_parsedImport) : '';

  document.getElementById('prices').innerHTML = `
    <div class="stack">
      ${vendors.length ? `
      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Add Price</h3>
        <div class="row3">
          <label>Peptide<select id="pPeptide">${peptideOpts}</select></label>
          <label>Vendor<select id="pVendor"><option value="">Select...</option>${vendorOpts}</select></label>
          <label>Price per mg ($)<input id="pPrice" type="number" step="0.01" min="0" placeholder="e.g. 2.50" /></label>
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:12px;" onclick="savePriceEntry()">+ Add Price</button>
      </div>` : ''}

      <div class="glass" style="padding:18px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;flex-wrap:wrap;gap:8px;">
          <h3 style="font-size:15px;font-weight:700;">Price Comparison</h3>
        </div>
        ${tableHTML}
      </div>

      <details class="glass" style="padding:18px;">
        <summary style="font-weight:700;font-size:15px;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;">
          Import from file (AI)
          <span class="muted" style="font-size:12px;">▸</span>
        </summary>
        <div class="stack" style="gap:12px;margin-top:14px;">
          <p class="muted">Upload any file — screenshot, PDF, CSV, price list. Claude will extract vendor names and prices.</p>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <input id="priceFile" type="file" accept="*/*" style="flex:1;min-width:0;" />
            <button class="btn btn-primary btn-sm" onclick="parsePriceFile()">Parse with AI</button>
          </div>
          <div id="parseStatus" class="muted" style="font-size:13px;"></div>
          ${importPreview}
        </div>
      </details>
    </div>`;
}

function buildImportPreview(parsed) {
  if (!parsed.prices?.length && !parsed.vendors?.length) {
    return `<div class="muted">No prices found in the file. Try a different file.</div>`;
  }
  const rows = parsed.prices.map((p, i) =>
    `<tr>
      <td><input type="checkbox" id="imp-${i}" checked style="width:auto;"></td>
      <td>${escHtml(p.vendor_name)}</td>
      <td>${escHtml(p.peptide)}</td>
      <td><input type="number" id="imp-price-${i}" value="${p.price_per_mg}" step="0.01" min="0" style="width:90px;"></td>
    </tr>`
  ).join('');
  return `
    <div style="overflow-x:auto;">
      <table>
        <thead><tr><th style="width:30px;"></th><th>Vendor</th><th>Peptide</th><th>$/mg</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="btn btn-primary btn-sm" onclick="confirmParsedPrices()">Save Selected</button>
      <button class="btn btn-ghost btn-sm" onclick="_parsedImport=null;renderPrices()">Cancel</button>
    </div>`;
}

async function savePriceEntry() {
  const peptide   = document.getElementById('pPeptide')?.value;
  const vendor_id = document.getElementById('pVendor')?.value;
  const price_per_mg = Number(document.getElementById('pPrice')?.value);
  if (!vendor_id) { alert('Select a vendor.'); return; }
  if (!peptide)   { alert('Select a peptide.'); return; }
  if (!price_per_mg || price_per_mg <= 0) { alert('Enter a price > 0.'); return; }
  try {
    await API.post('/prices', { vendor_id, peptide, price_per_mg });
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('prices');
  } catch (e) { alert('Failed: ' + e.message); }
}

function editPriceCell(id, currentVal) {
  const cell = document.getElementById(`pcell-${id}`);
  if (!cell) return;
  cell.innerHTML = `
    <input type="number" id="pedit-${id}" value="${currentVal}" step="0.01" min="0" style="width:80px;">
    <button class="btn btn-primary btn-sm" onclick="savePriceCellEdit('${id}')">✓</button>
    <button class="btn btn-ghost btn-sm" onclick="renderPrices()">✕</button>`;
}

async function savePriceCellEdit(id) {
  const val = Number(document.getElementById(`pedit-${id}`)?.value);
  if (!val || val <= 0) { alert('Price must be > 0'); return; }
  // Find the price entry to get vendor_id and peptide for upsert
  const price = App.getData().prices.find(p => p.id === id);
  if (!price) return;
  try {
    await API.post('/prices', { vendor_id: price.vendor_id, peptide: price.peptide, price_per_mg: val });
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('prices');
  } catch (e) { alert('Failed: ' + e.message); }
}

async function deletePrice(id) {
  try {
    await API.delete(`/prices/${id}`);
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('prices');
  } catch (e) { alert('Failed: ' + e.message); }
}

function priceToCalc(peptide, price) {
  _calcSubTab = 'cost';
  Tabs.switchTo('calc');
  renderCalc();
  setTimeout(() => {
    const priceField = document.getElementById('cPrice');
    if (priceField) { priceField.value = price; calcCost(); }
  }, 50);
}

async function parsePriceFile() {
  const fileInput = document.getElementById('priceFile');
  const statusEl  = document.getElementById('parseStatus');
  if (!fileInput?.files?.length) { alert('Select a file first.'); return; }
  if (statusEl) statusEl.textContent = '⏳ Parsing with AI...';
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  try {
    const token = API.getToken();
    const res = await fetch('/api/parse-price-file', {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Parse failed');
    _parsedImport = data;
    if (statusEl) statusEl.textContent = `Found ${data.prices?.length || 0} price entries from ${data.vendors?.length || 0} vendors.`;
    renderPrices();
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ ' + e.message;
  }
}

async function confirmParsedPrices() {
  if (!_parsedImport) return;
  const { vendors: existingVendors } = App.getData();
  const token = API.getToken();

  // Collect checked rows
  const rows = [];
  (_parsedImport.prices || []).forEach((p, i) => {
    const cb = document.getElementById(`imp-${i}`);
    const priceInput = document.getElementById(`imp-price-${i}`);
    if (cb?.checked) {
      rows.push({ vendor_name: p.vendor_name, peptide: p.peptide, price_per_mg: Number(priceInput?.value || p.price_per_mg) });
    }
  });
  if (!rows.length) { alert('No rows selected.'); return; }

  // Create any new vendors (case-insensitive match against existing)
  const vendorMap = {}; // name (lower) → id
  existingVendors.forEach(v => { vendorMap[v.name.toLowerCase()] = v.id; });

  for (const parsed of (_parsedImport.vendors || [])) {
    const key = parsed.name.toLowerCase();
    if (!vendorMap[key]) {
      const result = await API.post('/vendors', { name: parsed.name, url: parsed.url || null, rating: 3, trust: 'unverified' }).catch(() => null);
      if (result?.id) vendorMap[key] = result.id;
    }
  }

  // Reload to get new vendor IDs
  await App.loadAll();
  const freshVendors = App.getData().vendors;
  freshVendors.forEach(v => { vendorMap[v.name.toLowerCase()] = v.id; });

  // Upsert prices
  let saved = 0;
  for (const row of rows) {
    const vid = vendorMap[row.vendor_name.toLowerCase()];
    if (!vid) continue;
    await API.post('/prices', { vendor_id: vid, peptide: row.peptide, price_per_mg: row.price_per_mg }).catch(() => {});
    saved++;
  }

  _parsedImport = null;
  await App.loadAll();
  renderAllTabs();
  Tabs.switchTo('prices');
  alert(`Saved ${saved} price entr${saved === 1 ? 'y' : 'ies'}.`);
}
```

- [ ] **Step 2: Verify Prices tab in browser**

Open Prices tab with a logged-in account that has vendors:

- Add Price form shows peptide select, vendor select, price input → submit → row appears in matrix
- Matrix shows peptide rows × vendor columns, best price in each row highlighted green
- Click a price cell → inline edit input appears → save → updates in place
- × button on a price cell removes it
- → Calc link switches to Calculator → Cycle Cost, fills price field
- "Import from file" collapsible expands → file input appears
- Clicking "Parse with AI" with no file → alert "Select a file first."
- Upload a simple CSV like `vendor,peptide,price_per_mg\nPepTrek,BPC-157,2.50` → preview table renders with checkbox rows

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add Prices tab with comparison matrix and AI file import"
```

---

## Task 7: Run D1 Migration on Production + Deploy

**Files:**
- No code changes

- [ ] **Step 1: Run migration on production D1**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler d1 execute peptideos_db --file=migrations/0003_vendors_prices.sql 2>&1 | tail -5
```

Expected: `Successfully executed SQL file`

- [ ] **Step 2: Deploy**

```bash
npx wrangler deploy 2>&1 | tail -8
```

Expected: `Deployed peptideos triggers`

- [ ] **Step 3: Smoke test production**

```bash
PROD="https://peptideos.cwenterprises.net"
TOKEN=$(curl -s -X POST "${PROD}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"your@email.com","password":"yourpassword"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

# Add vendor on prod
VID=$(curl -s -X POST "${PROD}/api/vendors" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"ProdTestVendor","rating":3,"trust":"unverified"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Vendor created: ${VID:0:8}..."

# Cleanup
curl -s -X DELETE "${PROD}/api/vendors/$VID" -H "Authorization: Bearer $TOKEN" > /dev/null
echo "Done"
```

- [ ] **Step 4: Push to GitHub**

```bash
git push origin main
```

---

## Spec Coverage Check

| Spec requirement | Task |
|---|---|
| vendors D1 table with indexes | Task 1 |
| prices D1 table with unique index on (user_id, vendor_id, peptide) | Task 1 |
| GET/POST /api/vendors | Task 2 |
| PUT/DELETE /api/vendors/:id | Task 2 |
| vendor delete cascades prices | Task 1 (FK) + Task 2 |
| GET /api/prices, POST (upsert), DELETE | Task 2 |
| vendor ownership check before price upsert | Task 2 |
| POST /api/parse-price-file — Claude haiku, any format | Task 3 |
| ANTHROPIC_API_KEY wrangler secret | Task 3 |
| loadAll includes vendors + prices | Task 4 |
| Vendors + Prices nav tabs | Task 4 |
| renderAllTabs includes renderVendors/renderPrices | Task 4 |
| Vendor card grid with name, URL, stars, trust badge, edit, delete | Task 5 |
| Inline add/edit form (not modal) | Task 5 |
| Inline delete confirm (not browser confirm) | Task 5 |
| Prices comparison matrix (peptides × vendors) | Task 6 |
| Best price per row highlighted green | Task 6 |
| Inline cell edit | Task 6 |
| Delete price entry | Task 6 |
| priceToCalc → fills Cycle Cost calculator | Task 6 |
| File upload collapsible section | Task 6 |
| parsePriceFile — multipart POST, loading state | Task 6 |
| Import preview with checkboxes + editable prices | Task 6 |
| confirmParsedPrices — creates new vendors + upserts prices | Task 6 |
| Production D1 migration | Task 7 |
| wrangler deploy | Task 7 |
