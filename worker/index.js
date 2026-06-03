export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  }
};

// Fix 2: module-scope toHex helper
const toHex = (buf) => Array.from(new Uint8Array(buf))
  .map(b => b.toString(16).padStart(2, '0')).join('');

function base64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - padded.length % 4) % 4;
  const base64 = padded + '='.repeat(padding);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return `${toHex(salt.buffer)}:${toHex(hashBits)}`;
}

// Fix 1: timing-safe password comparison
async function verifyPassword(password, stored) {
  const [saltHex, expectedHex] = stored.split(':');
  if (!saltHex || !expectedHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const actual   = new Uint8Array(hashBits);
  const expected = new Uint8Array(expectedHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

// Fix 5: delete expired sessions from KV
async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const session = await env.SESSIONS.get(token, 'json');
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    await env.SESSIONS.delete(token);
    return null;
  }
  return session.user_id;
}

// Fix 3: restricted CORS origin
const ALLOWED_ORIGINS = ['https://peptideos.cwenterprises.net', 'http://localhost:8787', 'http://localhost:3000'];

function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

function err(msg, status = 400, origin = '') {
  return json({ error: msg }, status, origin);
}

async function handleAPI(request, env, url) {
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const path = url.pathname.replace('/api', '');
  const method = request.method;

  if (path === '/auth/register' && method === 'POST') return authRegister(request, env, origin);
  if (path === '/auth/login'    && method === 'POST') return authLogin(request, env, origin);
  if (path === '/auth/logout'   && method === 'POST') return authLogout(request, env, origin);
  if (path === '/auth/forgot'           && method === 'POST') return authForgot(request, env, origin);
  if (path === '/auth/reset'            && method === 'POST') return authReset(request, env, origin);
  if (path === '/auth/change-password'  && method === 'POST') return authChangePassword(request, env, origin);
  if (path === '/account'               && method === 'DELETE') return deleteAccount(request, env, origin);

  // Peptides
  if (path === '/peptides' && method === 'GET')    return peptidesList(request, env, origin);
  if (path === '/peptides' && method === 'POST')   return peptidesAdd(request, env, origin);
  if (path.match(/^\/peptides\/[^/]+$/) && method === 'DELETE') return peptidesDelete(request, env, origin, path);

  // Planner
  if (path === '/planner' && method === 'GET')    return plannerList(request, env, origin);
  if (path === '/planner' && method === 'POST')   return plannerAdd(request, env, origin);
  if (path.match(/^\/planner\/[^/]+$/) && method === 'DELETE') return plannerDelete(request, env, origin, path);

  // Vials
  if (path === '/vials' && method === 'GET')    return vialsList(request, env, origin);
  if (path === '/vials' && method === 'POST')   return vialsAdd(request, env, origin);
  if (path.match(/^\/vials\/[^/]+$/) && method === 'DELETE') return vialsDelete(request, env, origin, path);

  // Logs
  if (path === '/logs' && method === 'GET')    return logsList(request, env, origin);
  if (path === '/logs' && method === 'POST')   return logsAdd(request, env, origin);
  if (path === '/logs/last' && method === 'DELETE') return logsDeleteLast(request, env, origin);

  // Settings
  if (path === '/settings' && method === 'GET') return settingsGet(request, env, origin);
  if (path === '/settings' && method === 'PUT') return settingsPut(request, env, origin);

  // Push
  if (path === '/push/vapid-key' && method === 'GET')    return pushVapidKey(request, env, origin);
  if (path === '/push/subscribe' && method === 'POST')   return pushSubscribe(request, env, origin);
  if (path === '/push/subscribe' && method === 'DELETE') return pushUnsubscribe(request, env, origin);

  return err('Not found', 404, origin);
}

async function authRegister(request, env, origin) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email and password required', 400, origin);
  if (password.length < 8) return err('password must be at least 8 characters', 400, origin);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase().trim()).first();
  if (existing) return err('email already registered', 400, origin);

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

  return json({ token, email: email.toLowerCase().trim() }, 201, origin);
}

async function authLogin(request, env, origin) {
  const { email, password } = await request.json().catch(() => ({}));
  if (!email || !password) return err('email and password required', 400, origin);

  const user = await env.DB.prepare('SELECT id, password_hash FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();
  if (!user) return err('invalid credentials', 401, origin);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return err('invalid credentials', 401, origin);

  const token = crypto.randomUUID();
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.SESSIONS.put(token, JSON.stringify({ user_id: user.id, expires_at: expiresAt }), {
    expirationTtl: 30 * 24 * 60 * 60
  });

  return json({ token, email: email.toLowerCase().trim() }, 200, origin);
}

async function authLogout(request, env, origin) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) await env.SESSIONS.delete(token);
  return json({ ok: true }, 200, origin);
}

async function authForgot(request, env, origin) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return err('email required', 400, origin);

  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase().trim()).first();

  if (user) {
    const resetToken = crypto.randomUUID();
    await env.SESSIONS.put(
      `reset:${resetToken}`,
      JSON.stringify({ user_id: user.id, email: email.toLowerCase().trim() }),
      { expirationTtl: 15 * 60 }
    );
    // DEV only — log token to console so it can be used in testing
    console.log(`[DEV] Reset token for ${email}: ${resetToken}`);
  }

  // Always return 200 to prevent email enumeration
  return json({ ok: true, message: 'If that email is registered, a reset link has been sent.' }, 200, origin);
}

async function authReset(request, env, origin) {
  const { token, password } = await request.json().catch(() => ({}));
  if (!token || !password) return err('token and password required', 400, origin);
  if (password.length < 8) return err('password must be at least 8 characters', 400, origin);

  const data = await env.SESSIONS.get(`reset:${token}`, 'json');
  if (!data) return err('invalid or expired reset token', 401, origin);

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(hash, data.user_id).run();

  // One-time use — delete the reset token
  await env.SESSIONS.delete(`reset:${token}`);
  return json({ ok: true }, 200, origin);
}

// ── Peptides ──────────────────────────────────────────────────────────────────

async function peptidesList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT id, name FROM peptides WHERE user_id = ? ORDER BY name'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function peptidesAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { name } = await request.json().catch(() => ({}));
  if (!name?.trim()) return err('name required', 400, origin);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO peptides (id, user_id, name) VALUES (?, ?, ?)')
    .bind(id, userId, name.trim()).run();
  return json({ id, name: name.trim() }, 201, origin);
}

async function peptidesDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM peptides WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}

// ── Planner ───────────────────────────────────────────────────────────────────

async function plannerList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM planner WHERE user_id = ? ORDER BY day, time'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function plannerAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || b.day == null || !b.route || !b.dose || !b.unit) return err('missing fields', 400, origin);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO planner (id, user_id, peptide, day, time, route, dose, unit, note) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(id, userId, b.peptide, b.day, b.time || null, b.route, b.dose, b.unit, b.note || null).run();
  return json({ id, ...b }, 201, origin);
}

async function plannerDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('DELETE FROM planner WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}

// ── Vials ─────────────────────────────────────────────────────────────────────

async function vialsList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM vials WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function vialsAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || !b.mg || !b.ml) return err('peptide, mg, ml required', 400, origin);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO vials (id, user_id, peptide, mg, ml, created_at) VALUES (?,?,?,?,?,?)'
  ).bind(id, userId, b.peptide, b.mg, b.ml, now).run();
  return json({ id, peptide: b.peptide, mg: b.mg, ml: b.ml, created_at: now }, 201, origin);
}

async function vialsDelete(request, env, origin, path) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const id = path.split('/').pop();
  await env.DB.prepare('UPDATE logs SET vial_id = NULL WHERE vial_id = ? AND user_id = ?')
    .bind(id, userId).run();
  await env.DB.prepare('DELETE FROM vials WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return json({ ok: true }, 200, origin);
}

// ── Logs ──────────────────────────────────────────────────────────────────────

async function logsList(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { results } = await env.DB.prepare(
    'SELECT * FROM logs WHERE user_id = ? ORDER BY taken_at DESC LIMIT 200'
  ).bind(userId).all();
  return json(results, 200, origin);
}

async function logsAdd(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const b = await request.json().catch(() => ({}));
  if (!b.peptide || !b.route || !b.dose_value || !b.dose_unit || !b.taken_at) return err('missing fields', 400, origin);
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
  return json({ id, ...b }, 201, origin);
}

async function logsDeleteLast(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const last = await env.DB.prepare(
    'SELECT id FROM logs WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1'
  ).bind(userId).first();
  if (!last) return json({ ok: true, deleted: false }, 200, origin);
  await env.DB.prepare('DELETE FROM logs WHERE id = ? AND user_id = ?').bind(last.id, userId).run();
  return json({ ok: true, deleted: true }, 200, origin);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function settingsGet(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const row = await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first();
  return json(row || { user_id: userId, week_start: null, cycle_start: null, cycle_end: null, theme: 'system' }, 200, origin);
}

async function settingsPut(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
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
  return json({ ok: true }, 200, origin);
}

// ── Push ──────────────────────────────────────────────────────────────────────

async function pushVapidKey(request, env, origin) {
  return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, origin);
}

async function pushSubscribe(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { endpoint, keys } = await request.json().catch(() => ({}));
  if (!endpoint || !keys?.p256dh || !keys?.auth) return err('invalid subscription', 400, origin);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Upsert: if endpoint already exists for this user, update it; otherwise insert
  const existing = await env.DB.prepare(
    'SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'
  ).bind(userId, endpoint).first();

  if (existing) {
    await env.DB.prepare(
      'UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE id = ?'
    ).bind(keys.p256dh, keys.auth, existing.id).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(id, userId, endpoint, keys.p256dh, keys.auth, now).run();
  }

  return json({ ok: true }, 201, origin);
}

async function pushUnsubscribe(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { endpoint } = await request.json().catch(() => ({}));
  if (endpoint) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .bind(userId, endpoint).run();
  }
  return json({ ok: true }, 200, origin);
}

// ── Account Management ────────────────────────────────────────────────────────

async function authChangePassword(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  const { password } = await request.json().catch(() => ({}));
  if (!password || password.length < 8) return err('password must be at least 8 characters', 400, origin);
  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, userId).run();
  return json({ ok: true }, 200, origin);
}

async function deleteAccount(request, env, origin) {
  const userId = await requireAuth(request, env);
  if (!userId) return err('unauthorized', 401, origin);
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
  return json({ ok: true }, 200, origin);
}

// ── Cron ──────────────────────────────────────────────────────────────────────

async function handleCron(env) {
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10);
  const dayOfWeek = now.getUTCDay();

  // 10-minute window centered on now
  const windowStart = new Date(now.getTime() - 5 * 60 * 1000);
  const windowEnd   = new Date(now.getTime() + 5 * 60 * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const toHHMM = (d) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  const wsHHMM = toHHMM(windowStart);
  const weHHMM = toHHMM(windowEnd);

  const { results: dueItems } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.peptide, p.dose, p.unit, p.time
     FROM planner p
     WHERE p.day = ? AND p.time >= ? AND p.time <= ?`
  ).bind(dayOfWeek, wsHHMM, weHHMM).all();

  for (const item of dueItems) {
    // Deduplication check
    const alreadySent = await env.DB.prepare(
      'SELECT id FROM notifications_sent WHERE user_id = ? AND planner_id = ? AND sent_date = ?'
    ).bind(item.user_id, item.id, todayDate).first();
    if (alreadySent) continue;

    const { results: subs } = await env.DB.prepare(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?'
    ).bind(item.user_id).all();

    const payload = JSON.stringify({
      title: 'PeptideOS Reminder',
      body: `Time to take ${item.peptide} — ${item.dose} ${item.unit}`,
      icon: '/mini.svg'
    });

    for (const sub of subs) {
      try {
        await sendWebPush(env, sub.endpoint, sub.p256dh, sub.auth, payload);
      } catch (e) {
        console.error('Push failed:', e.message);
      }
    }

    // Record as sent (INSERT OR IGNORE handles race conditions)
    await env.DB.prepare(
      'INSERT OR IGNORE INTO notifications_sent (id, user_id, planner_id, sent_date) VALUES (?,?,?,?)'
    ).bind(crypto.randomUUID(), item.user_id, item.id, todayDate).run();
  }
}

// ── Web Push (RFC 8291 / RFC 8292) ────────────────────────────────────────────

async function sendWebPush(env, endpoint, p256dhB64url, authB64url, payload) {
  // --- VAPID JWT ---
  const privKeyBytes = base64urlDecode(env.VAPID_PRIVATE_KEY);
  const vapidPrivKey = await crypto.subtle.importKey(
    'raw', privKeyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const audience = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header  = base64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims  = base64urlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: env.VAPID_SUBJECT })));
  const sigInput = new TextEncoder().encode(`${header}.${claims}`);
  const sigBytes = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidPrivKey, sigInput);
  const jwt = `${header}.${claims}.${base64urlEncode(new Uint8Array(sigBytes))}`;

  // --- ECDH key exchange ---
  const serverPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverPair.publicKey));

  const clientPubRaw = base64urlDecode(p256dhB64url);
  const clientPubKey = await crypto.subtle.importKey('raw', clientPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPubKey }, serverPair.privateKey, 256);

  const authBytes = base64urlDecode(authB64url);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF extraction + expansion (RFC 8291)
  const hkdfBase = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveBits']);

  const authInfo = new TextEncoder().encode('Content-Encoding: auth\0');
  const prkBits  = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authBytes, info: authInfo }, hkdfBase, 256);
  const prk      = await crypto.subtle.importKey('raw', prkBits, 'HKDF', false, ['deriveBits']);

  function buildInfo(type) {
    const label = new TextEncoder().encode(`Content-Encoding: ${type}\0`);
    const buf = new Uint8Array(label.length + 2 + clientPubRaw.length + 2 + serverPubRaw.length);
    let off = 0;
    buf.set(label, off); off += label.length;
    const cv = new DataView(new ArrayBuffer(2)); cv.setUint16(0, clientPubRaw.length);
    buf.set(new Uint8Array(cv.buffer), off); off += 2;
    buf.set(clientPubRaw, off); off += clientPubRaw.length;
    const sv = new DataView(new ArrayBuffer(2)); sv.setUint16(0, serverPubRaw.length);
    buf.set(new Uint8Array(sv.buffer), off); off += 2;
    buf.set(serverPubRaw, off);
    return buf;
  }

  const cekBits   = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: buildInfo('aesgcm') }, prk, 128);
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: buildInfo('nonce') }, prk, 96);

  const cek = await crypto.subtle.importKey('raw', cekBits, 'AES-GCM', false, ['encrypt']);
  const plaintext = new TextEncoder().encode(payload);
  const padded = new Uint8Array(plaintext.length + 2);
  padded.set(plaintext, 2); // 2-byte zero padding prefix

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBits, tagLength: 128 }, cek, padded);

  // Build Encrypted Content-Coding body (RFC 8188 aesgcm)
  const rs = new DataView(new ArrayBuffer(4)); rs.setUint32(0, 4096);
  const body = new Uint8Array(16 + 4 + 1 + serverPubRaw.length + ciphertext.byteLength);
  let off = 0;
  body.set(salt, off); off += 16;
  body.set(new Uint8Array(rs.buffer), off); off += 4;
  body[off++] = serverPubRaw.length;
  body.set(serverPubRaw, off); off += serverPubRaw.length;
  body.set(new Uint8Array(ciphertext), off);

  const saltB64 = base64urlEncode(salt);
  const dhB64   = base64urlEncode(serverPubRaw);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption':       `salt=${saltB64}`,
      'Crypto-Key':       `dh=${dhB64};vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
      'TTL':              '86400',
      'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
    },
    body
  });

  if (!res.ok && res.status !== 201) {
    const text = await res.text().catch(() => '');
    throw new Error(`Push HTTP ${res.status}: ${text}`);
  }
}
