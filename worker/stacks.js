// Stack Builder — pure core (no env, no I/O) + HTTP handlers.
// A stack is a saved multi-peptide protocol. Turning it on writes ordinary planner
// rows and cycles tagged with stack_id; everything that reads the planner is unchanged.
// Only rows/cycles carrying this stack's id are ever touched.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}$/;

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
    if (!it || !it.peptide || !it.route || !it.unit) return 'each peptide needs a name, route and unit';
    if (!(Number(it.dose) > 0)) return `${it.peptide}: dose must be more than 0`;
    if (!Array.isArray(it.days) || !it.days.length || it.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return `${it.peptide}: pick at least one day`;
    const times = it.times || [];
    if (!Array.isArray(times) || times.length > 4 || times.some(t => !HHMM.test(t))) return `${it.peptide}: up to 4 times, as HH:MM`;
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
