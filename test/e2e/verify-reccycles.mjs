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

// 1. cycleRecRange parse cases
const ranges = await page.evaluate(() => {
  const semaglutide = cycleRecRange('Semaglutide');      // "Continuous..." or range per library
  const epithalon = cycleRecRange('Epithalon');
  const unknown = cycleRecRange('NoSuchPeptide');
  const ipam = cycleRecRange('Ipamorelin');
  return { semaglutide, epithalon, unknown, ipam };
});
check('Unknown peptide → null', ranges.unknown === null);
check('Library peptides return text', !!ranges.ipam?.text, JSON.stringify(ranges.ipam));

// 2. cycleRecLine verdicts with a weeks-range peptide picked from the library
const verdicts = await page.evaluate(() => {
  const pep = PEPTIDE_LIBRARY.find(p => /\d+\s*[–-]\s*\d+\s*week/i.test(p.cycleLength || ''));
  const rec = cycleRecRange(pep.name);
  const mk = weeks => cycleRecLine({ peptide: pep.name, start_date: '2026-08-01',
    end_date: new Date(new Date('2026-08-01T00:00:00').getTime() + (weeks * 7 - 1) * 86400000).toISOString().slice(0, 10) });
  return { pep: pep.name, rec,
    within: mk((rec.lo + rec.hi) / 2), over: mk(rec.hi + 3), under: mk(Math.max(0.5, rec.lo - 2)) };
});
check('Within range → ✓ green', verdicts.within.includes('✓') && verdicts.within.includes('--accent-green'), verdicts.pep);
check('Over range → amber "runs over"', verdicts.over.includes('runs') && verdicts.over.includes('--accent-amber'));
check('Under range → muted "shorter"', verdicts.under.includes('shorter') && verdicts.under.includes('--text-muted'));

// 2b. Months-based range parses (Ipamorelin "3–6 months" → lo/hi in weeks)
const months = await page.evaluate(() => cycleRecRange('Ipamorelin'));
check('Months range converts to weeks', months.lo !== null && months.lo > 12 && months.hi > months.lo, JSON.stringify(months));

// 3. Unparseable cycleLength renders text-only line
const textOnly = await page.evaluate(() => {
  const found = PEPTIDE_LIBRARY.find(p => p.cycleLength && !/\d+\s*(?:[–-]\s*\d+\s*)?week/i.test(p.cycleLength));
  if (!found) return { skip: true };
  const line = cycleRecLine({ peptide: found.name, start_date: '2026-08-01', end_date: '2026-09-01' });
  return { name: found.name, line, ok: line.includes('Recommended:') && !line.includes('yours') };
});
check('Unparseable cycleLength → text-only line', textOnly.skip || textOnly.ok, textOnly.name || 'none in library');

// 4. Live card: seed an active cycle, verify the recommendation line renders
const dash = await page.evaluate(async () => {
  const today = new Date(), end = new Date(Date.now() + 30 * 86400000);
  const f = d => d.toISOString().slice(0, 10);
  const start = new Date(Date.now() - 14 * 86400000);
  if (!(App.getData().cycles || []).length) {
    await API.post('/cycles', { peptide: 'BPC-157', start_date: f(start), end_date: f(end) });
    await App.loadAll();
  }
  renderDashboard();
  return document.getElementById('dashboard').innerHTML;
});
check('Cycle Progress shows Recommended line', dash.includes('Recommended'));

await page.evaluate(() => document.querySelector('#dashboard')?.scrollTo?.(0, 0));
await page.screenshot({ path: '/tmp/pepos-verify/reccycles.png' });

const fails = results.filter(r => !r.ok).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
await browser.close();
process.exit(fails ? 1 : 0);
