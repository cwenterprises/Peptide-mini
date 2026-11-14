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

// ── UI: Stacks tab list ───────────────────────────────────────────────────────
await page.evaluate(async () => {
  const today = ymd(new Date());
  for (const s of await API.get('/stacks?today=' + today)) await API.delete(`/stacks/${s.id}?today=${today}`);
  const item = { peptide: 'BPC-157', route: 'Subcutaneous', dose: 250, unit: 'mcg', days: [0,1,2,3,4,5,6], times: ['08:00'] };
  const on = await API.post('/stacks', { name: 'UI active', weeks: 6, items: [item] });
  await API.post(`/stacks/${on.id}/activate`, { start_date: today, today, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  await API.post('/stacks', { name: 'UI off', weeks: null, items: [{ ...item, peptide: 'TB-500', dose: 2, unit: 'mg' }] });
  await App.loadAll(); renderAllTabs();
});
const navHasStacks = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('.nav-tab')].map(b => b.dataset.tab);
  return tabs.indexOf('stacks') === tabs.indexOf('week') + 1;
});
check('Stacks tab sits right after Week', navHasStacks);
await page.click('[data-tab="stacks"]');
const ui = await page.evaluate(() => {
  const el = document.getElementById('stacks');
  return { visible: el.classList.contains('active'), cards: el.querySelectorAll('[data-stack-id]').length, text: el.innerText,
    dataLoaded: Array.isArray(App.getData().stacks) };
});
check('Stacks tab visible', ui.visible);
check('stacks loaded into App data', ui.dataLoaded);
check('one card per stack', ui.cards === 2, ui.cards);
check('active card shows "week 1 of 6"', /week 1 of 6/i.test(ui.text));
check('inactive card shows Off', /\bOff\b/.test(ui.text));
const todayHas = await page.evaluate(() => { renderToday(); return document.getElementById('today').innerText.includes('BPC-157'); });
check("Today shows the active stack's peptide", todayHas);
const hintFixed = await page.evaluate(() => {
  const saved = App.getData().planner; App.getData().planner = [];
  renderToday(); const t = document.getElementById('today').innerText;
  App.getData().planner = saved; renderToday();
  return t.includes('Stacks') && !t.includes('in Settings');
});
check('empty Today points to the Stacks tab', hintFixed);
// Deactivate from the card (inline, no dialog)
await page.click('[data-stack-id] [data-act="deactivate"]');
await page.waitForTimeout(1500);
const afterOff = await page.evaluate(() => App.getData().stacks.every(s => s.status === 'inactive') && !App.getData().planner.some(p => p.stack_id));
check('Deactivate button turns the stack off', afterOff);

// ── UI: builder, preview, templates ───────────────────────────────────────────
const names = await page.evaluate(() => ({
  spaced: resolvePeptideName('bpc 157', [{ name: 'BPC-157' }]),
  caseOnly: resolvePeptideName('ghk-cu', [{ name: 'GHK-CU' }]),
  alias: resolvePeptideName('Mod GRF 1-29', [{ name: 'CJC-1295' }]),
  libraryOnly: resolvePeptideName('mots-c', []),
  unknown: resolvePeptideName('My Custom Blend', []),
}));
check("resolvePeptideName: 'bpc 157' → user's BPC-157", names.spaced === 'BPC-157', names.spaced);
check("resolvePeptideName: case-only difference → user's name", names.caseOnly === 'GHK-CU', names.caseOnly);
check("resolvePeptideName: library alias → user's name", names.alias === 'CJC-1295', names.alias);
check('resolvePeptideName: not tracked → library name', names.libraryOnly === 'MOTS-C', names.libraryOnly);
check('resolvePeptideName: unknown stays as typed', names.unknown === 'My Custom Blend');
const tplOk = await page.evaluate(() => STACK_TEMPLATES.every(t => t.items.every(i => PEPTIDE_LIBRARY.some(l => l.name === i.peptide))) && STACK_TEMPLATES.length >= 6);
check('every template peptide exists in the library', tplOk);
check('expandItemsClient matches the server contract', await page.evaluate(() =>
  expandItemsClient([{ peptide: 'X', route: 'Subcutaneous', dose: 1, unit: 'mg', days: [1, 2], times: ['08:00', '20:00'] }]).length === 4 &&
  expandItemsClient([{ peptide: 'X', route: 'Subcutaneous', dose: 1, unit: 'mg', days: [1, 2], times: [] }]).every(r => r.time === null)));

await page.evaluate(() => { Tabs.switchTo('stacks'); openStackFromTemplate('wolverine'); });
const tpl = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('#stacks [data-sb-item]')].map(r => r.querySelector('[data-sb="peptide"]').value),
  name: document.getElementById('sbName')?.value,
}));
check('Wolverine template opens builder with 2 rows', tpl.rows.length === 2 && tpl.rows.includes('BPC-157') && tpl.rows.includes('TB-500'), JSON.stringify(tpl));
const tbIdx = tpl.rows.indexOf('TB-500');
await page.selectOption(`#stacks [data-sb-item="${tbIdx}"] [data-sb="preset"]`, 'mwf');
const preview = await page.evaluate(() => document.getElementById('sbPreview')?.innerText || '');
check('preset M/W/F → preview "TB-500 · 3 doses/week"', /TB-500[^\n]*3 doses\/week/.test(preview), preview.slice(0, 200));
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(300);
check('builder has no horizontal scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= 390));
await page.setViewportSize({ width: 430, height: 930 });
await page.click('#sbSaveOn');
await page.click('#sbStartGo');
await page.waitForTimeout(1500);
const saved = await page.evaluate(() => {
  const st = App.getData().stacks.find(s => s.template === 'wolverine');
  return st && { status: st.status, view: _stackView.mode, tb: st.items.find(i => i.peptide === 'TB-500')?.days };
});
check('Save & turn on → Wolverine active, back to list', saved?.status === 'active' && saved.view === 'list', JSON.stringify(saved));
check('saved TB-500 days are M/W/F', JSON.stringify(saved?.tb) === '[1,3,5]');

await page.evaluate(() => openStackBuilder(null));
await page.fill('#sbName', 'No times');
await page.fill('#stacks [data-sb-item="0"] [data-sb="peptide"]', 'Semax');
await page.dispatchEvent('#stacks [data-sb-item="0"] [data-sb="peptide"]', 'change');
await page.fill('#stacks [data-sb-item="0"] [data-sb="dose"]', '200');
await page.dispatchEvent('#stacks [data-sb-item="0"] [data-sb="dose"]', 'change');
await page.evaluate(() => { _sb.items[0].times = []; renderStackBuilder(); });
await page.click('#sbSave');
await page.waitForTimeout(1500);
const nt = await page.evaluate(() => App.getData().stacks.find(s => s.name === 'No times'));
check('builder saves a stack with no dose times', nt && nt.status === 'inactive' && nt.items[0].times.length === 0 && nt.items[0].route === 'Intranasal', JSON.stringify(nt?.items?.[0]));

// ── Checks: clashes and pairings ──────────────────────────────────────────────
const ck = await page.evaluate(() => {
  const it = (peptide) => ({ peptide, route: 'Subcutaneous', dose: 1, unit: 'mg', days: [1], times: [] });
  const lv = (items, stacks = [], id = null) => checkStack(items.map(it), stacks, id);
  const glp = lv(['Semaglutide', 'Tirzepatide']);
  const gh = lv(['CJC-1295', 'Ipamorelin']);
  const blend = lv(['Wolverine', 'BPC-157']);
  const fine = lv(['Semax', 'Selank']);
  const active = [{ id: 'other', name: 'Recovery', status: 'active', items: [it('BPC-157')] }];
  const overlap = lv(['BPC 157'], active);
  const selfEdit = lv(['BPC-157'], active, 'other');
  const igf = lv(['HGH', 'IGF-1 LR3']);
  return {
    glpSevere: glp.filter(c => c.level === 'severe').length === 1,
    ghTip: gh.some(c => c.level === 'tip'),
    blendCaution: blend.some(c => c.level === 'caution' && /Wolverine/.test(c.message)),
    fineNoWarnings: !fine.some(c => c.level !== 'tip'),
    overlap: overlap.some(c => c.level === 'caution' && /Recovery/.test(c.message)),
    noSelfOverlap: !selfEdit.some(c => /Recovery/.test(c.message)),
    igfSevere: igf.some(c => c.level === 'severe'),
    rulesCited: STACK_RULES.every(r => PEPTIDE_LIBRARY.some(l => l.name === r.source)),
  };
});
check('Semaglutide + Tirzepatide → one severe clash', ck.glpSevere);
check('CJC-1295 + Ipamorelin → synergy tip', ck.ghTip);
check('Wolverine blend + BPC-157 → duplicate-dosing caution', ck.blendCaution);
check('Semax + Selank → no warnings', ck.fineNoWarnings);
check('peptide already in another active stack → caution naming it', ck.overlap);
check("editing a stack doesn't warn about itself", ck.noSelfOverlap);
check('HGH + IGF-1 LR3 → severe (library: hypoglycemia risk)', ck.igfSevere);
check('every rule cites a library entry', ck.rulesCited);
await page.evaluate(() => {
  openStackBuilder(null);
  _sb.items = [sbItem({ peptide: 'Semaglutide', dose: 0.25, unit: 'mg' }), sbItem({ peptide: 'Tirzepatide', dose: 2.5, unit: 'mg' })];
  _sb.name = 'Clash'; renderStackBuilder();
});
const panel = await page.evaluate(() => document.getElementById('sbChecks')?.innerText || '');
check('builder shows the clash in a Checks panel', /GLP-1/.test(panel), panel.slice(0, 120));
await page.click('#sbSaveOn');
check('severe clash → "Turn on anyway"', (await page.textContent('#sbStartGo')).includes('anyway'));
await page.evaluate(() => { _sb = null; _stackView = { mode: 'list' }; renderStacks(); });

// ── Recommendations: recommended stacks + suggested partners ─────────────────
await page.evaluate(async () => {
  for (const i of await API.get('/inventory')) await API.delete('/inventory/' + i.id);
  for (const name of ['MOTS-C', 'SS-31', 'NAD+']) await API.post('/inventory', { name, category: 'Peptide', size: null, qty: 10 });
  await API.post('/inventory', { name: 'TB-500', category: 'Peptide', size: null, qty: 2 });
  await App.loadAll(); renderAllTabs(); Tabs.switchTo('stacks');
});
const rec = await page.evaluate(() => {
  const inStock = inStockNames(App.getData().inventory, App.getData().peptides);
  const ranked = recommendStacks(STACK_TEMPLATES, inStock);
  const cards = [...document.querySelectorAll('#stacks [data-reco]')].map(c => ({ key: c.dataset.reco, text: c.innerText }));
  const sym = Object.entries(STACK_PAIRINGS).every(([a, bs]) => bs.every(b => (STACK_PAIRINGS[b] || []).includes(a)));
  const allLib = Object.entries(STACK_PAIRINGS).every(([a, bs]) => [a, ...bs].every(n => PEPTIDE_LIBRARY.some(l => l.name === n)));
  return { count: STACK_TEMPLATES.length, first: ranked[0]?.template.key, firstHave: ranked[0] && `${ranked[0].have}/${ranked[0].total}`,
    cards, sym, allLib, sourcesOk: STACK_TEMPLATES.every(t => t.goal && PEPTIDE_LIBRARY.some(l => l.name === t.source)) };
});
check('14 recommended stacks, each with goal + library source', rec.count === 14 && rec.sourcesOk, rec.count);
check('Mitochondrial ranks first with 3/3 in stock', rec.first === 'mito' && rec.firstHave === '3/3', `${rec.first} ${rec.firstHave}`);
check('Recommended cards render, first shows "In stock: 3 of 3"', rec.cards[0]?.key === 'mito' && /In stock: 3 of 3/.test(rec.cards[0].text), rec.cards[0]?.text?.slice(0, 80));
check('STACK_PAIRINGS is symmetric', rec.sym);
check('STACK_PAIRINGS uses library names only', rec.allLib);
await page.click('#stacks [data-reco="mito"] [data-act="use"]');
check('tapping a recommendation opens the builder prefilled', await page.evaluate(() => _stackView.mode === 'builder' && _sb.items.length === 3 && _sb.template === 'mito'));

await page.evaluate(() => { openStackBuilder(null); _sb.items = [sbItem({ peptide: 'BPC-157', dose: 250, unit: 'mcg' })]; renderStackBuilder(); });
const chips = await page.evaluate(() => [...document.querySelectorAll('#stacks [data-partner]')].map(c => ({ p: c.dataset.partner, t: c.innerText })));
check('BPC-157 suggests TB-500, GHK-CU and KPV', ['TB-500', 'GHK-CU', 'KPV'].every(n => chips.some(c => c.p === n)), JSON.stringify(chips.map(c => c.p)));
check('in-stock partner is listed first and marked', chips[0]?.p === 'TB-500' && /in stock/i.test(chips[0].t));
await page.click('#stacks [data-partner="TB-500"]');
const added = await page.evaluate(() => _sb.items.map(i => i.peptide));
check('tapping a partner chip adds it as a row', added.includes('TB-500') && added.length === 2, JSON.stringify(added));
const glpChips = await page.evaluate(() => {
  _sb.items = [sbItem({ peptide: 'Semaglutide', dose: 0.25, unit: 'mg' })]; renderStackBuilder();
  return suggestPartners(_sb.items, inStockNames(App.getData().inventory, App.getData().peptides), App.getData().stacks).map(s => s.peptide);
});
check('Semaglutide never suggests another GLP-1', !glpChips.some(n => ['Tirzepatide', 'Retatrutide'].includes(n)) && glpChips.length > 0, JSON.stringify(glpChips));
await page.evaluate(async () => {
  _sb = null; _stackView = { mode: 'list' };
  for (const i of await API.get('/inventory')) await API.delete('/inventory/' + i.id);
});

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
