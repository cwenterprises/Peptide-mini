// Unit tests for the pure stack core. Run from the repo root: node --test test/unit/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStack, addDays, stackEndDate, localDateIn, expandItems,
  rewritePlannerRows, transitionFor, cycleOps, endStackCycles,
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
