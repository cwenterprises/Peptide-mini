// Calculator → Needles: needle size (gauge) chart (2026-11-12).
// Run against local `wrangler dev --port 8791 --local` (see README).
import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const SHOTS = process.env.SHOTS || '';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });

await page.goto('http://localhost:8791', { waitUntil: 'networkidle' });
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.evaluate(async () => { try { await API.post('/auth/register', { email: 'sitetest@test.com', password: 'testpass123' }); } catch {} });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

await page.evaluate(() => { Tabs.switchTo('calc'); _calcSubTab = 'recon'; renderCalc(); });
await page.click('#calcNav [data-ctab="needles"]');
const vis = await page.evaluate(() => getComputedStyle(document.getElementById('calcNeedles')).display);
check('Needles tab opens', vis === 'block', vis);

const info = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#calcNeedles .needle-row')];
  const width = g => parseFloat(document.querySelector(`#calcNeedles .needle-row[data-g="${g}"] svg line`).getAttribute('stroke-width'));
  return {
    gauges: rows.map(r => +r.dataset.g),
    w18: width(18), w31: width(31),
    hub23: document.querySelector('#calcNeedles .needle-row[data-g="23"] svg rect').getAttribute('fill'),
    row30: document.querySelector('#calcNeedles .needle-row[data-g="30"]').textContent.replace(/\s+/g, ' '),
    facts: document.querySelector('#calcNeedles .needle-facts').textContent,
  };
});
check('13 gauges, 18G → 32G in order', info.gauges.length === 13 && info.gauges[0] === 18 && info.gauges.at(-1) === 32 && info.gauges.every((g, i, a) => !i || g > a[i - 1]), info.gauges.join(','));
check('Drawn to scale: 18G ≈ 4.9× wider than 31G', Math.abs(info.w18 / info.w31 - 1.270 / 0.261) < 0.05, (info.w18 / info.w31).toFixed(2));
check('23G hub is ISO blue', info.hub23 === '#1d4ed8', info.hub23);
check('30G row: 0.31 mm, insulin syringe, SC peptides', info.row30.includes('0.31 mm') && info.row30.includes('Insulin syringe') && info.row30.includes('subcutaneous peptides'), info.row30);
check('"Higher gauge = thinner" explained', info.facts.includes('Higher gauge = thinner'));

// Filter: SC peptides dims oils-only and drawing-only rows
await page.click('#calcNeedles button:has-text("SC peptides")');
const dimmed = await page.evaluate(() => [...document.querySelectorAll('#calcNeedles .needle-row.dim')].map(r => +r.dataset.g));
check('SC peptides filter dims 18–25G and the pen row', JSON.stringify(dimmed) === JSON.stringify([18, 20, 21, 22, 23, 25, 32]), dimmed.join(','));
if (SHOTS) await page.locator('#needleChart').screenshot({ path: `${SHOTS}/needles-pep.png` });
await page.click('#calcNeedles button:has-text("Oils & IM")');
const dimOil = await page.evaluate(() => [...document.querySelectorAll('#calcNeedles .needle-row.dim')].map(r => +r.dataset.g));
check('Oils & IM filter dims insulin + pen + fill-only rows', JSON.stringify(dimOil) === JSON.stringify([18, 28, 29, 30, 31, 32]), dimOil.join(','));
await page.click('#calcNeedles button:has-text("All")');
check('All shows everything', await page.evaluate(() => !document.querySelector('#calcNeedles .needle-row.dim')));
if (SHOTS) await page.locator('#needleChart').screenshot({ path: `${SHOTS}/needles-all.png` });

check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
