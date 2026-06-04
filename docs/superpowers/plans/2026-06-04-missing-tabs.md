# Dashboard, Orders & History Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three tabs to PeptideOS — Dashboard (analytics: streak calendar, compliance chart, top peptides, stat chips), Orders (track peptide orders with status pipeline), and History (filterable full dose log with per-row delete).

**Architecture:** One new D1 table (`orders`), five new API endpoints (4 order CRUD + `DELETE /logs/:id`), and three new render functions in `index.html`. The live site is served by the Cloudflare Pages project `peptideos-cwenterprises` — static files must be deployed there after every code change, not just via `wrangler deploy`.

**Tech Stack:** Cloudflare D1, Cloudflare Workers, Cloudflare Pages, vanilla JS Canvas 2D API, single-file SPA

---

## Deploy command (use after every task that changes index.html or worker)

```bash
# Copy static files and deploy to Pages
cp /Users/coreywashington/Documents/GitHub/Peptide-mini/index.html /tmp/peptideos-pages/
cp /Users/coreywashington/Documents/GitHub/Peptide-mini/service-worker.js /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -5

# Deploy worker (for API changes)
npx wrangler deploy 2>&1 | tail -5
```

---

## File Map

| File | Status | Change |
|------|--------|--------|
| `migrations/0004_orders.sql` | Create | orders table + index |
| `worker/index.js` | Modify | Add `DELETE /logs/:id` + 4 order routes + 5 handler functions |
| `index.html` | Modify | 3 new nav tabs, 3 content divs, extend renderAllTabs + loadAll, add Dashboard/History/Orders render functions + constants |

---

## Task 1: D1 Migration — orders table

**Files:**
- Create: `migrations/0004_orders.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- migrations/0004_orders.sql
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

- [ ] **Step 2: Run locally**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler d1 execute peptideos_db --local --file=migrations/0004_orders.sql
```
Expected: `Successfully executed SQL file`

- [ ] **Step 3: Commit**

```bash
git add migrations/0004_orders.sql
git commit -m "feat: add orders D1 table"
```

---

## Task 2: Worker — Orders CRUD + DELETE /logs/:id

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Add routes to handleAPI**

Find the logs section (around line 134). The `/logs/last` route MUST stay before the new `/logs/:id` route to avoid ambiguity. Add the new routes — logs delete-by-id goes between `/logs/last` and the settings block; order routes go before the `return err('Not found', 404, origin)` line:

After `if (path === '/logs/last' && method === 'DELETE') ...`, add:
```javascript
  if (path.match(/^\/logs\/[^/]+$/) && method === 'DELETE') return logsDeleteById(request, env, origin, path);
```

Before `return err('Not found', 404, origin)`, add:
```javascript
  // Orders
  if (path === '/orders' && method === 'GET')  return ordersList(request, env, origin);
  if (path === '/orders' && method === 'POST') return ordersAdd(request, env, origin);
  if (path.match(/^\/orders\/[^/]+$/) && method === 'PUT')    return ordersUpdate(request, env, origin, path);
  if (path.match(/^\/orders\/[^/]+$/) && method === 'DELETE') return ordersDelete(request, env, origin, path);
```

- [ ] **Step 2: Add logsDeleteById handler**

Add after `logsDeleteLast` function in `worker/index.js`:

```javascript
async function logsDeleteById(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}
```

- [ ] **Step 3: Add orders handler functions**

Add before `handleCron` at end of `worker/index.js`:

```javascript
async function ordersList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function ordersAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.vendor_name?.trim()) return err('vendor_name required', 400, origin);
  // Validate items is valid JSON array
  let items = '[]';
  if (b.items) {
    try { const parsed = JSON.parse(b.items); if (!Array.isArray(parsed)) throw new Error(); items = b.items; }
    catch { return err('items must be a JSON array string', 400, origin); }
  }
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const status = ['Ordered','Processing','Shipped','In Transit','Delivered','Stored','Used','Cancelled']
    .includes(b.status) ? b.status : 'Ordered';
  await env.DB.prepare(
    `INSERT INTO orders (id, user_id, vendor_id, vendor_name, status, ordered_at, items, notes, tracking, total_cost, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, userId, b.vendor_id || null, b.vendor_name.trim(), status,
    b.ordered_at || null, items, b.notes || null, b.tracking || null,
    b.total_cost ? Number(b.total_cost) : null, now).run();
  return json({ id }, 201, origin);
}

async function ordersUpdate(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  const existing = await env.DB.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!existing) return err('not found', 404, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.vendor_name?.trim()) return err('vendor_name required', 400, origin);
  let items = '[]';
  if (b.items) {
    try { const parsed = JSON.parse(b.items); if (!Array.isArray(parsed)) throw new Error(); items = b.items; }
    catch { return err('items must be a JSON array string', 400, origin); }
  }
  const status = ['Ordered','Processing','Shipped','In Transit','Delivered','Stored','Used','Cancelled']
    .includes(b.status) ? b.status : 'Ordered';
  await env.DB.prepare(
    `UPDATE orders SET vendor_id=?, vendor_name=?, status=?, ordered_at=?, items=?, notes=?, tracking=?, total_cost=?
     WHERE id=? AND user_id=?`
  ).bind(b.vendor_id || null, b.vendor_name.trim(), status,
    b.ordered_at || null, items, b.notes || null, b.tracking || null,
    b.total_cost ? Number(b.total_cost) : null, id, userId).run();
  return json({ ok: true }, 200, origin);
}

async function ordersDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM orders WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}
```

- [ ] **Step 4: Verify with curl**

```bash
npx wrangler dev --local > /tmp/wdev_orders.log 2>&1 &
WPID=$!
sleep 7

TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"newpassword123"}' 2>/dev/null | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/register \
    -H 'Content-Type: application/json' \
    -d '{"email":"orders_test@test.com","password":"testpass123"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
fi
echo "Token: ${TOKEN:0:8}..."

# Add order
OID=$(curl -s -X POST http://localhost:8787/api/orders \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"vendor_name":"TestVendor","status":"Ordered","items":"[{\"peptide\":\"BPC-157\",\"qty\":\"10\",\"unit\":\"mg\"}]"}' \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Order: ${OID:0:8}..."

COUNT=$(curl -s http://localhost:8787/api/orders -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")
echo "Orders: $COUNT"
# Expected: 1

# Add a log then delete it by id
LID=$(curl -s -X POST http://localhost:8787/api/logs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"peptide":"BPC-157","route":"SubQ","dose_value":250,"dose_unit":"mcg","taken_at":"2026-06-04T08:00:00.000Z"}' \
  | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Log: ${LID:0:8}..."
DEL=$(curl -s -X DELETE "http://localhost:8787/api/logs/$LID" -H "Authorization: Bearer $TOKEN" | grep -o '"ok":true')
echo "Log delete by id: $DEL"

kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```
Expected: `Orders: 1`, `Log delete by id: "ok":true`

- [ ] **Step 5: Commit and deploy worker**

```bash
git add worker/index.js
git commit -m "feat: add orders CRUD and DELETE /logs/:id to worker"
npx wrangler deploy 2>&1 | tail -5
npx wrangler d1 execute peptideos_db --remote --file=migrations/0004_orders.sql 2>&1 | tail -5
```

---

## Task 3: Frontend Plumbing — Nav tabs, loadAll, renderAllTabs

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add Dashboard, History, Orders nav tab buttons**

In the HTML nav pill (around line 337), replace the current nav buttons:

```html
      <nav class="nav-pill" id="navPill" style="margin-bottom:16px;">
        <button class="nav-tab active" data-tab="dashboard">Dashboard</button>
        <button class="nav-tab" data-tab="today">Today</button>
        <button class="nav-tab" data-tab="week">Week</button>
        <button class="nav-tab" data-tab="logdose">Log Dose</button>
        <button class="nav-tab" data-tab="history">History</button>
        <button class="nav-tab" data-tab="vials">Vials</button>
        <button class="nav-tab" data-tab="vendors">Vendors</button>
        <button class="nav-tab" data-tab="prices">Prices</button>
        <button class="nav-tab" data-tab="calc">Calculator</button>
        <button class="nav-tab" data-tab="library">Library</button>
        <button class="nav-tab" data-tab="settings">Settings</button>
        <button class="nav-tab" data-tab="orders">Orders</button>
      </nav>
```

- [ ] **Step 2: Add tab content divs**

Replace the current tab content div block:

```html
      <div id="dashboard" class="tab-content active"></div>
      <div id="today"     class="tab-content"></div>
      <div id="week"      class="tab-content"></div>
      <div id="logdose"   class="tab-content"></div>
      <div id="history"   class="tab-content"></div>
      <div id="vials"     class="tab-content"></div>
      <div id="vendors"   class="tab-content"></div>
      <div id="prices"    class="tab-content"></div>
      <div id="calc"      class="tab-content"></div>
      <div id="library"   class="tab-content"></div>
      <div id="settings"  class="tab-content"></div>
      <div id="orders"    class="tab-content"></div>
```

Note: `dashboard` is now the active tab (default home screen), `today` is no longer active by default.

- [ ] **Step 3: Extend App.loadAll() to fetch orders**

Find the `loadAll` function. Add `orders` to the destructure and `_data`:

```javascript
  async function loadAll() {
    let [peptides, planner, vials, logs, settings, vendors, prices, orders] = await Promise.all([
      API.get('/peptides'),
      API.get('/planner'),
      API.get('/vials'),
      API.get('/logs'),
      API.get('/settings'),
      API.get('/vendors'),
      API.get('/prices'),
      API.get('/orders')
    ]);
    if (!peptides.length) {
      await Promise.all(DEFAULT_PEPTIDES.map(name => API.post('/peptides', { name }).catch(() => {})));
      peptides = await API.get('/peptides');
    }
    _data = { peptides, planner, vials, logs, settings, vendors, prices, orders };
    applyTheme(settings.theme || 'system');
    return _data;
  }
```

Also update both `_data` initializations (initial state + logout reset) to include `orders: []`:
```javascript
let _data = { peptides: [], planner: [], vials: [], logs: [], settings: {}, vendors: [], prices: [], orders: [] };
```

- [ ] **Step 4: Extend renderAllTabs**

Replace the `renderAllTabs` function:

```javascript
function renderAllTabs() {
  renderDashboard();
  renderToday();
  renderWeek();
  renderLogDose();
  renderHistory();
  renderVials();
  renderVendors();
  renderPrices();
  renderCalc();
  renderLibrary();
  renderSettings();
  renderOrders();
}
```

Add placeholders after `renderSettings`:

```javascript
function renderDashboard() { document.getElementById('dashboard').innerHTML = '<p class="muted" style="padding:20px;">Dashboard loading...</p>'; }
function renderHistory()   { document.getElementById('history').innerHTML   = '<p class="muted" style="padding:20px;">History loading...</p>'; }
function renderOrders()    { document.getElementById('orders').innerHTML    = '<p class="muted" style="padding:20px;">Orders loading...</p>'; }
```

- [ ] **Step 5: Verify 12 tabs load**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
cp index.html /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -3
sleep 3
TAB_COUNT=$(curl -s https://peptideos.cwenterprises.net/ | grep -o 'data-tab' | wc -l | tr -d ' ')
echo "Tab count: $TAB_COUNT"
# Expected: 12
```

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add dashboard/history/orders nav tabs and extend loadAll/renderAllTabs"
```

---

## Task 4: Dashboard Tab — Analytics

**Files:**
- Modify: `index.html` (replace `renderDashboard` placeholder)

- [ ] **Step 1: Add calcBestStreak helper**

Add immediately after the existing `calcStreak(logs)` function (around line 825):

```javascript
function calcBestStreak(logs) {
  if (!logs.length) return 0;
  const days = [...new Set(logs.map(l => l.taken_at?.slice(0, 10)).filter(Boolean))].sort();
  let best = 0, current = 0, prev = null;
  for (const day of days) {
    if (prev) {
      const diff = (new Date(day) - new Date(prev)) / 86400000;
      current = diff === 1 ? current + 1 : 1;
    } else {
      current = 1;
    }
    best = Math.max(best, current);
    prev = day;
  }
  return best;
}
```

- [ ] **Step 2: Replace renderDashboard placeholder with full implementation**

Replace `function renderDashboard() { ... }` placeholder with:

```javascript
function renderDashboard() {
  const { logs, planner, peptides, settings } = App.getData();
  const streak     = calcStreak(logs);
  const bestStreak = calcBestStreak(logs);
  const totalDoses = logs.length;
  const uniquePeps = new Set(logs.map(l => l.peptide)).size;

  // Cycle info
  const cs = settings.cycle_start, ce = settings.cycle_end;
  let cycleHTML = '<p class="muted" style="text-align:center;">No active cycle — set dates in Settings.</p>';
  if (cs && ce) {
    const start = new Date(cs + 'T00:00:00'), end = new Date(ce + 'T00:00:00'), now = new Date();
    const total = end - start, elapsed = now - start;
    const pct = Math.max(0, Math.min(100, Math.round(elapsed / total * 100)));
    const dayNum = Math.max(1, Math.ceil(elapsed / 86400000));
    const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
    cycleHTML = `
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="text-align:center;min-width:60px;">
          <div class="muted" style="font-size:11px;text-transform:uppercase;">Cycle Day</div>
          <div style="font-size:28px;font-weight:800;color:var(--accent-sky);">${dayNum}</div>
        </div>
        <div style="flex:1;min-width:120px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
            <span class="muted" style="font-size:12px;">Progress</span>
            <span class="muted" style="font-size:12px;">${pct}%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;">
            <span class="muted" style="font-size:11px;">${cs}</span>
            <span class="muted" style="font-size:11px;">${daysLeft}d left</span>
            <span class="muted" style="font-size:11px;">${ce}</span>
          </div>
        </div>
        <div style="text-align:center;min-width:60px;">
          <div class="muted" style="font-size:11px;text-transform:uppercase;">Days Left</div>
          <div style="font-size:28px;font-weight:800;color:var(--accent-indigo);">${daysLeft}</div>
        </div>
      </div>`;
  }

  // Streak calendar — 91 days (13 weeks), CSS grid
  const calCells = [];
  const calToday = new Date(); calToday.setHours(0,0,0,0);
  const calStart = new Date(calToday.getTime() - 90 * 86400000);
  // Pad to Monday start
  const startDow = calStart.getDay(); // 0=Sun
  for (let i = 0; i < 91; i++) {
    const d = new Date(calStart.getTime() + i * 86400000);
    const ds = ymd(d);
    const count = logs.filter(l => l.taken_at?.slice(0,10) === ds).length;
    const color = count === 0 ? 'var(--input-border)' : count <= 2 ? 'rgba(14,165,233,0.4)' : 'var(--accent-sky)';
    const isToday = ds === ymd(calToday);
    calCells.push(`<div title="${ds}: ${count} dose${count !== 1 ? 's' : ''}" style="width:12px;height:12px;border-radius:2px;background:${color};${isToday ? 'outline:2px solid var(--accent-sky);outline-offset:1px;' : ''}"></div>`);
  }

  document.getElementById('dashboard').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:18px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <div class="chip">🔥 Streak: <strong style="margin-left:4px;">${streak}d</strong></div>
          <div class="chip">🏆 Best: <strong style="margin-left:4px;">${bestStreak}d</strong></div>
          <div class="chip">💉 Total doses: <strong style="margin-left:4px;">${totalDoses}</strong></div>
          <div class="chip">🧪 Peptides used: <strong style="margin-left:4px;">${uniquePeps}</strong></div>
        </div>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Cycle Progress</h3>
        ${cycleHTML}
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Last 91 Days</h3>
        <div style="display:grid;grid-template-columns:repeat(13,12px);gap:3px;">${calCells.join('')}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <span class="muted" style="font-size:11px;">Less</span>
          <div style="width:10px;height:10px;border-radius:2px;background:var(--input-border);"></div>
          <div style="width:10px;height:10px;border-radius:2px;background:rgba(14,165,233,0.4);"></div>
          <div style="width:10px;height:10px;border-radius:2px;background:var(--accent-sky);"></div>
          <span class="muted" style="font-size:11px;">More</span>
        </div>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">7-Day Compliance</h3>
        <canvas id="complianceChart" height="120" style="width:100%;max-width:500px;display:block;"></canvas>
        ${planner.length === 0 ? '<p class="muted" style="margin-top:8px;">Add planner items to see compliance.</p>' : ''}
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Top Peptides</h3>
        <canvas id="topPeptidesChart" height="200" style="width:100%;max-width:500px;display:block;"></canvas>
        ${uniquePeps < 2 ? '<p class="muted" style="margin-top:8px;">Log more doses to see your top peptides.</p>' : ''}
      </div>
    </div>`;

  setTimeout(drawDashboardCharts, 0);
}

function drawDashboardCharts() {
  drawComplianceChart(document.getElementById('complianceChart'));
  drawTopPeptidesChart(document.getElementById('topPeptidesChart'));
}

function drawComplianceChart(canvas) {
  if (!canvas) return;
  const { logs, planner } = App.getData();
  if (!planner.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 500;
  canvas.width = W;
  canvas.height = 120;
  ctx.clearRect(0, 0, W, 120);

  const isDark = document.body.dataset.theme === 'dark' ||
    (!document.body.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Array.from({length:7}, (_,i) => {
    const d = new Date(today.getTime() - (6-i)*86400000);
    return { label: ['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()], ymd: ymd(d), dow: d.getDay() };
  });

  const maxPlanned = Math.max(1, ...days.map(d => planner.filter(p => p.day === d.dow).length));
  const barW = Math.floor((W - 40) / 7) - 4;
  const chartH = 80;

  days.forEach((day, i) => {
    const x = 20 + i * ((W - 40) / 7);
    const planned = planner.filter(p => p.day === day.dow).length;
    const done = planned ? logs.filter(l => {
      if (l.taken_at?.slice(0,10) !== day.ymd) return false;
      return planner.some(p => p.day === day.dow && p.peptide === l.peptide && p.unit === l.dose_unit &&
        Math.abs(Number(l.dose_value) - Number(p.dose)) / Math.max(Number(p.dose), 1e-9) <= 0.02);
    }).length : 0;

    const plannedH = Math.round((planned / maxPlanned) * chartH);
    const doneH    = Math.round((done    / maxPlanned) * chartH);

    // Planned bar (background)
    ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    ctx.fillRect(x, 85 - plannedH, barW, plannedH);

    // Done bar (foreground)
    if (doneH > 0) {
      const grad = ctx.createLinearGradient(0, 85 - doneH, 0, 85);
      grad.addColorStop(0, '#0ea5e9');
      grad.addColorStop(1, '#6366f1');
      ctx.fillStyle = grad;
      ctx.fillRect(x, 85 - doneH, barW, doneH);
    }

    // Labels
    ctx.fillStyle = textColor;
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(day.label, x + barW / 2, 100);
    if (planned > 0) ctx.fillText(`${done}/${planned}`, x + barW / 2, 85 - plannedH - 3);
  });
}

function drawTopPeptidesChart(canvas) {
  if (!canvas) return;
  const { logs } = App.getData();
  const counts = {};
  logs.forEach(l => { if (l.peptide) counts[l.peptide] = (counts[l.peptide] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 8);
  if (sorted.length < 2) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 500;
  canvas.width = W;
  const rowH = 24, padLeft = 110, padRight = 40;
  canvas.height = sorted.length * rowH + 10;
  ctx.clearRect(0, 0, W, canvas.height);

  const isDark = document.body.dataset.theme === 'dark' ||
    (!document.body.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const textColor = isDark ? '#94a3b8' : '#64748b';
  const max = sorted[0][1];
  const barArea = W - padLeft - padRight;

  sorted.forEach(([name, count], i) => {
    const y = i * rowH + 5;
    const barW = Math.round((count / max) * barArea);
    const label = name.length > 14 ? name.slice(0,13) + '…' : name;

    ctx.fillStyle = textColor;
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(label, padLeft - 6, y + 14);

    const grad = ctx.createLinearGradient(padLeft, 0, padLeft + barW, 0);
    grad.addColorStop(0, '#0ea5e9');
    grad.addColorStop(1, '#6366f130');
    ctx.fillStyle = grad;
    ctx.fillRect(padLeft, y + 2, barW, rowH - 6);

    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.fillText(String(count), padLeft + barW + 4, y + 14);
  });
}
```

- [ ] **Step 3: Verify — start wrangler dev and confirm no JS errors**

```bash
npx wrangler dev --local > /tmp/wdev_dash.log 2>&1 &
WPID=$!
sleep 7
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/)
echo "HTTP: $HTTP"
grep -i "SyntaxError\|ReferenceError" /tmp/wdev_dash.log | head -3 || echo "No errors"
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

Expected: `HTTP: 200`, no errors.

- [ ] **Step 4: Commit and deploy to Pages**

```bash
git add index.html
git commit -m "feat: add Dashboard analytics tab with streak calendar, compliance chart, top peptides"

cp /Users/coreywashington/Documents/GitHub/Peptide-mini/index.html /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -3
```

---

## Task 5: History Tab

**Files:**
- Modify: `index.html` (replace `renderHistory` placeholder)

- [ ] **Step 1: Replace renderHistory placeholder**

Replace `function renderHistory() { ... }` placeholder with:

```javascript
function renderHistory() {
  const { logs, peptides } = App.getData();
  const pepOpts = peptides.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');

  // Read current filter values (preserve across re-renders)
  const pepFilter  = document.getElementById('histPep')?.value  || '';
  const fromFilter = document.getElementById('histFrom')?.value || '';
  const toFilter   = document.getElementById('histTo')?.value   || '';
  const txtFilter  = document.getElementById('histSearch')?.value?.toLowerCase() || '';

  // Apply filters client-side
  let filtered = [...logs].sort((a,b) => (b.taken_at||'').localeCompare(a.taken_at||''));
  if (pepFilter)  filtered = filtered.filter(l => l.peptide === pepFilter);
  if (fromFilter) filtered = filtered.filter(l => l.taken_at >= fromFilter);
  if (toFilter)   filtered = filtered.filter(l => l.taken_at <= toFilter + 'T23:59:59');
  if (txtFilter)  filtered = filtered.filter(l =>
    (l.peptide||'').toLowerCase().includes(txtFilter) ||
    (l.notes||'').toLowerCase().includes(txtFilter));

  const rows = filtered.length ? filtered.map(l => {
    const dt = new Date(l.taken_at);
    const dtStr = isNaN(dt) ? l.taken_at : dt.toLocaleString([], {dateStyle:'short',timeStyle:'short'});
    const mlIu = (l.volume_ml != null && l.iu != null)
      ? `${Number(l.volume_ml).toFixed(3)} mL / ${Number(l.iu).toFixed(1)} IU` : '—';
    return `<tr>
      <td style="white-space:nowrap;">${escHtml(dtStr)}</td>
      <td><span class="badge badge-info">${escHtml(l.peptide)}</span></td>
      <td>${escHtml(String(l.dose_value))} ${escHtml(l.dose_unit)}</td>
      <td>${escHtml(l.route)}</td>
      <td class="muted">${mlIu}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" class="muted">${escHtml(l.notes||'—')}</td>
      <td><button class="btn btn-danger btn-sm" style="padding:2px 6px;" onclick="deleteHistoryEntry('${escHtml(l.id)}')">×</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" style="text-align:center;padding:20px;" class="muted">${
    logs.length ? 'No logs match your filters.' : 'No doses logged yet.'
  }</td></tr>`;

  document.getElementById('history').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:14px 18px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;">
            Peptide
            <select id="histPep" style="width:auto;" onchange="renderHistory()">
              <option value="">All</option>${pepOpts}
            </select>
          </label>
          <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;">
            From <input id="histFrom" type="date" style="width:auto;" onchange="renderHistory()" value="${escHtml(fromFilter)}">
          </label>
          <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;">
            To <input id="histTo" type="date" style="width:auto;" onchange="renderHistory()" value="${escHtml(toFilter)}">
          </label>
          <input id="histSearch" type="search" placeholder="Search peptide or notes…"
            style="width:180px;" oninput="renderHistory()" value="${escHtml(txtFilter)}">
          <button class="btn btn-ghost btn-sm" onclick="clearHistoryFilters()">Clear</button>
          <button class="btn btn-ghost btn-sm" onclick="exportHistoryCSV()">Export CSV</button>
          <span class="muted" style="font-size:12px;">${filtered.length} of ${logs.length}</span>
        </div>
      </div>
      <div class="glass" style="padding:0;overflow:auto;">
        <table>
          <thead><tr>
            <th>Date/Time</th><th>Peptide</th><th>Dose</th>
            <th>Route</th><th>mL / IU</th><th>Notes</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  // Restore filter values after re-render
  if (pepFilter)  { const el = document.getElementById('histPep');  if (el) el.value = pepFilter; }
  if (fromFilter) { const el = document.getElementById('histFrom'); if (el) el.value = fromFilter; }
  if (toFilter)   { const el = document.getElementById('histTo');   if (el) el.value = toFilter; }
}

function clearHistoryFilters() {
  // Clear stored values then re-render
  ['histPep','histFrom','histTo','histSearch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  renderHistory();
}

async function deleteHistoryEntry(id) {
  try {
    await API.delete(`/logs/${id}`);
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('history');
  } catch (e) { alert('Failed: ' + e.message); }
}

function exportHistoryCSV() {
  const { logs, peptides } = App.getData();
  const pepFilter  = document.getElementById('histPep')?.value  || '';
  const fromFilter = document.getElementById('histFrom')?.value || '';
  const toFilter   = document.getElementById('histTo')?.value   || '';
  const txtFilter  = document.getElementById('histSearch')?.value?.toLowerCase() || '';

  let filtered = [...logs].sort((a,b) => (b.taken_at||'').localeCompare(a.taken_at||''));
  if (pepFilter)  filtered = filtered.filter(l => l.peptide === pepFilter);
  if (fromFilter) filtered = filtered.filter(l => l.taken_at >= fromFilter);
  if (toFilter)   filtered = filtered.filter(l => l.taken_at <= toFilter + 'T23:59:59');
  if (txtFilter)  filtered = filtered.filter(l =>
    (l.peptide||'').toLowerCase().includes(txtFilter) ||
    (l.notes||'').toLowerCase().includes(txtFilter));

  const esc = s => { s = String(s ?? ''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replaceAll('"','""')}"` : s; };
  const keys = ['taken_at','peptide','dose_value','dose_unit','route','volume_ml','iu','notes'];
  const csv  = [keys.join(','), ...filtered.map(r => keys.map(k => esc(r[k])).join(','))].join('\n');

  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'peptideos_history.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
```

- [ ] **Step 2: Verify HTTP 200 and no JS errors**

```bash
npx wrangler dev --local > /tmp/wdev_hist.log 2>&1 &
WPID=$!; sleep 7
curl -s -o /dev/null -w "HTTP:%{http_code}" http://localhost:8787/
grep -i "SyntaxError\|ReferenceError" /tmp/wdev_hist.log | head -3 || echo "No errors"
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

- [ ] **Step 3: Commit and deploy to Pages**

```bash
git add index.html
git commit -m "feat: add History tab with filters, delete per row, and CSV export"

cp /Users/coreywashington/Documents/GitHub/Peptide-mini/index.html /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -3
```

---

## Task 6: Orders Tab

**Files:**
- Modify: `index.html` (replace `renderOrders` placeholder)

- [ ] **Step 1: Add ORDER_STATUSES and ORDER_STATUS_BADGE constants**

Add immediately after the existing `const DEFAULT_PEPTIDES = [...]` constant:

```javascript
const ORDER_STATUSES = ['Ordered','Processing','Shipped','In Transit','Delivered','Stored','Used','Cancelled'];
const ORDER_STATUS_BADGE = {
  'Ordered':    'badge-info',
  'Processing': 'badge-pending',
  'Shipped':    'badge-info',
  'In Transit': 'badge-info',
  'Delivered':  'badge-done',
  'Stored':     'badge-done',
  'Used':       'badge-done',
  'Cancelled':  'badge-pending'
};
let _orderFilter = '';
let _orderFormId = undefined; // undefined=hide, null=add new, string=editing id
```

- [ ] **Step 2: Replace renderOrders placeholder with full implementation**

Replace `function renderOrders() { ... }` with:

```javascript
function renderOrders() {
  const { orders, vendors } = App.getData();

  // Pipeline counts
  const pipeline = [{ key: '', label: 'All', count: orders.length },
    ...ORDER_STATUSES.map(s => ({ key: s, label: s, count: orders.filter(o => o.status === s).length }))
  ].map(s => `<span class="chip" style="cursor:pointer;${_orderFilter===s.key?'background:var(--accent-sky);color:white;':''}" onclick="_orderFilter='${s.key}';renderOrders();">
    ${escHtml(s.label)} <strong>${s.count}</strong>
  </span>`).join('');

  const filtered = _orderFilter ? orders.filter(o => o.status === _orderFilter) : orders;
  const sorted   = [...filtered].sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));

  const cards = sorted.length ? sorted.map(o => {
    let items = [];
    try { items = JSON.parse(o.items || '[]'); } catch {}
    const itemTags = items.map(it =>
      `<span class="chip" style="font-size:11px;">${escHtml(it.peptide||'')}${it.qty?' · '+escHtml(it.qty):''}${it.unit?' '+escHtml(it.unit):''}</span>`
    ).join('');
    const badgeCls = ORDER_STATUS_BADGE[o.status] || 'badge-info';
    return `
      <div class="glass" style="padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:700;font-size:15px;">${escHtml(o.vendor_name)}</div>
            ${o.ordered_at ? `<div class="muted" style="font-size:12px;margin-top:2px;">${escHtml(o.ordered_at)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
            <span class="badge ${badgeCls}">${escHtml(o.status)}</span>
            <button class="btn btn-ghost btn-sm" onclick="startEditOrder('${escHtml(o.id)}')">✎</button>
            <button class="btn btn-danger btn-sm" onclick="deleteOrderConfirm('${escHtml(o.id)}')">×</button>
          </div>
        </div>
        ${itemTags ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">${itemTags}</div>` : ''}
        ${o.tracking ? `<div class="muted" style="font-size:12px;margin-top:6px;">📦 ${escHtml(o.tracking)}</div>` : ''}
        ${o.total_cost != null ? `<div class="muted" style="font-size:12px;margin-top:4px;">💰 $${Number(o.total_cost).toFixed(2)}</div>` : ''}
        ${o.notes ? `<div class="muted" style="font-size:12px;margin-top:6px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escHtml(o.notes)}</div>` : ''}
        <div id="odel-${escHtml(o.id)}" style="display:none;margin-top:10px;">
          <span class="muted" style="font-size:13px;">Delete this order from <strong>${escHtml(o.vendor_name)}</strong>?</span>
          <div style="display:flex;gap:8px;margin-top:6px;">
            <button class="btn btn-danger btn-sm" onclick="deleteOrder('${escHtml(o.id)}')">Confirm</button>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('odel-${escHtml(o.id)}').style.display='none'">Cancel</button>
          </div>
        </div>
      </div>`;
  }).join('') : `<div class="glass" style="padding:24px;text-align:center;"><div style="font-size:32px;">📦</div><p style="margin-top:8px;font-weight:600;">No orders${_orderFilter?' in this status':''}</p><p class="muted" style="margin-top:4px;">Click "+ Add Order" to start tracking.</p></div>`;

  document.getElementById('orders').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:18px;" id="orderFormWrap">
        ${_orderFormId !== undefined ? orderFormHTML(_orderFormId) : '<button class="btn btn-primary btn-sm" onclick="_orderFormId=null;renderOrders()">+ Add Order</button>'}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;overflow-x:auto;padding:2px 0;">${pipeline}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;">${cards}</div>
    </div>`;
}

function orderFormHTML(editId) {
  const { orders, vendors, peptides } = App.getData();
  const o = editId ? orders.find(x => x.id === editId) : null;
  let items = [];
  if (o) { try { items = JSON.parse(o.items || '[]'); } catch {} }

  const vendorOpts = vendors.map(v =>
    `<option value="${escHtml(v.id)}" ${o?.vendor_id===v.id?'selected':''}>${escHtml(v.name)}</option>`
  ).join('');
  const statusOpts = ORDER_STATUSES.map(s =>
    `<option value="${s}" ${(o?.status||'Ordered')===s?'selected':''}>${s}</option>`
  ).join('');
  const pepOpts = peptides.map(p =>
    `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`
  ).join('');
  const itemRows = items.map((it, i) => `
    <div class="row3" style="margin-bottom:6px;" id="oitem-${i}">
      <label>Peptide<select class="o-item-pep" data-idx="${i}">${pepOpts.replace(`value="${escHtml(it.peptide)}"`,`value="${escHtml(it.peptide)}" selected`)}</select></label>
      <label>Qty<input class="o-item-qty" data-idx="${i}" type="text" value="${escHtml(it.qty||'')}" placeholder="e.g. 10"></label>
      <label>Unit
        <div style="display:flex;gap:4px;">
          <select class="o-item-unit" data-idx="${i}">
            <option value="mg" ${it.unit==='mg'?'selected':''}>mg</option>
            <option value="mcg" ${it.unit==='mcg'?'selected':''}>mcg</option>
            <option value="IU" ${it.unit==='IU'?'selected':''}>IU</option>
          </select>
          <button class="btn btn-danger btn-sm" style="padding:4px 8px;" onclick="removeOrderItem(${i})">×</button>
        </div>
      </label>
    </div>`).join('');

  return `
    <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">${o ? 'Edit Order' : 'Add Order'}</h3>
    <div class="stack" style="gap:10px;">
      <div class="row2">
        <label>Vendor (from list)
          <select id="oVendorId" onchange="document.getElementById('oVendorName').value=this.options[this.selectedIndex].text;">
            <option value="">None / Free text</option>${vendorOpts}
          </select>
        </label>
        <label>Vendor name
          <input id="oVendorName" type="text" value="${escHtml(o?.vendor_name||'')}" placeholder="required" />
        </label>
      </div>
      <div class="row3">
        <label>Status<select id="oStatus">${statusOpts}</select></label>
        <label>Order date<input id="oOrderedAt" type="date" value="${escHtml(o?.ordered_at||'')}"></label>
        <label>Total cost ($)<input id="oTotalCost" type="number" step="0.01" min="0" value="${o?.total_cost!=null?o.total_cost:''}" placeholder="optional"></label>
      </div>
      <div>
        <div style="font-size:13px;font-weight:500;color:var(--text-muted);margin-bottom:6px;">Items</div>
        <div id="oItemsWrap">${itemRows}</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="addOrderItem()">+ Add item</button>
      </div>
      <label>Tracking<input id="oTracking" type="text" value="${escHtml(o?.tracking||'')}" placeholder="optional"></label>
      <label>Notes<textarea id="oNotes" style="min-height:60px;">${escHtml(o?.notes||'')}</textarea></label>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-primary btn-sm" onclick="saveOrder(${o?`'${escHtml(o.id)}'`:'null'})">${o?'Save Changes':'+ Add Order'}</button>
        <button class="btn btn-ghost btn-sm" onclick="_orderFormId=undefined;renderOrders()">Cancel</button>
      </div>
    </div>`;
}

function addOrderItem() {
  const wrap = document.getElementById('oItemsWrap');
  if (!wrap) return;
  const i = wrap.children.length;
  const { peptides } = App.getData();
  const pepOpts = peptides.map(p => `<option value="${escHtml(p.name)}">${escHtml(p.name)}</option>`).join('');
  const div = document.createElement('div');
  div.className = 'row3';
  div.style.marginBottom = '6px';
  div.id = `oitem-${i}`;
  div.innerHTML = `
    <label>Peptide<select class="o-item-pep" data-idx="${i}">${pepOpts}</select></label>
    <label>Qty<input class="o-item-qty" data-idx="${i}" type="text" placeholder="e.g. 10"></label>
    <label>Unit
      <div style="display:flex;gap:4px;">
        <select class="o-item-unit" data-idx="${i}"><option value="mg">mg</option><option value="mcg">mcg</option><option value="IU">IU</option></select>
        <button class="btn btn-danger btn-sm" style="padding:4px 8px;" onclick="this.closest('.row3').remove()">×</button>
      </div>
    </label>`;
  wrap.appendChild(div);
}

function removeOrderItem(idx) {
  document.getElementById(`oitem-${idx}`)?.remove();
}

function collectOrderItems() {
  const peps  = [...document.querySelectorAll('.o-item-pep')];
  const qtys  = [...document.querySelectorAll('.o-item-qty')];
  const units = [...document.querySelectorAll('.o-item-unit')];
  return peps.map((p, i) => ({ peptide: p.value, qty: qtys[i]?.value||'', unit: units[i]?.value||'mg' }))
    .filter(it => it.peptide);
}

function startEditOrder(id) {
  _orderFormId = id;
  renderOrders();
  document.getElementById('orderFormWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveOrder(editId) {
  const vendor_id   = document.getElementById('oVendorId')?.value || null;
  const vendor_name = document.getElementById('oVendorName')?.value?.trim();
  const status      = document.getElementById('oStatus')?.value || 'Ordered';
  const ordered_at  = document.getElementById('oOrderedAt')?.value || null;
  const total_cost  = Number(document.getElementById('oTotalCost')?.value) || null;
  const tracking    = document.getElementById('oTracking')?.value?.trim() || null;
  const notes       = document.getElementById('oNotes')?.value?.trim() || null;
  const items       = JSON.stringify(collectOrderItems());

  if (!vendor_name) { alert('Vendor name is required.'); return; }
  const body = { vendor_id, vendor_name, status, ordered_at, items, notes, tracking, total_cost };
  try {
    if (editId && editId !== 'null') {
      await API.put(`/orders/${editId}`, body);
    } else {
      await API.post('/orders', body);
    }
    _orderFormId = undefined;
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('orders');
  } catch (e) { alert('Failed: ' + e.message); }
}

function deleteOrderConfirm(id) {
  const el = document.getElementById(`odel-${id}`);
  if (el) el.style.display = 'block';
}

async function deleteOrder(id) {
  try {
    await API.delete(`/orders/${id}`);
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('orders');
  } catch (e) { alert('Failed: ' + e.message); }
}
```

- [ ] **Step 3: Verify HTTP 200 and no errors**

```bash
npx wrangler dev --local > /tmp/wdev_orders2.log 2>&1 &
WPID=$!; sleep 7
curl -s -o /dev/null -w "HTTP:%{http_code}" http://localhost:8787/
grep -i "SyntaxError\|ReferenceError" /tmp/wdev_orders2.log | head -3 || echo "No errors"
kill $WPID 2>/dev/null; wait $WPID 2>/dev/null
```

- [ ] **Step 4: Commit and deploy**

```bash
git add index.html
git commit -m "feat: add Orders tab with status pipeline, CRUD form, and item rows"

cp /Users/coreywashington/Documents/GitHub/Peptide-mini/index.html /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -3
```

---

## Task 7: Production Migration + Final Deploy

- [ ] **Step 1: Run orders migration on production D1**

```bash
npx wrangler d1 execute peptideos_db --remote --file=migrations/0004_orders.sql 2>&1 | tail -5
```
Expected: success (or "already exists" if previously run)

- [ ] **Step 2: Deploy worker to production**

```bash
npx wrangler deploy 2>&1 | tail -5
```

- [ ] **Step 3: Deploy all static files to Pages**

```bash
cp /Users/coreywashington/Documents/GitHub/Peptide-mini/index.html /tmp/peptideos-pages/
cp /Users/coreywashington/Documents/GitHub/Peptide-mini/service-worker.js /tmp/peptideos-pages/
cp /Users/coreywashington/Documents/GitHub/Peptide-mini/manifest.json /tmp/peptideos-pages/
npx wrangler pages deploy /tmp/peptideos-pages --project-name peptideos-cwenterprises --branch main --commit-dirty=true 2>&1 | tail -5
```

- [ ] **Step 4: Smoke test**

```bash
PROD="https://peptideos.cwenterprises.net"
TAB_COUNT=$(curl -s "${PROD}/" | grep -o 'data-tab' | wc -l | tr -d ' ')
echo "Tab count: $TAB_COUNT"
# Expected: 12

TOKEN=$(curl -s -X POST "${PROD}/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"smoke_tabs_$(date +%s)@test.com\",\"password\":\"testtest123\"}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
O=$(curl -s -X POST "${PROD}/api/orders" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"vendor_name":"TestVendor","status":"Ordered","items":"[]"}' | grep -o '"id"')
echo "Orders endpoint: $O"
# Expected: "id"
```

- [ ] **Step 5: Push to GitHub**

```bash
git push origin main
```

---

## Spec Coverage Check

| Requirement | Task |
|---|---|
| orders D1 table with index | Task 1 |
| `DELETE /logs/:id` (before `/logs/last` in router) | Task 2 |
| Orders GET/POST/PUT/DELETE endpoints | Task 2 |
| items validated as JSON array | Task 2 |
| Dashboard nav tab (first position) | Task 3 |
| History nav tab (after Log Dose) | Task 3 |
| Orders nav tab (last position) | Task 3 |
| loadAll fetches orders | Task 3 |
| renderAllTabs includes all 3 new functions | Task 3 |
| Stats chips (streak, best streak, total doses, unique peptides) | Task 4 |
| calcBestStreak helper | Task 4 |
| Cycle progress bar (day/%, days left) | Task 4 |
| Streak calendar — 91 day CSS grid, 3 shade levels | Task 4 |
| 7-day compliance canvas chart | Task 4 |
| Top peptides horizontal canvas chart | Task 4 |
| History filters: peptide, from, to, text search | Task 5 |
| History table with 7 columns | Task 5 |
| Delete per row via DELETE /logs/:id | Task 5 |
| Export visible rows as CSV | Task 5 |
| ORDER_STATUSES + ORDER_STATUS_BADGE constants | Task 6 |
| Pipeline filter bar with counts | Task 6 |
| Order cards with items, tracking, cost, notes | Task 6 |
| Inline add/edit form with dynamic item rows | Task 6 |
| Inline delete confirm (no browser confirm) | Task 6 |
| Production D1 migration | Task 7 |
| Pages deploy (correct deploy target) | Tasks 4–7 |
