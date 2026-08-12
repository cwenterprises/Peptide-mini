import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
page.on('pageerror', e => console.log('PAGEERROR:', e.message));

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// Seed: dose YESTERDAY 21:30 local (rolls to today's date in UTC) + dose TODAY 12:00 local
await page.evaluate(async () => {
  // clean previous TzTest runs
  for (const l of App.getData().logs.filter(x => x.peptide === 'TzTest')) {
    await API.delete('/logs/' + l.id).catch(() => {});
  }
  const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(21, 30, 0, 0);
  const t = new Date(); t.setHours(12, 0, 0, 0);
  await API.post('/logs', { peptide: 'TzTest', route: 'Subcutaneous', dose_value: 1, dose_unit: 'mg', taken_at: y.toISOString(), notes: 'evening-yesterday' });
  await API.post('/logs', { peptide: 'TzTest', route: 'Subcutaneous', dose_value: 2, dose_unit: 'mg', taken_at: t.toISOString(), notes: 'noon-today' });
  await App.loadAll();
  renderLogViews();
});
await page.waitForTimeout(800);

// 1. Logged Today must contain ONLY the noon dose (one TzTest row, showing 12:00 not 21:30)
const today = await page.evaluate(() => {
  const html = document.getElementById('today').innerHTML;
  const rows = [...document.querySelectorAll('#today .dose-row')].filter(r => r.textContent.includes('TzTest'));
  return { count: rows.length, has2130: html.includes('21:30'), has1200: rows.some(r => r.textContent.includes('12:00')) };
});
check('Logged Today shows only the noon dose', today.count === 1 && today.has1200, `TzTest rows=${today.count}`);
check('Yesterday 21:30 dose NOT in Logged Today', !today.has2130);

// 2. The evening dose belongs to yesterday: streak calendar credits yesterday, not double-credits today
const cal = await page.evaluate(() => {
  const pad2 = n => String(n).padStart(2, '0');
  const loc = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yStr = loc(y), tStr = loc(new Date());
  const cell = sel => [...document.querySelectorAll('#dashboard [title]')].find(el => el.title.startsWith(sel + ':'))?.title || '';
  return { yesterday: cell(yStr), today: cell(tStr) };
});
const yCount = parseInt(cal.yesterday.split(': ')[1]) || 0;
check('Calendar credits yesterday with the evening dose', yCount >= 1, cal.yesterday);

// 3. History range filter: filtering to ONLY yesterday must include the 21:30 dose
const hist = await page.evaluate(() => {
  const pad2 = n => String(n).padStart(2, '0');
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yStr = `${y.getFullYear()}-${pad2(y.getMonth() + 1)}-${pad2(y.getDate())}`;
  Tabs.switchTo('history');
  renderHistory();
  document.getElementById('histFrom').value = yStr;
  document.getElementById('histTo').value = yStr;
  document.getElementById('histSearch').value = 'evening-yesterday';
  renderHistory();
  const html = document.getElementById('history').innerHTML;
  const shown = html.includes('evening-yesterday');
  document.getElementById('histFrom').value = ''; document.getElementById('histTo').value = ''; document.getElementById('histSearch').value = '';
  renderHistory();
  return shown;
});
check('History filtered to yesterday includes the evening dose', hist);

const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
await browser.close();
process.exit(fails ? 1 : 0);
