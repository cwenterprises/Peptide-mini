// Stack Builder — pure core (no env, no I/O) + HTTP handlers.
// A stack is a saved multi-peptide protocol. Turning it on writes ordinary planner
// rows and cycles tagged with stack_id; everything that reads the planner is unchanged.
// Only rows/cycles carrying this stack's id are ever touched.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function stackEndDate(start, weeks) {
  return weeks ? addDays(start, weeks * 7 - 1) : null;
}

export function localDateIn(tz, now) {
  try {
    if (tz) return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch { /* invalid zone → UTC */ }
  return now.toISOString().slice(0, 10);
}

export function validateStack(b) {
  if (!b || typeof b !== 'object') return 'invalid body';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 1 || name.length > 60) return 'name must be 1–60 characters';
  if (b.weeks != null && !(Number.isInteger(b.weeks) && b.weeks >= 1 && b.weeks <= 104)) return 'weeks must be 1–104 or empty';
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 12) return 'a stack needs 1–12 peptides';
  for (const it of b.items) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return 'invalid peptide entry';
    if (!str(it.peptide, 80) || !str(it.route, 40) || !str(it.unit, 16)) return 'each peptide needs a name, route and unit';
    if (it.note != null && (typeof it.note !== 'string' || it.note.length > 200)) return `${it.peptide}: note must be text (200 characters max)`;
    if (typeof it.dose !== 'number' || !Number.isFinite(it.dose) || it.dose <= 0) return `${it.peptide}: dose must be more than 0`;
    if (!Array.isArray(it.days) || !it.days.length || it.days.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(it.days).size !== it.days.length) return `${it.peptide}: pick at least one day`;
    const times = it.times ?? [];
    if (!Array.isArray(times) || times.length > 4 || times.some(t => typeof t !== 'string' || !HHMM.test(t)) || new Set(times).size !== times.length) return `${it.peptide}: up to 4 different times, as HH:MM`;
  }
  return null;
}

export function expandItems(items) {
  const rows = [];
  for (const it of items) {
    const times = it.times && it.times.length ? it.times : [null];
    for (const day of it.days) for (const time of times) {
      rows.push({ peptide: it.peptide, day, time, route: it.route, dose: Number(it.dose), unit: it.unit, note: it.note || '' });
    }
  }
  return rows;
}

const rowKey = r => [r.peptide, r.day, r.time ?? '', r.route, Number(r.dose), r.unit].join('|');

export function rewritePlannerRows(existingRows, expanded) {
  const pool = new Map();
  for (const r of existingRows) {
    const k = rowKey(r);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(r.id);
  }
  const keep = [], add = [];
  for (const r of expanded) {
    const ids = pool.get(rowKey(r));
    if (ids && ids.length) keep.push(ids.shift());
    else add.push(r);
  }
  const kept = new Set(keep);
  const remove = existingRows.map(r => r.id).filter(id => !kept.has(id));
  return { keep, remove, add };
}

export function transitionFor(stack, localToday) {
  if (stack.status === 'scheduled' && stack.start_date && stack.start_date <= localToday) return 'start';
  if (stack.status === 'active' && stack.end_date && stack.end_date < localToday) return 'complete';
  return null;
}

// SQL pre-filter for the cron: a stack's local date is at most one day past the UTC
// date, so anything due anywhere has start_date / end_date below utcToday + 1.
// The exact per-stack check is transitionFor() with that stack's own local date.
export function coarseBounds(now) {
  const next = addDays(now.toISOString().slice(0, 10), 1);
  return { startMax: next, endMax: next };
}

// Local weekday / date / HH:MM of an instant in a time zone (invalid zone → UTC).
function localParts(tz, date) {
  let f;
  try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hhmm: `${p.hour}:${p.minute}` };
}

// Stack planner times are the user's local wall-clock. Returns the local date the
// reminder belongs to when the row falls in the ±5 minute window around `now`.
export function reminderDue(row, tz, now) {
  if (!row.time) return null;
  const ws = localParts(tz, new Date(now.getTime() - 5 * 60000));
  const we = localParts(tz, new Date(now.getTime() + 5 * 60000));
  if (ws.ymd === we.ymd) return row.day === ws.day && row.time >= ws.hhmm && row.time <= we.hhmm ? ws.ymd : null;
  if (row.day === ws.day && row.time >= ws.hhmm) return ws.ymd;
  if (row.day === we.day && row.time <= we.hhmm) return we.ymd;
  return null;
}

const overlaps = (c, S, E) => !(c.end_date < S || (E && c.start_date > E));

export function cycleOps({ stackCycles, otherCycles, peptides, S, E, today }) {
  const insert = [], update = [], remove = [];
  for (const peptide of peptides) {
    const mine = stackCycles.filter(c => c.peptide === peptide);
    const unstarted = mine.filter(c => c.start_date > today);
    remove.push(...unstarted.map(c => c.id));
    const started = mine.filter(c => c.start_date <= today);
    const reopen = started.find(c => c.end_date >= addDays(S, -1));
    if (reopen) { update.push({ id: reopen.id, end_date: E }); continue; }
    if (otherCycles.some(c => c.peptide === peptide && overlaps(c, S, E))) continue;
    insert.push({ peptide, start_date: S, end_date: E });
  }
  return { insert, update, remove };
}

export function endStackCycles(stackCycles, today) {
  const update = [], remove = [];
  for (const c of stackCycles) {
    if (c.start_date > today) remove.push(c.id);
    else if (c.end_date > today) update.push({ id: c.id, end_date: today });
  }
  return { update, remove };
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

const normName = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const uniq = a => [...new Set(a)];
const parseStack = r => r && ({ ...r, items: (() => { try { return JSON.parse(r.items || '[]'); } catch { return []; } })() });

async function getStack(env, userId, id) {
  return parseStack(await env.DB.prepare('SELECT * FROM stacks WHERE id = ? AND user_id = ?').bind(id, userId).first());
}

async function stackCycles(env, userId, stackId) {
  const { results } = await env.DB.prepare('SELECT * FROM cycles WHERE user_id = ? AND stack_id = ?').bind(userId, stackId).all();
  return results;
}

async function otherCycles(env, userId, stackId) {
  // Only hand-made / auto cycles suppress a stack's own cycle; another stack's cycle doesn't.
  void stackId;
  const { results } = await env.DB.prepare('SELECT * FROM cycles WHERE user_id = ? AND stack_id IS NULL').bind(userId).all();
  return results;
}

// Insert any stack peptide the user doesn't track yet — vials, prices, Log Dose and
// planner matching all compare by exact name, so the stack must use the user's names.
async function ensurePeptideStmts(env, userId, names) {
  const { results } = await env.DB.prepare('SELECT name FROM peptides WHERE user_id = ?').bind(userId).all();
  const have = new Set(results.map(r => normName(r.name)));
  const stmts = [];
  for (const n of uniq(names)) {
    if (have.has(normName(n))) continue;
    have.add(normName(n));
    stmts.push(env.DB.prepare('INSERT INTO peptides (id, user_id, name) VALUES (?, ?, ?)').bind(crypto.randomUUID(), userId, n));
  }
  return stmts;
}

// Planner rows for this stack, rewritten in place (unchanged rows keep their ids so
// notifications_sent dedupe for today survives an edit).
async function plannerStmts(env, userId, stack) {
  const { results } = await env.DB.prepare('SELECT * FROM planner WHERE user_id = ? AND stack_id = ?').bind(userId, stack.id).all();
  const { remove, add } = rewritePlannerRows(results, expandItems(stack.items));
  const stmts = remove.map(id => env.DB.prepare('DELETE FROM planner WHERE id = ? AND user_id = ?').bind(id, userId));
  for (const r of add) {
    stmts.push(env.DB.prepare(
      'INSERT INTO planner (id, user_id, peptide, day, time, route, dose, unit, note, stack_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), userId, r.peptide, r.day, r.time, r.route, r.dose, r.unit, r.note || null, stack.id));
  }
  return stmts;
}

function cycleStmts(env, userId, stackId, ops) {
  const now = new Date().toISOString();
  return [
    ...(ops.remove || []).map(id => env.DB.prepare('DELETE FROM cycles WHERE id = ? AND user_id = ?').bind(id, userId)),
    ...(ops.update || []).map(u => env.DB.prepare('UPDATE cycles SET end_date = ? WHERE id = ? AND user_id = ?').bind(u.end_date, u.id, userId)),
    // NOT EXISTS is evaluated when the batch runs, so a concurrent activate can't add a twin.
    ...(ops.insert || []).map(c => env.DB.prepare(
      `INSERT INTO cycles (id, user_id, peptide, start_date, end_date, created_at, stack_id)
       SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS (
         SELECT 1 FROM cycles WHERE user_id = ? AND stack_id = ? AND peptide = ? AND NOT (end_date < ? OR start_date > ?))`
    ).bind(crypto.randomUUID(), userId, c.peptide, c.start_date, c.end_date, now, stackId, userId, stackId, c.peptide, c.start_date, c.end_date)),
  ];
}

// Fresh start: drop every row this stack has, then write them all. Concurrent starts
// each leave exactly one set (D1 batches are atomic and serialised).
async function freshPlannerStmts(env, userId, stack) {
  return [
    env.DB.prepare('DELETE FROM planner WHERE user_id = ? AND stack_id = ?').bind(userId, stack.id),
    ...expandItems(stack.items).map(r => env.DB.prepare(
      'INSERT INTO planner (id, user_id, peptide, day, time, route, dose, unit, note, stack_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(crypto.randomUUID(), userId, r.peptide, r.day, r.time, r.route, r.dose, r.unit, r.note || null, stack.id)),
  ];
}

// Start a stack now: write its planner rows and mark it active. Reused by the
// on-load/cron transitions when a scheduled stack reaches its start date.
export async function startStmts(env, userId, stack) {
  return [
    ...await freshPlannerStmts(env, userId, stack),
    env.DB.prepare("UPDATE stacks SET status = 'active', updated_at = ? WHERE id = ? AND user_id = ?").bind(new Date().toISOString(), stack.id, userId),
  ];
}

export async function completeStmts(env, userId, stack) {
  return [
    env.DB.prepare('DELETE FROM planner WHERE user_id = ? AND stack_id = ?').bind(userId, stack.id),
    env.DB.prepare("UPDATE stacks SET status = 'completed', updated_at = ? WHERE id = ? AND user_id = ?").bind(new Date().toISOString(), stack.id, userId),
  ];
}

async function deactivateStmts(env, userId, stack, today) {
  const ops = endStackCycles(await stackCycles(env, userId, stack.id), today);
  return [
    env.DB.prepare('DELETE FROM planner WHERE user_id = ? AND stack_id = ?').bind(userId, stack.id),
    ...cycleStmts(env, userId, stack.id, ops),
    env.DB.prepare("UPDATE stacks SET status = 'inactive', updated_at = ? WHERE id = ? AND user_id = ?").bind(new Date().toISOString(), stack.id, userId),
  ];
}

const todayFrom = (v, fallback) => (typeof v === 'string' && YMD.test(v)) ? v : fallback;

export function stackHandlers({ requireAuth, json, err, applyTransitions }) {
  const authed = fn => async (request, env, origin, path) => {
    const userId = await requireAuth(request, env);
    if (!userId) return err('unauthorized', 401, origin);
    return fn(request, env, origin, path, userId);
  };
  const idFrom = path => path.split('/')[2];
  const body = request => request.json().catch(() => ({}));

  return {
    list: authed(async (request, env, origin, path, userId) => {
      if (applyTransitions) {
        const q = new URL(request.url).searchParams.get('today');
        await applyTransitions(env, { userId, now: new Date(), todayOverride: todayFrom(q, null) });
      }
      const { results } = await env.DB.prepare('SELECT * FROM stacks WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all();
      return json(results.map(parseStack), 200, origin);
    }),

    create: authed(async (request, env, origin, path, userId) => {
      const b = await body(request);
      const bad = validateStack(b);
      if (bad) return err(bad, 400, origin);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO stacks (id, user_id, name, items, weeks, status, template, created_at, updated_at) VALUES (?,?,?,?,?,'inactive',?,?,?)"
      ).bind(id, userId, b.name.trim(), JSON.stringify(b.items), b.weeks ?? null, b.template || null, now, now).run();
      return json(await getStack(env, userId, id), 201, origin);
    }),

    update: authed(async (request, env, origin, path, userId) => {
      const stack = await getStack(env, userId, idFrom(path));
      if (!stack) return err('not found', 404, origin);
      const b = await body(request);
      const bad = validateStack(b);
      if (bad) return err(bad, 400, origin);
      const today = todayFrom(b.today, new Date().toISOString().slice(0, 10));
      const next = { ...stack, name: b.name.trim(), items: b.items, weeks: b.weeks ?? null };
      const running = stack.status === 'active' || stack.status === 'scheduled';
      next.end_date = running ? stackEndDate(stack.start_date, next.weeks) : stack.end_date;
      const stmts = [];
      if (running) {
        const before = uniq(stack.items.map(i => i.peptide));
        const after = uniq(next.items.map(i => i.peptide));
        const removed = before.filter(p => !after.includes(p));
        const added = after.filter(p => !before.includes(p));
        const kept = after.filter(p => before.includes(p));
        const mine = await stackCycles(env, userId, stack.id);
        stmts.push(...cycleStmts(env, userId, stack.id, endStackCycles(mine.filter(c => removed.includes(c.peptide)), today)));
        if (next.weeks) {
          const others = await otherCycles(env, userId, stack.id);
          const live = mine.filter(c => !removed.includes(c.peptide));
          const addS = stack.status === 'active' && today > stack.start_date ? today : stack.start_date;
          stmts.push(...cycleStmts(env, userId, stack.id, cycleOps({ stackCycles: live, otherCycles: others, peptides: added, S: addS, E: next.end_date, today })));
          stmts.push(...cycleStmts(env, userId, stack.id, cycleOps({ stackCycles: live, otherCycles: others, peptides: kept, S: stack.start_date, E: next.end_date, today })));
        }
        stmts.push(...await ensurePeptideStmts(env, userId, after));
        if (stack.status === 'active') stmts.push(...await plannerStmts(env, userId, next));
      }
      stmts.push(env.DB.prepare('UPDATE stacks SET name = ?, items = ?, weeks = ?, end_date = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .bind(next.name, JSON.stringify(next.items), next.weeks, next.end_date, new Date().toISOString(), stack.id, userId));
      await env.DB.batch(stmts);
      return json(await getStack(env, userId, stack.id), 200, origin);
    }),

    remove: authed(async (request, env, origin, path, userId) => {
      const stack = await getStack(env, userId, idFrom(path));
      if (!stack) return err('not found', 404, origin);
      const today = todayFrom(new URL(request.url).searchParams.get('today'), new Date().toISOString().slice(0, 10));
      const stmts = (stack.status === 'active' || stack.status === 'scheduled') ? await deactivateStmts(env, userId, stack, today) : [];
      stmts.push(env.DB.prepare('DELETE FROM stacks WHERE id = ? AND user_id = ?').bind(stack.id, userId));
      await env.DB.batch(stmts);
      return json({ ok: true }, 200, origin);
    }),

    activate: authed(async (request, env, origin, path, userId) => {
      const stack = await getStack(env, userId, idFrom(path));
      if (!stack) return err('not found', 404, origin);
      const b = await body(request);
      if (!YMD.test(b.start_date || '')) return err('start_date required (YYYY-MM-DD)', 400, origin);
      const today = todayFrom(b.today, new Date().toISOString().slice(0, 10));
      const S = b.start_date, E = stackEndDate(S, stack.weeks);
      const startsNow = S <= today;
      const peptides = uniq(stack.items.map(i => i.peptide));
      const stmts = [...await ensurePeptideStmts(env, userId, peptides)];
      if (stack.weeks) {
        stmts.push(...cycleStmts(env, userId, stack.id, cycleOps({
          stackCycles: await stackCycles(env, userId, stack.id), otherCycles: await otherCycles(env, userId, stack.id),
          peptides, S, E, today,
        })));
      }
      stmts.push(env.DB.prepare('UPDATE stacks SET start_date = ?, end_date = ?, tz = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .bind(S, E, typeof b.tz === 'string' ? b.tz.slice(0, 64) : null, startsNow ? 'active' : 'scheduled', new Date().toISOString(), stack.id, userId));
      if (startsNow) stmts.push(...await freshPlannerStmts(env, userId, stack));
      else stmts.push(env.DB.prepare('DELETE FROM planner WHERE user_id = ? AND stack_id = ?').bind(userId, stack.id));
      await env.DB.batch(stmts);
      return json(await getStack(env, userId, stack.id), 200, origin);
    }),

    deactivate: authed(async (request, env, origin, path, userId) => {
      const stack = await getStack(env, userId, idFrom(path));
      if (!stack) return err('not found', 404, origin);
      const b = await body(request);
      const today = todayFrom(b.today, new Date().toISOString().slice(0, 10));
      await env.DB.batch(await deactivateStmts(env, userId, stack, today));
      return json(await getStack(env, userId, stack.id), 200, origin);
    }),
  };
}

// Start scheduled stacks whose day has come and complete active stacks past their
// end date. Called by GET /stacks (one user, client's local date) and by the cron
// (everyone, each stack's own time zone). Returns how many stacks changed.
export async function applyTransitions(env, { userId = null, now = new Date(), todayOverride = null } = {}) {
  const { startMax, endMax } = coarseBounds(now);
  const due = todayOverride
    ? "(status = 'scheduled') OR (status = 'active' AND end_date IS NOT NULL)"
    : "(status = 'scheduled' AND start_date <= ?) OR (status = 'active' AND end_date IS NOT NULL AND end_date < ?)";
  const sql = `SELECT * FROM stacks WHERE (${due})` + (userId ? ' AND user_id = ?' : '');
  const binds = [...(todayOverride ? [] : [startMax, endMax]), ...(userId ? [userId] : [])];
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  let changed = 0;
  for (const row of results) {
    const stack = parseStack(row);
    // One broken stack must not stall everyone else's starts/completions.
    try {
      const t = transitionFor(stack, todayOverride || localDateIn(stack.tz, now));
      if (!t) continue;
      await env.DB.batch(t === 'start' ? await startStmts(env, stack.user_id, stack) : await completeStmts(env, stack.user_id, stack));
      changed++;
    } catch (e) {
      console.error('stack transition failed', stack.id, e && e.message);
    }
  }
  return changed;
}

// Reminders for stack rows, matched in each stack's own time zone (its times are
// local wall-clock). Rows without a stack keep the legacy UTC matching in handleCron.
export async function dueStackReminders(env, now = new Date()) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.peptide, p.dose, p.unit, p.day, p.time, s.tz
     FROM planner p JOIN stacks s ON s.id = p.stack_id AND s.user_id = p.user_id
     WHERE s.status = 'active' AND p.time IS NOT NULL`
  ).bind().all();
  const out = [];
  for (const r of results) {
    const sentDate = reminderDue(r, r.tz, now);
    if (sentDate) out.push({ ...r, sentDate });
  }
  return out;
}

// Restore path: keep only stack rows that would pass the API's own validation.
export function importableStack(row) {
  if (!row || typeof row.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.id)) return false;
  if (!['inactive', 'scheduled', 'active', 'completed'].includes(row.status)) return false;
  let items;
  try { items = typeof row.items === 'string' ? JSON.parse(row.items) : row.items; } catch { return false; }
  if (validateStack({ name: row.name, weeks: row.weeks ?? null, items })) return false;
  for (const d of [row.start_date, row.end_date]) if (d != null && !YMD.test(d)) return false;
  if ((row.status === 'active' || row.status === 'scheduled') && !row.start_date) return false;
  return true;
}
