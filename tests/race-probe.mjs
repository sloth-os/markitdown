// SPDX-License-Identifier: MIT
// Race probe for the keep-data-URIs reconvert redesign (reconvertCurrent /
// reconvertJob / enqueueFiles in src/js/app.js).
//
// The design relies on the "absorption property": every conversion pass
// reads the checkbox at pyodide-call time (after the arrayBuffer + magika
// awaits), so a flip landing in that window is absorbed by the in-flight
// pass; a flip landing after the read finds the job settled and reconverts
// normally. The probe attacks that window deterministically: it hooks
// File#arrayBuffer to STALL passes inside the pre-read window (per-file
// one-shot holds) and flips the toggle at a pinned offset inside a stall.
//
// Scenarios (each asserts: no view yank, correct final mode, EXACT pass
// counts per file — the counter logs every arrayBuffer call):
//   S1 flip on a QUEUED job while an earlier job is stalled mid-pass
//      → takeover converts it immediately; the enqueue loop skips the
//        settled row; the stalled pass absorbs the flip.
//      Also: preview-pane mode must survive the background settle (the
//      finally in reconvertJob only refreshes the panel for the VIEWED
//      job, and showJob preserves the raw/preview choice).
//   S2 flip lands inside the viewed job's INITIAL pass → absorbed by that
//      pass, no queued rerun; panel refresh keeps the preview pane with
//      the new content.
//   S3 cross-batch: batch 2 takes over out of order while batch 1's loop
//      is parked on a stalled pass; a flip inside batch 2's stall is
//      absorbed by that pass. Batch 1's loop iterates its OWN batch's job
//      objects (identity), so it never touches batch 2's rows at all.
//      Ordering is proven from the logged timeline: batch 1's html settles
//      while batch 2's pptx is still mid-stall, and pptx still converts
//      exactly once.
//   S4 double flip with a view switch mid-reconvert → no mis-targeted
//      drain, no stranded flag: exactly the requested passes, and the
//      parked pass absorbs the NEWER checkbox value.
//   S5 clear-queue mid-batch + re-drop → the detached old loop's stale
//      indices must not alias the new queue: no empty-panel reveal, no
//      extra conversions, the first new result auto-displays correctly.
//   S6 engine-boot failure must not poison the retry: a boot that fails
//      (network blocked) is not cached — after unblocking, a new drop
//      boots the engine and converts successfully. Also asserts the error
//      branch's pane contract (toggle disabled, stale preview cleared).
//   S7 error row viewed AFTER a successful one: the previous file's
//      preview DOM must not survive into the error pane (misattributed
//      content under a clickable 'Preview' button was the regression).
//
// Run (from tests/):  python3 -m http.server 8933 -d ../site &
//                     PROBE_BASE_URL=http://localhost:8933/ node race-probe.mjs
// Uses the same playwright install as the e2e suite (tests/node_modules).
import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE_URL || 'http://localhost:8933/';
const FIX = (n) => new URL('./fixtures/' + n, import.meta.url).pathname;
// PROBE_ONLY=S1,S5 runs just those scenarios (mutation-testing convenience).
const ONLY = (process.env.PROBE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (s) => ONLY.length === 0 || ONLY.includes(s);

const results = { pass: 0, fail: 0, failures: [] };
function check(name, ok, detail = '') {
  if (ok) { results.pass++; console.log(`  PASS ${name}`); }
  else { results.fail++; results.failures.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${name} ${detail}`); }
}

// Browser-side instrumentation, injected after load. Hooks
// File#arrayBuffer:
//  - every call logs 'arrayBuffer-enter' (one per engine conversion pass —
//    the pass counter),
//  - a file listed in __holds {name: ms} is STALLED for that long inside
//    the pre-read window (one-shot per name),
//  - __flipPending {name, to, afterMs} flips the checkbox afterMs into
//    THAT file's stall — deterministically before the stalled pass reads
//    the checkbox.
// MutationObservers trace result-panel renders and queue re-renders ('q'
// with every row's state — proves loop/skip ordering inside the browser
// clock). PANEL events are sampled on the title element's records
// (setAttribute/textContent writes fire even when the value is unchanged —
// unlike childList text writes, which is why an empty→empty write to
// #markdown-out produces NO record; sampling here instead catches every
// showJob call, including ones that reveal an empty pane).
const INSTRUMENT = `
window.__log = [];
window.__holds = {}; // {name: ms} — one-shot stalls in arrayBuffer
window.__flipPending = null; // {name, to, afterMs} — flip inside that file's stall
(function instrument() {
  const origAB = File.prototype.arrayBuffer;
  File.prototype.arrayBuffer = async function () {
    const name = this.name;
    window.__log.push({ t: performance.now(), ev: 'arrayBuffer-enter', name });
    const hold = window.__holds[name];
    if (hold !== undefined && hold !== null) {
      delete window.__holds[name]; // one-shot
      if (window.__flipPending && window.__flipPending.name === name) {
        const fp = window.__flipPending;
        setTimeout(() => {
          const cb = document.getElementById('keep-data-uris');
          cb.checked = fp.to;
          window.__log.push({ t: performance.now(), ev: 'flip', to: fp.to });
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }, fp.afterMs);
      }
      await new Promise((r) => setTimeout(r, hold));
      window.__log.push({ t: performance.now(), ev: 'arrayBuffer-exit', name });
    }
    return origAB.call(this);
  };
  const titleEl = document.getElementById('result-title');
  const resultEl = document.getElementById('result');
  new MutationObserver(() => {
    // One sample per title write = one showJob call. Record the FULL panel
    // state at that moment: a reveal of a busy/empty job shows up here as
    // visible=true with mdLen=0 (or a title that matches a still-busy row).
    window.__log.push({
      t: performance.now(),
      ev: 'panel',
      title: titleEl.textContent,
      mdLen: document.getElementById('markdown-out').textContent.length,
      visible: !resultEl.hidden,
      busy: Array.from(document.querySelectorAll('#queue li'))
        .filter((li) => li.querySelector('.qstate')?.dataset.state === 'busy')
        .map((li) => li.querySelector('.name')?.textContent),
    });
  }).observe(titleEl, { attributes: true, attributeFilter: ['title'], childList: true, characterData: true, subtree: true });
  new MutationObserver(() => {
    const states = {};
    for (const li of document.querySelectorAll('#queue li')) {
      states[li.querySelector('.name')?.textContent] = li.querySelector('.qstate')?.dataset.state;
    }
    window.__log.push({ t: performance.now(), ev: 'q', states });
  }).observe(document.getElementById('queue'), { childList: true, subtree: true });
})();
`;

async function newPage(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(INSTRUMENT);
  await page.waitForFunction(
    () => document.getElementById('engine-status')?.dataset.state === 'ready',
    null, { timeout: 180_000 }
  );
  return { context, page };
}

const fullUriRe = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{40}/;

const waitDone = async (page, name) => waitState(page, name, 'done', 120_000);

const waitState = async (page, name, state, timeout = 120_000) => {
  await page.waitForFunction(({ n, s }) => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === n) {
        return li.querySelector('.qstate')?.dataset.state === s;
      }
    }
    return false;
  }, { n: name, s: state }, { timeout });
};

// Wait until `name` has entered arrayBuffer `count` times (a pass boundary).
const waitPasses = async (page, name, count) => {
  await page.waitForFunction(({ n, c }) =>
    window.__log.filter((e) => e.ev === 'arrayBuffer-enter' && e.name === n).length >= c,
    { n: name, c: count }, { timeout: 30_000 });
};

const clickRow = (page, name) => page.evaluate((n) => {
  for (const li of document.querySelectorAll('#queue li')) {
    if (li.querySelector('.name')?.textContent === n) li.click();
  }
}, name);

const flip = (page, to) => page.evaluate((v) => {
  const cb = document.getElementById('keep-data-uris');
  cb.checked = v;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
}, to);

const drop = (page, names) =>
  page.setInputFiles('#file-input', names.map((n) => FIX(n)));

const paneState = (page) => page.evaluate(() => ({
  mdHidden: document.getElementById('markdown-out').hidden,
  renderedHidden: document.getElementById('rendered-out').hidden,
  label: document.getElementById('toggle-render-btn').textContent,
}));

const endState = (page) => page.evaluate(() => ({
  title: document.getElementById('result-title').textContent,
  md: document.getElementById('markdown-out').textContent,
  activeRow: document.querySelector('#queue li.active .name')?.textContent,
  resultHidden: document.getElementById('result').hidden,
  cb: document.getElementById('keep-data-uris').checked,
}));

const getLog = (page) => page.evaluate(() => window.__log);
const passesOf = (log, name) =>
  log.filter((e) => e.ev === 'arrayBuffer-enter' && e.name === name).length;
const evTime = (log, ev, name) =>
  log.find((e) => e.ev === ev && e.name === name)?.t;
// First queue render where `name` shows `state`.
const firstQWith = (log, name, state) =>
  log.find((e) => e.ev === 'q' && e.states[name] === state)?.t;

// ---------------------------------------------------------------------------
console.log('== S1: flip on a QUEUED job while the first job is stalled (takeover + enqueue-loop skip + pane preservation) ==');
if (want('S1')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  await page.evaluate(() => { window.__holds = { 'sample-img.docx': 3000 }; });
  await drop(page, ['sample-img.docx', 'sample-img.html']);
  // docx (job 0) is stalled inside its initial pass; html (job 1) is queued.
  await waitPasses(page, 'sample-img.docx', 1);
  await clickRow(page, 'sample-img.html'); // view the queued job
  await flip(page, true);                  // ON → queued job is taken over immediately
  await waitDone(page, 'sample-img.html');
  // Viewed job settled and refreshed the panel; switch to the rendered
  // preview — the background docx settle below must NOT yank it back.
  await page.click('#toggle-render-btn');
  await waitDone(page, 'sample-img.docx');
  await page.waitForTimeout(400);
  const end = await endState(page);
  const pane = await paneState(page);
  const log = await getLog(page);
  const contentRenders = log.filter((e) => e.ev === 'panel' && e.mdLen > 0);
  const tHtmlEnter = evTime(log, 'arrayBuffer-enter', 'sample-img.html');
  const tDocxExit = evTime(log, 'arrayBuffer-exit', 'sample-img.docx');
  console.log('   timeline:', JSON.stringify(log));
  check('S1: viewed row stays sample-img.html', end.activeRow === 'sample-img.html', end.activeRow);
  check('S1: result title matches viewed row', end.title === end.activeRow, end.title);
  check('S1: viewed output is keep mode (full base64)', fullUriRe.test(end.md), end.md.slice(0, 60));
  check('S1: toggle ends ON', end.cb === true);
  check('S1: docx converted exactly once (stalled pass absorbed the flip)',
    passesOf(log, 'sample-img.docx') === 1, `passes=${passesOf(log, 'sample-img.docx')}`);
  check('S1: html converted exactly once (takeover only; loop skipped the settled job)',
    passesOf(log, 'sample-img.html') === 1, `passes=${passesOf(log, 'sample-img.html')}`);
  // Non-vacuity for the takeover claim: html's pass must START while docx is
  // still stalled (out of order — only the flip-driven takeover can do that;
  // the enqueue loop would convert html strictly after docx's stall ends).
  check('S1: ordering — html takeover started before docx unstalled',
    tHtmlEnter !== undefined && tDocxExit !== undefined && tHtmlEnter < tDocxExit,
    `htmlEnter=${tHtmlEnter} docxExit=${tDocxExit}`);
  check('S1: preview mode survives the background settle (no pane yank)',
    pane.mdHidden === true && pane.renderedHidden === false && pane.label === 'Raw markdown',
    JSON.stringify(pane));
  check('S1: viewed panel rendered with content exactly once (no duplicate render)',
    contentRenders.length === 1, `content renders=${contentRenders.length}`);
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log('== S2: flip on a job BUSY in its INITIAL conversion (absorption, no rerun, pane mode kept) ==');
if (want('S2')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  await page.evaluate(() => {
    window.__holds = { 'sample-img.html': 3000 };
    window.__flipPending = { name: 'sample-img.html', to: true, afterMs: 800 };
  });
  await drop(page, ['sample-img.html', 'sample-img.docx']);
  await waitPasses(page, 'sample-img.html', 1); // job 0 stalled in its initial pass
  await clickRow(page, 'sample-img.html');      // view the BUSY job
  // The instrument flips ON 800ms into the stall — the change handler sees
  // state 'busy' and returns early; the stalled pass must absorb the flip
  // (it reads the checkbox only after the stall ends).
  await page.waitForFunction(() => window.__log.some((e) => e.ev === 'flip'),
    null, { timeout: 10_000 });
  // User switches to the rendered preview while the pass is still stalled;
  // the settle refresh must keep the preview pane and show the NEW content.
  await page.click('#toggle-render-btn');
  await waitDone(page, 'sample-img.html');
  await waitDone(page, 'sample-img.docx');
  await page.waitForTimeout(400);
  const end = await endState(page);
  const pane = await paneState(page);
  // A real <img> element (not innerHTML text): the preview now renders keep-mode
  // payloads as actual <img src="data:..."> nodes. Asserting on the ELEMENT
  // makes this non-vacuous — the old string-pushing renderer serialised the
  // escaped markup into innerHTML too (base64 included), so a text match there
  // passed for BOTH versions and could not detect a regression to the broken
  // one. Only a real <img> distinguishes them. Also assert the markup did not
  // leak as visible text.
  const rendered = await page.evaluate(() => {
    const el = document.getElementById('rendered-out');
    return {
      imgs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''),
      text: el.textContent,
    };
  });
  const log = await getLog(page);
  console.log('   timeline:', JSON.stringify(log));
  check('S2: viewed row stays sample-img.html', end.activeRow === 'sample-img.html', end.activeRow);
  check('S2: result title matches viewed row', end.title === end.activeRow, end.title);
  check('S2: viewed output is keep mode (flip absorbed by the busy pass)',
    fullUriRe.test(end.md), end.md.slice(0, 60));
  check('S2: toggle ends ON', end.cb === true);
  check('S2: html converted exactly once (absorbed, no queued rerun)',
    passesOf(log, 'sample-img.html') === 1, `passes=${passesOf(log, 'sample-img.html')}`);
  check('S2: docx converted exactly once (normal enqueue pass)',
    passesOf(log, 'sample-img.docx') === 1, `passes=${passesOf(log, 'sample-img.docx')}`);
  check('S2: preview pane kept across the settle refresh, rendering a real <img>',
    pane.mdHidden === true && pane.renderedHidden === false
      && rendered.imgs.some((s) => fullUriRe.test(s))
      && !rendered.text.includes('!['),
    JSON.stringify({ ...pane, imgs: rendered.imgs.map((s) => s.slice(0, 30)), textHead: rendered.text.slice(0, 40) }));
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log("== S3: cross-batch — batch 2's stalled pass absorbs the flip; batch 1's loop never touches batch 2's rows ==");
if (want('S3')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  await page.evaluate(() => {
    window.__holds = { 'sample-img.docx': 2500, 'sample-img.pptx': 8000 };
    window.__flipPending = { name: 'sample-img.pptx', to: true, afterMs: 800 };
  });
  await drop(page, ['sample-img.docx', 'sample-img.html']); // batch 1
  await waitPasses(page, 'sample-img.docx', 1); // batch 1's loop parked on docx's stall
  // Batch 2 lands while the main thread is free (docx parked in a timer):
  // its loop starts pptx's pass out of order and stalls there too.
  await drop(page, ['sample-img.pptx']);
  await clickRow(page, 'sample-img.pptx'); // view the busy batch-2 job
  await waitPasses(page, 'sample-img.pptx', 1);
  // Timeline being asserted (t0 = docx enter):
  //   t0+~600 pptx enter (batch-2 loop starts its own batch, stalled 8000ms)
  //   t0+~1400 flip ON (inside pptx's stall — absorbed by pptx's pass)
  //   t0+2500  docx stall ends → docx pass completes (also reads the flip)
  //   t0+~3900 batch 1's loop resumes: html is in ITS OWN batch → converts
  //   t0+~5000 html settles; batch 1's loop ends (pptx is not in its batch)
  //   t0+8600  pptx stall ends → pass completes in keep mode
  await waitDone(page, 'sample-img.docx');
  await waitDone(page, 'sample-img.html');
  await waitDone(page, 'sample-img.pptx');
  await page.waitForTimeout(400);
  const end = await endState(page);
  const log = await getLog(page);
  const tPptxEnter = evTime(log, 'arrayBuffer-enter', 'sample-img.pptx');
  const tHtmlEnter = evTime(log, 'arrayBuffer-enter', 'sample-img.html');
  const tPptxExit = evTime(log, 'arrayBuffer-exit', 'sample-img.pptx');
  const tHtmlDone = firstQWith(log, 'sample-img.html', 'done');
  console.log('   timeline:', JSON.stringify(log));
  check('S3: viewed row stays sample-img.pptx', end.activeRow === 'sample-img.pptx', end.activeRow);
  check('S3: result title matches viewed row', end.title === end.activeRow, end.title);
  check('S3: viewed output is keep mode (flip absorbed by batch-2 pass)',
    fullUriRe.test(end.md), end.md.slice(0, 60));
  check('S3: toggle ends ON', end.cb === true);
  check('S3: pptx converted exactly once (batch-1 loop never touched batch-2 rows)',
    passesOf(log, 'sample-img.pptx') === 1, `passes=${passesOf(log, 'sample-img.pptx')}`);
  check('S3: docx converted exactly once', passesOf(log, 'sample-img.docx') === 1,
    `passes=${passesOf(log, 'sample-img.docx')}`);
  check('S3: html converted exactly once', passesOf(log, 'sample-img.html') === 1,
    `passes=${passesOf(log, 'sample-img.html')}`);
  // The ordering proof that the batches genuinely overlapped: batch 1's
  // html settled while batch 2's pptx was still mid-stall — the exact
  // window in which an index-based loop would have aliased batch 2's rows.
  check('S3: ordering — html converted after pptx started',
    tPptxEnter !== undefined && tHtmlEnter !== undefined && tPptxEnter < tHtmlEnter,
    `pptxEnter=${tPptxEnter} htmlEnter=${tHtmlEnter}`);
  check('S3: ordering — html settled while pptx was still mid-stall',
    tHtmlDone !== undefined && tPptxExit !== undefined && tHtmlDone < tPptxExit,
    `htmlDone=${tHtmlDone} pptxExit=${tPptxExit}`);
  // docx also absorbed the flip (its pyodide call happened after the flip).
  await clickRow(page, 'sample-img.docx');
  const mdDocx = await page.evaluate(() => document.getElementById('markdown-out').textContent);
  check('S3: docx output is keep mode (its stalled pass also absorbed the flip)',
    fullUriRe.test(mdDocx), mdDocx.slice(0, 60));
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log('== S4: double flip with a view switch mid-reconvert (mis-targeted-drain killer) ==');
if (want('S4')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  await drop(page, ['sample-img.docx', 'sample-img.html']);
  await waitDone(page, 'sample-img.docx'); // both settle in truncate mode
  await waitDone(page, 'sample-img.html');
  await page.evaluate(() => { window.__holds = { 'sample-img.docx': 2000 }; });
  await flip(page, true); // ON while viewing docx → its reconvert stalls in arrayBuffer
  await waitPasses(page, 'sample-img.docx', 2);
  // View html and flip OFF. The OLD design drained its queued-flip flag into
  // whatever row was active here (an unrequested extra conversion). The NEW
  // design: this flip reconverts html exactly once (requested — it is the
  // viewed row), and docx's parked pass absorbs the newer checkbox value.
  await page.evaluate(() => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === 'sample-img.html') li.click();
    }
    const cb = document.getElementById('keep-data-uris');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitPasses(page, 'sample-img.html', 2); // html's requested reconvert ran
  await waitState(page, 'sample-img.html', 'done');
  await waitState(page, 'sample-img.docx', 'done'); // resumes from the stall and completes
  await page.waitForTimeout(400);
  const end = await endState(page);
  const log = await getLog(page);
  console.log('   timeline:', JSON.stringify(log));
  check('S4: viewed row stays sample-img.html', end.activeRow === 'sample-img.html', end.activeRow);
  check('S4: result title matches viewed row', end.title === end.activeRow, end.title);
  check('S4: toggle ends OFF', end.cb === false);
  check('S4: docx exactly 2 passes (initial + flip-1 reconvert; no drain duplicate)',
    passesOf(log, 'sample-img.docx') === 2, `passes=${passesOf(log, 'sample-img.docx')}`);
  check('S4: html exactly 2 passes (initial + flip-2 reconvert; no unrequested drain)',
    passesOf(log, 'sample-img.html') === 2, `passes=${passesOf(log, 'sample-img.html')}`);
  // Latest toggle state must win for BOTH jobs.
  await clickRow(page, 'sample-img.docx');
  const mdA = await page.evaluate(() => document.getElementById('markdown-out').textContent);
  await clickRow(page, 'sample-img.html');
  const mdB = await page.evaluate(() => document.getElementById('markdown-out').textContent);
  check('S4: docx output back to truncate (parked pass absorbed the newer flip)',
    !fullUriRe.test(mdA), mdA.slice(0, 60));
  check('S4: html output back to truncate (reconvert read the newer flip)',
    !fullUriRe.test(mdB), mdB.slice(0, 60));
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log('== S5: clear-queue mid-batch + re-drop (stale-index aliasing killer) ==');
if (want('S5')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  // Timing puts the detached docx settle INSIDE the bug window: docx
  // unstalls (~1500ms) and settles while batch 2's first job (pptx) is
  // still parked in its own stall (6000ms) and nothing has been selected
  // (activeJob === -1). Two stale-index failure modes live in this window
  // (the second was demonstrated live before the identity-iteration fix):
  //  a) the detached settle runs showJob(capturedIndex) → reveals the panel
  //     on the still-busy pptx row's EMPTY markdown;
  //  b) batch 1's loop, iterating by index, walks INTO batch 2's rows after
  //     its stall ends: queue[1] is now xlsx, so the stale loop converts
  //     xlsx out of order and auto-displays IT as the "first result" —
  //     pptx (the actual first settle of the new queue) never gets shown.
  // With docx unstalling AFTER batch 2 finished (the earlier 5000ms
  // timing) neither mode is reachable and every assertion passes vacuously.
  await page.evaluate(() => {
    window.__holds = { 'sample-img.docx': 1500, 'sample-img.pptx': 6000 };
  });
  await drop(page, ['sample-img.docx', 'sample-img.html']); // batch 1
  await waitPasses(page, 'sample-img.docx', 1); // batch 1's loop parked on docx's stall
  // Clear the queue while docx is mid-pass, then drop a fresh batch — the
  // parked loop's captured indices (firstNew=0, i=0/1) now alias rows of the
  // NEW queue if used.
  await page.click('#clear-queue');
  await drop(page, ['sample-img.pptx', 'sample-img.xlsx']); // batch 2 (new queue)
  await waitPasses(page, 'sample-img.pptx', 1); // batch 2's loop parked on pptx's stall
  // Wait for the detached docx pass to settle WHILE pptx is still busy —
  // this is the exact moment the stale-index bug would fire.
  await page.waitForFunction(() =>
    window.__log.some((e) => e.ev === 'arrayBuffer-exit' && e.name === 'sample-img.docx'),
    null, { timeout: 30_000 });
  await waitState(page, 'sample-img.pptx', 'busy'); // still mid-stall: window confirmed
  // Let the detached docx settle fully (pyodide conversion runs ~1.2s after
  // the stall ends — see S1's exit→done gap) so any buggy stale showJob has
  // fired and been sampled before the reveal assertions read the log.
  await page.waitForTimeout(2500);
  // The panel-sampled reveal check: every 'panel' sample (one per showJob
  // title write — attribute/text writes fire even for same-value writes,
  // unlike the old #markdown-out childList observer, which emitted NO
  // record for an empty→empty write and made the check vacuous) taken
  // while the panel is visible must carry content.
  const logMid = await getLog(page);
  const reveals = logMid.filter((e) => e.ev === 'panel');
  check('S5: no reveal while pptx still busy (panel stays hidden or has content)',
    reveals.every((e) => !e.visible || e.mdLen > 0), JSON.stringify(reveals));
  // The panel must still be HIDDEN at this point: with the pre-fix stale
  // index, the detached docx settle ran showJob(0) and revealed the busy
  // pptx row's empty markdown HERE (the old 'md' observer missed it because
  // an empty→empty text write produces no mutation record; the title-based
  // 'panel' sampler catches every showJob).
  const midVisible = await page.evaluate(() =>
    !document.getElementById('result').hidden);
  check('S5: panel not revealed by the detached settle (stale-index window)',
    midVisible === false, `visible=${midVisible} reveals=${JSON.stringify(reveals)}`);
  await waitDone(page, 'sample-img.pptx');
  await waitDone(page, 'sample-img.xlsx');
  await page.waitForTimeout(400);
  const end = await endState(page);
  const log = await getLog(page);
  const revealsAll = log.filter((e) => e.ev === 'panel');
  console.log('   timeline:', JSON.stringify(log));
  // First-result auto-display: the FIRST settle of the new queue (pptx —
  // xlsx was still queued when it fired, activeJob===-1) reveals the panel;
  // the later xlsx settle must NOT steal the view.
  const firstReveal = revealsAll.find((e) => e.visible && e.mdLen > 0);
  check('S5: first new result auto-displayed (pptx, panel visible)',
    firstReveal?.title === 'sample-img.pptx', JSON.stringify(firstReveal));
  check('S5: panel stays on the first result (later settle never yanks)',
    end.activeRow === 'sample-img.pptx' && end.resultHidden === false
      && end.title === 'sample-img.pptx' && end.md.length > 0,
    `row=${end.activeRow} title=${end.title} len=${end.md.length}`);
  check('S5: no empty-panel reveal across the whole scenario',
    revealsAll.length > 0 && revealsAll.every((e) => !e.visible || e.mdLen > 0),
    JSON.stringify(revealsAll));
  check('S5: docx exactly 1 pass (detached pass completed, no re-run)',
    passesOf(log, 'sample-img.docx') === 1, `passes=${passesOf(log, 'sample-img.docx')}`);
  check('S5: html never converted (cleared before its turn)',
    passesOf(log, 'sample-img.html') === 0, `passes=${passesOf(log, 'sample-img.html')}`);
  check('S5: pptx converted exactly once', passesOf(log, 'sample-img.pptx') === 1,
    `passes=${passesOf(log, 'sample-img.pptx')}`);
  check('S5: xlsx converted exactly once (no alias double-conversion)',
    passesOf(log, 'sample-img.xlsx') === 1, `passes=${passesOf(log, 'sample-img.xlsx')}`);
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log('== S6: failed engine boot must not poison the retry (boot-cache self-heal) ==');
if (want('S6')) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Block the pyodide distribution: the page shell loads, but the engine
  // boot fails at the pyodide.mjs import (and the SW install fails too, so
  // nothing is served from cache — a cold first visit on a dead network).
  await context.route('**/pyodide/**', (route) => route.abort());
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('engine-status')?.textContent === '✗ engine failed',
    null, { timeout: 60_000 }); // deferred warm-up boot failed
  // Drop A while still blocked → this boot attempt also fails; a cached
  // rejection here would poison every later conversion until page reload.
  await page.setInputFiles('#file-input', [FIX('sample.txt')]);
  await waitState(page, 'sample.txt', 'error', 60_000);
  // View the errored row: the error branch must disable the preview toggle
  // and clear any stale preview DOM (showJob error-branch contract — a
  // leftover preview from an earlier file would be misattributed content).
  await clickRow(page, 'sample.txt');
  const errPane = await page.evaluate(() => ({
    errText: document.getElementById('error-box').textContent,
    toggleDisabled: document.getElementById('toggle-render-btn').disabled,
    renderedKids: document.getElementById('rendered-out').childNodes.length,
    mdText: document.getElementById('markdown-out').textContent,
  }));
  check('S6: error row shows the failure and locks the preview toggle',
    errPane.errText.length > 0 && errPane.toggleDisabled === true
      && errPane.renderedKids === 0 && errPane.mdText === '',
    JSON.stringify(errPane));
  // Network returns. Drop B → the engine must boot NOW and convert it.
  await context.unroute('**/pyodide/**');
  await page.setInputFiles('#file-input', [FIX('sample.md')]);
  await waitState(page, 'sample.md', 'done', 180_000);
  await clickRow(page, 'sample.md');
  const endPane = await page.evaluate(() => ({
    md: document.getElementById('markdown-out').textContent,
    toggleDisabled: document.getElementById('toggle-render-btn').disabled,
  }));
  check('S6: engine recovers after a failed boot (retry succeeds, not cached)',
    endPane.md.trim().length > 0, `len=${endPane.md.length}`);
  check('S6: success row re-enables the preview toggle',
    endPane.toggleDisabled === false);
  const stateA = await page.evaluate(() => {
    for (const li of document.querySelectorAll('#queue li')) {
      if (li.querySelector('.name')?.textContent === 'sample.txt') {
        return li.querySelector('.qstate')?.dataset.state;
      }
    }
    return null;
  });
  check('S6: failed job A stays marked as an error after recovery',
    stateA === 'error', `state=${stateA}`);
  await context.close();
  await browser.close();
}

// ---------------------------------------------------------------------------
console.log('== S7: error row after a viewed success — no stale preview, toggle locked ==');
if (want('S7')) {
  const browser = await chromium.launch({ headless: true });
  const { context, page } = await newPage(browser);
  // View a successful conversion first: showJob's success path fills
  // #rendered-out via renderPreview() even while the raw pane is shown.
  await drop(page, ['sample-img.html']);
  await waitDone(page, 'sample-img.html');
  const previewLen = await page.evaluate(() =>
    document.getElementById('rendered-out').textContent.length);
  check('S7: success path populated the preview pane', previewLen > 0, `len=${previewLen}`);
  // Now a corrupt docx (random bytes, right extension) must settle as error.
  await page.evaluate(() => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'garbage.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await waitState(page, 'garbage.docx', 'error', 60_000);
  await clickRow(page, 'garbage.docx');
  // The regression being gated: the error branch used to leave the PREVIOUS
  // file's preview DOM in #rendered-out with a clickable 'Preview' button —
  // one click revealed another document's content under the error row.
  const errPane = await page.evaluate(() => {
    const btn = document.getElementById('toggle-render-btn');
    return {
      toggleDisabled: btn.disabled,
      renderedKids: document.getElementById('rendered-out').childNodes.length,
      renderedText: document.getElementById('rendered-out').textContent,
      errVisible: !document.getElementById('error-box').hidden,
      mdEmpty: document.getElementById('markdown-out').textContent === '',
      title: document.getElementById('result-title').textContent,
    };
  });
  console.log('   errPane:', JSON.stringify(errPane));
  check('S7: error row clears the stale preview DOM',
    errPane.renderedKids === 0 && errPane.renderedText === '',
    `kids=${errPane.renderedKids}`);
  check('S7: error row disables the preview toggle', errPane.toggleDisabled === true);
  check('S7: error row shows error box, empty raw pane, correct title',
    errPane.errVisible && errPane.mdEmpty && errPane.title === 'garbage.docx',
    JSON.stringify(errPane));
  // Even a forced synthetic click (bypassing the disabled UX) must not
  // reveal anything: the pane is empty, so there is nothing to misattribute.
  await page.evaluate(() =>
    document.getElementById('toggle-render-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const afterClick = await paneState(page);
  const revealed = await page.evaluate(() => ({
    renderedHidden: document.getElementById('rendered-out').hidden,
    renderedText: document.getElementById('rendered-out').textContent,
  }));
  check('S7: forced toggle click on error row reveals no content',
    revealed.renderedHidden === true || revealed.renderedText === '',
    JSON.stringify({ afterClick, revealed }));
  await context.close();
  await browser.close();
}

console.log('RESULTS: ' + results.pass + ' passed, ' + results.fail + ' failed');
if (results.failures.length) { console.log('Failures:'); for (const f of results.failures) console.log('  - ' + f); }
process.exit(results.fail ? 1 : 0);
