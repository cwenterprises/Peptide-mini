// Dashboard levels timeline: real curve from logged doses + planner projection (2026-11-12).
// Run against local `wrangler dev --port 8791 --local` (see README).
import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const SHOTS = process.env.SHOTS || '';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('dialog', d => d.accept());

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.evaluate(async () => { try { await API.post('/auth/register', { email: 'sitetest@test.com', password: 'testpass123' }); } catch {} });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// ── 1. Window sizing ──
const w = await page.evaluate(() => [levelsWindow(4), levelsWindow(24), levelsWindow(168)]);
check('BPC-157 (4h): 3 days back, 2 ahead', w[0].pastH === 72 && w[0].futureH === 48, JSON.stringify(w[0]));
check('TB-500 (24h): 10 days back, 5 ahead', w[1].pastH === 240 && w[1].futureH === 120, JSON.stringify(w[1]));
check('Semaglutide (168h): 42 days back, 21 ahead (capped)', w[2].pastH === 1008 && w[2].futureH === 504, JSON.stringify(w[2]));

// Hermetic seed (all relative to a single NOW captured in the page):
//  Semaglutide 250 mcg logged at now−14d and now−7d.
//  Planner Semaglutide 0.25 mg on weekday(today+2) and weekday(today−3), 08:00.
const seed = await page.evaluate(async () => {
  const d = App.getData();
  for (const l of d.logs.filter(x => ['Semaglutide', 'BPC-157'].includes(x.peptide))) await API.delete('/logs/' + l.id).catch(() => {});
  for (const p of d.planner) await API.delete('/planner/' + p.id).catch(() => {});
  for (const c of (d.cycles || []).filter(c => ['Semaglutide', 'BPC-157'].includes(c.peptide))) await API.delete('/cycles/' + c.id).catch(() => {});
  const now = Date.now();
  window.__NOW = now;
  for (const daysAgo of [14, 7]) await API.post('/logs', { peptide: 'Semaglutide', route: 'Subcutaneous', dose_value: 250, dose_unit: 'mcg', dose_mcg: 250, taken_at: new Date(now - daysAgo * 86400000).toISOString(), site: 'abd-rl' });
  const today = new Date(now).getDay();
  const dA = (today + 2) % 7, dB = (today + 7 - 3) % 7;
  await API.post('/planner', { peptide: 'Semaglutide', day: dA, time: '08:00', route: 'Subcutaneous', dose: 0.25, unit: 'mg' });
  await API.post('/planner', { peptide: 'Semaglutide', day: dB, time: '08:00', route: 'Subcutaneous', dose: 0.25, unit: 'mg' });
  await App.loadAll();
  return { now };
});

// ── 2. Real curve matches the model and the Active Levels card ──
const t1 = await page.evaluate(() => {
  const tl = levelsTimeline(App.getData(), 'Semaglutide', window.__NOW);
  const card = estimateLevels(App.getData().logs).find(l => l.peptide === 'Semaglutide');
  const planned = tl.doses.filter(d => d.kind === 'planned');
  const next = planned[0];
  return { now: tl.level(window.__NOW), card: card?.mcg, planned: planned.length, plannedMcg: planned.map(p => p.mcg),
    missed: tl.missed.length, nextT: next?.t, lowBefore: next && tl.level(next.t - 1), afterNext: next && tl.level(next.t),
    beforeFirst: tl.level(window.__NOW - 15 * 86400000) };
});
const expNow = 250 * (Math.pow(0.5, 2) + Math.pow(0.5, 1)); // 187.5
check('Level now = 250·(½² + ½¹) = 187.5 mcg', near(t1.now, expNow, 0.5), t1.now?.toFixed(2));
check('Timeline agrees with Active Levels card', near(t1.now, t1.card, 0.5), `${t1.now?.toFixed(1)} vs ${t1.card?.toFixed(1)}`);
check('Level before first dose = 0', t1.beforeFirst === 0);
check('6 planned doses projected over 21 days (2 weekdays × 3 weeks)', t1.planned === 6, t1.planned);
check('Planned 0.25 mg → 250 mcg each', t1.plannedMcg.every(m => m === 250));
const hoursToNext = (t1.nextT - seed.now) / 3600000;
check('Low point before next dose decays from now', near(t1.lowBefore, expNow * Math.pow(0.5, hoursToNext / 168), 0.5), t1.lowBefore?.toFixed(1));
check('Next dose adds 250 mcg', near(t1.afterNext - t1.lowBefore, 250, 0.5));
check('4 planned-but-unlogged doses in last 14 days', t1.missed === 4, t1.missed);

// ── 3. Cycle end stops the projection; finished old cycles are ignored ──
const cyc = await page.evaluate(async () => {
  const now = window.__NOW;
  const ymdL = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const data = App.getData();
  const withEnd = { ...data, cycles: [{ id: 'x', peptide: 'Semaglutide', start_date: ymdL(now - 30 * 86400000), end_date: ymdL(now + 5 * 86400000) }] };
  const oldOnly = { ...data, cycles: [{ id: 'y', peptide: 'Semaglutide', start_date: '2025-01-01', end_date: '2025-03-01' }] };
  const a = levelsTimeline(withEnd, 'Semaglutide', now), b = levelsTimeline(oldOnly, 'Semaglutide', now);
  return { capped: a.doses.filter(d => d.kind === 'planned').length, lastPlanned: Math.max(...a.doses.filter(d => d.kind === 'planned').map(d => d.t)) - now,
    oldIgnored: b.doses.filter(d => d.kind === 'planned').length };
});
check('Cycle ending in 5 days: only doses before it are projected', cyc.capped === 2 && cyc.lastPlanned < 6 * 86400000, `${cyc.capped} planned`);
check('Old finished cycle does not block the projection', cyc.oldIgnored === 6, cyc.oldIgnored);

// ── 4. Dashboard UI ──
await page.evaluate(() => { Tabs.switchTo('dashboard'); renderDashboard(); });
const ui = await page.evaluate(() => {
  const sec = document.getElementById('lvlChartSection');
  return { has: !!sec, svg: !!sec?.querySelector('svg.lv-chart'), proj: !!sec?.querySelector('.lv-proj'),
    missedMarks: (sec?.querySelector('svg.lv-chart')?.textContent.match(/✕/g) || []).length,
    stats: sec?.querySelector('.hl-stats')?.textContent.replace(/\s+/g, ' ') || '', legend: sec?.textContent || '' };
});
check('Timeline renders inside Active Levels', ui.has && ui.svg);
check('Dashed projection drawn', ui.proj);
check('4 ✕ markers for unlogged planned doses', ui.missedMarks === 4, ui.missedMarks);
// 187.5 at seed time; a few seconds of decay before render can round it to 187
check('Stats: estimated now ≈ 187.5 mcg', /\b18[78] mcgEstimated now/.test(ui.stats.replace(/\s+/g, '')) || ui.stats.includes('187 mcg') || ui.stats.includes('188 mcg'), ui.stats);
check('Stats: next planned dose + low point', ui.stats.includes('Next planned dose') && ui.stats.includes('Low point'));
check('Stats: missed count', ui.stats.includes('not logged'));
if (SHOTS) { await page.locator('#lvlChartSection').scrollIntoViewIfNeeded(); await page.locator('#lvlChartSection').screenshot({ path: `${SHOTS}/levels-sema.png` }); }

// Hover in the future half shows "(projected)"
await page.locator('#lvlChartSection svg.lv-chart').scrollIntoViewIfNeeded();
const box = await page.locator('#lvlChartSection svg.lv-chart').boundingBox();
await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
const tip = await page.evaluate(() => document.querySelector('#lvlChartSection .hl-tip').textContent);
check('Hover in the future reads "(projected)"', tip.includes('(projected)'), tip);
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
const tip2 = await page.evaluate(() => document.querySelector('#lvlChartSection .hl-tip').textContent);
check('Hover in the past has no "(projected)"', tip2 && !tip2.includes('(projected)'), tip2);

// ── 5. Second peptide → chips; switching re-renders ──
await page.evaluate(async () => {
  await API.post('/logs', { peptide: 'BPC-157', route: 'Subcutaneous', dose_value: 500, dose_unit: 'mcg', dose_mcg: 500, taken_at: new Date(Date.now() - 3600000).toISOString(), site: 'abd-rl' });
  await App.loadAll(); renderDashboard();
});
const chips = await page.evaluate(() => [...document.querySelectorAll('#lvlChartSection button[data-pep]')].map(b => b.dataset.pep));
check('Chips for both peptides, highest level first', chips.length === 2 && chips[0] === 'BPC-157', JSON.stringify(chips));
await page.click('#lvlChartSection button[data-pep="Semaglutide"]');
const label = await page.evaluate(() => document.querySelector('#lvlChartSection svg.lv-chart').getAttribute('aria-label'));
check('Switching chip shows that peptide', label.startsWith('Semaglutide'), label.slice(0, 40));
await page.click('#lvlChartSection button[data-pep="BPC-157"]');
const bpc = await page.evaluate(() => ({ label: document.querySelector('#lvlChartSection svg.lv-chart').getAttribute('aria-label'),
  stats: document.querySelector('#lvlChartSection .hl-stats').textContent }));
check('BPC-157 view: no planner → "until 10%" stat', bpc.label.startsWith('BPC-157') && bpc.stats.includes('10% of now'), bpc.stats.replace(/\s+/g, ' '));
if (SHOTS) await page.locator('#lvlChartSection').screenshot({ path: `${SHOTS}/levels-bpc.png` });

// Cleanup
await page.evaluate(async () => {
  const d = App.getData();
  for (const l of d.logs.filter(x => ['Semaglutide', 'BPC-157'].includes(x.peptide))) await API.delete('/logs/' + l.id).catch(() => {});
  for (const p of d.planner) await API.delete('/planner/' + p.id).catch(() => {});
});

check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
