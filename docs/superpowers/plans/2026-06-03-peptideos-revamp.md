# PeptideOS Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite Peptide Mini into PeptideOS — a cloud-first PWA with liquid glass UI, Cloudflare Worker API, D1 database, email/password auth, 7-tab navigation, calculator suite, peptide library, and push notifications.

**Architecture:** Single `index.html` SPA (vanilla JS, no build step) talks to a Cloudflare Worker at `/api/*`. D1 stores users, planner, vials, and logs. KV stores sessions (30-day TTL) and password-reset tokens (15-min TTL). A Cron Trigger fires every 5 min to send Web Push reminders.

**Tech Stack:** Cloudflare Workers, D1 (SQLite), KV, Cron Triggers, Web Crypto API (PBKDF2, ECDH), Web Push Protocol, Service Worker, IndexedDB, vanilla JS/CSS

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `index.html` | **Rewrite** | Single-file SPA: auth screens + all 7 tabs |
| `manifest.json` | **Create** | PWA manifest (replaces Manifest.webmanifest) |
| `service-worker.js` | **Create** | Cache-first shell, IndexedDB offline queue, push handler |
| `terms.html` | **Create** | Terms of Service static page |
| `privacy.html` | **Create** | Privacy Policy static page |
| `worker/index.js` | **Create** | All `/api/*` routes — auth, CRUD, push, cron |
| `wrangler.toml` | **Create** | D1 + KV bindings, cron schedule, route |
| `migrations/0001_init.sql` | **Create** | Full D1 schema |

---

## Task 1: Project Scaffolding & D1 Schema

**Files:**
- Create: `wrangler.toml`
- Create: `migrations/0001_init.sql`
- Create: `worker/index.js` (skeleton only)

- [ ] **Step 1: Create wrangler.toml**

```toml
name = "peptideos"
main = "worker/index.js"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "peptideos_db"
database_id = "REPLACE_WITH_ACTUAL_ID"

[[kv_namespaces]]
binding = "SESSIONS"
id = "REPLACE_WITH_ACTUAL_ID"

[triggers]
crons = ["*/5 * * * *"]

[vars]
APP_URL = "https://peptideos.cwenterprises.net"
```

- [ ] **Step 2: Create D1 database and get IDs**

```bash
cd /Users/coreywashington/Documents/GitHub/Peptide-mini
npx wrangler d1 create peptideos_db
# Copy the database_id output → replace REPLACE_WITH_ACTUAL_ID in wrangler.toml

npx wrangler kv:namespace create SESSIONS
# Copy the id output → replace REPLACE_WITH_ACTUAL_ID in wrangler.toml
```

- [ ] **Step 3: Create the D1 migration file**

```sql
-- migrations/0001_init.sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE peptides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE planner (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  day INTEGER NOT NULL,
  time TEXT,
  route TEXT NOT NULL,
  dose REAL NOT NULL,
  unit TEXT NOT NULL,
  note TEXT
);

CREATE TABLE vials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peptide TEXT NOT NULL,
  mg REAL NOT NULL,
  ml REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vial_id TEXT REFERENCES vials(id) ON DELETE SET NULL,
  peptide TEXT NOT NULL,
  route TEXT NOT NULL,
  dose_value REAL NOT NULL,
  dose_unit TEXT NOT NULL,
  dose_mcg REAL,
  volume_ml REAL,
  iu REAL,
  taken_at TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications_sent (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  planner_id TEXT NOT NULL,
  sent_date TEXT NOT NULL,
  UNIQUE(user_id, planner_id, sent_date)
);

CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT,
  cycle_start TEXT,
  cycle_end TEXT,
  theme TEXT DEFAULT 'system'
);
```

- [ ] **Step 4: Run migration against local D1**

```bash
npx wrangler d1 execute peptideos_db --local --file=migrations/0001_init.sql
```
Expected: `Successfully executed SQL file`

- [ ] **Step 5: Create worker/index.js skeleton**

```javascript
// worker/index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};

async function handleAPI(request, env, url) {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleCron(env) {
  // placeholder
}
```

- [ ] **Step 6: Verify wrangler dev starts**

```bash
npx wrangler dev --local
```
Expected: `Ready on http://localhost:8787`

```bash
curl http://localhost:8787/api/ping
```
Expected: `{"ok":true}`

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml migrations/0001_init.sql worker/index.js
git commit -m "feat: scaffold project — wrangler config, D1 schema, worker skeleton"
```

---

## Task 2: Worker — Auth Helpers & PBKDF2

**Files:**
- Modify: `worker/index.js` (add crypto helpers, no routes yet)

- [ ] **Step 1: Add PBKDF2 helpers to worker/index.js**

Add before the `handleAPI` function:

```javascript
// --- Crypto helpers ---

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const toHex = (buf) => Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(salt.buffer)}:${toHex(hashBits)}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, expectedHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const actualHex = Array.from(new Uint8Array(hashBits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return actualHex === expectedHex;
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const session = await env.SESSIONS.get(token, 'json');
  if (!session || session.expires_at < Date.now()) return null;
  return session.user_id;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    }
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}
```

- [ ] **Step 2: Verify worker still starts**

```bash
npx wrangler dev --local
```
Expected: no errors in terminal

- [ ] **Step 3: Commit**

```bash
git add worker/index.js
git commit -m "feat: add PBKDF2 password hashing and session auth helpers to worker"
```

---

## Task 3: Worker — Auth Endpoints

**Files:**
- Modify: `worker/index.js` (add register, login, logout routes)

- [ ] **Step 1: Replace handleAPI with a router and add OPTIONS handler**

```javascript
async function handleAPI(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
      }
    });
  }

  const path = url.pathname.replace('/api', '');
  const method = request.method;

  if (path === '/auth/register' && method === 'POST') return authRegister(request, env);
  if (path === '/auth/login'    && method === 'POST') return authLogin(request, env);
  if (path === '/auth/logout'   && method === 'POST') return authLogout(request, env);

  return err('Not found', 404);
}
```

- [ ] **Step 2: Implement authRegister**

```javascript
async function authRegister(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email and password required');
  if (password.length < 8) return err('password must be at least 8 characters');

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return err('email already registered');

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, email.toLowerCase().trim(), hash, now).run();

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.SESSIONS.put(token, JSON.stringify({ user_id: id, expires_at: expiresAt }), {
    expirationTtl: 30 * 24 * 60 * 60
  });

  return json({ token, email: email.toLowerCase().trim() }, 201);
}
```

- [ ] **Step 3: Implement authLogin**

```javascript
async function authLogin(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email and password required');

  const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (!user) return err('invalid credentials', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return err('invalid credentials', 401);

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.SESSIONS.put(token, JSON.stringify({ user_id: user.id, expires_at: expiresAt }), {
    expirationTtl: 30 * 24 * 60 * 60
  });

  return json({ token, email: email.toLowerCase().trim() });
}
```

- [ ] **Step 4: Implement authLogout**

```javascript
async function authLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) await env.SESSIONS.delete(token);
  return json({ ok: true });
}
```

- [ ] **Step 5: Verify register → login → logout flow with curl**

```bash
npx wrangler dev --local
# In a second terminal:

curl -s -X POST http://localhost:8787/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"password123"}' | jq .
# Expected: {"token":"<uuid>","email":"test@test.com"}

TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"password123"}' | jq -r .token)
echo $TOKEN
# Expected: a UUID string

curl -s -X POST http://localhost:8787/api/auth/logout \
  -H "Authorization: Bearer $TOKEN" | jq .
# Expected: {"ok":true}

# Duplicate registration should fail:
curl -s -X POST http://localhost:8787/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"password123"}' | jq .
# Expected: {"error":"email already registered"}
```

- [ ] **Step 6: Commit**

```bash
git add worker/index.js
git commit -m "feat: add auth register/login/logout endpoints with PBKDF2 + KV sessions"
```

---

## Task 4: Worker — Password Reset

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Add forgot-password and reset-password routes to the router**

In `handleAPI`, add after the logout route:

```javascript
  if (path === '/auth/forgot' && method === 'POST') return authForgot(request, env);
  if (path === '/auth/reset'  && method === 'POST') return authReset(request, env);
```

- [ ] **Step 2: Implement authForgot**

```javascript
async function authForgot(request, env) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return err('email required');

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();

  if (user) {
    const resetToken = crypto.randomUUID();
    await env.SESSIONS.put(
      `reset:${resetToken}`,
      JSON.stringify({ user_id: user.id, email: email.toLowerCase().trim() }),
      { expirationTtl: 15 * 60 }
    );
    // In production: send email with reset link. For now, return token in response (dev only).
    // Remove the token from the response before deploying to production.
    console.log(`[DEV] Reset token for ${email}: ${resetToken}`);
  }

  // Always return 200 to prevent email enumeration
  return json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
}
```

- [ ] **Step 3: Implement authReset**

```javascript
async function authReset(request, env) {
  const { token, password } = await request.json().catch(() => ({}));
  if (!token || !password) return err('token and password required');
  if (password.length < 8) return err('password must be at least 8 characters');

  const data = await env.SESSIONS.get(`reset:${token}`, 'json');
  if (!data) return err('invalid or expired reset token', 401);

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(hash, data.user_id).run();

  await env.SESSIONS.delete(`reset:${token}`);
  return json({ ok: true });
}
```

- [ ] **Step 4: Verify forgot + reset flow**

```bash
curl -s -X POST http://localhost:8787/api/auth/forgot \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com"}' | jq .
# Expected: {"ok":true,"message":"If that email is registered, a reset link has been sent."}
# Also check wrangler dev console for the reset token (DEV log)

# Copy the token from the console log, then:
curl -s -X POST http://localhost:8787/api/auth/reset \
  -H 'Content-Type: application/json' \
  -d '{"token":"<PASTE_TOKEN>","password":"newpassword123"}' | jq .
# Expected: {"ok":true}

# Verify login with new password works:
curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"newpassword123"}' | jq .
# Expected: {"token":"...","email":"test@test.com"}
```

- [ ] **Step 5: Commit**

```bash
git add worker/index.js
git commit -m "feat: add password reset flow with 15-minute KV tokens"
```

---

## Task 5: Worker — CRUD Endpoints (peptides, planner, vials, logs, settings)

**Files:**
- Modify: `worker/index.js`

- [ ] **Step 1: Add all CRUD routes to the router in handleAPI**

After the auth routes, add:

```javascript
  // Peptides
  if (path === '/peptides' && method === 'GET')    return peptidesList(request, env);
  if (path === '/peptides' && method === 'POST')   return peptidesAdd(request, env);
  if (path.match(/^\/peptides\/[^/]+$/) && method === 'DELETE') return peptidesDelete(request, env, path);

  // Planner
  if (path === '/planner' && method === 'GET')    return plannerList(request, env);
  if (path === '/planner' && method === 'POST')   return plannerAdd(request, env);
  if (path.match(/^\/planner\/[^/]+$/) && method === 'DELETE') return plannerDelete(request, env, path);

  // Vials
  if (path === '/vials' && method === 'GET')    return vialsList(request, env);
  if (path === '/vials' && method === 'POST')   return vialsAdd(request, env);
  if (path.match(/^\/vials\/[^/]+$/) && method === 'DELETE') return vialsDelete(request, env, path);

  // Logs
  if (path === '/logs' && method === 'GET')    return logsList(request, env);
  if (path === '/logs' && method === 'POST')   return logsAdd(request, env);
  if (path === '/logs/last' && method === 'DELETE') return logsDeleteLast(request, env);

  // Settings
  if (path === '/settings' && method === 'GET') return settingsGet(request, env);
  if (path === '/settings' && method === 'PUT') return settingsPut(request, env);
```

- [ ] **Step 2: Implement peptide CRUD**

```javascript
async function peptidesList(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { results } = await env.DB.prepare(
    'SELECT id, name FROM peptides WHERE user_id = ? ORDER BY name'
  ).bind(userId).all();
  return json(results);
}

async function peptidesAdd(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { name } = await request.json().catch(() => ({}));
  if (!name?.trim()) return err('name required');
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO peptides (id, user_id, name) VALUES (?, ?, ?)')
    .bind(id, userId, name.trim()).run();
  return json({ id, name: name.trim() }, 201);
}

async function peptidesDelete(request, env, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM peptides WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true });
}
```

- [ ] **Step 3: Implement planner CRUD**

```javascript
async function plannerList(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { results } = await env.DB.prepare(
    'SELECT * FROM planner WHERE user_id = ? ORDER BY day, time'
  ).bind(userId).all();
  return json(results);
}

async function plannerAdd(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || b.day == null || !b.route || !b.dose || !b.unit) return err('missing fields');
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO planner (id, user_id, peptide, day, time, route, dose, unit, note) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(id, userId, b.peptide, b.day, b.time || null, b.route, b.dose, b.unit, b.note || null).run();
  return json({ id, ...b }, 201);
}

async function plannerDelete(request, env, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM planner WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true });
}
```

- [ ] **Step 4: Implement vials CRUD**

```javascript
async function vialsList(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { results } = await env.DB.prepare(
    'SELECT * FROM vials WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return json(results);
}

async function vialsAdd(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || !b.mg || !b.ml) return err('peptide, mg, ml required');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vials (id, user_id, peptide, mg, ml, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, userId, b.peptide, b.mg, b.ml, now).run();
  return json({ id, peptide: b.peptide, mg: b.mg, ml: b.ml, created_at: now }, 201);
}

async function vialsDelete(request, env, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const id = path.split('/').pop();
  // Null out vial_id in logs before deleting
  await env.DB.prepare('UPDATE logs SET vial_id = NULL WHERE vial_id = ? AND user_id = ?')
    .bind(id, userId).run();
  await env.DB.prepare('DELETE FROM vials WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true });
}
```

- [ ] **Step 5: Implement logs CRUD**

```javascript
async function logsList(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { results } = await env.DB.prepare(
    'SELECT * FROM logs WHERE user_id = ? ORDER BY taken_at DESC LIMIT 200'
  ).bind(userId).all();
  return json(results);
}

async function logsAdd(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || !b.route || !b.dose_value || !b.dose_unit || !b.taken_at) return err('missing fields');
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO logs (id, user_id, vial_id, peptide, route, dose_value, dose_unit, dose_mcg, volume_ml, iu, taken_at, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id, userId,
    b.vial_id || null, b.peptide, b.route,
    b.dose_value, b.dose_unit,
    b.dose_mcg ?? null, b.volume_ml ?? null, b.iu ?? null,
    b.taken_at, b.notes || null
  ).run();
  return json({ id, ...b }, 201);
}

async function logsDeleteLast(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const last = await env.DB.prepare(
    'SELECT id FROM logs WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1'
  ).bind(userId).first();
  if (!last) return json({ ok: true, deleted: false });
  await env.DB.prepare('DELETE FROM logs WHERE id = ?').bind(last.id).run();
  return json({ ok: true, deleted: true });
}
```

- [ ] **Step 6: Implement settings GET/PUT**

```javascript
async function settingsGet(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const row = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first();
  return json(row || { user_id: userId, week_start: null, cycle_start: null, cycle_end: null, theme: 'system' });
}

async function settingsPut(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const b = await request.json().catch(() => ({}));
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, week_start, cycle_start, cycle_end, theme)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       week_start = excluded.week_start,
       cycle_start = excluded.cycle_start,
       cycle_end = excluded.cycle_end,
       theme = excluded.theme`
  ).bind(
    userId,
    b.week_start ?? null, b.cycle_start ?? null, b.cycle_end ?? null,
    b.theme ?? 'system'
  ).run();
  return json({ ok: true });
}
```

- [ ] **Step 7: Verify CRUD endpoints**

```bash
# Get a fresh token
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@test.com","password":"newpassword123"}' | jq -r .token)

# Add a planner item
curl -s -X POST http://localhost:8787/api/planner \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"peptide":"BPC-157","day":1,"time":"08:00","route":"SubQ","dose":250,"unit":"mcg"}' | jq .
# Expected: {"id":"...","peptide":"BPC-157",...}

# List planner
curl -s http://localhost:8787/api/planner \
  -H "Authorization: Bearer $TOKEN" | jq .
# Expected: array with 1 item

# Settings
curl -s -X PUT http://localhost:8787/api/settings \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"theme":"dark","week_start":"2026-06-02"}' | jq .
# Expected: {"ok":true}
```

- [ ] **Step 8: Commit**

```bash
git add worker/index.js
git commit -m "feat: add CRUD endpoints for peptides, planner, vials, logs, and settings"
```

---

## Task 6: Worker — Push Subscriptions & Cron Handler

**Files:**
- Modify: `worker/index.js`

Note: Full Web Push requires VAPID ECDH message encryption. The cron handler below implements the complete Web Push Protocol using SubtleCrypto. Store VAPID keys as Wrangler secrets.

- [ ] **Step 1: Generate VAPID keys and store as secrets**

```bash
# Generate an EC P-256 key pair for VAPID
node -e "
const { generateKeyPairSync } = require('crypto');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
// Raw public key = last 65 bytes of SPKI DER
const rawPub = Buffer.from(pubDer).slice(-65);
const rawPriv = Buffer.from(privDer).slice(-32);
console.log('VAPID_PUBLIC_KEY=' + rawPub.toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + rawPriv.toString('base64url'));
"

npx wrangler secret put VAPID_PUBLIC_KEY
# Paste the public key value when prompted

npx wrangler secret put VAPID_PRIVATE_KEY
# Paste the private key value when prompted

npx wrangler secret put VAPID_SUBJECT
# Enter: mailto:claude@cwenterprises.net
```

- [ ] **Step 2: Add push subscription routes to the router**

```javascript
  if (path === '/push/subscribe' && method === 'POST')   return pushSubscribe(request, env);
  if (path === '/push/subscribe' && method === 'DELETE') return pushUnsubscribe(request, env);
  if (path === '/push/vapid-key' && method === 'GET')    return pushVapidKey(request, env);
```

- [ ] **Step 3: Implement push subscription endpoints**

```javascript
async function pushVapidKey(request, env) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
}

async function pushSubscribe(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { endpoint, keys } = await request.json().catch(() => ({}));
  if (!endpoint || !keys?.p256dh || !keys?.auth) return err('invalid subscription');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Upsert: replace existing subscription for this endpoint
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth`
  ).bind(id, userId, endpoint, keys.p256dh, keys.auth, now).run().catch(async () => {
    // endpoint column may not have UNIQUE — insert or ignore
    const existing = await env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?')
      .bind(endpoint).first();
    if (!existing) {
      await env.DB.prepare(
        'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(id, userId, endpoint, keys.p256dh, keys.auth, now).run();
    }
  });
  return json({ ok: true }, 201);
}

async function pushUnsubscribe(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { endpoint } = await request.json().catch(() => ({}));
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .bind(userId, endpoint || '').run();
  return json({ ok: true });
}
```

- [ ] **Step 4: Add UNIQUE constraint to endpoint via migration**

```bash
# Create a second migration file to add the UNIQUE index
cat > migrations/0002_push_unique.sql << 'EOF'
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint);
EOF

npx wrangler d1 execute peptideos_db --local --file=migrations/0002_push_unique.sql
```

- [ ] **Step 5: Implement the cron + Web Push sender**

```javascript
async function handleCron(env) {
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const dayOfWeek = now.getUTCDay();
  const currentHHMM = `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;

  // Find planner items due in the next 10 minutes
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 5 * 60 * 1000);
  const wsHHMM = `${String(windowStart.getUTCHours()).padStart(2,'0')}:${String(windowStart.getUTCMinutes()).padStart(2,'0')}`;
  const weHHMM = `${String(windowEnd.getUTCHours()).padStart(2,'0')}:${String(windowEnd.getUTCMinutes()).padStart(2,'0')}`;

  const { results: dueItems } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.peptide, p.dose, p.unit, p.time
     FROM planner p
     WHERE p.day = ? AND p.time >= ? AND p.time <= ?`
  ).bind(dayOfWeek, wsHHMM, weHHMM).all();

  for (const item of dueItems) {
    // Check deduplication
    const alreadySent = await env.DB.prepare(
      'SELECT id FROM notifications_sent WHERE user_id = ? AND planner_id = ? AND sent_date = ?'
    ).bind(item.user_id, item.id, todayDate).first();
    if (alreadySent) continue;

    // Get push subscriptions for this user
    const { results: subs } = await env.DB.prepare(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
    ).bind(item.user_id).all();

    const payload = JSON.stringify({
      title: 'PeptideOS Reminder',
      body: `Time to take ${item.peptide} — ${item.dose} ${item.unit}`,
      icon: '/icon-192.png'
    });

    for (const sub of subs) {
      try {
        await sendWebPush(env, sub.endpoint, sub.p256dh, sub.auth, payload);
      } catch (e) {
        console.error('Push failed:', e.message);
      }
    }

    // Record sent
    await env.DB.prepare(
      'INSERT OR IGNORE INTO notifications_sent (id, user_id, planner_id, sent_date) VALUES (?,?,?,?)'
    ).bind(crypto.randomUUID(), item.user_id, item.id, todayDate).run();
  }
}

async function sendWebPush(env, endpoint, p256dhB64, authB64, payload) {
  // Import VAPID private key
  const privKeyRaw = Uint8Array.from(atob(env.VAPID_PRIVATE_KEY.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const pubKeyRaw  = Uint8Array.from(atob(env.VAPID_PUBLIC_KEY.replace(/-/g,'+').replace(/_/g,'/')),  c => c.charCodeAt(0));

  const vapidKey = await crypto.subtle.importKey(
    'raw', privKeyRaw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );

  // Build VAPID JWT
  const audience = new URL(endpoint).origin;
  const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const claims = btoa(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: env.VAPID_SUBJECT
  })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const sigInput = new TextEncoder().encode(`${header}.${claims}`);
  const sigRaw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, sigInput);
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigRaw))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${header}.${claims}.${sig}`;
  const vapidAuthHeader = `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`;

  // Encrypt payload using Web Push encryption (RFC 8291)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const serverECDH = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverECDH.publicKey));

  const clientPublicRaw = Uint8Array.from(atob(p256dhB64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const clientPublicKey = await crypto.subtle.importKey('raw', clientPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverECDH.privateKey, 256);

  const authRaw = Uint8Array.from(atob(authB64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));

  // HKDF for content encryption key and nonce
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);

  function buildInfo(type, clientPub, serverPub) {
    const enc = new TextEncoder();
    const label = enc.encode(`Content-Encoding: ${type}\0`);
    const prefix = new Uint8Array([0x00, 0x41]);
    const buf = new Uint8Array(label.length + prefix.length + clientPub.length + 2 + serverPub.length + 2);
    let off = 0;
    buf.set(label, off); off += label.length;
    buf.set(prefix, off); off += prefix.length;
    const cl = new DataView(new ArrayBuffer(2)); cl.setUint16(0, clientPub.length);
    buf.set(new Uint8Array(cl.buffer), off); off += 2;
    buf.set(clientPub, off); off += clientPub.length;
    const sl = new DataView(new ArrayBuffer(2)); sl.setUint16(0, serverPub.length);
    buf.set(new Uint8Array(sl.buffer), off); off += 2;
    buf.set(serverPub, off);
    return buf;
  }

  const prkBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: authRaw, info: new TextEncoder().encode('Content-Encoding: auth\0') },
    hkdfKey, 256
  );
  const prk = await crypto.subtle.importKey('raw', prkBits, 'HKDF', false, ['deriveBits']);

  const cekInfo = buildInfo('aesgcm', clientPublicRaw, serverPublicRaw);
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, prk, 128);
  const nonceInfo = buildInfo('nonce', clientPublicRaw, serverPublicRaw);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, prk, 96);

  const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const encodedPayload = new TextEncoder().encode(payload);
  const paddedPayload = new Uint8Array(encodedPayload.length + 2);
  paddedPayload.set(encodedPayload, 2);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonceBits, tagLength: 128 }, cek, paddedPayload
  );

  // Build body: salt (16) + rs (4) + keyid_len (1) + server_pub (65) + ciphertext
  const rs = new DataView(new ArrayBuffer(4)); rs.setUint32(0, 4096);
  const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.byteLength);
  let off = 0;
  body.set(salt, off); off += 16;
  body.set(new Uint8Array(rs.buffer), off); off += 4;
  body[off++] = 65;
  body.set(serverPublicRaw, off); off += 65;
  body.set(new Uint8Array(ciphertext), off);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption': `salt=${btoa(String.fromCharCode(...salt)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`,
      'Crypto-Key': `dh=${btoa(String.fromCharCode(...serverPublicRaw)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')};${vapidAuthHeader}`,
      'TTL': '86400'
    },
    body
  });

  if (!res.ok && res.status !== 201) {
    throw new Error(`Push failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add worker/index.js migrations/0002_push_unique.sql
git commit -m "feat: add push subscription endpoints and cron handler with Web Push encryption"
```

---

## Task 7: index.html — Design System CSS

**Files:**
- Rewrite: `index.html` (start fresh — CSS only, no JS yet)

- [ ] **Step 1: Create new index.html with the full design system CSS**

Replace the entire existing `index.html` with:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>PeptideOS</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="PeptideOS">
  <meta name="color-scheme" content="light dark">
  <link rel="manifest" href="/manifest.json">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #e8f4fd;
      --grad1: rgba(56,189,248,0.22);
      --grad2: rgba(99,102,241,0.16);
      --grad3: rgba(34,211,238,0.14);
      --text: #0f172a;
      --text-muted: #64748b;
      --glass-bg: rgba(255,255,255,0.55);
      --glass-border: rgba(255,255,255,0.85);
      --glass-shadow: 0 8px 32px rgba(14,30,60,0.10), 0 2px 8px rgba(14,30,60,0.07), inset 0 1px 0 rgba(255,255,255,0.95);
      --glass-shimmer: linear-gradient(90deg, transparent, rgba(255,255,255,0.9) 40%, rgba(255,255,255,1) 60%, transparent);
      --chip-bg: rgba(255,255,255,0.65);
      --input-bg: rgba(255,255,255,0.7);
      --input-border: rgba(148,163,184,0.5);
      --accent-sky: #0ea5e9;
      --accent-indigo: #6366f1;
      --accent-green: #16a34a;
      --accent-amber: #d97706;
      --btn-grad: linear-gradient(135deg, #0ea5e9, #6366f1);
      --btn-glow: 0 4px 16px rgba(99,102,241,0.35);
      --radius-card: 18px;
      --radius-btn: 12px;
      --radius-input: 10px;
      --font: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0a0f1e;
        --grad1: rgba(56,189,248,0.10);
        --grad2: rgba(99,102,241,0.10);
        --grad3: rgba(34,211,238,0.06);
        --text: #f1f5f9;
        --text-muted: #94a3b8;
        --glass-bg: rgba(255,255,255,0.06);
        --glass-border: rgba(255,255,255,0.12);
        --glass-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.08);
        --glass-shimmer: linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.12) 60%, transparent);
        --chip-bg: rgba(255,255,255,0.08);
        --input-bg: rgba(255,255,255,0.05);
        --input-border: rgba(255,255,255,0.12);
        --accent-green: #4ade80;
        --accent-amber: #fbbf24;
      }
    }

    body[data-theme="dark"] {
      --bg: #0a0f1e;
      --grad1: rgba(56,189,248,0.10);
      --grad2: rgba(99,102,241,0.10);
      --grad3: rgba(34,211,238,0.06);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --glass-bg: rgba(255,255,255,0.06);
      --glass-border: rgba(255,255,255,0.12);
      --glass-shadow: 0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30), inset 0 1px 0 rgba(255,255,255,0.08);
      --glass-shimmer: linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0.12) 60%, transparent);
      --chip-bg: rgba(255,255,255,0.08);
      --input-bg: rgba(255,255,255,0.05);
      --input-border: rgba(255,255,255,0.12);
      --accent-green: #4ade80;
      --accent-amber: #fbbf24;
    }

    body[data-theme="light"] {
      --bg: #e8f4fd;
      --grad1: rgba(56,189,248,0.22);
      --grad2: rgba(99,102,241,0.16);
      --grad3: rgba(34,211,238,0.14);
      --text: #0f172a;
      --text-muted: #64748b;
      --glass-bg: rgba(255,255,255,0.55);
      --glass-border: rgba(255,255,255,0.85);
      --glass-shadow: 0 8px 32px rgba(14,30,60,0.10), 0 2px 8px rgba(14,30,60,0.07), inset 0 1px 0 rgba(255,255,255,0.95);
      --chip-bg: rgba(255,255,255,0.65);
      --input-bg: rgba(255,255,255,0.7);
      --input-border: rgba(148,163,184,0.5);
      --accent-green: #16a34a;
      --accent-amber: #d97706;
    }

    html, body { height: 100%; }
    body {
      font-family: var(--font);
      background:
        radial-gradient(ellipse at 15% 10%, var(--grad1) 0%, transparent 45%),
        radial-gradient(ellipse at 85% 80%, var(--grad2) 0%, transparent 45%),
        radial-gradient(ellipse at 55% 5%,  var(--grad3) 0%, transparent 35%),
        var(--bg);
      background-attachment: fixed;
      color: var(--text);
      font-size: 14px;
      min-height: 100vh;
    }

    /* Glass card */
    .glass {
      position: relative;
      background: var(--glass-bg);
      backdrop-filter: blur(28px) saturate(180%);
      -webkit-backdrop-filter: blur(28px) saturate(180%);
      border-radius: var(--radius-card);
      border: 1px solid var(--glass-border);
      box-shadow: var(--glass-shadow);
      overflow: hidden;
    }
    .glass::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 1px;
      background: var(--glass-shimmer);
      pointer-events: none;
      z-index: 1;
    }

    /* Nav pill */
    .nav-pill {
      display: flex;
      gap: 2px;
      padding: 4px;
      background: var(--chip-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      box-shadow: 0 4px 16px rgba(14,30,60,0.09), inset 0 1px 0 rgba(255,255,255,0.8);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .nav-pill::-webkit-scrollbar { display: none; }
    .nav-tab {
      flex: 1;
      min-width: 64px;
      text-align: center;
      padding: 7px 10px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 500;
      border: none;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, color 0.15s;
    }
    .nav-tab.active {
      background: var(--glass-bg);
      color: var(--text);
      box-shadow: 0 2px 8px rgba(14,30,60,0.10), inset 0 1px 0 rgba(255,255,255,0.9);
    }

    /* Buttons */
    .btn {
      font-family: var(--font);
      font-size: 14px;
      font-weight: 600;
      border-radius: var(--radius-btn);
      border: none;
      padding: 10px 20px;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    .btn:active { transform: scale(0.97); }
    .btn-primary {
      background: var(--btn-grad);
      color: white;
      box-shadow: var(--btn-glow);
    }
    .btn-ghost {
      background: var(--chip-bg);
      color: var(--text);
      border: 1px solid var(--glass-border);
      backdrop-filter: blur(8px);
    }
    .btn-danger {
      background: rgba(239,68,68,0.12);
      color: #ef4444;
      border: 1px solid rgba(239,68,68,0.3);
    }
    .btn-sm { font-size: 12px; padding: 6px 12px; }

    /* Inputs */
    input, select, textarea {
      font-family: var(--font);
      font-size: 14px;
      background: var(--input-bg);
      color: var(--text);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-input);
      padding: 9px 12px;
      width: 100%;
      transition: border-color 0.15s;
      backdrop-filter: blur(8px);
    }
    input:focus, select:focus, textarea:focus {
      outline: none;
      border-color: var(--accent-sky);
      box-shadow: 0 0 0 2px rgba(14,165,233,0.18);
    }
    textarea { min-height: 60px; resize: vertical; }
    label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 500; color: var(--text-muted); }
    label > span { color: var(--text-muted); font-size: 12px; font-weight: 500; }

    /* Status badges */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .badge-done    { background: rgba(22,163,74,0.15); color: var(--accent-green); border: 1px solid rgba(22,163,74,0.3); }
    .badge-pending { background: rgba(217,119,6,0.12); color: var(--accent-amber); border: 1px solid rgba(217,119,6,0.3); }
    .badge-info    { background: rgba(14,165,233,0.12); color: var(--accent-sky);   border: 1px solid rgba(14,165,233,0.3); }

    /* Chip */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: var(--chip-bg);
      border: 1px solid var(--glass-border);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      backdrop-filter: blur(8px);
    }

    /* Layout helpers */
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .muted { color: var(--text-muted); font-size: 12px; }
    .divider { border: none; border-top: 1px solid var(--glass-border); margin: 8px 0; }

    /* Progress bar */
    .progress-track {
      height: 6px;
      background: var(--input-border);
      border-radius: 999px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--btn-grad);
      transition: width 0.4s ease;
    }

    /* Tables */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--input-border); }
    th { font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
    .text-right { text-align: right; }

    /* App shell layout */
    #app { max-width: 980px; margin: 0 auto; padding: 16px 16px 80px; }
    .app-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .app-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* Auth screens */
    #authScreen {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .auth-card { width: 100%; max-width: 400px; padding: 32px; }
    .auth-logo { text-align: center; margin-bottom: 24px; }
    .auth-logo h1 { font-size: 28px; font-weight: 800; background: var(--btn-grad); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .auth-error { color: #ef4444; font-size: 13px; min-height: 18px; }

    /* Dose row in Today */
    .dose-row {
      padding: 12px;
      border-radius: 12px;
      background: var(--chip-bg);
      border: 1px solid var(--glass-border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .dose-row-info { flex: 1; min-width: 0; }
    .dose-row-name { font-weight: 600; font-size: 14px; }
    .dose-row-meta { color: var(--text-muted); font-size: 12px; margin-top: 2px; }

    /* Vial progress bar gradient */
    .vial-bar { height: 6px; border-radius: 999px; background: var(--input-border); overflow: hidden; margin-top: 6px; }
    .vial-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease; }

    /* Disclaimer */
    .disclaimer { font-size: 11px; color: var(--text-muted); padding: 10px 14px; text-align: center; opacity: 0.8; }

    @media (max-width: 640px) {
      .row2, .row3 { grid-template-columns: 1fr; }
      .app-title { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div id="authScreen" style="display:none;">
    <!-- Auth screens rendered by JS -->
  </div>
  <div id="app" style="display:none;">
    <!-- App shell rendered by JS -->
  </div>
  <script>
    // JS goes here in later tasks
    document.getElementById('app').style.display = 'block';
    document.getElementById('app').innerHTML = '<h2 style="padding:20px">Design system loaded</h2>';
  </script>
</body>
</html>
```

- [ ] **Step 2: Open in browser and verify design system**

Open `index.html` directly in a browser (file://):
- Background should be soft blue radial gradient
- "Design system loaded" h2 visible
- No console errors

Switch to dark mode (OS System Preferences > Appearance > Dark): background should shift to deep navy.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add liquid glass design system CSS to index.html"
```

---

## Task 8: index.html — App Shell, Tab Navigation & Auth Gate

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace the JS stub with the full app shell + API client**

Replace the `<script>` block content with:

```javascript
const API = (() => {
  const BASE = '/api';
  const getToken = () => localStorage.getItem('peptideos_token');
  const setToken = (t) => localStorage.setItem('peptideos_token', t);
  const clearToken = () => localStorage.removeItem('peptideos_token');

  async function req(method, path, body) {
    const token = getToken();
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  }

  return {
    get:    (path)        => req('GET',    path),
    post:   (path, body)  => req('POST',   path, body),
    put:    (path, body)  => req('PUT',    path, body),
    delete: (path, body)  => req('DELETE', path, body),
    setToken, clearToken, getToken
  };
})();

const App = (() => {
  let _token = API.getToken();
  let _email = localStorage.getItem('peptideos_email') || '';
  let _theme = localStorage.getItem('peptideos_theme') || 'system';
  let _data = { peptides: [], planner: [], vials: [], logs: [], settings: {} };

  function applyTheme(t) {
    _theme = t;
    localStorage.setItem('peptideos_theme', t);
    if (t === 'system') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', t);
  }

  function isLoggedIn() { return !!_token; }

  async function login(email, password) {
    const { token } = await API.post('/auth/login', { email, password });
    _token = token; _email = email;
    API.setToken(token);
    localStorage.setItem('peptideos_email', email);
    return token;
  }

  async function register(email, password) {
    const { token } = await API.post('/auth/register', { email, password });
    _token = token; _email = email;
    API.setToken(token);
    localStorage.setItem('peptideos_email', email);
    return token;
  }

  async function logout() {
    await API.post('/auth/logout').catch(() => {});
    API.clearToken();
    localStorage.removeItem('peptideos_email');
    _token = null; _email = '';
    _data = { peptides: [], planner: [], vials: [], logs: [], settings: {} };
  }

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

  return { isLoggedIn, login, register, logout, loadAll, applyTheme,
    getData: () => _data, getEmail: () => _email, getTheme: () => _theme };
})();
```

- [ ] **Step 2: Add the HTML body and tab rendering**

Replace the `<body>` content with:

```html
<body>
  <div id="authScreen" style="display:none;"></div>
  <div id="mainApp" style="display:none;">
    <div id="app">
      <div class="app-header">
        <span class="app-title">PeptideOS</span>
      </div>
      <nav class="nav-pill" style="margin-bottom:16px;" id="navPill">
        <button class="nav-tab active" data-tab="today">Today</button>
        <button class="nav-tab" data-tab="week">Week</button>
        <button class="nav-tab" data-tab="logdose">Log Dose</button>
        <button class="nav-tab" data-tab="vials">Vials</button>
        <button class="nav-tab" data-tab="calc">Calculator</button>
        <button class="nav-tab" data-tab="library">Library</button>
        <button class="nav-tab" data-tab="settings">Settings</button>
      </nav>
      <div id="today"    class="tab-content active"></div>
      <div id="week"     class="tab-content"></div>
      <div id="logdose"  class="tab-content"></div>
      <div id="vials"    class="tab-content"></div>
      <div id="calc"     class="tab-content"></div>
      <div id="library"  class="tab-content"></div>
      <div id="settings" class="tab-content"></div>
    </div>
  </div>

  <script>
    // [API and App objects from Step 1 go here]

    // Tab navigation
    const Tabs = (() => {
      let current = 'today';
      document.getElementById('navPill').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        switchTo(btn.dataset.tab);
      });
      function switchTo(tabId) {
        current = tabId;
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
      }
      return { switchTo, current: () => current };
    })();

    // Boot
    (async function boot() {
      const themeStored = localStorage.getItem('peptideos_theme') || 'system';
      if (themeStored !== 'system') document.body.setAttribute('data-theme', themeStored);

      if (App.isLoggedIn()) {
        try {
          await App.loadAll();
          document.getElementById('mainApp').style.display = 'block';
          renderAllTabs();
        } catch (e) {
          if (e.status === 401) showAuth('login');
          else { document.getElementById('mainApp').style.display = 'block'; renderAllTabs(); }
        }
      } else {
        showAuth('login');
      }
    })();

    function renderAllTabs() {
      renderToday();
      renderWeek();
      renderLogDose();
      renderVials();
      renderCalc();
      renderLibrary();
      renderSettings();
    }

    // Placeholder render functions — each filled in by subsequent tasks
    function renderToday()    { document.getElementById('today').innerHTML    = '<p class="muted" style="padding:20px">Today tab — coming next</p>'; }
    function renderWeek()     { document.getElementById('week').innerHTML     = '<p class="muted" style="padding:20px">Week tab</p>'; }
    function renderLogDose()  { document.getElementById('logdose').innerHTML  = '<p class="muted" style="padding:20px">Log Dose tab</p>'; }
    function renderVials()    { document.getElementById('vials').innerHTML    = '<p class="muted" style="padding:20px">Vials tab</p>'; }
    function renderCalc()     { document.getElementById('calc').innerHTML     = '<p class="muted" style="padding:20px">Calculator tab</p>'; }
    function renderLibrary()  { document.getElementById('library').innerHTML  = '<p class="muted" style="padding:20px">Library tab</p>'; }
    function renderSettings() { document.getElementById('settings').innerHTML = '<p class="muted" style="padding:20px">Settings tab</p>'; }

    function showAuth(mode) {
      document.getElementById('authScreen').style.display = 'flex';
      document.getElementById('mainApp').style.display = 'none';
      renderAuth(mode);
    }
  </script>
</body>
```

- [ ] **Step 3: Verify tab switching**

Open `index.html` in browser with `wrangler dev --local` serving the API. Since index.html is not yet served by the worker (it's a static file), open directly via file://. 

Because `App.isLoggedIn()` returns false (no token), `showAuth` is called. The `#authScreen` div shows, `#mainApp` is hidden. Console should show no errors.

Click the nav tabs → tab panels switch. (Visible only after login — we'll confirm in the next task.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add app shell, tab nav, API client, and boot sequence to index.html"
```

---

## Task 9: index.html — Auth Screens

**Files:**
- Modify: `index.html` (add `renderAuth`, sign-in, sign-up, forgot/reset)

- [ ] **Step 1: Add renderAuth function (replace the stub `function showAuth`)**

Add this before the closing `</script>`:

```javascript
function renderAuth(mode = 'login') {
  const el = document.getElementById('authScreen');

  const logoHTML = `<div class="auth-logo"><h1>PeptideOS</h1><p class="muted" style="margin-top:4px">Personal peptide tracker</p></div>`;

  if (mode === 'login') {
    el.innerHTML = `<div class="glass auth-card"><div style="padding:0">
      ${logoHTML}
      <div class="stack" style="gap:16px;">
        <label><span>Email</span><input id="authEmail" type="email" placeholder="you@example.com" autocomplete="username"></label>
        <label><span>Password</span><input id="authPass" type="password" placeholder="••••••••" autocomplete="current-password"></label>
        <div class="auth-error" id="authErr"></div>
        <button class="btn btn-primary" onclick="doLogin()">Sign In</button>
        <div style="text-align:center;font-size:13px;color:var(--text-muted);">
          <a href="#" onclick="renderAuth('forgot');return false;" style="color:var(--accent-sky);">Forgot password?</a>
          &nbsp;·&nbsp;
          <a href="#" onclick="renderAuth('register');return false;" style="color:var(--accent-sky);">Create account</a>
        </div>
      </div>
    </div></div>`;
  }

  else if (mode === 'register') {
    el.innerHTML = `<div class="glass auth-card"><div style="padding:0">
      ${logoHTML}
      <div class="stack" style="gap:14px;">
        <label><span>Email</span><input id="authEmail" type="email" placeholder="you@example.com" autocomplete="username"></label>
        <label><span>Password</span><input id="authPass" type="password" placeholder="8+ characters" autocomplete="new-password"></label>
        <label><span>Confirm password</span><input id="authPass2" type="password" placeholder="repeat password" autocomplete="new-password"></label>
        <label style="flex-direction:row;align-items:flex-start;gap:10px;color:var(--text);font-size:12px;">
          <input id="checkTos" type="checkbox" style="width:auto;margin-top:2px;">
          I agree to the <a href="/terms" style="color:var(--accent-sky);">Terms of Service</a> and <a href="/privacy" style="color:var(--accent-sky);">Privacy Policy</a>
        </label>
        <label style="flex-direction:row;align-items:flex-start;gap:10px;color:var(--text);font-size:12px;">
          <input id="checkDisclaimer" type="checkbox" style="width:auto;margin-top:2px;">
          I understand this app is for personal tracking only and is not medical advice
        </label>
        <div class="auth-error" id="authErr"></div>
        <button class="btn btn-primary" onclick="doRegister()">Create Account</button>
        <p class="muted" style="text-align:center;font-size:11px;">By signing up you confirm you are 18+ and agree all peptides are used for research purposes only.</p>
        <div style="text-align:center;font-size:13px;">
          <a href="#" onclick="renderAuth('login');return false;" style="color:var(--accent-sky);">Already have an account? Sign in</a>
        </div>
      </div>
    </div></div>`;
  }

  else if (mode === 'forgot') {
    el.innerHTML = `<div class="glass auth-card"><div style="padding:0">
      ${logoHTML}
      <div class="stack" style="gap:16px;">
        <p style="font-size:13px;color:var(--text-muted);">Enter your email to receive a password reset link.</p>
        <label><span>Email</span><input id="authEmail" type="email" placeholder="you@example.com"></label>
        <div class="auth-error" id="authErr"></div>
        <div id="forgotSuccess" style="display:none;text-align:center;padding:16px;">
          <div style="font-size:32px;">✉️</div>
          <p style="margin-top:8px;font-weight:600;">Reset link sent</p>
          <p class="muted" style="margin-top:4px;">Check your email. Link expires in 15 minutes.</p>
        </div>
        <button class="btn btn-primary" id="forgotBtn" onclick="doForgot()">Send Reset Link</button>
        <div style="text-align:center;font-size:13px;">
          <a href="#" onclick="renderAuth('login');return false;" style="color:var(--accent-sky);">Back to sign in</a>
        </div>
      </div>
    </div></div>`;
  }

  else if (mode === 'reset') {
    // Mode called with token in URL: /reset?token=xxx
    const token = new URLSearchParams(window.location.search).get('token') || '';
    el.innerHTML = `<div class="glass auth-card"><div style="padding:0">
      ${logoHTML}
      <div class="stack" style="gap:16px;">
        <label><span>New password</span><input id="authPass" type="password" placeholder="8+ characters"></label>
        <label><span>Confirm new password</span><input id="authPass2" type="password" placeholder="repeat password"></label>
        <div class="auth-error" id="authErr"></div>
        <button class="btn btn-primary" onclick="doReset('${token}')">Set New Password</button>
      </div>
    </div></div>`;
  }
}

async function doLogin() {
  const email = document.getElementById('authEmail').value.trim();
  const pass   = document.getElementById('authPass').value;
  const errEl  = document.getElementById('authErr');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Email and password required.'; return; }
  try {
    await App.login(email, pass);
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    await App.loadAll();
    renderAllTabs();
  } catch (e) {
    errEl.textContent = e.message || 'Sign in failed.';
  }
}

async function doRegister() {
  const email  = document.getElementById('authEmail').value.trim();
  const pass   = document.getElementById('authPass').value;
  const pass2  = document.getElementById('authPass2').value;
  const tos    = document.getElementById('checkTos').checked;
  const disc   = document.getElementById('checkDisclaimer').checked;
  const errEl  = document.getElementById('authErr');
  errEl.textContent = '';
  if (!tos || !disc) { errEl.textContent = 'Please check both required boxes.'; return; }
  if (!email || !pass) { errEl.textContent = 'Email and password required.'; return; }
  if (pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (pass !== pass2)  { errEl.textContent = 'Passwords do not match.'; return; }
  try {
    await App.register(email, pass);
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    await App.loadAll();
    renderAllTabs();
  } catch (e) {
    errEl.textContent = e.message || 'Registration failed.';
  }
}

async function doForgot() {
  const email = document.getElementById('authEmail').value.trim();
  const errEl = document.getElementById('authErr');
  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Email required.'; return; }
  try {
    await API.post('/auth/forgot', { email });
    document.getElementById('forgotSuccess').style.display = 'block';
    document.getElementById('forgotBtn').style.display = 'none';
  } catch (e) {
    errEl.textContent = e.message;
  }
}

async function doReset(token) {
  const pass  = document.getElementById('authPass').value;
  const pass2 = document.getElementById('authPass2').value;
  const errEl = document.getElementById('authErr');
  errEl.textContent = '';
  if (pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (pass !== pass2)  { errEl.textContent = 'Passwords do not match.'; return; }
  try {
    await API.post('/auth/reset', { token, password: pass });
    renderAuth('login');
    document.getElementById('authErr').textContent = 'Password reset! Please sign in.';
  } catch (e) {
    errEl.textContent = e.message;
  }
}
```

- [ ] **Step 2: Add `/reset` route detection to boot**

In the `boot` function, add at the top (before the `if (App.isLoggedIn())` block):

```javascript
if (window.location.pathname === '/reset') {
  document.getElementById('authScreen').style.display = 'flex';
  renderAuth('reset');
  return;
}
```

- [ ] **Step 3: Serve index.html via wrangler and test auth flow**

Add a static file handler to `worker/index.js`. Add before the `handleAPI` call:

```javascript
// In the fetch handler, before handleAPI:
// Serve index.html for non-API requests (add to the export default fetch)
```

Update the main `fetch` handler:

```javascript
async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    return handleAPI(request, env, url);
  }
  // Static files are served by Cloudflare Pages in production.
  // In dev, wrangler dev serves from the project root automatically.
  return new Response('Not found', { status: 404 });
},
```

Add to `wrangler.toml` to serve static assets:
```toml
[site]
bucket = "."
```

Restart `npx wrangler dev --local`, then open `http://localhost:8787`:
- Sign in form displays with glass card styling
- "Create account" link switches to registration form
- Both TOS checkboxes are present and required
- "Forgot password?" link shows the forgot form

Register a test account → should land on main app with 7 tabs visible.

- [ ] **Step 4: Commit**

```bash
git add index.html wrangler.toml
git commit -m "feat: add auth screens (sign in, register, forgot/reset) with glass UI"
```

---

## Task 10: index.html — Today Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add streak calculation helper**

Add this function to the script block:

```javascript
function calcStreak(logs) {
  if (!logs.length) return 0;
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  const today = new Date();
  const days = new Set(logs.map(l => l.taken_at.slice(0, 10)));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (days.has(ymd(d))) streak++;
    else if (i > 0) break;
  }
  return streak;
}
```

- [ ] **Step 2: Replace the renderToday placeholder**

```javascript
function renderToday() {
  const data = App.getData();
  const now = new Date();
  const todayDow = now.getDay();
  const pad2 = (n) => String(n).padStart(2,'0');
  const todayYmd = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const todaysPlan = (data.planner || [])
    .filter(p => p.day === todayDow)
    .sort((a, b) => (a.time||'99:99').localeCompare(b.time||'99:99'));

  const start = new Date(todayYmd + 'T00:00:00');
  const end   = new Date(todayYmd + 'T23:59:59.999');
  const todaysLogs = (data.logs || []).filter(l => {
    const t = new Date(l.taken_at);
    return t >= start && t <= end;
  });

  function planMatched(plan, logs) {
    return logs.some(l =>
      l.peptide === plan.peptide &&
      l.route === plan.route &&
      l.dose_unit === plan.unit &&
      Math.abs(Number(l.dose_value) - Number(plan.dose)) / Math.max(Math.abs(Number(plan.dose)), 1e-9) <= 0.02
    );
  }

  const doneCount = todaysPlan.filter(p => planMatched(p, todaysLogs)).length;
  const pendingCount = todaysPlan.length - doneCount;
  const pct = todaysPlan.length ? Math.round((doneCount / todaysPlan.length) * 100) : 0;
  const streak = calcStreak(data.logs || []);

  const doseRows = todaysPlan.length
    ? todaysPlan.map(p => {
        const matched = planMatched(p, todaysLogs);
        return `<div class="dose-row">
          <div class="dose-row-info">
            <div class="dose-row-name">${p.peptide}</div>
            <div class="dose-row-meta">${p.route} · ${p.dose} ${p.unit}${p.note ? ' · ' + p.note : ''}${p.time ? ' · ' + p.time : ''}</div>
          </div>
          <span class="badge ${matched ? 'badge-done' : 'badge-pending'}">${matched ? 'DONE' : 'PENDING'}</span>
          ${matched ? '' : `<button class="btn btn-ghost btn-sm" onclick="quickLog('${p.id}','${todayYmd}')">Log</button>`}
        </div>`;
      }).join('')
    : `<p class="muted" style="padding:8px 0;">No planned items for today. Add them in Settings.</p>`;

  document.getElementById('today').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:18px;">
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
          <div class="chip">📋 Planned: <strong style="margin-left:4px;">${todaysPlan.length}</strong></div>
          <div class="chip">✅ Done: <strong style="margin-left:4px;">${doneCount}</strong></div>
          <div class="chip">⏳ Pending: <strong style="margin-left:4px;">${pendingCount}</strong></div>
          <div class="chip">🔥 Streak: <strong style="margin-left:4px;">${streak}d</strong></div>
        </div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="muted" style="margin-top:6px;text-align:right;">${pct}% complete</div>
      </div>
      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;">Today — ${DAYS[todayDow]}</h3>
        <div class="stack" style="gap:8px;">${doseRows}</div>
        <p class="disclaimer" style="margin-top:12px;">Research use only. Not medical advice.</p>
      </div>
    </div>`;
}

function quickLog(planId, dayYmd) {
  const plan = App.getData().planner.find(p => p.id === planId);
  if (!plan) return;
  Tabs.switchTo('logdose');
  // Pre-fill form fields — called after renderLogDose
  setTimeout(() => {
    const pep = document.getElementById('ldPeptide');
    if (pep) { pep.value = plan.peptide; }
    const route = document.getElementById('ldRoute');
    if (route) route.value = plan.route;
    const dose = document.getElementById('ldDose');
    if (dose) dose.value = plan.dose;
    const unit = document.getElementById('ldUnit');
    if (unit) unit.value = plan.unit;
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2,'0');
    let hh = pad2(now.getHours()), mm = pad2(now.getMinutes());
    if (plan.time) { [hh, mm] = plan.time.split(':'); }
    const dt = document.getElementById('ldTakenAt');
    if (dt) dt.value = `${dayYmd}T${hh}:${mm}`;
    updateDrawMath();
  }, 50);
}
```

- [ ] **Step 3: Open browser and verify Today tab**

With a registered account + at least one planner item (add via curl or wait for Settings tab):
- Stat chips render with correct counts
- Progress bar fills proportionally
- Dose rows show DONE/PENDING badges
- "Log" button appears on pending items
- Clicking "Log" switches to Log Dose tab and pre-fills the form

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Today tab with stat chips, streak, progress bar, and quick-log"
```

---

## Task 11: index.html — Week Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace renderWeek placeholder**

```javascript
function renderWeek() {
  const data = App.getData();
  const settings = data.settings || {};
  const weekStartVal = settings.week_start || (() => {
    const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10);
  })();
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const pad2 = (n) => String(n).padStart(2,'0');
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  const todayYmd = ymd(new Date());

  function logsForDay(dayYmd) {
    const start = new Date(dayYmd + 'T00:00:00');
    const end   = new Date(dayYmd + 'T23:59:59.999');
    return (data.logs || []).filter(l => { const t = new Date(l.taken_at); return t >= start && t <= end; });
  }

  function planMatched(plan, logs) {
    return logs.some(l =>
      l.peptide === plan.peptide && l.route === plan.route && l.dose_unit === plan.unit &&
      Math.abs(Number(l.dose_value) - Number(plan.dose)) / Math.max(Math.abs(Number(plan.dose)), 1e-9) <= 0.02
    );
  }

  const cols = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStartVal + 'T00:00:00');
    d.setDate(d.getDate() + i);
    const dayYmd = ymd(d);
    const dow = d.getDay();
    const plan = (data.planner || []).filter(p => p.day === dow).sort((a, b) => (a.time||'99:99').localeCompare(b.time||'99:99'));
    const dayLogs = logsForDay(dayYmd);
    const doneCount = plan.filter(p => planMatched(p, dayLogs)).length;
    const isToday = dayYmd === todayYmd;

    const items = plan.length ? plan.map(p => {
      const matched = planMatched(p, dayLogs);
      return `<div style="padding:6px 8px;border-radius:8px;background:var(--chip-bg);border:1px solid var(--glass-border);margin-bottom:6px;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="badge ${matched ? 'badge-done' : 'badge-pending'}" style="font-size:10px;">${matched?'✓':'•'}</span>
          <strong style="font-size:12px;">${p.peptide}</strong>
        </div>
        <div class="muted" style="font-size:11px;margin-top:2px;">${p.route} · ${p.dose} ${p.unit}${p.time ? ' · '+p.time:''}</div>
        ${matched ? '' : `<button class="btn btn-ghost btn-sm" style="margin-top:4px;font-size:11px;padding:3px 8px;" onclick="quickLog('${p.id}','${dayYmd}')">Log</button>`}
      </div>`;
    }).join('') : `<p class="muted" style="font-size:12px;margin-top:8px;">No items</p>`;

    return `<div style="border-radius:12px;padding:10px;border:${isToday ? '2px solid var(--accent-sky)' : '1px solid var(--glass-border)'};background:${isToday ? 'rgba(14,165,233,0.06)' : 'var(--chip-bg)'};">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
        <div>
          <div style="font-weight:700;font-size:13px;">${DAYS[dow]}</div>
          <div class="muted" style="font-size:11px;">${dayYmd.slice(5)}</div>
        </div>
        <div class="muted" style="font-size:11px;text-align:right;">Done ${doneCount}/${plan.length}</div>
      </div>
      ${items}
    </div>`;
  }).join('');

  document.getElementById('week').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
          <h3 style="font-size:15px;font-weight:700;">Week View</h3>
          <label style="flex-direction:row;align-items:center;gap:8px;font-size:13px;">
            Week starts
            <input id="weekStartInput" type="date" style="width:auto;" value="${weekStartVal}">
          </label>
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;overflow-x:auto;">${cols}</div>
      </div>
    </div>`;

  document.getElementById('weekStartInput').addEventListener('change', async (e) => {
    const d = App.getData();
    d.settings = { ...d.settings, week_start: e.target.value };
    await API.put('/settings', d.settings).catch(() => {});
    renderWeek();
  });
}
```

- [ ] **Step 2: Verify Week tab**

Open browser → click Week tab:
- 7 columns with day names and dates
- Today's column has sky-blue border
- Done/Pending counts correct per day
- Week start date picker updates the grid

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: Week tab with 7-column grid, today highlight, and week-start picker"
```

---

## Task 12: index.html — Log Dose Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add draw math helper**

```javascript
function calcDrawMath(vialId, doseValue, doseUnit, vials) {
  const vial = vials.find(v => v.id === vialId);
  if (!vial) return null;
  const mg = Number(vial.mg), ml = Number(vial.ml);
  let mcg = null;
  if (doseUnit === 'mcg') mcg = Number(doseValue);
  else if (doseUnit === 'mg') mcg = Number(doseValue) * 1000;
  if (!Number.isFinite(mg) || !Number.isFinite(ml) || !Number.isFinite(mcg)) return null;
  const conc = (mg * 1000) / ml;
  const vol = mcg / conc;
  const iu = vol * 100;
  return { conc, vol, iu, mcg };
}

function updateDrawMath() {
  const data = App.getData();
  const vialId = document.getElementById('ldVial')?.value || null;
  const doseValue = document.getElementById('ldDose')?.value || '';
  const doseUnit = document.getElementById('ldUnit')?.value || 'mcg';
  const mathEl = document.getElementById('ldMath');
  if (!mathEl) return;
  const m = vialId ? calcDrawMath(vialId, doseValue, doseUnit, data.vials || []) : null;
  mathEl.innerHTML = m
    ? `Conc <strong>${m.conc.toFixed(0)}</strong> mcg/mL &nbsp;→&nbsp; Draw <strong>${m.vol.toFixed(3)}</strong> mL ≈ <strong>${m.iu.toFixed(1)}</strong> IU`
    : 'Select a vial + enter mcg/mg dose to see draw volume.';
}
```

- [ ] **Step 2: Replace renderLogDose placeholder**

```javascript
function renderLogDose() {
  const data = App.getData();
  const peptideOpts = (data.peptides || []).map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2,'0');
  const defaultDT = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  document.getElementById('logdose').innerHTML = `
    <div class="glass" style="padding:18px;">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Log Dose</h3>
      <div class="stack" style="gap:12px;">
        <div class="row2">
          <label><span>Peptide</span>
            <select id="ldPeptide" onchange="renderLogDose()">
              <option value="">Select…</option>${peptideOpts}
            </select>
          </label>
          <label><span>Date / Time</span>
            <input id="ldTakenAt" type="datetime-local" value="${defaultDT}">
          </label>
        </div>
        <div class="row3">
          <label><span>Route</span>
            <select id="ldRoute">
              <option>SubQ</option><option>IM</option><option>Nasal</option><option>Oral</option><option>Other</option>
            </select>
          </label>
          <label><span>Dose</span>
            <input id="ldDose" type="number" step="0.01" placeholder="e.g. 250" oninput="updateDrawMath()">
          </label>
          <label><span>Unit</span>
            <select id="ldUnit" onchange="updateDrawMath()">
              <option value="mcg">mcg</option><option value="mg">mg</option>
              <option value="IU">IU</option><option value="sprays">sprays</option>
            </select>
          </label>
        </div>
        <div class="row2">
          <label><span>Vial (optional)</span>
            <select id="ldVial" onchange="updateDrawMath()">
              <option value="">None</option>
              ${(data.vials||[]).map(v => {
                const conc = ((Number(v.mg)*1000)/Number(v.ml)).toFixed(0);
                const used = (data.logs||[]).filter(l=>l.vial_id===v.id&&Number.isFinite(Number(l.dose_mcg))).reduce((s,l)=>s+Number(l.dose_mcg),0);
                const rem = Math.max((Number(v.mg)*1000) - used, 0).toFixed(0);
                return `<option value="${v.id}">${v.peptide} · ${conc} mcg/mL · ${rem} mcg rem</option>`;
              }).join('')}
            </select>
          </label>
          <div class="glass" style="padding:12px;font-size:13px;">
            <strong>Draw math</strong>
            <div id="ldMath" class="muted" style="margin-top:6px;">Select a vial + enter mcg/mg dose to see draw volume.</div>
          </div>
        </div>
        <label><span>Notes (optional)</span>
          <textarea id="ldNotes" placeholder="fasted, bedtime, etc."></textarea>
        </label>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="saveLog()">Save Dose</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteLastLog()">Delete Last</button>
        </div>
      </div>
    </div>`;
}

async function saveLog() {
  const data = App.getData();
  const peptide = document.getElementById('ldPeptide').value;
  const route   = document.getElementById('ldRoute').value;
  const doseVal = Number(document.getElementById('ldDose').value);
  const doseUnit = document.getElementById('ldUnit').value;
  const takenAt = document.getElementById('ldTakenAt').value;
  const vialId  = document.getElementById('ldVial').value || null;
  const notes   = document.getElementById('ldNotes').value || '';

  if (!peptide) { alert('Select a peptide.'); return; }
  if (!doseVal || doseVal <= 0) { alert('Enter a dose > 0.'); return; }
  if (!takenAt) { alert('Select date/time.'); return; }

  const vial = vialId ? data.vials.find(v => v.id === vialId) : null;
  const m = vial ? calcDrawMath(vialId, doseVal, doseUnit, data.vials) : null;

  const payload = {
    peptide, route,
    dose_value: doseVal,
    dose_unit: doseUnit,
    taken_at: new Date(takenAt).toISOString(),
    vial_id: vialId,
    dose_mcg: m?.mcg ?? null,
    volume_ml: m?.vol ?? null,
    iu: m?.iu ?? null,
    notes
  };

  try {
    await API.post('/logs', payload);
    await App.loadAll();
    renderAllTabs();
    Tabs.switchTo('today');
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}

async function deleteLastLog() {
  if (!confirm('Delete the most recent log entry?')) return;
  try {
    await API.delete('/logs/last');
    await App.loadAll();
    renderAllTabs();
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}
```

- [ ] **Step 3: Verify Log Dose tab**

Open Log Dose tab:
- All fields render correctly
- Selecting a vial + entering a dose shows draw math calculation
- Saving a dose reloads all tabs and switches to Today

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Log Dose tab with draw math and save/delete endpoints wired up"
```

---

## Task 13: index.html — Vials Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Replace renderVials placeholder**

```javascript
function renderVials() {
  const data = App.getData();
  const peptideOpts = (data.peptides||[]).map(p => `<option value="${p.name}">${p.name}</option>`).join('');

  function vialRemMcg(vial) {
    const start = Number(vial.mg) * 1000;
    const used = (data.logs||[]).filter(l => l.vial_id === vial.id && Number.isFinite(Number(l.dose_mcg)))
      .reduce((s, l) => s + Number(l.dose_mcg), 0);
    return Math.max(start - used, 0);
  }

  function vialBarColor(pct) {
    if (pct > 50) return 'linear-gradient(90deg, #16a34a, #4ade80)';
    if (pct > 20) return 'linear-gradient(90deg, #d97706, #fbbf24)';
    return 'linear-gradient(90deg, #dc2626, #f87171)';
  }

  const vialRows = (data.vials||[]).map(v => {
    const conc = ((Number(v.mg)*1000)/Number(v.ml)).toFixed(0);
    const rem = vialRemMcg(v);
    const total = Number(v.mg) * 1000;
    const pct = Math.round((rem / total) * 100);
    return `<div style="padding:12px;border-radius:12px;background:var(--chip-bg);border:1px solid var(--glass-border);">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div>
          <strong>${v.peptide}</strong>
          <span class="muted" style="margin-left:8px;">${conc} mcg/mL</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="muted" style="font-size:12px;">${rem.toFixed(0)} mcg left (${pct}%)</span>
          <button class="btn btn-danger btn-sm" onclick="deleteVial('${v.id}')">Remove</button>
        </div>
      </div>
      <div class="vial-bar" style="margin-top:8px;">
        <div class="vial-fill" style="width:${pct}%;background:${vialBarColor(pct)};"></div>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No vials added yet.</p>';

  document.getElementById('vials').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Add Vial</h3>
        <div class="row3">
          <label><span>Peptide</span><select id="vPeptide"><option value="">Select…</option>${peptideOpts}</select></label>
          <label><span>Vial (mg)</span><input id="vMg" type="number" step="0.01" placeholder="e.g. 10"></label>
          <label><span>Diluent (mL)</span><input id="vMl" type="number" step="0.01" placeholder="e.g. 2"></label>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-primary" onclick="addVial()">Add Vial</button>
        </div>
      </div>
      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Active Vials</h3>
        <div class="stack" style="gap:10px;">${vialRows}</div>
      </div>
    </div>`;
}

async function addVial() {
  const peptide = document.getElementById('vPeptide').value;
  const mg = Number(document.getElementById('vMg').value);
  const ml = Number(document.getElementById('vMl').value);
  if (!peptide) { alert('Select a peptide.'); return; }
  if (!mg || mg <= 0) { alert('mg must be > 0.'); return; }
  if (!ml || ml <= 0) { alert('mL must be > 0.'); return; }
  try {
    await API.post('/vials', { peptide, mg, ml });
    await App.loadAll();
    renderAllTabs();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function deleteVial(id) {
  if (!confirm('Remove this vial? Associated log entries will lose the vial link.')) return;
  try {
    await API.delete(`/vials/${id}`);
    await App.loadAll();
    renderAllTabs();
  } catch (e) { alert('Failed: ' + e.message); }
}
```

- [ ] **Step 2: Verify Vials tab**

Open Vials tab:
- "Add Vial" form renders
- Adding a vial shows it in the list with a green progress bar (100% full)
- Logging doses against the vial reduces the progress bar (amber → red as depleted)
- Remove button works

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: Vials tab with gradient progress bars and add/remove functionality"
```

---

## Task 14: index.html — Calculator Tab (4 Modes)

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add peptide half-life data**

```javascript
const PEPTIDE_HALFLIFE = {
  'BPC-157':     { halfLife: 4,   unit: 'h', notes: 'SQ half-life ~4h' },
  'TB-500':      { halfLife: 24,  unit: 'h', notes: 'Estimated ~24h' },
  'Ipamorelin':  { halfLife: 2,   unit: 'h', notes: '~2h' },
  'CJC-1295':    { halfLife: 168, unit: 'h', notes: 'DAC form: ~7 days' },
  'Tesamorelin': { halfLife: 0.5, unit: 'h', notes: '~26 min' },
  'Sermorelin':  { halfLife: 0.3, unit: 'h', notes: '~11-12 min' },
  'PT-141':      { halfLife: 2.5, unit: 'h', notes: '~2-3h' },
  'Retatrutide': { halfLife: 168, unit: 'h', notes: '~7 days (estimate)' },
  'Epithalon':   { halfLife: 0.5, unit: 'h', notes: 'Short, repeat dosing' },
  'Semax':       { halfLife: 0.1, unit: 'h', notes: 'Intranasal: mins' },
  'Selank':      { halfLife: 0.1, unit: 'h', notes: 'Intranasal: mins' },
  'Thymosin Alpha-1': { halfLife: 2, unit: 'h', notes: '~2h' },
  'MOTS-C':      { halfLife: 0.5, unit: 'h', notes: 'Short' },
  'IGF-1 LR3':   { halfLife: 20,  unit: 'h', notes: '~20-30h' },
  'GHK-CU':      { halfLife: 1,   unit: 'h', notes: '~1h' },
};
```

- [ ] **Step 2: Replace renderCalc placeholder**

```javascript
function renderCalc() {
  const data = App.getData();
  const peptideOpts = (data.peptides||[]).map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  const hlPeptideOpts = Object.keys(PEPTIDE_HALFLIFE).map(n => `<option value="${n}">${n}</option>`).join('');

  document.getElementById('calc').innerHTML = `
    <div class="glass" style="padding:18px;">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Calculator</h3>
      <div class="nav-pill" id="calcNav" style="margin-bottom:16px;">
        <button class="nav-tab active" data-ctab="recon">Reconstitution</button>
        <button class="nav-tab" data-ctab="draw">Draw</button>
        <button class="nav-tab" data-ctab="cost">Cycle Cost</button>
        <button class="nav-tab" data-ctab="halflife">Half-Life</button>
      </div>

      <div id="calcRecon" class="ctab-content" style="display:block;">
        <div class="stack" style="gap:12px;">
          <div class="row2">
            <label><span>Vial size (mg)</span><input id="rcVialMg" type="number" step="0.01" placeholder="e.g. 10" oninput="calcRecon()"></label>
            <label><span>Diluent to add (mL)</span><input id="rcDiluent" type="number" step="0.01" placeholder="e.g. 2" oninput="calcRecon()"></label>
          </div>
          <div id="rcResult" class="glass" style="padding:12px;display:none;">
            <div id="rcResultBody" class="muted" style="font-size:13px;"></div>
          </div>
          <hr class="divider">
          <div class="row3">
            <label><span>Desired dose (mcg)</span><input id="rcDose" type="number" step="0.01" placeholder="e.g. 250" oninput="calcRecon()"></label>
            <div id="rcDrawResult" class="glass" style="padding:12px;grid-column:span 2;">
              <div class="muted" style="font-size:13px;">Enter vial + diluent above, then desired dose.</div>
            </div>
          </div>
        </div>
      </div>

      <div id="calcDraw" class="ctab-content" style="display:none;">
        <div class="stack" style="gap:12px;">
          <div class="row2">
            <label><span>Concentration (mcg/mL)</span><input id="drawConc" type="number" step="0.01" placeholder="e.g. 500" oninput="calcDraw()"></label>
            <label><span>Desired dose</span>
              <div style="display:flex;gap:6px;">
                <input id="drawDose" type="number" step="0.01" placeholder="e.g. 250" oninput="calcDraw()" style="flex:1;">
                <select id="drawUnit" onchange="calcDraw()">
                  <option value="mcg">mcg</option><option value="mg">mg</option>
                </select>
              </div>
            </label>
          </div>
          <div style="margin-top:-4px;margin-bottom:4px;">
            <label><span>Or select existing vial to auto-fill concentration</span>
              <select id="drawVial" onchange="drawFromVial()" style="max-width:320px;">
                <option value="">Select vial…</option>
                ${(data.vials||[]).map(v => `<option value="${(Number(v.mg)*1000/Number(v.ml)).toFixed(2)}">${v.peptide} · ${(Number(v.mg)*1000/Number(v.ml)).toFixed(0)} mcg/mL</option>`).join('')}
              </select>
            </label>
          </div>
          <div id="drawResult" class="glass" style="padding:12px;font-size:13px;" class="muted">Enter concentration and dose above.</div>
        </div>
      </div>

      <div id="calcCost" class="ctab-content" style="display:none;">
        <div class="stack" style="gap:12px;">
          <div class="row2">
            <label><span>Peptide</span><select id="costPep"><option value="">Select…</option>${peptideOpts}</select></label>
            <label><span>Dose per injection (mcg)</span><input id="costDose" type="number" step="0.01" placeholder="e.g. 250" oninput="calcCost()"></label>
          </div>
          <div class="row3">
            <label><span>Frequency (times/week)</span><input id="costFreq" type="number" step="0.5" placeholder="e.g. 7" oninput="calcCost()"></label>
            <label><span>Cycle length (weeks)</span><input id="costWeeks" type="number" step="1" placeholder="e.g. 12" oninput="calcCost()"></label>
            <label><span>Price per mg ($)</span><input id="costPpm" type="number" step="0.01" placeholder="e.g. 2.50" oninput="calcCost()"></label>
          </div>
          <div id="costResult" class="glass" style="padding:12px;font-size:13px;display:none;"><div id="costResultBody"></div></div>
        </div>
      </div>

      <div id="calcHL" class="ctab-content" style="display:none;">
        <div class="stack" style="gap:12px;">
          <div class="row2">
            <label><span>Peptide (auto-fills half-life)</span>
              <select id="hlPeptide" onchange="hlFromPeptide()">
                <option value="">Select or enter manually…</option>${hlPeptideOpts}
              </select>
            </label>
            <label><span>Half-life (hours)</span><input id="hlHours" type="number" step="0.01" placeholder="e.g. 4" oninput="calcHL()"></label>
          </div>
          <div id="hlResult" class="glass" style="padding:12px;font-size:13px;display:none;"><div id="hlResultBody"></div></div>
        </div>
      </div>

      <p class="disclaimer" style="margin-top:16px;">For research and personal tracking only. Always verify calculations independently.</p>
    </div>`;

  // Sub-tab nav
  document.getElementById('calcNav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ctab]');
    if (!btn) return;
    const id = btn.dataset.ctab;
    document.querySelectorAll('#calcNav .nav-tab').forEach(b => b.classList.toggle('active', b.dataset.ctab === id));
    document.querySelectorAll('.ctab-content').forEach(c => c.style.display = c.id === `calc${id.charAt(0).toUpperCase()+id.slice(1)}` ? 'block' : 'none');
  });
}

function calcRecon() {
  const mg = Number(document.getElementById('rcVialMg')?.value);
  const ml = Number(document.getElementById('rcDiluent')?.value);
  const dose = Number(document.getElementById('rcDose')?.value);
  const resEl = document.getElementById('rcResult');
  const drawEl = document.getElementById('rcDrawResult');
  if (!resEl) return;

  if (mg > 0 && ml > 0) {
    const conc = (mg * 1000) / ml;
    const totalMcg = mg * 1000;
    resEl.style.display = 'block';
    document.getElementById('rcResultBody').innerHTML =
      `Concentration: <strong>${conc.toFixed(0)} mcg/mL</strong><br>Total: <strong>${totalMcg.toFixed(0)} mcg</strong> in <strong>${ml} mL</strong>`;
    if (dose > 0) {
      const vol = dose / conc;
      drawEl.innerHTML = `Draw <strong>${vol.toFixed(3)} mL</strong> ≈ <strong>${(vol*100).toFixed(1)} IU</strong> for ${dose} mcg`;
    } else {
      drawEl.innerHTML = '<span class="muted">Enter desired dose (mcg) to see draw volume.</span>';
    }
  } else {
    resEl.style.display = 'none';
  }
}

function calcDraw() {
  const conc = Number(document.getElementById('drawConc')?.value);
  const dose = Number(document.getElementById('drawDose')?.value);
  const unit = document.getElementById('drawUnit')?.value || 'mcg';
  const el = document.getElementById('drawResult');
  if (!el) return;
  if (conc > 0 && dose > 0) {
    const mcg = unit === 'mg' ? dose * 1000 : dose;
    const vol = mcg / conc;
    el.innerHTML = `Draw <strong>${vol.toFixed(3)} mL</strong> ≈ <strong>${(vol*100).toFixed(1)} IU</strong>`;
  } else {
    el.innerHTML = '<span class="muted">Enter concentration and dose above.</span>';
  }
}

function drawFromVial() {
  const val = document.getElementById('drawVial')?.value;
  if (val) {
    const concInput = document.getElementById('drawConc');
    if (concInput) { concInput.value = Number(val).toFixed(0); calcDraw(); }
  }
}

function calcCost() {
  const dose = Number(document.getElementById('costDose')?.value);
  const freq = Number(document.getElementById('costFreq')?.value);
  const weeks = Number(document.getElementById('costWeeks')?.value);
  const ppm = Number(document.getElementById('costPpm')?.value);
  const el = document.getElementById('costResult');
  if (!el || !dose || !freq || !weeks) return;
  el.style.display = 'block';
  const totalMcg = dose * freq * weeks;
  const totalMg = totalMcg / 1000;
  const vials10mg = Math.ceil(totalMg / 10);
  const vials5mg  = Math.ceil(totalMg / 5);
  const cost = ppm > 0 ? `$${(totalMg * ppm).toFixed(2)}` : 'N/A';
  document.getElementById('costResultBody').innerHTML =
    `Total: <strong>${totalMcg.toFixed(0)} mcg</strong> = <strong>${totalMg.toFixed(2)} mg</strong><br>
     Vials needed: <strong>${vials10mg}</strong> × 10mg vials <em>or</em> <strong>${vials5mg}</strong> × 5mg vials<br>
     Estimated cost: <strong>${cost}</strong>`;
}

function hlFromPeptide() {
  const name = document.getElementById('hlPeptide')?.value;
  const data = name ? PEPTIDE_HALFLIFE[name] : null;
  if (data) {
    const inp = document.getElementById('hlHours');
    if (inp) { inp.value = data.halfLife; calcHL(); }
  }
}

function calcHL() {
  const hl = Number(document.getElementById('hlHours')?.value);
  const el = document.getElementById('hlResult');
  if (!el || !hl || hl <= 0) return;
  el.style.display = 'block';
  const t50  = hl;
  const t25  = hl * 2;
  const t12  = hl * 3;
  const minInterval = (hl * Math.log(2)).toFixed(1);
  document.getElementById('hlResultBody').innerHTML =
    `50% remaining at: <strong>${t50}h</strong><br>
     25% remaining at: <strong>${t25}h</strong><br>
     12.5% remaining at: <strong>${t12}h</strong><br>
     Min dosing interval (1 half-life): <strong>${hl}h</strong>`;
}
```

- [ ] **Step 3: Verify Calculator tab**

Open Calculator tab:
- 4 sub-tabs: Reconstitution, Draw, Cycle Cost, Half-Life
- **Reconstitution:** Enter 10mg vial, 2mL diluent → shows 5000 mcg/mL, 10000 mcg total. Enter 250mcg dose → shows 0.050 mL ≈ 5.0 IU
- **Draw:** Enter 5000 mcg/mL, 500 mcg → shows 0.100 mL ≈ 10.0 IU
- **Cycle Cost:** 500 mcg × 7×/wk × 12 wks × $2/mg → shows 42000 mcg, 42mg, 5 × 10mg vials, $84.00
- **Half-Life:** Select BPC-157 → auto-fills 4h → shows 50% at 4h, 25% at 8h, 12.5% at 12h
- Disclaimer appears below

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Calculator tab with 4 modes — Reconstitution, Draw, Cycle Cost, Half-Life"
```

---

## Task 15: index.html — Library Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the peptide library data object**

```javascript
const PEPTIDE_LIBRARY = [
  { name: 'BPC-157', aliases: ['Body Protection Compound'],
    description: 'Synthetic pentadecapeptide derived from human gastric juice. Studied for GI healing, tendon/ligament repair, and neuroprotection.',
    halfLife: '~4h (SubQ)', doseRange: '200–500 mcg/day', route: 'SubQ / IM / Oral',
    mechanism: 'Upregulates growth hormone receptor expression; promotes angiogenesis via VEGFR2; modulates dopaminergic and serotonergic systems.',
    protocols: '200–500 mcg/day for 4–12 weeks. SubQ near injury site or oral for GI.',
    cycleLength: '4–12 weeks', stack: 'Often stacked with TB-500 for connective tissue repair.' },
  { name: 'TB-500', aliases: ['Thymosin Beta-4'],
    description: 'Synthetic version of naturally occurring Thymosin Beta-4. Studied for muscle repair, wound healing, and reduced inflammation.',
    halfLife: '~24h', doseRange: '2–2.5 mg twice weekly',  route: 'SubQ / IM',
    mechanism: 'Promotes actin polymerization, cell migration, and angiogenesis. Reduces inflammation via NF-κB pathway.',
    protocols: 'Loading: 4–6 mg/week × 4–6 weeks. Maintenance: 2 mg/week.',
    cycleLength: '4–8 weeks', stack: 'Commonly paired with BPC-157.' },
  { name: 'Ipamorelin', aliases: ['IPAM'],
    description: 'Selective GH secretagogue / GHRP. Studied for GH release with minimal effect on cortisol and prolactin.',
    halfLife: '~2h', doseRange: '100–300 mcg 2–3×/day', route: 'SubQ / IM',
    mechanism: 'Selective agonist of the ghrelin/GHS-R1a receptor. Stimulates pulsatile GH release from the pituitary.',
    protocols: '100–300 mcg pre-sleep or post-workout. Often combined with CJC-1295 without DAC.',
    cycleLength: '8–12 weeks', stack: 'Synergistic with CJC-1295 (GHRH analog).' },
  { name: 'CJC-1295', aliases: ['CJC-1295 w/ DAC', 'CJC-1295 no DAC', 'Mod GRF 1-29'],
    description: 'GHRH analog. DAC version has extended half-life (~7 days). No-DAC version mirrors natural GH pulse.',
    halfLife: 'No DAC: ~30 min · DAC: ~7 days', doseRange: '100–200 mcg (no DAC); 1–2 mg/week (DAC)', route: 'SubQ / IM',
    mechanism: 'Mimics GHRH; binds and activates GHRH receptors in the pituitary to amplify GH release.',
    protocols: 'No DAC: 100 mcg 2–3×/day with GHRP. DAC: 1–2 mg once or twice weekly.',
    cycleLength: '8–12 weeks', stack: 'Standard stack: CJC-1295 no DAC + Ipamorelin.' },
  { name: 'Semax', aliases: ['ACTH(4-10) analog'],
    description: 'Synthetic peptide analog of ACTH(4-7). Nootropic studied for cognitive enhancement, neuroprotection, and anxiety reduction.',
    halfLife: 'Minutes (intranasal)', doseRange: '100–300 mcg/day intranasal', route: 'Nasal',
    mechanism: 'Modulates BDNF and NGF levels; acts on melanocortin receptors; influences dopaminergic and serotonergic systems.',
    protocols: '100–300 mcg intranasally 1–2×/day for 2–4 weeks.',
    cycleLength: '2–4 weeks', stack: 'Often used with Selank.' },
  { name: 'PT-141', aliases: ['Bremelanotide'],
    description: 'Melanocortin receptor agonist studied for sexual dysfunction in both males and females.',
    halfLife: '~2.5h', doseRange: '500 mcg–2 mg as needed', route: 'SubQ / Nasal',
    mechanism: 'Agonist of MC3R and MC4R in the CNS, activating neural pathways involved in sexual arousal.',
    protocols: '500 mcg–2 mg SubQ 30–45 min before activity. Max 1×/72h.',
    cycleLength: 'As needed', stack: 'Not typically stacked.' },
  { name: 'Retatrutide', aliases: ['GLP-1/GIP/Glucagon triple agonist'],
    description: 'Triagonist peptide studied for weight loss and metabolic improvement. Phase 2 trials showed significant weight reduction.',
    halfLife: '~7 days', doseRange: '1–12 mg/week (research doses)', route: 'SubQ',
    mechanism: 'Simultaneous agonism of GLP-1R, GIPR, and glucagon receptor; reduces appetite, increases energy expenditure.',
    protocols: 'Gradual dose escalation starting at 1 mg/week. See current literature for protocols.',
    cycleLength: 'Ongoing / long-term', stack: 'Research stage — limited stacking data.' },
  { name: 'Epithalon', aliases: ['Epitalon', 'Epithalamin'],
    description: 'Synthetic tetrapeptide studied for telomerase activation, longevity, and anti-aging effects.',
    halfLife: 'Short', doseRange: '10 mg/day × 10–20 days', route: 'SubQ / IM / Nasal',
    mechanism: 'Activates telomerase, may elongate telomeres; regulates melatonin production in the pineal gland.',
    protocols: '5–10 mg/day for 10–20 days, 1–2× per year.',
    cycleLength: '10–20 days', stack: 'Sometimes used with GHK-Cu.' },
  { name: 'GHK-Cu', aliases: ['Copper peptide'],
    description: 'Naturally occurring copper complex. Studied for wound healing, collagen synthesis, and anti-aging skin effects.',
    halfLife: '~1h', doseRange: '1–3 mg/day SubQ or topical', route: 'SubQ / Topical',
    mechanism: 'Promotes collagen and glycosaminoglycan synthesis; anti-inflammatory; activates wound healing genes.',
    protocols: '1–3 mg/day SubQ or topical 1–2×/day.',
    cycleLength: '4–8 weeks', stack: 'BPC-157 for tissue repair synergy.' },
  { name: 'Selank', aliases: ['Thr-Lys-Pro-Arg-Pro-Gly-Pro'],
    description: 'Anxiolytic peptide analog of tuftsin. Studied for anxiety, stress reduction, and cognitive enhancement.',
    halfLife: 'Minutes (intranasal)', doseRange: '250–500 mcg intranasally 1–3×/day', route: 'Nasal',
    mechanism: 'Modulates GABA, serotonin, and dopamine systems; increases BDNF.',
    protocols: '250–500 mcg intranasally 1–3×/day for 10–14 day cycles.',
    cycleLength: '10–14 days', stack: 'Often combined with Semax.' },
];
```

- [ ] **Step 2: Replace renderLibrary placeholder**

```javascript
function renderLibrary() {
  let filterText = '';

  function renderCards() {
    const q = filterText.toLowerCase();
    const filtered = PEPTIDE_LIBRARY.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.aliases || []).some(a => a.toLowerCase().includes(q)) ||
      p.description.toLowerCase().includes(q)
    );

    const cards = filtered.map(p => `
      <div class="glass" style="padding:16px;cursor:pointer;" onclick="showLibraryDetail('${p.name}')">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
          <div>
            <strong style="font-size:15px;">${p.name}</strong>
            ${p.aliases?.length ? `<span class="muted" style="font-size:12px;margin-left:8px;">${p.aliases[0]}</span>` : ''}
          </div>
          <span class="badge badge-info">Research</span>
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin-top:8px;line-height:1.5;">${p.description}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
          <span class="chip">⏱ ${p.halfLife}</span>
          <span class="chip">💊 ${p.doseRange}</span>
          <span class="chip">📍 ${p.route}</span>
        </div>
      </div>`).join('') || '<p class="muted">No matching peptides.</p>';

    document.getElementById('libCards').innerHTML = cards;
  }

  document.getElementById('library').innerHTML = `
    <div class="stack">
      <div class="glass" style="padding:16px;">
        <input id="libSearch" type="search" placeholder="Search peptides by name or description…"
          oninput="document._libFilter=this.value;document._renderLibCards()">
      </div>
      <div id="libCards" class="stack"></div>
      <p class="disclaimer">All peptides listed for research purposes only. Information is educational and not intended as medical advice.</p>
    </div>`;

  document.getElementById('libSearch').addEventListener('input', (e) => {
    filterText = e.target.value;
    renderCards();
  });

  renderCards();
}

function showLibraryDetail(name) {
  const p = PEPTIDE_LIBRARY.find(x => x.name === name);
  if (!p) return;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="glass" style="max-width:560px;width:100%;max-height:90vh;overflow-y:auto;padding:24px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="font-size:20px;font-weight:800;">${p.name}</h2>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('[style*=fixed]').remove()">Close</button>
      </div>
      <span class="badge badge-info" style="margin-bottom:12px;">Research Only</span>
      <div class="stack" style="gap:12px;margin-top:12px;">
        <div><strong class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Description</strong><p style="font-size:14px;margin-top:4px;line-height:1.6;">${p.description}</p></div>
        <div><strong class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Mechanism</strong><p style="font-size:13px;margin-top:4px;line-height:1.5;color:var(--text-muted);">${p.mechanism}</p></div>
        <div class="row2">
          <div><strong class="muted" style="font-size:11px;text-transform:uppercase;">Half-Life</strong><p style="margin-top:4px;">${p.halfLife}</p></div>
          <div><strong class="muted" style="font-size:11px;text-transform:uppercase;">Dose Range</strong><p style="margin-top:4px;">${p.doseRange}</p></div>
        </div>
        <div><strong class="muted" style="font-size:11px;text-transform:uppercase;">Common Protocols</strong><p style="font-size:13px;margin-top:4px;line-height:1.5;color:var(--text-muted);">${p.protocols}</p></div>
        <div><strong class="muted" style="font-size:11px;text-transform:uppercase;">Cycle Length</strong><p style="margin-top:4px;">${p.cycleLength}</p></div>
        <div><strong class="muted" style="font-size:11px;text-transform:uppercase;">Stack Notes</strong><p style="font-size:13px;margin-top:4px;line-height:1.5;color:var(--text-muted);">${p.stack}</p></div>
      </div>
      <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="useInCalc('${p.name}')">Use in Calculator</button>
        <button class="btn btn-ghost btn-sm" onclick="this.closest('[style*=fixed]').remove()">Close</button>
      </div>
      <p class="disclaimer" style="margin-top:12px;">Research purposes only. Not medical advice.</p>
    </div>`;
  document.body.appendChild(overlay);
}

function useInCalc(peptideName) {
  document.querySelector('[style*=fixed]')?.remove();
  Tabs.switchTo('calc');
  setTimeout(() => {
    const hl = PEPTIDE_HALFLIFE[peptideName];
    const hlSel = document.getElementById('hlPeptide');
    if (hlSel && hl) {
      document.querySelectorAll('#calcNav .nav-tab').forEach(b => b.classList.toggle('active', b.dataset.ctab === 'halflife'));
      document.querySelectorAll('.ctab-content').forEach(c => c.style.display = c.id === 'calcHL' ? 'block' : 'none');
      hlSel.value = peptideName;
      hlFromPeptide();
    }
  }, 50);
}
```

- [ ] **Step 3: Verify Library tab**

Open Library tab:
- 10 peptide cards render with name, description, half-life, dose range, route chips
- Search bar filters cards in real-time
- Clicking a card opens a detail modal with mechanism, protocols, stack notes
- "Use in Calculator" button closes the modal, switches to Calculator, switches to Half-Life sub-tab, and pre-fills the peptide

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: Library tab with searchable peptide cards, detail modal, and Calculator integration"
```

---

## Task 16: index.html — Settings Tab

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add peptide constants list and replace renderSettings placeholder**

```javascript
const DEFAULT_PEPTIDES = [
  "5-amino-1mq","AICAR","AOD-9604","ARA-290","Adalank","Adamax","BPC-157","Cerebrolysin","CJC-1295",
  "CJC-195/IPA","DSIP","Dihexa","Epithalon","GHK-CU","GhRIP","Glow","Glutathione","IGF-1 LR3",
  "Ipamorelin","KPV","Kisspeptin","Klow","LL-37","Lipo-C","MOTS-C","NAD+","Oxytocin","PE-22-28",
  "PT-141","Pinealon","Retatrutide","SS-31","SLU-PP-332","Semax","Selank","Sermorelin","TB-500",
  "Tesamorelin","Thymosin Alpha-1","VIP","Wolverine"
];

function renderSettings() {
  const data = App.getData();
  const s = data.settings || {};
  const theme = App.getTheme();
  const peptideChips = (data.peptides || []).map(p =>
    `<span class="chip" style="gap:8px;">${p}
      <button class="btn btn-ghost btn-sm" style="padding:1px 6px;" onclick="removePeptide('${p}')">×</button>
    </span>`).join('');

  document.getElementById('settings').innerHTML = `
    <div class="stack">

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Account</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">Signed in as <strong>${App.getEmail()}</strong></p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="showChangePassword()">Change Password</button>
          <button class="btn btn-danger btn-sm" onclick="doSignOut()">Sign Out</button>
        </div>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Push Notifications</h3>
        <p class="muted" style="margin-bottom:10px;">Receive reminders when planned doses are due.</p>
        <button class="btn btn-ghost btn-sm" id="pushBtn" onclick="togglePush()">Enable Notifications</button>
        <p id="pushStatus" class="muted" style="margin-top:8px;font-size:12px;"></p>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Theme</h3>
        <div style="display:flex;gap:8px;">
          ${['light','dark','system'].map(t =>
            `<button class="btn ${theme===t ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="setTheme('${t}')">${t.charAt(0).toUpperCase()+t.slice(1)}</button>`
          ).join('')}
        </div>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Peptide List</h3>
        <div class="row2" style="margin-bottom:12px;">
          <input id="newPeptideInput" placeholder="e.g. BPC-157" style="flex:1;">
          <button class="btn btn-ghost btn-sm" onclick="addPeptide()">Add Peptide</button>
        </div>
        <button class="btn btn-ghost btn-sm" style="margin-bottom:10px;" onclick="resetPeptides()">Reset to Defaults</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">${peptideChips}</div>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Cycle Dates</h3>
        <div class="row2">
          <label><span>Cycle start</span><input id="cycleStart" type="date" value="${s.cycle_start||''}"></label>
          <label><span>Cycle end</span><input id="cycleEnd" type="date" value="${s.cycle_end||''}"></label>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="saveCycleDates()">Save</button>
          <button class="btn btn-danger btn-sm" onclick="clearCycleDates()">Clear</button>
        </div>
        <p id="cycleSummary" class="muted" style="margin-top:8px;font-size:12px;">
          ${s.cycle_start && s.cycle_end ? s.cycle_start + ' → ' + s.cycle_end : '—'}
        </p>
      </div>

      <div class="glass" style="padding:18px;">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px;">Export</h3>
        <button class="btn btn-ghost btn-sm" onclick="exportCSV()">Download CSV</button>
      </div>

      <div class="glass" style="padding:18px;border-color:rgba(239,68,68,0.3);">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:10px;color:#ef4444;">Danger Zone</h3>
        <button class="btn btn-danger btn-sm" onclick="deleteAllData()">Delete All My Data</button>
      </div>

      <div class="disclaimer" style="margin-top:4px;">
        <p>PeptideOS is for personal tracking of research use only. All information is educational. This is not medical advice.<br>
        <a href="/terms" style="color:var(--accent-sky);">Terms of Service</a> &nbsp;·&nbsp;
        <a href="/privacy" style="color:var(--accent-sky);">Privacy Policy</a><br>
        © 2026 CW Enterprises. All rights reserved.</p>
      </div>

    </div>`;

  updatePushButtonState();
}

function setTheme(t) {
  App.applyTheme(t);
  API.put('/settings', { ...App.getData().settings, theme: t }).catch(() => {});
  renderSettings();
}

async function addPeptide() {
  const name = (document.getElementById('newPeptideInput')?.value || '').trim();
  if (!name) return;
  const exists = (App.getData().peptides || []).some(p => p.name.toLowerCase() === name.toLowerCase());
  if (exists) { alert('Already in list.'); return; }
  try {
    await API.post('/peptides', { name });
    await App.loadAll();
    renderAllTabs();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function removePeptide(name) {
  const d = App.getData();
  const used = (d.planner||[]).some(x=>x.peptide===name) || (d.logs||[]).some(x=>x.peptide===name) || (d.vials||[]).some(x=>x.peptide===name);
  if (used) { alert('Peptide is used in planner/logs/vials. Remove those entries first.'); return; }
  const pep = (d.peptides||[]).find(p => p.name === name);
  if (!pep) return;
  try {
    await API.delete(`/peptides/${pep.id}`);
    await App.loadAll();
    renderAllTabs();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function resetPeptides() {
  if (!confirm('Reset peptide list to defaults? Custom entries will be removed if unused.')) return;
  const d = App.getData();
  // Remove peptides not in defaults and not in use
  const toRemove = (d.peptides||[]).filter(p => {
    const inDefault = DEFAULT_PEPTIDES.includes(p.name);
    const inUse = (d.planner||[]).some(x=>x.peptide===p.name) || (d.logs||[]).some(x=>x.peptide===p.name) || (d.vials||[]).some(x=>x.peptide===p.name);
    return !inDefault && !inUse;
  });
  for (const p of toRemove) {
    await API.delete(`/peptides/${p.id}`).catch(() => {});
  }
  // Add any defaults not yet present
  const existing = new Set((d.peptides||[]).map(p => p.name.toLowerCase()));
  for (const name of DEFAULT_PEPTIDES) {
    if (!existing.has(name.toLowerCase())) {
      await API.post('/peptides', { name }).catch(() => {});
    }
  }
  await App.loadAll();
  renderAllTabs();
}

async function saveCycleDates() {
  const d = App.getData();
  const newSettings = { ...d.settings, cycle_start: document.getElementById('cycleStart')?.value || null, cycle_end: document.getElementById('cycleEnd')?.value || null };
  try {
    await API.put('/settings', newSettings);
    await App.loadAll();
    renderSettings();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function clearCycleDates() {
  const d = App.getData();
  const newSettings = { ...d.settings, cycle_start: null, cycle_end: null };
  try {
    await API.put('/settings', newSettings);
    await App.loadAll();
    renderSettings();
  } catch (e) { alert('Failed: ' + e.message); }
}

async function doSignOut() {
  if (!confirm('Sign out?')) return;
  await App.logout();
  showAuth('login');
}

function showChangePassword() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="glass" style="max-width:360px;width:100%;padding:24px;">
      <h3 style="margin-bottom:16px;">Change Password</h3>
      <div class="stack" style="gap:12px;">
        <label><span>New password</span><input id="cpPass" type="password" placeholder="8+ characters"></label>
        <label><span>Confirm new password</span><input id="cpPass2" type="password"></label>
        <p id="cpErr" class="auth-error"></p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary btn-sm" onclick="doChangePassword()">Update</button>
          <button class="btn btn-ghost btn-sm" onclick="this.closest('[style*=fixed]').remove()">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function doChangePassword() {
  const pass  = document.getElementById('cpPass')?.value;
  const pass2 = document.getElementById('cpPass2')?.value;
  const errEl = document.getElementById('cpErr');
  if (!errEl) return;
  if (!pass || pass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (pass !== pass2) { errEl.textContent = 'Passwords do not match.'; return; }
  try {
    // Use reset flow: logout, forgot, then user completes reset via email
    // For direct change: we need an authenticated change endpoint — add to worker
    await API.post('/auth/change-password', { password: pass });
    document.querySelector('[style*=fixed]')?.remove();
    alert('Password updated.');
  } catch (e) {
    if (errEl) errEl.textContent = e.message;
  }
}

function exportCSV() {
  const d = App.getData();
  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const esc = (s) => {
    s = String(s ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const csv = (rows) => rows.length
    ? [Object.keys(rows[0]).join(','), ...rows.map(r => Object.keys(rows[0]).map(k => esc(r[k])).join(','))].join('\n') : '';

  const blob = new Blob([
    `# CYCLE\ncycleStart,cycleEnd\n${esc(d.settings?.cycle_start||'')},${esc(d.settings?.cycle_end||'')}\n\n` +
    `# PLANNER\n${csv((d.planner||[]).map(p=>({day:DAYS[p.day],time:p.time,peptide:p.peptide,route:p.route,dose:p.dose,unit:p.unit,note:p.note||''})   ))}\n\n` +
    `# VIALS\n${csv(d.vials||[])}\n\n` +
    `# LOGS\n${csv(d.logs||[])}\n`
  ], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'peptideos_export.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}

async function deleteAllData() {
  if (!confirm('Delete ALL your data permanently? This cannot be undone.')) return;
  if (!confirm('Are you sure? All planner, vial, and log data will be deleted.')) return;
  try {
    await API.delete('/account');
    await App.logout();
    showAuth('login');
  } catch (e) { alert('Failed: ' + e.message); }
}

// Push notification helpers
function updatePushButtonState() {
  const btn = document.getElementById('pushBtn');
  const status = document.getElementById('pushStatus');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.textContent = 'Not supported in this browser';
    btn.disabled = true;
    return;
  }
  if (Notification.permission === 'granted') {
    btn.textContent = 'Disable Notifications';
    if (status) status.textContent = 'Push notifications are enabled.';
  } else {
    btn.textContent = 'Enable Notifications';
    if (status) status.textContent = Notification.permission === 'denied' ? 'Blocked — change in browser settings.' : '';
  }
}

async function togglePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'granted') {
    // Unsubscribe
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      await API.delete('/push/subscribe', { endpoint: sub.endpoint }).catch(() => {});
    }
    updatePushButtonState();
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { updatePushButtonState(); return; }
  try {
    const { publicKey } = await API.get('/push/vapid-key');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await API.post('/push/subscribe', { endpoint: sub.endpoint, keys: { p256dh: sub.getKey('p256dh') ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))) : '', auth: sub.getKey('auth') ? btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))) : '' } });
    updatePushButtonState();
  } catch (e) {
    alert('Push subscription failed: ' + e.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw.split('').map(c => c.charCodeAt(0)));
}
```

- [ ] **Step 2: Add change-password endpoint to worker/index.js**

In `handleAPI`, add:
```javascript
  if (path === '/auth/change-password' && method === 'POST') return authChangePassword(request, env);
  if (path === '/account' && method === 'DELETE') return deleteAccount(request, env);
```

Add the implementations:
```javascript
async function authChangePassword(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  const { password } = await request.json().catch(() => ({}));
  if (!password || password.length < 8) return err('password must be at least 8 characters');
  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();
  return json({ ok: true });
}

async function deleteAccount(request, env) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return json({ ok: true });
}
```

- [ ] **Step 3: Verify Settings tab**

Open Settings tab:
- Account section shows logged-in email
- Theme toggle switches between light/dark/system — persists on reload
- Peptide management: add a new peptide → appears in chips; x button removes it
- Cycle dates: save → summary shows dates; clear → shows "—"
- Export → downloads a CSV file with planner, vials, logs sections
- Change password modal opens, validates, and updates

- [ ] **Step 4: Commit**

```bash
git add index.html worker/index.js
git commit -m "feat: Settings tab with account, theme toggle, peptide list, cycle dates, export, and danger zone"
```

---

## Task 17: PWA — manifest.json & Service Worker

**Files:**
- Create: `manifest.json`
- Create: `service-worker.js`

- [ ] **Step 1: Create manifest.json**

```json
{
  "name": "PeptideOS",
  "short_name": "PeptideOS",
  "description": "Personal peptide tracking and research tool",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#e8f4fd",
  "theme_color": "#0ea5e9",
  "icons": [
    { "src": "/mini.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 2: Create service-worker.js**

```javascript
const CACHE_NAME = 'peptideos-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.json', '/mini.svg'];
const DB_NAME = 'peptideos_offline';
const STORE_NAME = 'queue';

// Open IndexedDB for offline queue
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = reject;
  });
}

async function enqueue(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
}

async function dequeueAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const all = [];
    store.openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { all.push(cursor.value); store.delete(cursor.primaryKey); cursor.continue(); }
      else resolve(all);
    };
    tx.onerror = reject;
  });
}

// Install: cache shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

// Activate: clear old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: cache-first for shell, network-first for API, queue mutations when offline
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API requests
  if (url.pathname.startsWith('/api/')) {
    const method = e.request.method;
    if (method === 'GET') {
      // Network first for GET API calls
      e.respondWith(
        fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        }))
      );
    } else if (['POST', 'PUT', 'DELETE'].includes(method)) {
      // Try network; if offline, queue the mutation
      e.respondWith(
        fetch(e.request.clone()).catch(async () => {
          const body = await e.request.text().catch(() => '');
          await enqueue({ url: e.request.url, method, headers: Object.fromEntries(e.request.headers), body, timestamp: Date.now() });
          return new Response(JSON.stringify({ queued: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
        })
      );
    }
    return;
  }

  // Shell: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }))
  );
});

// Background sync: flush offline queue on reconnect
self.addEventListener('sync', (e) => {
  if (e.tag === 'flush-queue') {
    e.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const entries = await dequeueAll();
  for (const entry of entries) {
    try {
      await fetch(entry.url, { method: entry.method, headers: entry.headers, body: entry.body || undefined });
    } catch {
      // Re-enqueue on failure
      await enqueue(entry);
    }
  }
}

// Push notification handler
self.addEventListener('push', (e) => {
  const data = e.data?.json() || { title: 'PeptideOS', body: 'Dose reminder' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || '/mini.svg',
      badge: '/mini.svg',
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/'));
});
```

- [ ] **Step 3: Register the service worker in index.html**

Add this at the end of the `<script>` block, after `renderAllTabs()`:

```javascript
// Service worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').then(reg => {
    console.log('SW registered');
    // When back online, trigger background sync
    window.addEventListener('online', () => reg.sync?.register('flush-queue').catch(() => {}));
  }).catch(err => console.warn('SW registration failed:', err));
}
```

- [ ] **Step 4: Verify PWA install + offline behavior**

In Chrome, open DevTools → Application → Service Workers:
- SW should show as "activated and is running"

Application → Manifest:
- Should show "PeptideOS" with icons

Network tab → set to "Offline":
- Open the app → loads from cache (no network error page)
- Logging a dose returns `{"queued":true}` (status 202)

Network tab → back to "Online":
- Check Application → IndexedDB → `peptideos_offline` → queue store should be empty (flushed)

- [ ] **Step 5: Commit**

```bash
git add manifest.json service-worker.js index.html
git commit -m "feat: PWA manifest, service worker with cache-first shell and offline mutation queue"
```

---

## Task 18: Legal Pages

**Files:**
- Create: `terms.html`
- Create: `privacy.html`

- [ ] **Step 1: Create terms.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Terms of Service — PeptideOS</title>
  <style>
    body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px 60px;line-height:1.7;color:#1e293b;}
    h1{font-size:28px;font-weight:800;margin-bottom:8px;}
    h2{font-size:18px;font-weight:700;margin-top:32px;}
    p,li{font-size:15px;color:#334155;}
    a{color:#0ea5e9;}
    .meta{color:#64748b;font-size:13px;}
    @media(prefers-color-scheme:dark){body{background:#0a0f1e;color:#f1f5f9;}p,li{color:#94a3b8;}h1,h2{color:#f1f5f9;}}
  </style>
</head>
<body>
  <a href="/" style="color:#0ea5e9;font-size:14px;">← Back to PeptideOS</a>
  <h1 style="margin-top:16px;">Terms of Service</h1>
  <p class="meta">Effective date: June 3, 2026 · CW Enterprises</p>

  <h2>1. Permitted Use</h2>
  <p>PeptideOS is provided for personal research tracking only. You may use PeptideOS to log, plan, and track peptide protocols for your own private, non-commercial research purposes.</p>

  <h2>2. Prohibited Use</h2>
  <ul>
    <li>You may not use PeptideOS as a substitute for professional medical advice, diagnosis, or treatment.</li>
    <li>You may not redistribute, resell, or commercially exploit the software or data.</li>
    <li>You may not use PeptideOS to provide medical guidance to others.</li>
  </ul>

  <h2>3. Age Requirement</h2>
  <p>You must be 18 years of age or older to use PeptideOS. By creating an account, you confirm you meet this requirement.</p>

  <h2>4. No Medical Advice</h2>
  <p>PeptideOS is a personal tracking tool. Nothing on the platform constitutes medical advice. All information is for educational and research purposes only. Always consult a qualified healthcare professional before beginning any peptide protocol.</p>

  <h2>5. Limitation of Liability</h2>
  <p>CW Enterprises and PeptideOS are provided "as is" without warranty of any kind. We are not liable for any damages arising from your use of the application or reliance on its information.</p>

  <h2>6. Changes to Terms</h2>
  <p>We reserve the right to update these Terms at any time. Continued use after changes constitutes acceptance.</p>

  <p style="margin-top:40px;" class="meta">© 2026 CW Enterprises. All rights reserved. · <a href="/privacy">Privacy Policy</a></p>
</body>
</html>
```

- [ ] **Step 2: Create privacy.html**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Privacy Policy — PeptideOS</title>
  <style>
    body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px 60px;line-height:1.7;color:#1e293b;}
    h1{font-size:28px;font-weight:800;margin-bottom:8px;}
    h2{font-size:18px;font-weight:700;margin-top:32px;}
    p,li{font-size:15px;color:#334155;}
    a{color:#0ea5e9;}
    .meta{color:#64748b;font-size:13px;}
    @media(prefers-color-scheme:dark){body{background:#0a0f1e;color:#f1f5f9;}p,li{color:#94a3b8;}h1,h2{color:#f1f5f9;}}
  </style>
</head>
<body>
  <a href="/" style="color:#0ea5e9;font-size:14px;">← Back to PeptideOS</a>
  <h1 style="margin-top:16px;">Privacy Policy</h1>
  <p class="meta">Effective date: June 3, 2026 · CW Enterprises</p>

  <h2>1. What We Collect</h2>
  <ul>
    <li><strong>Account data:</strong> Email address and hashed password (PBKDF2, 100,000 iterations, SHA-256).</li>
    <li><strong>Tracking data:</strong> Peptide names, planner entries, vial records, dose logs, and cycle dates you enter.</li>
    <li><strong>Push subscription:</strong> Browser endpoint URL and encryption keys, only if you enable notifications.</li>
    <li><strong>Session token:</strong> UUID stored in browser localStorage; expires after 30 days.</li>
  </ul>

  <h2>2. How We Use Your Data</h2>
  <p>Your data is used solely to provide the PeptideOS service to you. We do not sell, share, or transfer your data to any third party for marketing purposes.</p>

  <h2>3. Storage & Security</h2>
  <p>Data is stored in Cloudflare D1 (SQLite), which is encrypted at rest. Passwords are never stored in plaintext — only a salted PBKDF2 hash. Session tokens are stored in Cloudflare KV with a 30-day expiry.</p>

  <h2>4. Data Retention</h2>
  <p>Your data is retained as long as your account is active. You can delete all data at any time from Settings → Danger Zone. Deletion is permanent and immediate.</p>

  <h2>5. No Third-Party Sharing</h2>
  <p>We do not sell your data. We do not share your data with advertisers, data brokers, or analytics providers.</p>

  <h2>6. Push Notifications</h2>
  <p>If you enable push notifications, your browser push subscription (endpoint URL and encryption keys) is stored in our database solely to send you dose reminders. You can unsubscribe at any time from Settings.</p>

  <h2>7. GDPR / Rights</h2>
  <p>If you are in the EU or UK, you have the right to access, correct, or delete your personal data. Contact us at <a href="mailto:claude@cwenterprises.net">claude@cwenterprises.net</a> to exercise these rights.</p>

  <h2>8. Changes</h2>
  <p>We may update this policy. We'll note the effective date at the top of this page.</p>

  <p style="margin-top:40px;" class="meta">© 2026 CW Enterprises. All rights reserved. · <a href="/terms">Terms of Service</a></p>
</body>
</html>
```

- [ ] **Step 3: Verify legal pages render**

Open `http://localhost:8787/terms` and `http://localhost:8787/privacy`:
- Both pages render with correct content
- "← Back to PeptideOS" link works
- Cross-links between terms and privacy work

Note: wrangler dev's static file serving must serve `.html` files from the project root. If not, add explicit routes to the worker:

```javascript
// In handleAPI, before the 404:
if (url.pathname === '/terms')   return env.ASSETS.fetch(request);
if (url.pathname === '/privacy') return env.ASSETS.fetch(request);
```

- [ ] **Step 4: Commit**

```bash
git add terms.html privacy.html
git commit -m "feat: add Terms of Service and Privacy Policy static pages"
```

---

## Task 19: Integration Testing & Deploy

**Files:**
- Modify: `wrangler.toml` (update APP_URL for production)

- [ ] **Step 1: Run end-to-end smoke test against wrangler dev**

```bash
npx wrangler dev --local
```

Test checklist (open http://localhost:8787 in browser):

```
Auth:
[ ] Register new account → lands on main app
[ ] Sign out → auth screen shown
[ ] Sign in → lands on main app (all data persisted)
[ ] Forgot password → console shows reset token; reset works

Settings:
[ ] Add custom peptide → appears in all dropdowns
[ ] Theme toggle → dark/system/light persists across reload
[ ] Save cycle dates → summary shows correctly

Today tab:
[ ] Add planner item (via Settings peptide list + curl planner POST)
[ ] Today tab shows planner item with PENDING badge
[ ] Click "Log" → Log Dose pre-filled
[ ] Save dose → Today tab updates to DONE

Week tab:
[ ] All 7 days render
[ ] Today column has blue border
[ ] Week start picker changes the grid

Log Dose:
[ ] Add vial via Vials tab
[ ] Select vial in Log Dose → draw math calculates
[ ] Save dose → Logs section shows entry
[ ] Delete last → removes most recent entry

Vials:
[ ] Add vial → appears in list with green 100% bar
[ ] After logging doses → bar shrinks and changes color

Calculator:
[ ] Reconstitution: 10mg + 2mL → 5000 mcg/mL, 250mcg dose → 0.050 mL
[ ] Draw: 5000 mcg/mL + 500 mcg → 0.100 mL ≈ 10.0 IU
[ ] Cycle Cost: 500mcg × 7×/wk × 12wk × $2/mg → $84
[ ] Half-Life: BPC-157 auto-fills → 4h half-life, 8h at 25%

Library:
[ ] Search "BPC" → filters to BPC-157 card
[ ] Click card → detail modal opens
[ ] "Use in Calculator" → switches to Calculator, Half-Life tab, pre-fills BPC-157

Push (optional):
[ ] Enable Notifications → browser permission prompt appears
[ ] Permission granted → button changes to "Disable Notifications"

Legal:
[ ] /terms renders
[ ] /privacy renders
[ ] Links in Settings footer work
```

- [ ] **Step 2: Run D1 migration against production DB**

```bash
# First, ensure wrangler.toml has the correct database_id (from Step 1 of Task 1)
npx wrangler d1 execute peptideos_db --file=migrations/0001_init.sql
npx wrangler d1 execute peptideos_db --file=migrations/0002_push_unique.sql
```
Expected: `Successfully executed SQL file`

- [ ] **Step 3: Set VAPID secrets in production**

```bash
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

- [ ] **Step 4: Update wrangler.toml APP_URL and deploy**

```toml
[vars]
APP_URL = "https://peptideos.cwenterprises.net"
```

```bash
npx wrangler deploy
```
Expected: `Deployed peptideos (X ms)`

- [ ] **Step 5: Smoke test production**

Open the deployed URL:
- Registration works
- All tabs render
- Dose logging saves to D1

- [ ] **Step 6: Final commit**

```bash
git add wrangler.toml
git commit -m "chore: update APP_URL for production and deploy PeptideOS"
```

---

## Spec Coverage Checklist

| Spec Section | Task |
|---|---|
| Liquid glass design system | Task 7 |
| Dark/light/system theme + manual toggle | Tasks 7, 16 |
| Auth: register, login, logout, forgot, reset | Tasks 3, 4, 9 |
| D1 schema + KV sessions | Tasks 1, 2, 3 |
| 7-tab navigation | Task 8 |
| Today tab: chips, streak, progress bar, quick-log | Task 10 |
| Week tab: 7-column grid, today highlight | Task 11 |
| Log Dose tab: form, vial selector, draw math | Task 12 |
| Vials tab: gradient progress bars | Task 13 |
| Calculator: 4 modes (Recon, Draw, Cost, Half-Life) | Task 14 |
| Library tab: search, cards, detail, Use in Calculator | Task 15 |
| Settings: account, push, theme, peptides, cycle, export, delete | Task 16 |
| PWA manifest | Task 17 |
| Service worker: cache-first, offline queue | Task 17 |
| Web Push Protocol (VAPID + encryption) | Task 6 |
| Push cron trigger (every 5 min, deduplication) | Task 6 |
| Password reset (15-min KV token) | Task 4 |
| Terms of Service page | Task 18 |
| Privacy Policy page | Task 18 |
| Disclaimers on all tabs | Tasks 10, 14, 15, 16 |
| CSV export | Task 16 |
| Offline mutation queue (IndexedDB) | Task 17 |
| Background sync on reconnect | Task 17 |
