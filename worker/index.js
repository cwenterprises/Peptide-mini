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

// Fix 2: module-scope toHex helper
const toHex = (buf) => Array.from(new Uint8Array(buf))
  .map(b => b.toString(16).padStart(2, '0')).join('');

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

async function handleCron(env) {
  // placeholder
}
