// Unit tests for the pure stack core. Run from the repo root: node --test test/unit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStack, addDays, stackEndDate, localDateIn, expandItems,
  rewritePlannerRows, transitionFor, cycleOps, endStackCycles, coarseBounds,
  reminderDue, applyTransitions, dueStackReminders,
} from '../../worker/stacks.js';

const bpc = { peptide: 'BPC-157', route: 'Subcutaneous', dose: 250, unit: 'mcg',
  days: [0, 1, 2, 3, 4, 5, 6], times: ['08:00', '20:00'], note: '' };
const valid = { name: 'Wolverine', weeks: 6, items: [bpc] };

test('expandItems: days × times rows', () => {
  assert.equal(expandItems([bpc]).length, 14);
});

test('expandItems: no times → one row per day with null time', () => {
  const rows = expandItems([{ ...bpc, times: [] }]);
  assert.equal(rows.length, 7);
  assert.ok(rows.every(r => r.time === null));
  assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'dose', 'note', 'peptide', 'route', 'time', 'unit']);
});

test('addDays crosses month and year', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('stackEndDate = start + weeks*7 - 1; null weeks → null', () => {
  assert.equal(stackEndDate('2026-11-16', 8), '2027-01-10');
  assert.equal(stackEndDate('2026-11-16', null), null);
});

test('localDateIn uses the zone; bad zone falls back to UTC', () => {
  const now = new Date('2026-11-14T03:00:00Z');
  assert.equal(localDateIn('America/Chicago', now), '2026-11-13');
  assert.equal(localDateIn('Bad/Zone', now), '2026-11-14');
  assert.equal(localDateIn(null, now), '2026-11-14');
});

test('validateStack accepts a valid body', () => {
  assert.equal(validateStack(valid), null);
  assert.equal(validateStack({ ...valid, weeks: null }), null);
});

test('validateStack rejects bad bodies', () => {
  assert.notEqual(validateStack({ name: '', items: [] }), null);
  assert.notEqual(validateStack({ ...valid, name: 'x'.repeat(61) }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, times: ['8am'] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, times: ['01:00', '02:00', '03:00', '04:00', '05:00'] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, days: [] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, days: [7] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, dose: 0 }] }), null);
  assert.notEqual(validateStack({ ...valid, weeks: 0 }), null);
  assert.notEqual(validateStack({ ...valid, weeks: 105 }), null);
  assert.notEqual(validateStack({ ...valid, items: Array(13).fill(bpc) }), null);
});

test('rewritePlannerRows reuses ids of unchanged rows', () => {
  const existing = [
    { id: 'keep-me', peptide: 'BPC-157', day: 1, time: '08:00', route: 'Subcutaneous', dose: 250, unit: 'mcg' },
    { id: 'drop-me', peptide: 'TB-500', day: 1, time: '08:00', route: 'Subcutaneous', dose: 2, unit: 'mg' },
  ];
  const expanded = [
    { peptide: 'BPC-157', day: 1, time: '08:00', route: 'Subcutaneous', dose: 250, unit: 'mcg', note: '' },
    { peptide: 'BPC-157', day: 2, time: '08:00', route: 'Subcutaneous', dose: 250, unit: 'mcg', note: '' },
  ];
  const r = rewritePlannerRows(existing, expanded);
  assert.deepEqual(r.keep, ['keep-me']);
  assert.deepEqual(r.remove, ['drop-me']);
  assert.equal(r.add.length, 1);
  assert.equal(r.add[0].day, 2);
});

test('transitionFor: scheduled starts on its start date, not before', () => {
  assert.equal(transitionFor({ status: 'scheduled', start_date: '2026-11-14' }, '2026-11-14'), 'start');
  assert.equal(transitionFor({ status: 'scheduled', start_date: '2026-11-14' }, '2026-11-13'), null);
});

test('transitionFor: active completes the day after end_date; open-ended never does', () => {
  assert.equal(transitionFor({ status: 'active', end_date: '2026-11-13' }, '2026-11-14'), 'complete');
  assert.equal(transitionFor({ status: 'active', end_date: '2026-11-13' }, '2026-11-13'), null);
  assert.equal(transitionFor({ status: 'active', end_date: null }, '2030-01-01'), null);
  assert.equal(transitionFor({ status: 'inactive', end_date: '2026-01-01' }, '2026-11-14'), null);
});

const T = '2026-11-14';
test('cycleOps: no cycles → insert [S,E]', () => {
  const r = cycleOps({ stackCycles: [], otherCycles: [], peptides: ['BPC-157'], S: T, E: '2026-12-25', today: T });
  assert.deepEqual(r.insert, [{ peptide: 'BPC-157', start_date: T, end_date: '2026-12-25' }]);
  assert.deepEqual(r.update, []);
  assert.deepEqual(r.remove, []);
});

test('cycleOps: stack cycle ended today is reopened, not duplicated', () => {
  const stackCycles = [{ id: 'c1', peptide: 'BPC-157', start_date: '2026-11-01', end_date: T }];
  const r = cycleOps({ stackCycles, otherCycles: [], peptides: ['BPC-157'], S: T, E: '2026-12-25', today: T });
  assert.deepEqual(r.insert, []);
  assert.deepEqual(r.update, [{ id: 'c1', end_date: '2026-12-25' }]);
});

test('cycleOps: unstarted stack cycle is removed and replaced', () => {
  const stackCycles = [{ id: 'future', peptide: 'BPC-157', start_date: '2026-11-20', end_date: '2026-12-30' }];
  const r = cycleOps({ stackCycles, otherCycles: [], peptides: ['BPC-157'], S: T, E: '2026-12-25', today: T });
  assert.deepEqual(r.remove, ['future']);
  assert.equal(r.insert.length, 1);
});

test('cycleOps: an overlapping non-stack cycle suppresses the insert', () => {
  const otherCycles = [{ id: 'mine', peptide: 'BPC-157', start_date: '2026-11-01', end_date: '2026-11-30' }];
  const r = cycleOps({ stackCycles: [], otherCycles, peptides: ['BPC-157'], S: T, E: '2026-12-25', today: T });
  assert.deepEqual(r, { insert: [], update: [], remove: [] });
});

test('cycleOps: stack cycles of other peptides are ignored', () => {
  const stackCycles = [{ id: 'tb', peptide: 'TB-500', start_date: '2026-11-01', end_date: T }];
  const r = cycleOps({ stackCycles, otherCycles: [], peptides: ['BPC-157'], S: T, E: '2026-12-25', today: T });
  assert.equal(r.insert.length, 1);
  assert.deepEqual(r.update, []);
});

test('endStackCycles: started → end today; unstarted → removed; ended → untouched', () => {
  const r = endStackCycles([
    { id: 'started', start_date: '2026-11-01', end_date: '2026-12-01' },
    { id: 'unstarted', start_date: '2026-11-20', end_date: '2026-12-20' },
    { id: 'ended', start_date: '2026-10-01', end_date: '2026-10-31' },
  ], T);
  assert.deepEqual(r.update, [{ id: 'started', end_date: T }]);
  assert.deepEqual(r.remove, ['unstarted']);
});

test('coarseBounds: one day past the UTC date covers every zone ahead of UTC', () => {
  assert.deepEqual(coarseBounds(new Date('2026-11-14T03:00:00Z')), { startMax: '2026-11-15', endMax: '2026-11-15' });
});

// ── Review fixes ──────────────────────────────────────────────────────────────
test('reminderDue: stack times are local wall-clock in the stack zone', () => {
  const mon8amCST = new Date('2026-11-16T14:00:00Z');
  assert.equal(reminderDue({ day: 1, time: '08:00' }, 'America/Chicago', mon8amCST), '2026-11-16');
  assert.equal(reminderDue({ day: 1, time: '08:00' }, 'UTC', mon8amCST), null);
});

test('reminderDue: ±5 minute window, inclusive', () => {
  const now = new Date('2026-11-16T14:00:00Z');
  assert.equal(reminderDue({ day: 1, time: '08:05' }, 'America/Chicago', now), '2026-11-16');
  assert.equal(reminderDue({ day: 1, time: '07:55' }, 'America/Chicago', now), '2026-11-16');
  assert.equal(reminderDue({ day: 1, time: '08:06' }, 'America/Chicago', now), null);
  assert.equal(reminderDue({ day: 2, time: '08:00' }, 'America/Chicago', now), null);
  assert.equal(reminderDue({ day: 1, time: null }, 'America/Chicago', now), null);
});

test('reminderDue: window crossing local midnight uses the next day and date', () => {
  const mon2358CST = new Date('2026-11-17T05:58:00Z');
  assert.equal(reminderDue({ day: 2, time: '00:02' }, 'America/Chicago', mon2358CST), '2026-11-17');
  assert.equal(reminderDue({ day: 1, time: '23:55' }, 'America/Chicago', mon2358CST), '2026-11-16');
});

test('validateStack rejects non-string fields and nested or non-finite values', () => {
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, route: {} }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, unit: ['mg'] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, note: { x: 1 } }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, peptide: 'x'.repeat(81) }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, times: [['08:00']] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, dose: Infinity }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, dose: '250' }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, days: [1, 1] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, times: ['08:00', '08:00'] }] }), null);
  assert.notEqual(validateStack({ ...valid, items: [{ ...bpc, times: ['25:00'] }] }), null);
});

// Minimal D1 stand-in: enough for applyTransitions → startStmts.
function fakeEnv(stacks, failId) {
  const batches = [];
  const stmt = sql => ({ sql, args: [], bind(...a) { this.args = a; return this; },
    async all() { return { results: sql.startsWith('SELECT * FROM stacks') ? stacks : [] }; },
    async first() { return null; }, async run() { return { meta: { changes: 1 } }; } });
  return { batches, DB: { prepare: stmt, async batch(stmts) {
    if (stmts.some(s => s.args.includes(failId))) throw new Error('D1_TYPE_ERROR');
    batches.push(stmts);
  } } };
}

test('applyTransitions: one failing stack does not stop the others', async () => {
  const item = JSON.stringify([bpc]);
  const rows = [
    { id: 'bad', user_id: 'u1', status: 'scheduled', start_date: '2026-11-01', items: item, tz: 'UTC' },
    { id: 'good', user_id: 'u2', status: 'scheduled', start_date: '2026-11-01', items: item, tz: 'UTC' },
  ];
  const env = fakeEnv(rows, 'bad');
  const origError = console.error; console.error = () => {};
  try {
    const changed = await applyTransitions(env, { now: new Date('2026-11-14T12:00:00Z') });
    assert.equal(changed, 1);
    assert.equal(env.batches.length, 1);
  } finally { console.error = origError; }
});

test('dueStackReminders: picks active-stack rows due in each stack\'s own zone', async () => {
  const rows = [
    { id: 'p1', user_id: 'u1', peptide: 'BPC-157', dose: 250, unit: 'mcg', day: 1, time: '08:00', tz: 'America/Chicago' },
    { id: 'p2', user_id: 'u2', peptide: 'TB-500', dose: 2, unit: 'mg', day: 1, time: '08:00', tz: 'Europe/London' },
  ];
  let seenSql = '';
  const env = { DB: { prepare: sql => ({ bind() { return this; }, async all() { seenSql = sql; return { results: rows }; } }) } };
  const due = await dueStackReminders(env, new Date('2026-11-16T14:00:00Z'));
  assert.deepEqual(due.map(d => [d.id, d.sentDate]), [['p1', '2026-11-16']]);
  assert.match(seenSql, /status = 'active'/);
});
