import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// 1. Unit conversion round-trips
const conv = await page.evaluate(() => ({
  lb: Math.round(kgToUnit(90.7185, 'lb') * 10) / 10,
  kg: kgToUnit(90.7185, 'kg'),
  rt: Math.abs(unitToKg(kgToUnit(77.3, 'lb'), 'lb') - 77.3) < 1e-9
}));
check('kg→lb (90.72kg → 200lb)', conv.lb === 200, String(conv.lb));
check('kg passthrough + round-trip', conv.kg === 90.7185 && conv.rt);

// 2. Fill plan: only days without manual weight; last sample of day wins
const plan = await page.evaluate(() => healthFillPlan(
  [{ date: '2026-08-10', kg: 90 }, { date: '2026-08-10', kg: 91 }, { date: '2026-08-11', kg: 89.5 }, { date: '2026-08-12', kg: 89 }],
  [{ date: '2026-08-11', weight: 198.2 }, { date: '2026-08-12', weight: null }],
  'lb'));
check('Fill skips manually-entered day', !plan.some(p => p.date === '2026-08-11'), JSON.stringify(plan));
check('Fill includes null-weight day', plan.some(p => p.date === '2026-08-12'));
check('Last sample of day wins (91kg → 200.6lb)', plan.find(p => p.date === '2026-08-10')?.weight === 200.6);

// 3. Web degrades: no plugin, no settings section, sync helpers no-op
const web = await page.evaluate(async () => {
  renderSettings();
  const html = document.getElementById('settings').innerHTML;
  await healthSyncPull();               // must not throw on web
  await healthSyncPushWeight('2026-08-12', 200); // must not throw on web
  return { plugin: healthPlugin(), section: html.includes('Apple Health') };
});
check('No plugin on web', web.plugin === null || web.plugin === undefined);
check('Settings section hidden on web', !web.section);
check('Sync helpers no-op safely on web', true);

const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
await browser.close();
process.exit(fails ? 1 : 0);
