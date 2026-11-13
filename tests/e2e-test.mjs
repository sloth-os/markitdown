// SPDX-License-Identifier: MIT
// End-to-end test: load the site in headless Chromium, verify the engine
// boots, files convert correctly (comparing against local Python reference
// conversions), the service worker caches everything, offline mode works,
// and the keep-data-URIs toggle produces the untruncated reference output.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:8931/';
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;
const REFERENCE = JSON.parse(fs.readFileSync(new URL('./reference-conversions.json', import.meta.url), 'utf8'));
const REFERENCE_KEEP = JSON.parse(fs.readFileSync(new URL('./reference-keep-data-uris.json', import.meta.url), 'utf8'));

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
// Wait until this page is actually CONTROLLED by the service worker — a bare
// !!getRegistration() is always truthy (a Promise is truthy), so that form
// would be a no-op that can race ahead of SW activation on slow networks.
await page.waitForFunction(
  () => navigator.serviceWorker.controller !== null,
  null, { timeout: 60_000 }
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

console.log('== 5. keep data URIs toggle ==');
// Section 4 already converted the image fixtures in default (truncating)
// mode and matched the reference. Here: focus each image fixture's row,
// flip the toggle in both directions, and wait on the *markdown content*
// (not the queue state) so a stale 'done' state can't satisfy the wait.
const FULL_URI_RE = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{40}/;
const IMG_FIXTURES = Object.keys(REFERENCE_KEEP).filter(
  (n) => REFERENCE_KEEP[n].ok
    && REFERENCE_KEEP[n].markdown !== REFERENCE[n].markdown
    // The keep-mode WAIT SIGNAL (waitMarkdownMode) is the inlined regex
    // below — only admit fixtures whose keep output it can actually match,
    // or waitMarkdownMode('keep') would time out on a fixture the regex
    // can't see (e.g. svg+xml mimes, sub-30-byte payloads).
    && FULL_URI_RE.test(REFERENCE_KEEP[n].markdown)
);
check('image fixtures found in references', IMG_FIXTURES.length >= 3,
  `got ${IMG_FIXTURES.length}`);

// "truncate" mode = no full base64 payload in the output. (html/docx render
// `data:...;base64...` placeholders, but pptx's default swaps in a filename
// like `Picture2.jpg` — so absence of a full URI, not presence of the
// placeholder, is the reliable signal.)
// NOTE: the predicate below is serialized and evaluated in the BROWSER, so it
// must be self-contained — it cannot close over FULL_URI_RE (Node-side).
const waitMarkdownMode = (mode) =>
  page.waitForFunction(
    (m) => {
      const re = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{40}/;
      const t = document.getElementById('markdown-out')?.textContent || '';
      return m === 'keep' ? re.test(t) : !re.test(t);
    }, mode, { timeout: 60_000 }
  );

for (const name of IMG_FIXTURES) {
  // Focus this fixture's queue row (it was converted in section 4).
  await page.evaluate((fname) => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === fname) li.click();
    }
  }, name);
  // Make sure the toggle is OFF. HONEST SEMANTICS: for the first fixture the
  // checkbox is already off (fresh context, section 4 never touched it) so
  // uncheck is a no-op and the wait below passes on the row's section-4
  // content — the value assertion is still exactly REFERENCE[name], but no
  // reconvert runs. For later fixtures (toggle left ON) uncheck fires a real
  // reconvert; the wait may still be satisfied early by the clicked row's
  // cached section-4 (truncate-mode) markdown while that reconvert is in
  // flight — harmless here because the value checked is identical either
  // way, and the following check() flip is absorbed per the design (the
  // busy pass reads the checkbox at Python-call time). The toggle-OFF
  // reconvert path is genuinely gated below by the "toggle-off restores
  // truncation" check (displayed content there is keep-mode, so only a
  // fresh truncated reconvert can satisfy the wait).
  await page.uncheck('#keep-data-uris');
  await waitMarkdownMode('truncate');
  const mdDefault = (await page.textContent('#markdown-out')).trim();
  check(`${name} default truncates data URIs`,
    !FULL_URI_RE.test(mdDefault) && mdDefault === REFERENCE[name].markdown.trim(),
    mdDefault.slice(0, 80));
  // Turn it on: change → reconvertCurrent() → full base64 output.
  await page.check('#keep-data-uris');
  await waitMarkdownMode('keep');
  const mdKeep = (await page.textContent('#markdown-out')).trim();
  const expectedKeep = REFERENCE_KEEP[name].markdown.trim();
  check(`${name} keep-data-uris matches reference`, mdKeep === expectedKeep,
    `${mdKeep.length} vs ${expectedKeep.length} chars`);
}
// Toggle is left ON by the loop, and the loop leaves the LAST fixture
// selected. Re-select the first fixture so the comparison below matches the
// row that actually gets reconverted.
await page.evaluate((fname) => {
  for (const li of document.querySelectorAll('#queue li')) {
    if (li.querySelector('.name')?.textContent === fname) li.click();
  }
}, IMG_FIXTURES[0]);
// Flip the toggle off and confirm truncation comes back (exercises the
// change handler in the other direction).
await page.uncheck('#keep-data-uris');
await waitMarkdownMode('truncate');
const mdBack = (await page.textContent('#markdown-out')).trim();
check(`${IMG_FIXTURES[0]} toggle-off restores truncation`,
  !FULL_URI_RE.test(mdBack) && mdBack === REFERENCE[IMG_FIXTURES[0]].markdown.trim(),
  mdBack.slice(0, 80));
// Preference must persist across reloads. End ON (store '1') so the check
// exercises the RESTORE direction: 'checked' being true after reload is only
// possible if restoreKeepDataUris() actually read localStorage — unchecked is
// the checkbox's HTML default, so ending OFF could never catch a broken
// restore (a key mismatch or a dropped restore call would pass vacuously).
await page.check('#keep-data-uris');
await waitMarkdownMode('keep');
await page.reload({ waitUntil: 'domcontentloaded' });
// 'attached', not default 'visible': after reload the in-memory queue is
// gone and #result carries its hidden attribute; the checkbox is only
// visible today because .result{display:flex} (which the [hidden] reset in
// styles.css now correctly overrides) used to beat the UA [hidden] rule.
// The check below reads cb.checked/localStorage — no visibility needed.
await page.waitForSelector('#keep-data-uris', { state: 'attached' });
{
  const stored = await page.evaluate(() => {
    const cb = document.getElementById('keep-data-uris');
    return { checked: cb.checked, ls: localStorage.getItem('markitdown-web:keep-data-uris') };
  });
  check('keep-data-uris preference persists (restore direction)',
    stored.checked === true && stored.ls === '1',
    JSON.stringify(stored));
}

console.log('== 6. offline mode ==');
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

console.log('== 7. file handling API surface ==');
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

console.log('== 8. JS magika port matches native magika ==');
// The README claims the JS re-implementation agrees with native magika
// "verified by the test suite" — make that true: run the in-browser port
// (same createMagika + model the engine uses) over every fixture and diff
// against tests/reference-magika.json (generated by native magika on CPython
// via tests/regen-references.py). label/mime/is_text/extensions must match
// exactly; scores get a small float tolerance (native softmax vs ort-web).
const REFERENCE_MAGIKA = JSON.parse(fs.readFileSync(new URL('./reference-magika.json', import.meta.url), 'utf8'));
const magikaPreds = await page.evaluate(async (fixtures) => {
  const { createMagika } = await import('./magika.js');
  const m = await createMagika(globalThis.ort, new URL('magika/', location.href));
  const out = {};
  for (const [name, b64] of Object.entries(fixtures)) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    out[name] = await m.identify(bytes);
  }
  return out;
}, Object.fromEntries(Object.keys(REFERENCE_MAGIKA).map((n) => {
  const p = path.join(FIXTURES, n);
  return fs.existsSync(p) ? [n, fs.readFileSync(p).toString('base64')] : [n, null];
})));
check('magika reference covers the fixtures',
  Object.keys(REFERENCE_MAGIKA).length >= Object.keys(REFERENCE).length,
  `${Object.keys(REFERENCE_MAGIKA).length} refs vs ${Object.keys(REFERENCE).length} conversions`);
for (const [name, ref] of Object.entries(REFERENCE_MAGIKA)) {
  const got = magikaPreds[name];
  if (!got) { check(`magika ${name}`, false, 'no prediction (fixture missing?)'); continue; }
  const match = got.label === ref.label
    && got.mime_type === ref.mime_type
    && got.is_text === ref.is_text
    && JSON.stringify(got.extensions) === JSON.stringify(ref.extensions)
    && Math.abs(got.score - ref.score) < 0.01;
  check(`magika ${name}`, match,
    match ? '' : `got ${JSON.stringify({ l: got.label, m: got.mime_type, s: +got.score?.toFixed(4) })} vs ref ${JSON.stringify({ l: ref.label, m: ref.mime_type, s: +ref.score?.toFixed(4) })}`);
}

console.log('\n==========================');
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed`);
if (results.failures.length) {
  console.log('Failures:');
  for (const f of results.failures) console.log('  -', f);
}
await browser.close();
process.exit(results.fail ? 1 : 0);
