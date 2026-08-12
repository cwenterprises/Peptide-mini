import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('dialog', d => d.accept());

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// Hermetic: wipe residue from previous runs before seeding
await page.evaluate(async () => {
  const d = App.getData();
  for (const l of d.logs.filter(x => ['Semaglutide', 'Ipamorelin'].includes(x.peptide))) await API.delete('/logs/' + l.id).catch(() => {});
  for (const i of (d.inventory || []).filter(x => x.name === 'Semaglutide')) await API.delete('/inventory/' + i.id).catch(() => {});
  await App.loadAll();
});

// Seed: Semaglutide (t½ 168h) dose 2 days ago + Ipamorelin (t½ 2h) dose 1h ago
await page.evaluate(async () => {
  await API.post('/logs', { peptide: 'Semaglutide', route: 'Subcutaneous', dose_value: 1, dose_unit: 'mg',
    dose_mcg: 1000, taken_at: new Date(Date.now() - 48 * 3600000).toISOString(), site: 'abd-rl' });
  await API.post('/logs', { peptide: 'Ipamorelin', route: 'Subcutaneous', dose_value: 200, dose_unit: 'mcg',
    dose_mcg: 200, taken_at: new Date(Date.now() - 3600000).toISOString(), site: 'abd-rl' });
  await App.loadAll();
  renderLogViews();
});
await page.waitForTimeout(600);

// ── 1. Live levels ──
const levels = await page.evaluate(() => estimateLevels(App.getData().logs));
const sema = levels.find(l => l.peptide === 'Semaglutide');
const ipam = levels.find(l => l.peptide === 'Ipamorelin');
check('Semaglutide level ≈ 820 mcg after 48h (t½ 168h)', sema && Math.abs(sema.mcg - 1000 * Math.pow(0.5, 48 / 168)) < 5, sema && Math.round(sema.mcg));
check('Ipamorelin level ≈ 141 mcg after 1h (t½ 2h)', ipam && Math.abs(ipam.mcg - 200 * Math.pow(0.5, 0.5)) < 5, ipam && Math.round(ipam.mcg));
const dashHas = await page.evaluate(() => document.getElementById('dashboard').innerHTML);
check('Active Levels card renders', dashHas.includes('Active Levels') && dashHas.includes('Semaglutide'));

// ── 2. Peptide notes ──
await page.evaluate(async () => { await API.put('/peptide-notes', { peptide: 'Semaglutide', notes: 'my test note about titration' }); await App.loadAll(); });
const noteInSheet = await page.evaluate(() => {
  showPeptideInfo('Semaglutide');
  const html = document.getElementById('pepInfoOverlay').innerHTML;
  document.getElementById('pepInfoOverlay').remove();
  return html.includes('My Notes') && html.includes('my test note about titration');
});
check('Note saved and visible in ⓘ sheet', noteInSheet);
const noteDeleted = await page.evaluate(async () => {
  const r = await API.put('/peptide-notes', { peptide: 'Semaglutide', notes: '' });
  await App.loadAll();
  return r.deleted === true && peptideNote('Semaglutide') === '';
});
check('Empty save deletes note', noteDeleted);

// ── 3. Check-in + weight card ──
await page.evaluate(async () => {
  const d = new Date();
  const f = x => { const p = n => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
  for (let i = 5; i >= 0; i--) {
    const day = new Date(d.getTime() - i * 86400000);
    await API.put('/checkins', { date: f(day), weight: 200 - (5 - i) * 0.5, energy: 4, sleep: 3 });
  }
  await App.loadAll();
  renderLogViews();
});
await page.waitForTimeout(600);
const todayHtml = await page.evaluate(() => document.getElementById('today').innerHTML);
check('Daily Check-in card on Today', todayHtml.includes('Daily Check-in'));
const ciPersisted = await page.evaluate(() => {
  const t = (App.getData().checkins || []).find(c => c.weight === 197.5);
  return !!t;
});
check('Check-ins persisted (weight 197.5 present)', ciPersisted);
const weightCard = await page.evaluate(() => { renderDashboard(); return document.getElementById('dashboard').innerHTML; });
check('Weight Trend chart with delta', weightCard.includes('Weight Trend') && weightCard.includes('-2.5 over'));

// ── 4. Reorder projection ──
await page.evaluate(async () => {
  await API.post('/inventory', { name: 'Semaglutide', category: 'Peptide', size: '10 mg', qty: 1 });
  // burn: ~12mg over the 28d window → 1×10mg vial ≈ 23 days left (inside the 45d alert cutoff)
  await API.post('/logs', { peptide: 'Semaglutide', route: 'Subcutaneous', dose_value: 11, dose_unit: 'mg',
    dose_mcg: 11000, taken_at: new Date(Date.now() - 5 * 86400000).toISOString() });
  await App.loadAll();
  renderInventory();
});
await page.waitForTimeout(400);
const proj = await page.evaluate(() => inventoryProjections());
check('Projection computed for Semaglutide', proj.some(p => p.name === 'Semaglutide' && p.daysLeft > 0 && p.daysLeft <= 45), JSON.stringify(proj));
const invHtml = await page.evaluate(() => document.getElementById('inventory').innerHTML);
check('Runs-out banner in Inventory', invHtml.includes('runs out'));

// ── 5. Heat-scaled dots ──
const dotScaled = await page.evaluate(() => {
  renderToday();
  const svg = document.querySelector('#today svg');
  return /r="[0-9.]+"/.test(document.getElementById('today').innerHTML) &&
    document.getElementById('today').innerHTML.includes('× in 90d');
});
check('Site dots carry frequency tooltip', dotScaled);

// ── 6. Rest-day streak ──
const streakOk = await page.evaluate(async () => {
  // planner: only today's weekday scheduled → yesterday (unscheduled) must not break streak
  for (const p of App.getData().planner) await API.delete('/planner/' + p.id).catch(() => {});
  await API.post('/planner', { peptide: 'Semaglutide', day: new Date().getDay(), route: 'Subcutaneous', dose: 1, unit: 'mg' });
  await API.post('/logs', { peptide: 'Semaglutide', route: 'Subcutaneous', dose_value: 1, dose_unit: 'mg',
    dose_mcg: 1000, taken_at: new Date().toISOString() });
  await App.loadAll();
  return calcStreak(App.getData().logs) >= 1;
});
check('Rest days do not break streak', streakOk);

// ── 7. Export ──
const exp = await page.evaluate(async () => await API.get('/export'));
check('Export contains all tables + version', exp.version === 1 && Array.isArray(exp.logs) && Array.isArray(exp.checkins) && Array.isArray(exp.inventory), `logs=${exp.logs?.length}`);

// ── 8. Import round-trip (idempotent restore of own backup) ──
const imp = await page.evaluate(async data => await API.post('/import', data), exp);
check('Import restores without error', imp.ok === true && imp.restored > 0, `restored=${imp.restored}`);
const afterImp = await page.evaluate(async () => { await App.loadAll(); return App.getData().logs.length; });
check('Import idempotent (no duplicates)', afterImp === exp.logs.length, `${afterImp} vs ${exp.logs.length}`);

// ── 9. AI summary card (endpoint 503s without key locally — card must render + degrade) ──
const aiCard = await page.evaluate(() => document.getElementById('dashboard').innerHTML.includes('Weekly Summary'));
check('AI summary card renders', aiCard);

await page.evaluate(() => { Tabs.switchTo('dashboard'); window.scrollTo(0, 0); });
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/innovations.png', fullPage: false });

const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
await browser.close();
process.exit(fails ? 1 : 0);
