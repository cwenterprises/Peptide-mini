// Render the PeptideOS master SVG to a 1024 PNG and install it as the iOS app icon
// (single-size icon, supported by Xcode 14+). Run AFTER `npx cap add ios`.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const MASTER = new URL('../docs/assets/peptideos-appicon-master.svg', import.meta.url).pathname;
const OUT_DIR = new URL('./ios/App/App/Assets.xcassets/AppIcon.appiconset/', import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await p.goto('file://' + MASTER, { waitUntil: 'load' });
await p.waitForTimeout(300);
await p.screenshot({ path: OUT_DIR + 'AppIcon-1024.png' });
await b.close();

writeFileSync(OUT_DIR + 'Contents.json', JSON.stringify({
  images: [{ filename: 'AppIcon-1024.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }],
  info: { author: 'xcode', version: 1 },
}, null, 2));
console.log('icon installed ->', OUT_DIR);
