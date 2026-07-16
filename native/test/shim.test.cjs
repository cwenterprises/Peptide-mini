// Unit tests for the pure URL-rewrite helpers in src/peptide-native.js.
// Run: node test/shim.test.cjs
const assert = require('assert');
const { rewriteApiUrl, rewriteWsUrl, LIVE_ORIGIN } = require('../src/peptide-native.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  -', name); }
  catch (e) { fail++; console.error('  FAIL-', name, '\n       ', e.message); }
}

const ORIGIN = 'https://peptideos.cwenterprises.net';

t('relative /api path is repointed at live origin', () => {
  assert.strictEqual(rewriteApiUrl('/api/vendors'), ORIGIN + '/api/vendors');
  assert.strictEqual(rewriteApiUrl('/api/auth/login'), ORIGIN + '/api/auth/login');
  assert.strictEqual(rewriteApiUrl('/api/parse-price-file'), ORIGIN + '/api/parse-price-file');
  assert.strictEqual(rewriteApiUrl('/api'), ORIGIN + '/api');
});

t('relative /api preserves query and hash', () => {
  assert.strictEqual(rewriteApiUrl('/api/prices?vendor=1#x'), ORIGIN + '/api/prices?vendor=1#x');
});

t('non-/api relative paths are untouched', () => {
  assert.strictEqual(rewriteApiUrl('/index.html'), '/index.html');
  assert.strictEqual(rewriteApiUrl('/manifest.json'), '/manifest.json');
  assert.strictEqual(rewriteApiUrl('/'), '/');
});

t('absolute localhost /api is repointed (Capacitor iosScheme=https -> https://localhost)', () => {
  assert.strictEqual(rewriteApiUrl('https://localhost/api/vendors'), ORIGIN + '/api/vendors');
  assert.strictEqual(rewriteApiUrl('capacitor://localhost/api/prices'), ORIGIN + '/api/prices');
});

t('absolute localhost /api preserves query string', () => {
  assert.strictEqual(rewriteApiUrl('https://localhost/api/prices?x=1'), ORIGIN + '/api/prices?x=1');
});

t('real remote hosts pass through untouched', () => {
  assert.strictEqual(rewriteApiUrl('https://fonts.googleapis.com/css2'), 'https://fonts.googleapis.com/css2');
  assert.strictEqual(rewriteApiUrl('https://example.com/api/x'), 'https://example.com/api/x');
});

t('localhost non-/api pages pass through (app shell stays local)', () => {
  assert.strictEqual(rewriteApiUrl('https://localhost/index.html'), 'https://localhost/index.html');
  assert.strictEqual(rewriteApiUrl('capacitor://localhost/'), 'capacitor://localhost/');
});

t('protocol-relative and non-string inputs are safe', () => {
  assert.strictEqual(rewriteApiUrl('//cdn.example.com/api/x'), '//cdn.example.com/api/x');
  assert.strictEqual(rewriteApiUrl(undefined), undefined);
  assert.strictEqual(rewriteApiUrl(42), 42);
});

t('rewriteWsUrl repoints relative + localhost ws to wss live origin', () => {
  const WSS = 'wss://peptideos.cwenterprises.net';
  assert.strictEqual(rewriteWsUrl('/ws'), WSS + '/ws');
  assert.strictEqual(rewriteWsUrl('ws://localhost/room'), WSS + '/room');
  assert.strictEqual(rewriteWsUrl('wss://localhost:443/x'), WSS + '/x');
});

t('rewriteWsUrl leaves real remote ws hosts alone', () => {
  assert.strictEqual(rewriteWsUrl('wss://realtime.example.com/x'), 'wss://realtime.example.com/x');
});

t('LIVE_ORIGIN export is the production host', () => {
  assert.strictEqual(LIVE_ORIGIN, ORIGIN);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
