// Stack Builder (2026-11-14): saved stacks → tagged planner rows + cycles,
// auto start/complete, Stacks tab, builder, checks, recommendations.
// Run against local `wrangler dev --port 8791 --local` (see README).
import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 930 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('dialog', d => { console.log('DIALOG (should not happen):', d.message()); d.dismiss(); });

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.evaluate(async () => { try { await API.post('/auth/register', { email: 'sitetest@test.com', password: 'testpass123' }); } catch {} });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// ── API: CRUD, activate/deactivate, cycles ────────────────────────────────────
const api = await page.evaluate(async () => {
  const out = {};
  const today = ymd(new Date());
  const plus = n => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Hermetic: remove stacks, planner rows, and cycles/peptides the suite uses
  for (const s of await API.get('/stacks?today=' + today)) await API.delete(`/stacks/${s.id}?today=${today}`);
  for (const p of await API.get('/planner')) await API.delete('/planner/' + p.id);
  for (const c of await API.get('/cycles')) await API.delete('/cycles/' + c.id);
  for (const p of (await API.get('/peptides')).filter(p => p.name === 'SS-31')) await API.delete('/peptides/' + p.id);

  const bpc = { peptide: 'BPC-157', route: 'Subcutaneous', dose: 250, unit: 'mcg', days: [0,1,2,3,4,5,6], times: ['08:00'] };
  const tb  = { peptide: 'TB-500',  route: 'Subcutaneous', dose: 2,   unit: 'mg',  days: [1,4],           times: ['08:00'] };
  const hand = await API.post('/planner', { peptide: 'Semaglutide', day: 1, time: '09:00', route: 'Subcutaneous', dose: 0.25, unit: 'mg' });

  const A = await API.post('/stacks', { name: 'Wolverine test', weeks: 6, items: [bpc, tb] });
  out.createdInactive = A.status === 'inactive' && Array.isArray(A.items);
  try { await API.post('/stacks', { name: '', items: [] }); out.rejectsBad = false; } catch (e) { out.rejectsBad = e.status === 400; }

  const Aon = await API.post(`/stacks/${A.id}/activate`, { start_date: today, today, tz });
  let planner = await API.get('/planner');
  out.activeStatus = Aon.status === 'active' && Aon.end_date === plus(41);
  out.rowCount = planner.filter(p => p.stack_id === A.id).length;
  out.handSurvives = planner.some(p => p.id === hand.id);
  let cycles = await API.get('/cycles');
  out.cycleCount = cycles.filter(c => c.stack_id === A.id).length;

  const B = await API.post('/stacks', { name: 'BPC solo', weeks: null, items: [{ ...bpc, times: ['20:00'] }] });
  await API.post(`/stacks/${B.id}/activate`, { start_date: today, today, tz });
  await API.post(`/stacks/${A.id}/deactivate`, { today });
  planner = await API.get('/planner');
  out.bRowsSurvive = planner.filter(p => p.stack_id === B.id).length === 7;
  out.aRowsGone = planner.filter(p => p.stack_id === A.id).length === 0;
  out.handSurvivesDeactivate = planner.some(p => p.id === hand.id);
  cycles = await API.get('/cycles');
  out.endedToday = cycles.filter(c => c.stack_id === A.id).every(c => c.end_date === today);

  await API.post(`/stacks/${A.id}/activate`, { start_date: today, today, tz });
  cycles = await API.get('/cycles');
  const aCycles = cycles.filter(c => c.stack_id === A.id);
  out.reopenedNotDuplicated = aCycles.length === 2 && aCycles.every(c => c.end_date === plus(41));

  // Edit an active stack: add SS-31, remove TB-500
  const bpcIdsBefore = (await API.get('/planner')).filter(p => p.stack_id === A.id && p.peptide === 'BPC-157').map(p => p.id).sort();
  const ss = { peptide: 'SS-31', route: 'Subcutaneous', dose: 5, unit: 'mg', days: [1,3,5], times: [] };
  await API.put(`/stacks/${A.id}`, { name: 'Wolverine test', weeks: 6, items: [bpc, ss], today });
  planner = await API.get('/planner'); cycles = await API.get('/cycles');
  const bpcIdsAfter = planner.filter(p => p.stack_id === A.id && p.peptide === 'BPC-157').map(p => p.id).sort();
  out.bpcIdsKept = JSON.stringify(bpcIdsBefore) === JSON.stringify(bpcIdsAfter) && bpcIdsAfter.length === 7;
  out.tbRowsGone = !planner.some(p => p.stack_id === A.id && p.peptide === 'TB-500');
  const ssCycle = cycles.find(c => c.stack_id === A.id && c.peptide === 'SS-31');
  out.ssCycle = !!ssCycle && ssCycle.start_date === today && ssCycle.end_date === plus(41);
  const tbCycle = cycles.find(c => c.stack_id === A.id && c.peptide === 'TB-500');
  out.tbCycleEnded = !!tbCycle && tbCycle.end_date === today;
  out.ssAddedToPeptides = (await API.get('/peptides')).filter(p => p.name === 'SS-31').length === 1;

  // Change weeks 6 → 8: unended stack cycles retarget
  const A8 = await API.put(`/stacks/${A.id}`, { name: 'Wolverine test', weeks: 8, items: [bpc, ss], today });
  cycles = await API.get('/cycles');
  out.weeksRetarget = A8.end_date === plus(55) &&
    cycles.filter(c => c.stack_id === A.id && c.end_date > today).every(c => c.end_date === plus(55));

  // Future start → scheduled, no rows
  const C = await API.post('/stacks', { name: 'Later', weeks: 4, items: [tb] });
  const Cs = await API.post(`/stacks/${C.id}/activate`, { start_date: plus(3), today, tz });
  out.scheduled = Cs.status === 'scheduled' && !(await API.get('/planner')).some(p => p.stack_id === C.id);

  // Delete an active stack: rows gone, started cycle ends today
  await API.delete(`/stacks/${A.id}?today=${today}`);
  planner = await API.get('/planner'); cycles = await API.get('/cycles');
  out.deletedRowsGone = !planner.some(p => p.stack_id === A.id);
  out.deletedCycleEnded = cycles.filter(c => c.stack_id === A.id).every(c => c.end_date === today);
  out.deletedGone = !(await API.get('/stacks?today=' + today)).some(s => s.id === A.id);

  const exp = await API.get('/export');
  out.exportHasStacks = Array.isArray(exp.stacks) && exp.stacks.length >= 2;
  return out;
});

check('create → inactive, items parsed', api.createdInactive);
check('invalid body → 400', api.rejectsBad);
check('activate today → active, end = start + 6w − 1', api.activeStatus);
check('activate writes 7 + 2 tagged planner rows', api.rowCount === 9, api.rowCount);
check('hand-made planner row survives activate', api.handSurvives);
check('activate writes one cycle per peptide', api.cycleCount === 2, api.cycleCount);
check("deactivate A leaves B's shared-peptide rows", api.bRowsSurvive);
check("deactivate removes A's rows", api.aRowsGone);
check('hand-made row survives deactivate', api.handSurvivesDeactivate);
check('deactivate ends started cycles today', api.endedToday);
check('off → on same day reopens cycles (no duplicates)', api.reopenedNotDuplicated);
check('edit active stack keeps unchanged row ids', api.bpcIdsKept);
check('edit removes dropped peptide rows', api.tbRowsGone);
check('added peptide cycle runs today → stack end', api.ssCycle);
check("removed peptide's cycle ends today", api.tbCycleEnded);
check('missing peptide added to peptides list once', api.ssAddedToPeptides);
check('weeks 6 → 8 retargets unended cycles', api.weeksRetarget);
check('future start → scheduled, no planner rows', api.scheduled);
check('delete active stack removes its rows', api.deletedRowsGone);
check('delete ends its started cycles today', api.deletedCycleEnded);
check('deleted stack no longer listed', api.deletedGone);
check('export includes stacks', api.exportHasStacks);

// ── Transitions: scheduled → active, active → completed (GET ?today=) ────────
const tr = await page.evaluate(async () => {
  const out = {};
  const today = ymd(new Date());
  const plus = n => { const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const item = { peptide: 'Ipamorelin', route: 'Subcutaneous', dose: 200, unit: 'mcg', days: [0,1,2,3,4,5,6], times: ['22:00'] };
  const later = await API.post('/stacks', { name: 'Starts later', weeks: 4, items: [item] });
  await API.post(`/stacks/${later.id}/activate`, { start_date: plus(3), today, tz });
  let list = await API.get('/stacks?today=' + plus(2));
  out.stillScheduled = list.find(s => s.id === later.id).status === 'scheduled';
  list = await API.get('/stacks?today=' + plus(3));
  out.startedOnDay = list.find(s => s.id === later.id).status === 'active' &&
    (await API.get('/planner')).filter(p => p.stack_id === later.id).length === 7;

  const short = await API.post('/stacks', { name: 'Short', weeks: 1, items: [{ ...item, peptide: 'Sermorelin' }] });
  await API.post(`/stacks/${short.id}/activate`, { start_date: plus(-10), today, tz });
  const cyclesBefore = (await API.get('/cycles')).filter(c => c.stack_id === short.id);
  list = await API.get('/stacks?today=' + today);
  out.completed = list.find(s => s.id === short.id).status === 'completed' &&
    !(await API.get('/planner')).some(p => p.stack_id === short.id);
  const cyclesAfter = (await API.get('/cycles')).filter(c => c.stack_id === short.id);
  out.cyclesUntouched = JSON.stringify(cyclesBefore) === JSON.stringify(cyclesAfter) && cyclesAfter.length === 1;

  const open = await API.post('/stacks', { name: 'Ongoing', weeks: null, items: [{ ...item, peptide: 'Tesamorelin' }] });
  await API.post(`/stacks/${open.id}/activate`, { start_date: today, today, tz });
  list = await API.get('/stacks?today=' + plus(400));
  out.openEndedStays = list.find(s => s.id === open.id).status === 'active';
  return out;
});
check('scheduled stays scheduled the day before', tr.stillScheduled);
check('scheduled → active on its start date, rows written', tr.startedOnDay);
check('active → completed after end date, rows removed', tr.completed);
check('completing leaves cycles as they were', tr.cyclesUntouched);
check('open-ended stack never completes', tr.openEndedStays);

// ── Cron path: each stack's own zone, no client date ─────────────────────────
const cronId = await page.evaluate(async () => {
  const today = ymd(new Date());
  const d = new Date(today + 'T00:00:00'); d.setDate(d.getDate() - 10);
  const s = await API.post('/stacks', { name: 'Cron expiry', weeks: 1, items: [{ peptide: 'DSIP', route: 'Subcutaneous', dose: 100, unit: 'mcg', days: [1], times: [] }] });
  await API.post(`/stacks/${s.id}/activate`, { start_date: ymd(d), today, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  return s.id;
});
const cronRes = await fetch('http://localhost:8791/__scheduled?cron=*/5+*+*+*+*');
const cronStatus = await page.evaluate(async id => (await API.get('/export')).stacks.find(s => s.id === id)?.status, cronId);
check('cron completes an expired stack', cronRes.status === 200 && cronStatus === 'completed', `${cronRes.status} ${cronStatus}`);

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

// Leave no stack state behind: later suites seed BPC-157 and read cycles/planner.
await page.evaluate(async () => {
  const today = ymd(new Date());
  for (const s of await API.get('/stacks?today=' + today)) await API.delete(`/stacks/${s.id}?today=${today}`);
  for (const p of await API.get('/planner')) await API.delete('/planner/' + p.id);
  for (const c of await API.get('/cycles')) await API.delete('/cycles/' + c.id);
});
await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
