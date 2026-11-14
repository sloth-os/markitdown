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

console.log('== 9. preview pane renders real DOM ==');
// NOTE: the queue is in-memory, so the section-5 reload left it EMPTY — this
// section converts its own fixtures rather than reusing earlier rows. The
// toggle is left ON by that section (persisted to localStorage), so new
// conversions arrive in keep mode.
//
// showJob() calls renderPreview() on the success path even while the RAW pane
// is shown, so #rendered-out always reflects the focused row — no need to
// click the toggle.
//
// The regression this section gates: renderPreview used to push HTML STRINGS
// that the append loop turned into text nodes, so tables were the only thing
// that rendered. Every other branch reached the user as literal markup —
// "<h1>Images</h1>", "**Title:**" — and images had no branch at all. These
// assertions fail against that version: they require real elements AND
// forbid the markup leaking as visible text.
const convertFixture = async (name) => {
  await page.setInputFiles('#file-input', path.join(FIXTURES, name));
  await page.waitForFunction(
    (fname) => {
      for (const li of document.querySelectorAll('#queue li')) {
        const nm = li.querySelector('.name')?.textContent;
        const st = li.querySelector('.qstate')?.dataset.state;
        if (nm === fname && (st === 'done' || st === 'error')) return true;
      }
      return false;
    }, name, { timeout: 60_000 }
  );
};
const previewOf = async (name) => {
  await convertFixture(name);
  await page.evaluate((fname) => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === fname) li.click();
    }
  }, name);
  return page.evaluate(() => {
    const el = document.getElementById('rendered-out');
    return {
      counts: {
        h: el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
        strong: el.querySelectorAll('strong').length,
        code: el.querySelectorAll('code').length,
        pre: el.querySelectorAll('pre').length,
        table: el.querySelectorAll('table').length,
        tr: el.querySelectorAll('tr').length,
        img: el.querySelectorAll('img').length,
        a: el.querySelectorAll('a').length,
        placeholder: el.querySelectorAll('.img-placeholder').length,
      },
      // Visible text of every TEXT NODE (not descendants' text), which is where
      // escaped markup used to land.
      textNodes: (function collect(n) {
        let acc = [];
        for (const c of n.childNodes) {
          if (c.nodeType === 3) acc.push(c.textContent);
          else if (c.nodeType === 1) acc = acc.concat(collect(c));
        }
        return acc;
      }(el)),
      imgSrcs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''),
      innerHTML: el.innerHTML,
      paneHidden: el.hidden,
    };
  });
};
// No literal markdown/HTML syntax may be visible as text. Deliberately broad:
// the first version of this pattern only anchored `\*\*` at the start of a text
// node, so a leaked `see **this** ok` slipped through, and it required a leading
// `!` for links, so `[Next](page2.html)` did too. These are the exact residue
// shapes the renderer produces when a token fails to parse.
const NO_LEAKED_MARKUP =
  /<\s*(h\d|strong|code|pre|li|img|table|p|u)\b|\*\*|!\[[^\]]*\]\(|\]\(|\[[^\]]*\]\(|<h\d>|~~/;
const noLeak = (p) => !p.textNodes.some((t) => NO_LEAKED_MARKUP.test(t));

{
  const p = await previewOf('sample.csv');
  check('preview: csv renders a real <table>',
    p.counts.table === 1 && p.counts.tr === 3, JSON.stringify(p.counts));
  check('preview: csv leaks no markup as text', noLeak(p),
    JSON.stringify(p.textNodes.slice(0, 3)));
}
{
  const p = await previewOf('sample.md');
  check('preview: md renders a real <h1>', p.counts.h === 1, JSON.stringify(p.counts));
  check('preview: md heading text is the content, not the markup',
    p.textNodes.some((t) => t.includes('MD Title')) && !p.innerHTML.includes('&lt;h1&gt;'),
    p.innerHTML.slice(0, 80));
}
{
  const p = await previewOf('sample.epub');
  check('preview: epub renders real <strong>', p.counts.strong >= 1, JSON.stringify(p.counts));
  check('preview: epub leaks no markup as text', noLeak(p),
    JSON.stringify(p.textNodes.slice(0, 3)));
}
// Keep-mode images: two inline 1x1 PNG data URIs plus one REMOTE https URL,
// which cannot resolve here and must degrade to a placeholder rather than a
// broken-image icon.
//
// Two timing notes:
//  * <img> carries loading="lazy", and a lazy image inside a display:none
//    subtree never starts loading — so the pane MUST be revealed before its
//    error can fire. (Eager loading would be wrong for keep-mode documents,
//    where a single file can carry megabytes of base64 the user may never
//    view.)
//  * the degradation rides an async error event, so wait for the placeholder
//    instead of sampling immediately.
{
  await previewOf('sample-img.html');
  if (await page.evaluate(() => document.getElementById('rendered-out').hidden)) {
    await page.click('#toggle-render-btn');
  }
  await page.waitForFunction(
    () => document.querySelectorAll('#rendered-out .img-placeholder').length >= 1,
    null, { timeout: 30_000 }
  );
  const p = await page.evaluate(() => {
    const el = document.getElementById('rendered-out');
    return {
      img: el.querySelectorAll('img').length,
      placeholder: el.querySelectorAll('.img-placeholder').length,
      imgSrcs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''),
      textNodes: (function collect(n) {
        let acc = [];
        for (const c of n.childNodes) {
          if (c.nodeType === 3) acc.push(c.textContent);
          else if (c.nodeType === 1) acc = acc.concat(collect(c));
        }
        return acc;
      }(el)),
      paneHidden: el.hidden,
    };
  });
  check('preview: keep-mode html renders the two inline data-URI images',
    p.img === 2, JSON.stringify({ img: p.img, ph: p.placeholder, paneHidden: p.paneHidden }));
  check('preview: every rendered <img> src is a full base64 data URI',
    p.imgSrcs.every((s) => FULL_URI_RE.test(s)),
    JSON.stringify(p.imgSrcs.map((s) => s.slice(0, 40))));
  check('preview: unreachable remote image degrades to a placeholder',
    p.placeholder >= 1, JSON.stringify({ img: p.img, ph: p.placeholder }));
  check('preview: html leaks no markup as text', noLeak(p),
    JSON.stringify(p.textNodes.slice(0, 4)));
}
// The toggle is now in preview mode for the rest of the section; the two
// placeholder cases below create their nodes synchronously (truncated URI and
// non-renderable src), so they do not depend on a load attempt.
// PPTX default mode substitutes the image's FILENAME (Picture2.jpg), which is
// not a renderable src here and must become a placeholder — never an <img>
// pointing at a nonexistent same-origin file.
{
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === 'sample-img.html') li.click();
    }
  });
  await page.uncheck('#keep-data-uris');
  await waitMarkdownMode('truncate');
  const p = await previewOf('sample-img.pptx');
  check('preview: pptx filename substitution renders a placeholder, not an <img>',
    p.counts.img === 0 && p.counts.placeholder >= 1, JSON.stringify(p.counts));
}
// Truncated data URIs (default mode) carry no payload, so they must render a
// placeholder that says so rather than a broken image.
{
  const p = await previewOf('sample-img.docx');
  check('preview: truncated data URI renders a placeholder, not a broken <img>',
    p.counts.img === 0 && p.counts.placeholder >= 1, JSON.stringify(p.counts));
}

console.log('== 10. preview renderer: synthetic markdown (real renderPreview) ==');
// Section 9 exercises the renderer through converted fixtures, but those only
// ever produce a handful of block types — no fixture yields a list, a link, a
// code fence, a blockquote or an h2-h6, so a regression in any of those would
// sail through. This section imports the ACTUAL renderPreview (app.js is a
// module, so the re-import returns the live singleton, side effects already
// run) and drives it with hand-built markdown that pins each construct plus
// the specific regressions found in review.
//
// Non-vacuity: several of these assertions FAIL against both the old
// string-pushing renderer AND intermediate versions of the rewrite (see the
// per-case comments). They are written as DOM-shape + visible-text assertions,
// so a construct that renders as literal text instead of an element fails.
const renderMd = async (md) => page.evaluate(async (src) => {
  const { renderPreview } = await import('./app.js');
  const el = document.getElementById('rendered-out');
  el.hidden = false; // lazy <img> never loads in a display:none subtree
  renderPreview(src);
  const collect = (n) => {
    let acc = [];
    for (const c of n.childNodes) {
      if (c.nodeType === 3) acc.push(c.textContent);
      else if (c.nodeType === 1) acc = acc.concat(collect(c));
    }
    return acc;
  };
  return {
    counts: Object.fromEntries(['H1','H2','H3','H4','H5','H6','P','STRONG','EM','CODE','PRE','TABLE','THEAD','TBODY','TR','TH','TD','UL','OL','LI','BLOCKQUOTE','HR','IMG','A','BR'].map(
      (t) => [t, el.querySelectorAll(t).length])),
    text: el.textContent,
    textNodes: collect(el),
    html: el.innerHTML,
    olStart: [...el.querySelectorAll('ol')].map((o) => o.getAttribute('start')),
    imgSrcs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''),
    hrefs: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href') || ''),
    placeholders: [...el.querySelectorAll('.img-placeholder')].map((s) => ({
      t: s.textContent, title: s.getAttribute('title') || '',
    })),
  };
}, md);
const noScriptNodes = (p) => !/<script|<iframe|<object|<embed|onerror=/i.test(p.html);

{
  // Headings h2-h6 + inline strong/code inside a heading.
  const p = await renderMd('## Sub\n### Third\n#### Four\n##### Five\n###### Six\n# Top with **bold** and `code`');
  check('preview: renders h2 through h6 as distinct real elements',
    p.counts.H2 === 1 && p.counts.H3 === 1 && p.counts.H4 === 1 && p.counts.H5 === 1
      && p.counts.H6 === 1 && p.counts.H1 === 1 && p.counts.STRONG === 1 && p.counts.CODE === 1,
    JSON.stringify(p.counts));
  check('preview: heading text has no leftover # or markup',
    p.text.includes('Sub') && !p.text.includes('#') && !p.text.includes('**') && !p.text.includes('`'),
    p.text.slice(0, 60));
}
{
  // Lists: ul, ol with a start attribute, mixed punctuation bullet that must
  // NOT be eaten as an <hr> (review finding 7), and an indented continuation
  // line that must stay INSIDE its item (review finding 11).
  const p = await renderMd('* item\n* --\n* item2\n\n5. five\n6. six\n\n* Line one  \n  Line two');
  check('preview: punctuation-only bullet stays a list item, not an <hr>',
    p.counts.UL >= 1 && p.counts.LI >= 3 && p.counts.HR === 0,
    JSON.stringify(p.counts));
  check('preview: <ol start> honoured (5. five → start=5)',
    p.counts.OL === 1 && p.olStart[0] === '5', JSON.stringify(p.olStart));
  check('preview: indented continuation stays inside its <li>',
    p.textNodes.some((t) => t.includes('Line two')) && !/<p>\s*Line two/i.test(p.html),
    p.html.slice(0, 120));
}
{
  // Links + images. Nested [![alt](img)](url) must become an <a> CONTAINING an
  // <img> with the anchor pointing at the TARGET url (review finding 3: the old
  // regex parsed it as an image whose src was the poster — wrong href).
  const p = await renderMd('[![Buy now](https://cdn.example/logo.png)](https://shop.example/item)\n\n[**bold link**](https://x/y)');
  check('preview: link wrapping an image → <a> with correct href + inner <img>',
    p.counts.A >= 1 && p.counts.IMG >= 1
      && p.hrefs.includes('https://shop.example/item')
      && p.imgSrcs.includes('https://cdn.example/logo.png'),
    JSON.stringify({ hrefs: p.hrefs, imgSrcs: p.imgSrcs }));
  check('preview: bold inside a link label renders as <strong>, not literal **',
    p.counts.STRONG >= 1 && !p.text.includes('**'), p.text.slice(0, 60));
}
{
  // Fenced code: an inner ``` line must be CONTENT of the ~~~ block, not a
  // closer. (An intermediate draft did `continue` on any fence-looking line
  // while inside a block, which silently DROPPED the ``` line from the output.)
  const p = await renderMd('~~~\n``` not a closer\nstill code\n~~~');
  check('preview: ~~~ fence not closed by an inner ``` line',
    p.counts.PRE === 1 && p.counts.CODE === 1, JSON.stringify(p.counts));
  check('preview: inner ``` line is kept as code content, not dropped',
    p.text.includes('``` not a closer') && p.text.includes('still code'),
    JSON.stringify(p.text));
}
{
  // Emphasis: markdownify's default emphasis_style is "*", so <em>/<i> arrive
  // as single asterisks. The flanking rule must keep multiplication literal —
  // PlainTextConverter passes .txt/.md through VERBATIM, so "2 * 3 and 4 * 5"
  // is arithmetic, not emphasis.
  const p = await renderMd('*emphasis* and ***boldit*** and 2 * 3 and 4 * 5\n\n`a * b`');
  check('preview: *emphasis* renders as a real <em>',
    p.counts.EM >= 1 && p.text.includes('emphasis'), JSON.stringify(p.counts));
  check('preview: ***x*** renders as <em><strong>',
    p.counts.STRONG >= 1 && p.text.includes('boldit'), JSON.stringify(p.counts));
  check('preview: spaced asterisks stay literal (no false emphasis)',
    p.text.includes('2 * 3 and 4 * 5'), JSON.stringify(p.text));
  check('preview: asterisks inside a code span stay literal',
    p.counts.CODE === 1 && p.text.includes('a * b'), JSON.stringify(p.counts));
}
{
  // Blockquote across two lines + escaped asterisks must unescape
  // (review finding 4: markdownify escapes * and _ by default).
  const p = await renderMd('> Quoted \\*text\\*\n> second line\n\n**Price \\* Qty**\n\n*snake\\_case\\_name*');
  check('preview: blockquote renders as a real <blockquote>',
    p.counts.BLOCKQUOTE === 1, JSON.stringify(p.counts));
  check('preview: markdownify backslash escapes are unescaped in visible text',
    p.text.includes('Price * Qty') && p.text.includes('snake_case_name')
      && !p.text.includes('\\'), p.text.slice(0, 80));
  check('preview: escaped asterisk inside bold still yields <strong>',
    p.counts.STRONG === 1, JSON.stringify(p.counts));
}
{
  // CSV escaped pipe (review finding 2): a cell "x|y" must stay ONE cell.
  const p = await renderMd('| a | b | c |\n| --- | --- | --- |\n| x\\|y | 2 | 3 |');
  check('preview: escaped pipe stays inside one table cell',
    p.counts.TABLE === 1 && p.counts.TR === 2 && p.counts.TD === 3
      && p.textNodes.some((t) => t === 'x|y'),
    JSON.stringify({ counts: p.counts, td: p.textNodes }));
}
{
  // Security: script-capable URLs and raw HTML must never become live nodes.
  const p = await renderMd('<script>alert(1)</script> ![x](javascript:alert(2)) '
    + '[y](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) '
    + '![z](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=) ![w](//evil.com/x.png) ![v](/\\evil.com/x.png)');
  check('preview: no script-capable node created from hostile markdown',
    noScriptNodes(p) && p.counts.IMG === 0 && p.counts.A === 0,
    JSON.stringify({ counts: p.counts, imgs: p.imgSrcs, hrefs: p.hrefs }));
  check('preview: backslash-rooted URL refused (no cross-origin beacon)',
    p.placeholders.some((x) => (x.title || '').includes('evil.com')),
    JSON.stringify(p.placeholders.map((x) => x.title)));
}
{
  // Empty-alt huge data URI that is NOT a renderable mime (x-emf is not in the
  // SAFE_URL_RE allowlist), so imageNode takes the synchronous
  // "source not renderable" branch and builds a placeholder immediately — no
  // async load needed. The placeholder label/title must be SHORT, never the
  // 200 KB src (review finding 6: `alt || src` put the whole payload in the DOM
  // and produced a 16-million-pixel-wide row).
  const big = 'data:image/x-emf;base64,' + 'A'.repeat(200_000);
  const p = await renderMd('![](' + big + ')');
  check('preview: non-renderable empty-alt data URI → placeholder, not an <img>',
    p.counts.IMG === 0 && p.placeholders.length === 1, JSON.stringify(p.counts));
  const ph = p.placeholders[0] || { t: '', title: '' };
  check('preview: placeholder title is a short description, not the raw payload',
    ph.title.length > 0 && ph.title.length < 300 && ph.t.length < 200,
    JSON.stringify({ tLen: ph.t.length, titleLen: ph.title.length }));
}
{
  // Quadratic-freeze regression (review finding 1): the OLD INLINE_RE froze the
  // tab for 13 s on a 200 KB line of "[TODO " (measured). The new linear
  // scanner must render it fast and without throwing.
  const hostile = '[TODO '.repeat(34_000); // ~200 KB, one line, all unbalanced
  const r = await page.evaluate(async (src) => {
    const { renderPreview } = await import('./app.js');
    const t0 = performance.now();
    let err = null;
    try { renderPreview(src); } catch (e) { err = String(e); }
    return { ms: performance.now() - t0, err };
  }, hostile);
  check('preview: 200 KB unbalanced-bracket line renders fast (no quadratic freeze)',
    r.err === null && r.ms < 1500, `${Math.round(r.ms)} ms, err=${r.err}`);
}

console.log('\n==========================');
console.log(`RESULTS: ${results.pass} passed, ${results.fail} failed`);
if (results.failures.length) {
  console.log('Failures:');
  for (const f of results.failures) console.log('  -', f);
}
await browser.close();
process.exit(results.fail ? 1 : 0);
