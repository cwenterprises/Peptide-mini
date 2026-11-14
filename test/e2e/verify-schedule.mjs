// Dosing schedule: .ics export, vial runout, printable plan (2026-11-12).
// Run against local `wrangler dev --port 8791 --local` (see README).
import { chromium } from 'playwright';

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const SHOTS = process.env.SHOTS || '';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 430, height: 930 }, acceptDownloads: true });
const page = await ctx.newPage();
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

// Hermetic seed: wipe planner/vials/cycles for the test peptides, then add fresh ones
const seeded = await page.evaluate(async () => {
  const d = App.getData();
  for (const p of d.planner) await API.delete('/planner/' + p.id).catch(() => {});
  for (const v of d.vials.filter(v => ['BPC-157', 'Semaglutide'].includes(v.peptide))) await API.delete('/vials/' + v.id).catch(() => {});
  for (const c of (d.cycles || []).filter(c => c.peptide === 'BPC-157')) await API.delete('/cycles/' + c.id).catch(() => {});
  await API.post('/vials', { peptide: 'BPC-157', mg: 5, ml: 2 });                  // 2500 mcg/mL
  for (const day of [1, 3, 5]) await API.post('/planner', { peptide: 'BPC-157', day, time: '08:00', route: 'Subcutaneous', dose: 250, unit: 'mcg' });
  await API.post('/planner', { peptide: 'BPC-157', day: 2, time: '20:30', route: 'Subcutaneous', dose: 250, unit: 'mcg', note: 'PM, after training' });
  await API.post('/planner', { peptide: 'Semaglutide', day: 0, route: 'Subcutaneous', dose: 0.25, unit: 'mg' }); // no vial, no time
  await API.post('/cycles', { peptide: 'BPC-157', start_date: '2026-11-01', end_date: '2026-12-31' });
  await App.loadAll();
  setSyringeType(100); setSyringeCapacity(1.0);
  const v = App.getData().vials.find(v => v.peptide === 'BPC-157');
  return { planner: App.getData().planner.length, vialCreated: v?.created_at };
});
check('Seeded 5 planner rows + BPC vial', seeded.planner === 5 && !!seeded.vialCreated, JSON.stringify(seeded));

// Fixed "now": Wed 2026-11-18 09:00 local
const NOW = [2026, 10, 18, 9, 0];

// ── 1. Vial runout ──
const ro = await page.evaluate((N) => {
  const now = new Date(...N);
  return vialRunouts(App.getData(), now).map(r => ({ peptide: r.peptide, doses: r.doses, runout: r.runout && ymd(r.runout),
    lastDose: r.lastDose && ymd(r.lastDose), expires: r.expires && ymd(r.expires), expiresFirst: r.expiresFirst }));
}, NOW);
// Independent expectation: 250 mcg on Mon/Tue/Wed/Fri from Wed Nov 18, 5000 mcg → 20 doses
const exp = (() => {
  let rem = 5000, doses = 0, last = null;
  const pad = n => String(n).padStart(2, '0');
  const ymdL = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  for (let i = 0; i < 400; i++) {
    const d = new Date(2026, 10, 18 + i);
    if (![1, 2, 3, 5].includes(d.getDay())) continue;
    if (rem < 250) return { doses, runout: ymdL(d), last };
    rem -= 250; doses++; last = ymdL(d);
  }
})();
const bpc = ro.find(r => r.peptide === 'BPC-157');
check('Only peptides with a vial get a runout (no Semaglutide)', ro.length === 1 && !!bpc, JSON.stringify(ro));
check(`BPC vial covers ${exp.doses} doses`, bpc?.doses === exp.doses, bpc?.doses);
check(`BPC runs out ${exp.runout} (last dose ${exp.last})`, bpc?.runout === exp.runout && bpc?.lastDose === exp.last, `${bpc?.runout} / ${bpc?.lastDose}`);
check('28-days-since-mixing lands before runout → flagged', bpc?.expiresFirst === true, bpc?.expires);

// ── 2. ICS content ──
const ics = await page.evaluate((N) => buildScheduleIcs(App.getData(), new Date(...N)), NOW);
const lines = ics.split('\r\n');
const enc = new TextEncoder();
check('CRLF line endings, starts/ends VCALENDAR', ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics));
check('Every line ≤ 75 octets (folded)', lines.every(l => enc.encode(l).length <= 75), Math.max(...lines.map(l => enc.encode(l).length)));
const unfolded = ics.replace(/\r\n /g, '');
const events = unfolded.split('BEGIN:VEVENT').slice(1);
check('7 events: 5 dose series + runout + 28-day', events.length === 7, events.length);
const mon = events.find(e => e.includes('BYDAY=MO'));
check('Monday BPC: DTSTART next Monday 08:00', mon?.includes('DTSTART:20261123T080000'), mon?.match(/DTSTART:[^\r]+/)?.[0]);
check('Monday BPC: weekly until cycle end', mon?.includes('RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959'));
check('Summary shows syringe units (10.0 units)', mon?.includes('SUMMARY:💉 BPC-157 250 mcg · 10.0 units'), mon?.match(/SUMMARY:[^\r]+/)?.[0]);
check('Description explains the draw', mon?.includes('Draw 10.0 units (0.100 mL) on a U-100 syringe'));
check('Reminder alarm at dose time', mon?.includes('BEGIN:VALARM') && mon?.includes('TRIGGER:PT0M'));
const wed = events.find(e => e.includes('BYDAY=WE'));
check('Wednesday series starts today (Nov 18)', wed?.includes('DTSTART:20261118T080000'), wed?.match(/DTSTART:[^\r]+/)?.[0]);
const tue = events.find(e => e.includes('BYDAY=TU'));
check('Tuesday PM row keeps its time + escaped note', tue?.includes('DTSTART:20261124T203000') && tue?.includes('Note: PM\\, after training'));
const sema = events.find(e => e.includes('Semaglutide'));
check('No-vial row: default 08:00, no units, open-ended', sema?.includes('DTSTART:20261122T080000') && !sema?.includes('units') && !sema?.includes('UNTIL'), sema?.match(/SUMMARY:[^\r]+/)?.[0]);
const runoutEv = events.find(e => e.includes('runs out'));
check(`Runout all-day event on ${exp.runout}`, runoutEv?.includes(`DTSTART;VALUE=DATE:${exp.runout.replace(/-/g, '')}`));
check('Stable UIDs per planner row', (unfolded.match(/UID:plan-/g) || []).length === 5);
const monId = await page.evaluate(() => App.getData().planner.find(p => p.peptide === 'BPC-157' && p.day === 1)?.id);
check('Event links to Log Dose for that planner row', mon?.includes(`URL:https://peptideos.cwenterprises.net/?log=bpc157&plan=${monId}`), mon?.match(/URL:[^\r]+/)?.[0]);
check('Event notes say "Tap to log this dose"', mon?.includes(`Tap to log this dose: https://peptideos.cwenterprises.net/?log=bpc157&plan=${monId}`));

// ── 3. Week tab card + download ──
await page.evaluate(() => { Tabs.switchTo('week'); renderWeek(); });
const card = await page.evaluate(() => document.getElementById('week').textContent);
check('Week tab shows Dosing schedule card', card.includes('Dosing schedule') && card.includes('runs out'));
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#schedIcsBtn')]);
check('Add to Calendar downloads peptideos-schedule.ics', dl.suggestedFilename() === 'peptideos-schedule.ics', dl.suggestedFilename());
const dlText = await (await import('node:fs/promises')).readFile(await dl.path(), 'utf8');
check('Downloaded file is a calendar with dose events', dlText.includes('BEGIN:VCALENDAR') && (dlText.match(/BEGIN:VEVENT/g) || []).length >= 5);
if (SHOTS) { await page.locator('#schedIcsBtn').scrollIntoViewIfNeeded(); await page.locator('#week .glass').nth(1).screenshot({ path: `${SHOTS}/schedule-card.png` }); }

// ── 4. Printable plan ──
await page.click('#schedPrintBtn');
const pp = await page.evaluate(() => {
  const el = document.getElementById('printPlan');
  return { open: !!el, rows: el?.querySelectorAll('tbody tr').length, syringes: el?.querySelectorAll('svg.syringe-svg').length,
    rest: el?.querySelectorAll('tr.pp-rest').length, text: el?.textContent || '' };
});
check('Printable plan opens', pp.open);
check('4 BPC rows draw a syringe', pp.syringes === 4, pp.syringes);
check('Thu + Sat are rest days', pp.rest === 2, pp.rest);
check('Plan lists vial runout', pp.text.includes('runs out'));
await page.emulateMedia({ media: 'print' });
const printVis = await page.evaluate(() => ({
  app: getComputedStyle(document.getElementById('week').closest('body > *')).display,
  plan: getComputedStyle(document.getElementById('printPlan')).display,
  btns: getComputedStyle(document.querySelector('#printPlan .pp-actions')).display,
}));
check('Print media: app hidden, plan visible, buttons hidden', printVis.app === 'none' && printVis.plan !== 'none' && printVis.btns === 'none', JSON.stringify(printVis));
await page.emulateMedia({ media: 'screen' });
if (SHOTS) await page.locator('#printPlan .pp-sheet').screenshot({ path: `${SHOTS}/print-plan.png` });
await page.evaluate(() => document.getElementById('printPlan').remove());

// ── 5. Empty planner state ──
const empty = await page.evaluate(() => { const real = App.getData().planner; App.getData().planner = []; const h = scheduleCardHtml(); App.getData().planner = real; return h; });
check('Empty planner shows guidance', empty.includes('Build a stack in the Stacks tab'));

// ── 6. Reminder link → Log Dose prefilled from the planner row (beats "same as last time") ──
const tueId = await page.evaluate(async () => {
  await API.post('/logs', { peptide: 'BPC-157', route: 'Intramuscular', dose_value: 200, dose_unit: 'mcg', dose_mcg: 200, taken_at: new Date(Date.now() - 86400000).toISOString(), site: 'abd-rl' });
  await App.loadAll();
  return App.getData().planner.find(p => p.peptide === 'BPC-157' && p.day === 2)?.id;
});
await page.goto(`http://localhost:8791/?log=bpc157&plan=${tueId}`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('ldPeptide')?.value === 'BPC-157', null, { timeout: 15000 }).catch(() => {});
const pre = await page.evaluate(() => ({ pep: document.getElementById('ldPeptide')?.value, dose: document.getElementById('ldDose')?.value,
  unit: document.getElementById('ldUnit')?.value, route: document.getElementById('ldRoute')?.value, url: location.search }));
check('Reminder link opens Log Dose for BPC-157', pre.pep === 'BPC-157', JSON.stringify(pre));
check('Prefilled with the planned 250 mcg Subcutaneous (not last log 200 IM)', pre.dose === '250' && pre.unit === 'mcg' && pre.route === 'Subcutaneous', JSON.stringify(pre));
check('Link params cleared from the address bar', !pre.url.includes('log=') && !pre.url.includes('plan='), pre.url);
await page.goto('http://localhost:8791/?log=bpc157', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.getElementById('ldPeptide')?.value === 'BPC-157', null, { timeout: 15000 }).catch(() => {});
const qr = await page.evaluate(() => ({ dose: document.getElementById('ldDose')?.value, route: document.getElementById('ldRoute')?.value }));
check('Plain vial-QR link still uses the last logged dose', qr.dose === '200' && qr.route === 'Intramuscular', JSON.stringify(qr));
await page.evaluate(async () => { for (const l of App.getData().logs.filter(x => x.peptide === 'BPC-157')) await API.delete('/logs/' + l.id).catch(() => {}); await App.loadAll(); });

// Cleanup seeded planner rows so other suites see their usual state
await page.evaluate(async () => {
  const d = App.getData();
  for (const p of d.planner) await API.delete('/planner/' + p.id).catch(() => {});
  for (const c of (d.cycles || []).filter(c => c.peptide === 'BPC-157')) await API.delete('/cycles/' + c.id).catch(() => {});
});

check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
