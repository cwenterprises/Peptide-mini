import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('dialog', d => d.dismiss()); // decline inventory-deduct prompts

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500); // version-check script may reload the page once after load
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// Seed: fresh vial (10mg/2mL) + a logged dose today linked to it consuming 5.8mg (42% left)
await page.evaluate(async () => {
  for (const l of App.getData().logs.filter(x => x.peptide === 'VialViz')) await API.delete('/logs/' + l.id).catch(() => {});
  for (const v of App.getData().vials.filter(x => x.peptide === 'VialViz')) await API.delete('/vials/' + v.id).catch(() => {});
  const vial = await API.post('/vials', { peptide: 'VialViz', mg: 10, ml: 2 });
  await API.post('/logs', { peptide: 'VialViz', route: 'Subcutaneous', dose_value: 5.8, dose_unit: 'mg',
    dose_mcg: 5800, vial_id: vial.id, taken_at: new Date().toISOString() });
  await App.loadAll();
  renderLogViews();
});
await page.waitForTimeout(800);

// 1. Helper math: 42% remaining → amber, "4.2 mg"
const unit = await page.evaluate(() => {
  const { vials, logs } = App.getData();
  const v = vials.find(x => x.peptide === 'VialViz');
  const html = vialLevelHtml(v, logs);
  return { html, hasAmber: html.includes('--accent-amber'), hasText: html.includes('4.2 mg'), pct: html.match(/\((\d+)%\)/)?.[1] };
});
check('42% → amber color', unit.hasAmber);
check('Remaining text "4.2 mg"', unit.hasText);
check('Tooltip pct = 42', unit.pct === '42', unit.pct);

// 2. Low vial → red; high → green; empty/none → ''
const edges = await page.evaluate(() => {
  const { logs } = App.getData();
  const mk = (mg, usedMcg) => vialLevelHtml({ id: 'x', peptide: 'T', mg, ml: 1 },
    [{ vial_id: 'x', dose_mcg: usedMcg, taken_at: '2026-08-10T00:00:00Z' }]);
  return {
    red: mk(10, 9000).includes('#ef4444'),
    green: mk(10, 1000).includes('--accent-green'),
    none: vialLevelHtml(null, logs) === ''
  };
});
check('10% → red, 90% → green, no vial → empty', edges.red && edges.green && edges.none, JSON.stringify(edges));

// 3. Logged row on Today shows the glyph
const loggedRow = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#today .dose-row')].filter(r => r.textContent.includes('VialViz'));
  return rows.some(r => r.querySelector('svg[aria-label^="vial level"]'));
});
check('Logged Today row shows vial glyph', loggedRow);

// 4. Planned row best-match: planner item for VialViz picks the seeded vial
await page.evaluate(async () => {
  await API.post('/planner', { peptide: 'VialViz', day: new Date().getDay(), route: 'Subcutaneous', dose: 1, unit: 'mg' });
  await App.loadAll();
  renderLogViews();
});
await page.waitForTimeout(800);
const planned = await page.evaluate(() => {
  const { vials, logs } = App.getData();
  const match = nextVialForPeptide('VialViz', vials, logs);
  const rows = [...document.querySelectorAll('#today .dose-row')];
  const plannedRow = rows.find(r => r.textContent.includes('Pending') && r.textContent.includes('VialViz'));
  return { matched: !!match, glyphOnPlanned: !!plannedRow?.querySelector('svg[aria-label^="vial level"]') };
});
check('Planned row matched to next vial', planned.matched && planned.glyphOnPlanned, JSON.stringify(planned));

// 5. No vial for peptide → no glyph
const noVial = await page.evaluate(() => nextVialForPeptide('NoSuchPeptide', App.getData().vials, App.getData().logs));
check('No matching vial → null (no glyph)', noVial === null);

await page.evaluate(() => { Tabs.switchTo('today'); window.scrollTo(0, 0); });
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/pepos-verify/viallevel.png' });

// cleanup planner test item
await page.evaluate(async () => {
  for (const p of App.getData().planner.filter(x => x.peptide === 'VialViz')) await API.delete('/planner/' + p.id).catch(() => {});
});

const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
await browser.close();
process.exit(fails ? 1 : 0);
