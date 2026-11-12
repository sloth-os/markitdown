// SPDX-License-Identifier: MIT
// End-to-end test: load the site in headless Chromium, verify the engine
// boots, files convert correctly (comparing against local Python reference
// conversions), the service worker caches everything, and offline mode works.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:8931/';
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const REFERENCE = JSON.parse(fs.readFileSync(new URL('./reference-conversions.json', import.meta.url), 'utf8'));

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = '') {
  if (ok) { results.pass++; console.log(`  PASS ${name}`); }
  else { results.fail++; results.failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL ${name} ${detail}`); }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 200));
});
page.on('pageerror', (err) => console.log('  [pageerror]', String(err).slice(0, 300)));

console.log('==1. load page ==');
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('title', (await page.title()).includes('MarkItDown'));

console.log('== 2. engine boot ==');
await page.waitForFunction(
  () => document.getElementById('engine-status')?.dataset.state === 'ready',
  null, { timeout: 120_000 }
);
const versionText = await page.textContent('#md-version');
check('engine ready + version', /v\d+\.\d+\.\d+/.test(versionText), versionText);
console.log('  markitdown version:', versionText.trim());

console.log('== 3. service worker installed ==');
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null || !!navigator.serviceWorker.getRegistration(),
  null, { timeout: 30_000 }
);
const swStatus = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.active?.state ?? 'installing' : 'none';
});
check('service worker active', swStatus === 'activated', swStatus);

console.log('== 4. conversions match Python reference ==');
for (const [name, ref] of Object.entries(REFERENCE)) {
  const filePath = path.join(FIXTURES, name);
  if (!fs.existsSync(filePath)) { check(name, false, 'fixture missing'); continue; }
  await page.setInputFiles('#file-input', filePath);
  // wait for this file's job to finish
  await page.waitForFunction(
    (fname) => {
      const items = document.querySelectorAll('#queue li');
      for (const li of items) {
        const nm = li.querySelector('.name')?.textContent;
        const st = li.querySelector('.qstate')?.dataset.state;
        if (nm === fname && (st === 'done' || st === 'error')) return true;
      }
      return false;
    }, name, { timeout: 60_000 }
  );
  // click the row to focus this job
  await page.evaluate((fname) => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === fname) li.click();
    }
  }, name);

  const state = await page.evaluate((fname) => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === fname) {
        return li.querySelector('.qstate')?.dataset.state;
      }
    }
    return null;
  }, name);

  if (state === 'error') {
    const errText = await page.textContent('#error-box');
    check(`convert ${name}`, false, errText.slice(0, 150));
    continue;
  }
  const md = await page.textContent('#markdown-out');
  const expected = ref.markdown ?? '';
  check(`convert ${name}`, md.trim() === expected.trim(),
    md.trim().slice(0, 60) + ' vs ' + expected.trim().slice(0, 60));
}

console.log('== 5. offline mode ==');
// Cut the network (offline context) and reload — everything must come from SW cache.
await context.setOffline(true);
const offlinePage = await context.newPage();
let netErrors = 0;
offlinePage.on('requestfailed', (r) => {
  // Ignore requests that the SW served from cache (they don't "fail"); only
  // count failures that produced a document error.
  if (r.failure()?.errorString !== 'net::ERR_FAILED') return;
  netErrors++;
});
await offlinePage.goto(BASE, { waitUntil: 'load', timeout: 60_000 });
await offlinePage.waitForFunction(
  () => document.getElementById('engine-status')?.dataset.state === 'ready',
  null, { timeout: 120_000 }
);
const offlineMd = await offlinePage.evaluate(async () => {
  // convert a small file through the exposed engine path (drop simulation)
  const dt = new DataTransfer();
  const file = new File(['# offline test\n\nworks'], 'test.md', { type: 'text/markdown' });
  dt.items.add(file);
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // wait for queue completion
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const li = document.querySelector('#queue li .qstate');
    if (li && (li.dataset.state === 'done' || li.dataset.state === 'error')) break;
  }
  return document.getElementById('markdown-out')?.textContent || '';
});
check('offline conversion works', offlineMd.includes('# offline test'), offlineMd.slice(0, 80));

await offlinePage.close();
await context.setOffline(false);

console.log('== 6. file handling API surface ==');
// Manifest must declare file_handlers; the page wires launchQueue if present.
const manifest = await page.evaluate(async () => {
  const res = await fetch('manifest.webmanifest');
  return res.json();
});
check('manifest has file_handlers', Array.isArray(manifest.file_handlers) && manifest.file_handlers.length > 0);
check('manifest accepts pdf', Object.values(manifest.file_handlers[0].accept).some(exts => exts.includes('.pdf')));
check('manifest start_url/scope/id present', !!manifest.start_url && !!manifest.scope);
check('manifest icons complete', manifest.icons.length >= 4);
check('manifest launch_handler present', !!manifest.launch_handler);
check('file handler action is app root', manifest.file_handlers[0].action.endsWith('/') || manifest.file_handlers[0].action === './');
// The launchQueue consumer lives in app.js (guarded by feature detection —
// headless Chromium exposes launchQueue only with flag flips, so verify the
// wiring by source inspection rather than runtime).
const appSrc = await page.evaluate(() => fetch('app.js').then((r) => r.text()));
check('launchQueue consumer wired', /launchQueue/.test(appSrc) && /setConsumer/.test(appSrc));
check('launchQueue reads files', /launchParams\.files/.test(appSrc) && /getFile\(\)/.test(appSrc));

console.log('\n==========================');
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed`);
if (results.failures.length) {
  console.log('Failures:');
  for (const f of results.failures) console.log('  -', f);
}
await browser.close();
process.exit(results.fail ? 1 : 0);
