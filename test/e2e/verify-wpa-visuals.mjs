// Visual syringe + half-life buildup chart (2026-11-12).
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
// Fresh local DB: register the test account if it doesn't exist yet
await page.evaluate(async () => {
  try { await API.post('/auth/register', { email: 'sitetest@test.com', password: 'testpass123' }); } catch {}
});
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// ── 1. Buildup math (pure functions) ──
const tirz = await page.evaluate(() => buildupModel(120, 168));        // Tirzepatide, weekly
check('Tirzepatide weekly: steady-state peak ≈ 1.61× one dose', near(tirz.ssPeak, 1 / (1 - Math.pow(0.5, 168 / 120)), 1e-9), tirz.ssPeak.toFixed(3));
check('Tirzepatide weekly: ~4 doses to steady state (≥95%)', tirz.dosesToSS === 4, tirz.dosesToSS);
const lvl = await page.evaluate(() => {
  const m = buildupModel(120, 168);
  // just after dose 3 (t = 2τ): 1 + r + r²; just before dose 2: r
  return { afterThird: buildupLevel(m, 336), beforeSecond: buildupLevel(m, 168 - 1e-6), zero: buildupLevel(m, -1) };
});
const r = Math.pow(0.5, 168 / 120);
check('Level after 3rd dose = 1 + r + r²', near(lvl.afterThird, 1 + r + r * r, 1e-9), lvl.afterThird.toFixed(4));
check('Level just before 2nd dose = r', near(lvl.beforeSecond, r, 1e-6), lvl.beforeSecond.toFixed(4));
check('Level before first dose = 0', lvl.zero === 0);
const tesa = await page.evaluate(() => buildupModel(0.5, 24));          // Tesamorelin daily: clears fully
check('Tesamorelin daily: flagged as no buildup', tesa.noBuildup === true);
check('Cadence guess: once-weekly → 168h', await page.evaluate(() => guessDoseIntervalH('GLP-1 agonist; once-weekly subcutaneous injection')) === 168);
check('Cadence guess: twice-weekly → 84h', await page.evaluate(() => guessDoseIntervalH('Long-acting systemic; weekly or twice-weekly dosing common')) === 84);
check('Cadence guess: AM/PM → 12h', await page.evaluate(() => guessDoseIntervalH('Short acting; split into AM/PM dosing for best results')) === 12);

// ── 2. Syringe scale + reading hint ──
const sc = await page.evaluate(() => [syringeScale(100, 1.0), syringeScale(100, 0.3), syringeScale(40, 1.0), syringeScale(100, 3.0)]);
check('U-100 1 mL: marks every 2 units, labels every 10', sc[0].minor === 2 && sc[0].major === 10 && sc[0].maxUnits === 100);
check('U-100 0.3 mL: marks every unit', sc[1].minor === 1 && sc[1].maxUnits === 30);
check('U-40 1 mL: 40 units, marks every unit', sc[2].minor === 1 && sc[2].maxUnits === 40);
check('3 mL syringe labels in mL', sc[3].labelInMl === true);
check('Reading hint 12.5u on U-100 1 mL', await page.evaluate(() => syringeReadingHint(12.5, syringeScale(100, 1.0))) === 'between the 12 and 14 marks');
check('Reading hint 10u on a mark', await page.evaluate(() => syringeReadingHint(10, syringeScale(100, 1.0))) === 'right on the 10 mark');

// ── 3. Calculator UI: syringe renders in Recon (WPA example: 5 mg / 1 mL / 250 mcg → 5.0 units) ──
await page.evaluate(() => { Tabs.switchTo('calc'); _calcSubTab = 'recon'; setSyringeType(100); setSyringeCapacity(1.0); renderCalc(); });
await page.fill('#rVialMg', '5');
await page.fill('#rDilMl', '1');
await page.fill('#rDoseMcg', '250');
const recon = await page.evaluate(() => {
  const el = document.getElementById('rDrawResult');
  const svg = el.querySelector('svg.syringe-svg');
  return { hasSvg: !!svg, label: svg?.getAttribute('aria-label') || '', text: el.textContent };
});
check('Recon shows syringe visual', recon.hasSvg);
check('Syringe drawn to 5.0 units', recon.label.includes('5.0 units'), recon.label);
check('Reading hint shown under syringe', recon.text.includes('right on the 6 mark') || recon.text.includes('between the 4 and 6 marks'), recon.text.match(/(between|right on)[^·]*/)?.[0]);
if (SHOTS) await page.locator('#calcRecon').screenshot({ path: `${SHOTS}/recon-syringe.png` });

// Overflow: 0.3 mL syringe, 50 units → red, clamped
await page.evaluate(() => setSyringeCapacity(0.3));
await page.fill('#rDoseMcg', '2500');
const over = await page.evaluate(() => document.getElementById('rDrawResult').innerHTML);
check('Overflow: badge + warning shown', over.includes('&gt; 0.3 mL') && over.includes('Exceeds 0.3 mL'));
await page.evaluate(() => setSyringeCapacity(1.0));

// Draw, TRT, HCG, HGH, custom recon all render the syringe
const counts = await page.evaluate(() => {
  const out = {};
  _calcSubTab = 'draw'; renderCalc();
  document.getElementById('dConc').value = '2500'; document.getElementById('dDose').value = '250'; calcDraw();
  out.draw = !!document.querySelector('#dResult svg.syringe-svg');
  _calcSubTab = 'trt'; renderCalc();
  document.getElementById('tWeekly').value = '150'; calcTRT();
  out.trt = !!document.querySelector('#tResult svg.syringe-svg');
  _calcSubTab = 'hcg'; renderCalc();
  document.getElementById('hBacMl').value = '5'; document.getElementById('hDoseIU').value = '500'; calcHCG();
  out.hcg = !!document.querySelector('#hResult svg.syringe-svg');
  _calcSubTab = 'hgh'; renderCalc();
  document.getElementById('gBacMl').value = '1'; document.getElementById('gDoseIU').value = '2'; calcHGH();
  out.hgh = !!document.querySelector('#gResult svg.syringe-svg');
  _calcSubTab = 'recon'; renderCalc();
  document.getElementById('crVialMg').value = '5'; document.getElementById('crDoseMcg').value = '250'; document.getElementById('crUnits').value = '10'; calcCustomRecon();
  out.custom = !!document.querySelector('#crResult svg.syringe-svg');
  return out;
});
for (const [k, v] of Object.entries(counts)) check(`Syringe visual in ${k} result`, v);

// ── 4. Half-life tab: buildup chart ──
await page.evaluate(() => { _calcSubTab = 'hl'; renderCalc(); });
await page.selectOption('#hlPeptide', 'Tirzepatide');
const hl = await page.evaluate(() => ({
  every: document.getElementById('hlEvery').value,
  chart: !!document.querySelector('#hlResult svg.hl-chart'),
  marks: (document.querySelector('#hlResult svg.hl-chart')?.textContent.match(/💉/g) || []).length,
  stats: document.querySelector('#hlResult .hl-stats')?.textContent.replace(/\s+/g, ' ').trim(),
}));
check('Picking Tirzepatide sets cadence to weekly', hl.every === '168', hl.every);
check('Buildup chart renders', hl.chart);
check('One 💉 per dose (6 doses for tirzepatide)', hl.marks === 6, hl.marks);
check('Stats show 1.61× steady-state peak', (hl.stats || '').includes('1.61×'), hl.stats);
check('Stats show ≈ 4 weeks to steady state', (hl.stats || '').includes('4 weeks'), hl.stats);

await page.fill('#hlDose', '5');
await page.selectOption('#hlDoseUnit', 'mg');
const withDose = await page.evaluate(() => document.querySelector('#hlResult .hl-stats').textContent);
check('With a 5 mg dose, peak shown in mg (≈ 8.05 mg)', withDose.includes('8.05 mg') || withDose.includes('8.04 mg'), withDose.match(/[\d.]+ mg/)?.[0]);

// Hover readout
await page.locator('#hlResult svg.hl-chart').scrollIntoViewIfNeeded();
const box = await page.locator('#hlResult svg.hl-chart').boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
const tip = await page.evaluate(() => { const t = document.querySelector('#hlResult .hl-tip'); return { shown: t.style.display === 'block', text: t.textContent }; });
check('Hover shows level readout', tip.shown && /in system/.test(tip.text), tip.text);
if (SHOTS) await page.locator('#calcHL').screenshot({ path: `${SHOTS}/halflife-buildup.png` });

// No-buildup peptide
await page.selectOption('#hlPeptide', 'Tesamorelin');
const nb = await page.evaluate(() => document.querySelector('#hlResult .hl-stats').textContent);
check('Tesamorelin shows "No buildup"', nb.includes('No buildup'));

// ── 5. Log Dose draw math still works with the visual ──
const ld = await page.evaluate(async () => {
  await API.post('/vials', { peptide: 'BPC-157', mg: 5, ml: 2, opened_at: new Date().toISOString().slice(0, 10) }).catch(e => ({ err: e.message }));
  await App.loadAll();
  Tabs.switchTo('logdose'); renderLogDose();
  const v = App.getData().vials.find(x => x.peptide === 'BPC-157');
  if (!v) return { err: 'no vial' };
  const sel = document.getElementById('ldVial'); if (sel) sel.value = v.id;
  const dose = document.getElementById('ldDose'); if (dose) dose.value = '250';
  updateDrawMath();
  const m = document.getElementById('ldMath');
  return { svg: !!m?.querySelector('svg.syringe-svg'), label: m?.querySelector('svg.syringe-svg')?.getAttribute('aria-label') || '' };
});
check('Log Dose draw math shows syringe (250 mcg of 2.5 mg/mL = 10 units)', ld.svg && ld.label.includes('10.0 units'), ld.err || ld.label);

check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
