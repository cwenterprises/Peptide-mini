// Calendar subscription (webcal feed) — 2026-11-12.
// Run against local `wrangler dev --port 8791 --local` (see README); needs migration 0013.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8791';
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ' — ' + extra : ''}`); };
const SHOTS = process.env.SHOTS || '';
const fetchFeed = async (url) => { const r = await fetch(url); return { status: r.status, type: r.headers.get('content-type') || '', robots: r.headers.get('x-robots-tag') || '', body: await r.text() }; };
const waitFor = async (fn, ms = 6000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v || Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 250)); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 930 } });
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('dialog', d => d.accept()); // confirm() for Reset / Turn off

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('#authEmail', { timeout: 15000 });
await page.evaluate(async () => { try { await API.post('/auth/register', { email: 'sitetest@test.com', password: 'testpass123' }); } catch {} });
await page.fill('#authEmail', 'sitetest@test.com');
await page.fill('#authPass', 'testpass123');
await page.evaluate(() => doLogin());
await page.waitForTimeout(2500);

// Hermetic seed: feed off, one BPC vial, BPC Mon/Wed 250 mcg
await page.evaluate(async () => {
  await API.delete('/calendar-feed').catch(() => {});
  const d = App.getData();
  for (const p of d.planner) await API.delete('/planner/' + p.id).catch(() => {});
  for (const v of d.vials.filter(v => v.peptide === 'BPC-157')) await API.delete('/vials/' + v.id).catch(() => {});
  await API.post('/vials', { peptide: 'BPC-157', mg: 5, ml: 2 });
  for (const day of [1, 3]) await API.post('/planner', { peptide: 'BPC-157', day, time: '08:00', route: 'Subcutaneous', dose: 250, unit: 'mcg' });
  await App.loadAll();
});

// ── 1. Off by default ──
check('Feed starts off', await page.evaluate(() => App.getData().calendarFeed?.enabled === false));
await page.evaluate(() => { Tabs.switchTo('settings'); renderSettings(); });
check('Settings shows Create calendar link', await page.isVisible('#calFeedEnable'));
check('Week card suggests subscribing', await page.evaluate(() => { renderWeek(); return document.getElementById('week').textContent.includes('subscribe instead'); }));

// ── 2. Create → link works without auth ──
await page.evaluate(() => { Tabs.switchTo('settings'); renderSettings(); });
await page.click('#calFeedEnable');
await page.waitForSelector('#calFeedUrl');
const url1 = await page.inputValue('#calFeedUrl');
check('Link looks like /cal/<32-char token>.ics', /\/cal\/[A-Za-z0-9_-]{32}\.ics$/.test(url1), url1);
const f1 = await waitFor(async () => { const f = await fetchFeed(url1); return f.body.includes('BEGIN:VEVENT') ? f : null; });
check('Feed serves calendar without login', f1?.status === 200 && f1.type.startsWith('text/calendar'), f1 && `${f1.status} ${f1.type}`);
check('Feed has noindex header', /noindex/.test(f1?.robots || ''));
check('Feed has refresh hints', f1?.body.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H') && f1?.body.includes('X-PUBLISHED-TTL:PT1H'));
check('Feed has 2 dose series with U-100 units', (f1?.body.match(/UID:plan-/g) || []).length === 2 && f1?.body.includes('10.0 units'));
check('Subscribe button points at webcal://', await page.evaluate(() => calendarFeedUrls(App.getData().calendarFeed.token).webcal.startsWith('webcal://')));
if (SHOTS) await page.locator('#calFeedCard').screenshot({ path: `${SHOTS}/calendar-feed-card.png` });

// ── 3. Auto-updates on data change; session U-40 doesn't leak into the feed ──
await page.evaluate(async () => {
  setSyringeType(40);
  await API.post('/planner', { peptide: 'BPC-157', day: 5, time: '19:00', route: 'Subcutaneous', dose: 250, unit: 'mcg' });
  await App.loadAll(); // the app reloads data after every change — sync rides on it
});
const f2 = await waitFor(async () => { const f = await fetchFeed(url1); return (f.body.match(/UID:plan-/g) || []).length === 3 ? f : null; });
check('New planner row appears in feed automatically', !!f2);
check('Feed stays on U-100 while calculator is on U-40', f2?.body.includes('10.0 units') && !f2?.body.includes(' 4.0 units'));
check('Unchanged data → no re-upload', await page.evaluate(async () => (await syncCalendarFeed()) === false));
await page.evaluate(() => setSyringeType(100));

// ── 4. Reset link: old URL dies, new one works ──
await page.evaluate(() => { Tabs.switchTo('settings'); renderSettings(); });
await page.click('#calFeedReset');
await waitFor(async () => (await page.inputValue('#calFeedUrl').catch(() => url1)) !== url1);
const url2 = await page.inputValue('#calFeedUrl');
check('Reset gives a new link', url2 !== url1 && /\/cal\/[A-Za-z0-9_-]{32}\.ics$/.test(url2));
check('Old link → 404', (await fetchFeed(url1)).status === 404);
const f3 = await waitFor(async () => { const f = await fetchFeed(url2); return f.body.includes('UID:plan-') ? f : null; });
check('New link serves the schedule', f3?.status === 200);

// ── 5. API guards ──
const guards = await page.evaluate(async () => {
  const out = {};
  try { await API.put('/calendar-feed/ics', { ics: 'not a calendar' }); out.bad = 'accepted'; } catch (e) { out.bad = e.message; }
  const r = await fetch('/api/calendar-feed/ics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }) });
  out.noauth = r.status;
  return out;
});
check('Rejects non-calendar upload', guards.bad !== 'accepted', guards.bad);
check('Upload without login → 401', guards.noauth === 401, guards.noauth);
check('Junk token → 404', (await fetchFeed(`${BASE}/cal/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ics`)).status === 404);

// ── 6. Turn off ──
await page.click('#calFeedOff');
await page.waitForSelector('#calFeedEnable');
check('Turn off → link 404', (await fetchFeed(url2)).status === 404);
const offPut = await page.evaluate(async () => { try { await API.put('/calendar-feed/ics', { ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }); return 'accepted'; } catch (e) { return e.message; } });
check('Upload while off is refused', offPut !== 'accepted', offPut);
check('Week card back to tip', await page.evaluate(() => { renderWeek(); return document.getElementById('week').textContent.includes('subscribe instead'); }));

// Cleanup
await page.evaluate(async () => { for (const p of App.getData().planner) await API.delete('/planner/' + p.id).catch(() => {}); });

check('No page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
