// SPDX-License-Identifier: MIT
//
// MarkItDown Web — main application.
//
// Boot order:
//   1. register the service worker (offline support)
//   2. start pyodide + install the vendored wheels
//   3. load magika (ONNX via onnxruntime-web) in parallel
//   4. expose convertFile() once both are ready
//
// Files enter via: drag & drop, file picker, clipboard paste, or the PWA
// File Handling API (launchQueue — see manifest.webmanifest file_handlers).

import "./ort-setup.js"; // sets globalThis.ort (onnxruntime-web)
import { createMagika } from "./magika.js";

const BASE = new URL(".", location.href);

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const els = {
  engineStatus: $("engine-status"),
  offlineStatus: $("offline-status"),
  mdVersion: $("md-version"),
  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  fileList: $("file-list"),
  queue: $("queue"),
  clearQueue: $("clear-queue"),
  result: $("result"),
  resultTitle: $("result-title"),
  errorBox: $("error-box"),
  markdownOut: $("markdown-out"),
  renderedOut: $("rendered-out"),
  copyBtn: $("copy-btn"),
  downloadBtn: $("download-btn"),
  toggleRenderBtn: $("toggle-render-btn"),
  keepDataUris: $("keep-data-uris"),
  pasteHint: $("paste-hint"),
};

let toastTimer;
function toast(msg, isError = false) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function setEngineStatus(state, text) {
  els.engineStatus.dataset.state = state;
  els.engineStatus.textContent = text;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// "keep data URIs" option (the CLI's --keep-data-uris):
// by default markitdown truncates embedded base64 images to `data:...;base64...`;
// when enabled, the raw image data is retained in the markdown. Persisted so
// the choice survives reloads; the File object is kept on the queue entry so
// flipping the switch can re-convert the file being viewed.
// ---------------------------------------------------------------------------
const KEEP_URIS_KEY = "markitdown-web:keep-data-uris";

function restoreKeepDataUris() {
  if (!els.keepDataUris) return;
  let stored = null;
  try {
    stored = localStorage.getItem(KEEP_URIS_KEY);
  } catch { /* private mode / storage disabled — just use the default */ }
  els.keepDataUris.checked = stored === "1";
}

restoreKeepDataUris();

function keepDataUrisEnabled() {
  return !!(els.keepDataUris && els.keepDataUris.checked);
}

async function reconvertCurrent() {
  // Re-run the job being viewed with the new setting (used when the
  // keep-data-URIs checkbox changes).
  //
  // If the viewed job is ALREADY converting — either a prior reconvert or its
  // initial conversion from the enqueue loop — there is nothing to do: every
  // conversion pass reads the checkbox value at the moment of the Python call
  // (engine.convertFile → keepDataUrisEnabled(), after the arrayBuffer and
  // magika awaits). A flip dispatched before that point is absorbed by the
  // in-flight pass itself (its output already reflects the new setting); a
  // flip dispatched during the synchronous WASM window cannot run until the
  // pass completes, at which point job.state is settled and the next flip
  // takes the normal reconvert path. No pending-flip bookkeeping — and
  // therefore no mis-targeted or stranded flags.
  const job = queue[activeJob];
  if (!job) return;
  if (job.state === "busy") return;
  await reconvertJob(job);
}

async function reconvertJob(job) {
  // One conversion pass on `job`: mark busy, convert, settle state, re-render.
  // Shared by the keep-data-URIs change handler (settled jobs) and the
  // enqueue loop (initial conversions) so both paths write job state through
  // one code path.
  job.state = "busy";
  renderQueue();
  try {
    const res = await engine.convertFile(job.file);
    if (res.ok) {
      job.state = "done";
      job.markdown = res.markdown;
      job.title = res.title;
    } else {
      job.state = "error";
      job.error = res.error || "conversion failed";
    }
  } catch (e) {
    job.state = "error";
    job.error = String(e);
  } finally {
    renderQueue();
    // Refresh the result panel ONLY when the settled job is the one being
    // viewed (identity, not index: after a clear-queue + re-drop the index
    // may belong to a different job entirely). A background job's settle
    // must never touch the viewed panel — showJob resets the pane state
    // (markdown shown, preview hidden, button label), so an unconditional
    // call here would yank the user out of the rendered preview mode on
    // every background settle. The enqueue loop below handles the
    // first-result auto-display case.
    if (queue[activeJob] === job) showJob(activeJob);
  }
}

if (els.keepDataUris) {
  els.keepDataUris.addEventListener("change", () => {
    try {
      localStorage.setItem(KEEP_URIS_KEY, els.keepDataUris.checked ? "1" : "0");
    } catch { /* best effort */ }
    reconvertCurrent();
  });
}

// ---------------------------------------------------------------------------
// Engine: pyodide + markitdown + magika
// ---------------------------------------------------------------------------
const engine = {
  pyodide: null,
  api: null,
  magika: null,
  ready: false,
  _readyPromise: null,

  async boot() {
    if (this._readyPromise) return this._readyPromise;
    const p = this._boot();
    // Never cache a FAILED boot: enqueueFiles() re-triggers boot() on every
    // drop, and a cached rejection would poison every later conversion (a
    // drop while briefly offline → engine dead until page reload). Clear the
    // cache on rejection so the next drop retries from scratch.
    p.catch(() => {
      if (this._readyPromise === p) this._readyPromise = null;
    });
    this._readyPromise = p;
    return p;
  },

  async _boot() {
    setEngineStatus("loading", "⏳ loading engine…");

    // Pyodide loads both wheels and the magika ONNX model; run them in
    // parallel since neither depends on the other.
    const [pyodide, magika] = await Promise.all([
      this._bootPyodide(),
      createMagika(globalThis.ort, new URL("magika/", BASE)).catch((e) => {
        console.warn("magika unavailable, falling back to extension/mime only:", e);
        return null;
      }),
    ]);
    this.pyodide = pyodide;
    this.api = pyodide.globals.get("api");
    this.magika = magika;

    const info = await this.api.initialize();
    if (info && info.markitdown) {
      els.mdVersion.textContent = `v${info.markitdown} · web`;
      els.mdVersion.title = `markitdown ${info.markitdown} on Python ${info.python}`;
    }

    this.ready = true;
    setEngineStatus("ready", "✓ ready — offline capable");
  },

  async _bootPyodide() {
    const { loadPyodide } = await import(new URL("pyodide/pyodide.mjs", BASE).href);

    const pyodide = await loadPyodide({
      indexURL: new URL("pyodide/", BASE).href,
    });

    // Engine packages compiled for wasm (numpy, pandas, lxml, ...) come from
    // the local pyodide distribution; pure-python wheels are vendored.
    await pyodide.loadPackage([
      "numpy", "pandas", "lxml", "requests", "beautifulsoup4",
      "six", "click", "xlrd", "Pillow", "cryptography",
    ]);

    const micropip = pyodide.loadPackage("micropip").then(() =>
      pyodide.pyimport("micropip")
    );

    // Write every vendored wheel into the virtual FS so micropip can install
    // offline via emfs:// URLs (no PyPI round-trips).
    const manifest = await (await fetch(new URL("wheels/wheels.json", BASE))).json();
    const FS = pyodide.FS;
    const mkdir = (p) => { try { FS.mkdir(p); } catch {} };
    mkdir("/wheels");
    for (const name of manifest.wheels) {
      const buf = new Uint8Array(
        await (await fetch(new URL(`wheels/${name}`, BASE))).arrayBuffer()
      );
      FS.writeFile(`/wheels/${name}`, buf);
    }

    const mp = await micropip;
    // deps=False: everything (including transitive deps) is vendored above,
    // so resolution never needs the network.
    //
    // certifi must be reinstalled over the pyodide-bundled copy because
    // markitdown requires a newer version (micropip still runs the
    // "already installed" version check even with deps=False).
    const wheels = manifest.wheels.map((w) => `emfs:/wheels/${w}`);
    const certifi = wheels.filter((w) => /\/certifi-/.test(w));
    const rest = wheels.filter((w) => !/\/certifi-/.test(w));
    if (certifi.length > 0) {
      // reinstall=True is keyword-only; PyProxy.callKwargs maps a plain
      // JS object onto the Python kwargs.
      await mp.install.callKwargs(pyodide.toPy(certifi), {
        deps: false,
        reinstall: true,
      });
    }
    await mp.install.callKwargs(pyodide.toPy(rest), { deps: false });

    // Our glue module: stubs onnxruntime before markitdown is imported.
    const apiSrc = await (await fetch(new URL("python/api.py", BASE))).text();
    FS.mkdir("/app");
    FS.writeFile("/app/api.py", apiSrc);
    pyodide.runPython(
      "import sys; sys.path.insert(0, '/app'); import api; api"
    );
    return pyodide;
  },

  /**
   * Identify (JS-side magika) then convert (Python-side markitdown).
   * Returns {ok, markdown, title} or {ok:false, error}.
   */
  async convertFile(file) {
    await this.boot();
    const bytes = new Uint8Array(await file.arrayBuffer());

    let prediction = null;
    let mimetype = file.type || null;
    let extension = null;
    const dot = file.name.lastIndexOf(".");
    if (dot >= 0 && dot < file.name.length - 1) {
      extension = file.name.slice(dot);
    }

    if (this.magika) {
      try {
        prediction = await this.magika.identify(bytes);
 } catch (e) {
        console.warn("magika identify failed:", e);
      }
      if (prediction && prediction.label !== "unknown") {
        // Trust the content sniff over the (often missing/wrong) MIME type.
        mimetype = prediction.mime_type;
        if (prediction.extensions && prediction.extensions.length > 0) {
          extension = `.${prediction.extensions[0]}`;
        }
      }
    }

    // keep_data_uris is sent ONLY when enabled. The service worker serves
    // cache-first with background revalidation, so right after a weekly
    // deploy a session can briefly run a fresh app.js against the stale
    // cached python/api.py, whose convert() has no keep_data_uris param —
    // sending it unconditionally would TypeError every conversion. Omitting
    // it when false keeps that (and any old-cache) combination working;
    // when true but unsupported, retry once without the kwarg.
    const convertCall = (withKeep) => {
      const kwargs = {
        mimetype,
        extension,
        filename: file.name,
        magika_prediction: prediction,
      };
      if (withKeep) kwargs.keep_data_uris = true;
      return this.api.convert.callKwargs(bytes, kwargs);
    };
    let res;
    if (keepDataUrisEnabled()) {
      try {
        res = await convertCall(true);
      } catch (e) {
        if (/keep_data_uris/.test(String(e))) {
          // Stale api.py without the param: retry as a plain (truncating)
          // conversion rather than erroring the row. The one-shot toggle
          // lands when the SW cache updates and the page reloads.
          console.warn("api.convert does not support keep_data_uris; retrying without it:", e);
          res = await convertCall(false);
        } else {
          throw e;
        }
      }
    } else {
      res = await convertCall(false);
    }
    return res;
  },
};

// ---------------------------------------------------------------------------
// Queue + UI
// ---------------------------------------------------------------------------
const queue = []; // {file, state: queued|busy|done|error, markdown?, error?}
let activeJob = -1;

function renderQueue() {
  els.queue.replaceChildren();
  if (queue.length === 0) {
    els.fileList.hidden = true;
    return;
  }
  els.fileList.hidden = false;
  queue.forEach((job, i) => {
    const li = document.createElement("li");
    li.classList.toggle("active", i === activeJob);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = job.file.name;
    name.title = job.file.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = fmtSize(job.file.size);
    const state = document.createElement("span");
    state.className = "qstate";
    state.dataset.state = job.state;
    state.textContent =
      job.state === "queued" ? "…" :
      job.state === "busy" ? "converting" :
      job.state === "done" ? "✓ done" : "✗ error";
    if (job.state === "done") state.classList.add("done");
    if (job.state === "error") state.classList.add("error");
    li.append(name, size, state);
    li.addEventListener("click", () => showJob(i));
    els.queue.appendChild(li);
  });
}

function showJob(i) {
  const job = queue[i];
  if (!job) return;
  activeJob = i;
  renderQueue();
  els.result.hidden = false;
  els.resultTitle.textContent = job.file.name;
  els.resultTitle.title = job.file.name;

  if (job.state === "error") {
    els.errorBox.hidden = false;
    els.errorBox.textContent = job.error;
    els.markdownOut.textContent = "";
    els.markdownOut.hidden = false;
    els.renderedOut.hidden = true;
    els.toggleRenderBtn.textContent = "Preview";
    // Drop the PREVIOUS file's preview DOM: renderPreview() only ever runs on
    // the success path, so #rendered-out still holds whatever was viewed last.
    // Left in place, one click on the (correctly labelled) "Preview" button
    // would reveal another document's rendered output under this file's title
    // and error box — wrong content attributed to the wrong file. Disable the
    // toggle too: there is nothing to preview, and a disabled button beats an
    // empty pane. The success path re-enables it.
    els.renderedOut.replaceChildren();
    els.toggleRenderBtn.disabled = true;
    return;
  }
  els.errorBox.hidden = true;
  els.toggleRenderBtn.disabled = false;
  const md = job.markdown ?? "";
  els.markdownOut.textContent = md;
  renderPreview(md);
  // Preserve the user's raw/preview choice across viewed-job refreshes
  // (flip-triggered reconvert settles) AND row switches: the button label
  // encodes the current mode ("Preview" = showing raw, "Raw markdown" =
  // showing the rendered preview) and is only ever rewritten by the toggle
  // click handler, so deriving the pane state from it keeps the chosen
  // mode until the user explicitly toggles. Error rows always show the raw
  // pane (above) since there is nothing to preview.
  if (els.toggleRenderBtn.textContent === "Raw markdown") {
    els.markdownOut.hidden = true;
    els.renderedOut.hidden = false;
  } else {
    els.markdownOut.hidden = false;
    els.renderedOut.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Minimal markdown preview
// ---------------------------------------------------------------------------
// The authoritative output is the raw markdown pane; the preview exists so
// tables, headings, lists and embedded images are actually visible.
//
// Two rules shaped this implementation:
//
//   * Real DOM only — no innerHTML, no markup strings. The previous version
//     pushed HTML STRINGS into an `out` array that the append loop turned into
//     text nodes, so the table branch (the only one pushing an element) was
//     the only thing that rendered: headings, bold, inline code and fences all
//     reached the user as literal "<h1>Images</h1>" / "**Title:**" text, and
//     there was no image branch at all. Converted documents are untrusted
//     input, so keeping every piece of them in text nodes also removes the
//     injection surface outright.
//   * Fail soft. A construct not modelled here falls through to paragraph
//     text; nothing on this path may throw and blank the pane.

// markdownify truncates an embedded image to "<mime prefix>;base64..." in the
// default mode (see README → "keep data URIs"). No payload is left to decode,
// so render a labelled placeholder rather than a broken-image icon.
const TRUNCATED_URI_RE = /^data:image\/[\w.+-]+;base64(?:\.\.\.|…)$/i;
// Raster data URIs, absolute http(s), root-relative paths and explicit ./ ../
// paths. Excludes javascript:, data:text/html, data:image/svg+xml (all
// scriptable). The "\\/" guards reject BOTH "//host" and "/\host": the URL
// parser treats a leading backslash as a slash, so "/\evil.com/x.png" would
// otherwise resolve cross-origin and let a converted document beacon to an
// arbitrary host from this offline-first PWA. Bare relative names
// ("page2.html") are deliberately refused — they would resolve against the
// app's own URL, not the source document's. So are fragments ("#section"):
// the preview gives headings no ids, so a fragment can never resolve, and
// with target="_blank" it opened a pointless second copy of the app.
const SAFE_URL_RE =
  /^(?:data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,|https?:\/\/|\/(?!\/|\\)|\.{1,2}\/)/i;

// A label/destination longer than this is not a real link — bound every scan so
// hostile input can't make inline parsing quadratic (see inlineMd).
const MAX_LABEL = 1000;
// Nesting cap for recursing into a link label (which may itself hold an image).
const MAX_INLINE_DEPTH = 8;
// Placeholder labels go into textContent and a title attribute, so they must be
// short: see describeSrc for why a raw data URI can't be one.
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

// CJK ranges: a soft line break between two CJK characters is hard-wrapped
// prose, not a word boundary, so it joins with nothing instead of a space.
// markitdown's PDF output (which prompted this) is exactly that case.
//
// Spelled with \u escapes, not literal characters, and with the `u` flag.
// Both halves of that matter. Without `u` the pattern is UTF-16-unit based, so
// an astral character can match through a single surrogate half. And literal
// characters are un-auditable: the first version's third range began at U+8C48
// instead of U+F900 — those two 豈 are compatibility duplicates with identical
// glyphs, so the typo was invisible in the source — which swept the surrogate
// block D800-DFFF and made EVERY emoji lose its word space at a line break.
//   1100-11FF    Hangul Jamo
//   2E80-A4CF    CJK radicals, Kangxi, CJK punctuation, kana, Bopomofo,
//                enclosed CJK, ext A, unified ideographs, Yi
//   AC00-D7AF    Hangul syllables (+ jamo ext), stopping before the surrogates
//   F900-FAFF    CJK compatibility ideographs
//   FE10-FE6F    vertical forms, CJK compatibility forms, small form variants
//   FF00-FFEF    full-width AND half-width forms
//   20000-2FA1F  astral CJK ext B-F + compatibility supplement
// Astral EMOJI is deliberately outside all of them.
const CJK_RE =
  /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE10-\uFE6F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

function imgPlaceholder(label, why, detail) {
  const span = document.createElement("span");
  span.className = "img-placeholder";
  span.textContent = `${clip(label, 80) || "image"} — ${why}`;
  if (detail) span.title = detail;
  return span;
}

// markdownify emits `![](data:image/png;base64,…)` with an EMPTY alt whenever
// the source <img> had none, so a placeholder label must never fall back to
// the src: in keep-data-URIs mode that src is a multi-megabyte base64 payload,
// and putting it in textContent/title produced a 16-million-pixel-wide row.
function describeSrc(src) {
  return /^data:/i.test(src)
    ? `${src.slice(0, 24)}… (${src.length.toLocaleString()} chars of image data)`
    : clip(src, 200);
}

// --- linear inline scanner -------------------------------------------------
// A single forward scan, never a backtracking regex over the whole line. The
// previous `INLINE_RE` had three alternatives able to consume the same
// character inside a link destination, which is catastrophic backtracking:
// markitdown's PlainTextConverter passes .txt/.md/.json through VERBATIM, so
// one unclosed "[" in a 400 KB log line froze the tab for 56 s (measured) —
// synchronously, on the main thread, with no way to click away.
//
// Every scan below is O(distance to its delimiter), and a FAILED scan returns
// how far it looked so the caller stops retrying at every position inside that
// span. One skip cursor is kept PER TOKEN KIND, because "this ** never closes"
// says nothing about whether a later [link] can match — a single shared cursor
// would drop real tokens after the first failure. Each cursor is monotonic, so
// each kind costs O(line) and the whole pass is O(3 × line): the guarantee the
// old backtracking regex did not have. Recursion into a label or bold span is
// bounded by MAX_INLINE_DEPTH over strictly shorter substrings.

function tokenAt(text, i, depth) {
  const c = text[i];
  // `code` — a backtick run is closed by a run of the SAME length (CommonMark,
  // and markdownify relies on it: it pads with `` when content has a backtick).
  if (c === "`") {
    let run = 0;
    while (text[i + run] === "`") run++;
    let j = i + run;
    while (j < text.length) {
      if (text[j] === "`") {
        let k = j;
        while (text[k] === "`") k++;
        if (k - j === run) {
          const code = document.createElement("code");
          // NO unescaping inside a code span: backslash escapes are literal
          // there, which is the whole point of a code span.
          code.textContent = text.slice(i + run, j);
          return { node: code, end: k, examined: k };
        }
        j = k;
        continue;
      }
      j++;
    }
    return { node: null, examined: text.length };
  }
  // ***bold emphasis*** — markdownify nests <b><i>…</i></b> (and <strong><em>)
  // into exactly this run of three. Handled before `**` so the outer asterisk
  // isn't consumed as a bold opener, which would leave a literal `*` inside the
  // <strong>.
  if (c === "*" && text[i + 1] === "*" && text[i + 2] === "*" && text[i + 3] !== "*") {
    let j = i + 3;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "*" && text[j + 1] === "*" && text[j + 2] === "*" && text[j + 3] !== "*") {
        const em = document.createElement("em");
        const b = document.createElement("strong");
        b.appendChild(inlineMd(text.slice(i + 3, j), depth + 1));
        em.appendChild(b);
        return { node: em, end: j + 3, examined: j + 3 };
      }
      j++;
    }
    return { node: null, examined: text.length };
  }
  // **bold**. Inner characters may be backslash-escaped — markdownify escapes
  // asterisks by default, so `**Price \* Qty**` is real bold, not literal.
  if (c === "*" && text[i + 1] === "*") {
    let j = i + 2;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "*" && text[j + 1] === "*") {
        const b = document.createElement("strong");
        b.appendChild(inlineMd(text.slice(i + 2, j), depth + 1));
        return { node: b, end: j + 2, examined: j + 2 };
      }
      j++;
    }
    return { node: null, examined: text.length };
  }
  // *emphasis* — markdownify's default emphasis_style is `*`, so <em>/<i>
  // arrive this way. CommonMark's flanking rule is what keeps this honest on
  // VERBATIM text (PlainTextConverter passes .txt/.md through untouched):
  // in "2 * 3 and 4 * 5" the opener is followed by whitespace and the closer
  // preceded by it, so both asterisks stay literal.
  if (c === "*" && !/\s/.test(text[i + 1] ?? "")) {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "*") {
        // Skip whole delimiter runs: the `**` inside `*a **b** c*` is bold, not
        // an emphasis closer, so only a run of exactly ONE asterisk can close.
        let r = 0;
        while (text[j + r] === "*") r++;
        if (r === 1 && j > i + 1 && !/\s/.test(text[j - 1])) {
          const em = document.createElement("em");
          em.appendChild(inlineMd(text.slice(i + 1, j), depth + 1));
          return { node: em, end: j + 1, examined: j + 1 };
        }
        j += r;
        continue;
      }
      j++;
    }
    return { node: null, examined: text.length };
  }
  // _emphasis_. Same shape, plus CommonMark's INTRAWORD rule, which is what
  // makes this safe on verbatim text: an underscore flanked by alphanumerics is
  // part of an identifier, so snake_case_name stays literal while _here_ is
  // emphasis. markdownify never emits `_` for emphasis itself (it uses `*`) and
  // escapes literal underscores to `\_`, so this only ever fires on user-written
  // .md — which is exactly where `_here_` is common.
  const ALNUM = /[0-9A-Za-z]/;
  if (c === "_" && !ALNUM.test(text[i - 1] ?? "") && !/[\s_]/.test(text[i + 1] ?? "")) {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "_") {
        let r = 0;
        while (text[j + r] === "_") r++;
        if (r === 1 && j > i + 1 && !/\s/.test(text[j - 1]) && !ALNUM.test(text[j + 1] ?? "")) {
          const em = document.createElement("em");
          em.appendChild(inlineMd(text.slice(i + 1, j), depth + 1));
          return { node: em, end: j + 1, examined: j + 1 };
        }
        j += r;
        continue;
      }
      j++;
    }
    return { node: null, examined: text.length };
  }
  // ![alt](src "title") or [label](url "title")
  if (c === "[" || (c === "!" && text[i + 1] === "[")) {
    const bang = c === "!";
    const open = bang ? i + 1 : i;
    const labelEnd = findLabelEnd(text, open);
    if (labelEnd < 0) {
      // No "]" within MAX_LABEL of the opener — bound the charge accordingly.
      return { node: null, examined: Math.min(text.length, open + MAX_LABEL) };
    }
    if (text[labelEnd + 1] !== "(") {
      return { node: null, examined: labelEnd + 2 };
    }
    const destEnd = findDestEnd(text, labelEnd + 2);
    if (destEnd < 0) return { node: null, examined: text.length };
    const raw = text.slice(labelEnd + 2, destEnd);
    const label = text.slice(open + 1, labelEnd);
    const { url, title } = splitTitle(raw);
    const end = destEnd + 1;
    const node = bang
      ? imageNode(label, url, title)
      : linkNode(label, url, title, depth);
    return { node, end, examined: end };
  }
  return { node: null, examined: i + 1 };
}

// "]" matching the "[" at i, honouring backslash escapes and ONE level of
// bracket nesting (so `[![alt](img)](url)` yields the whole image as the
// label), capped at MAX_LABEL from the opener.
function findLabelEnd(text, i) {
  const cap = Math.min(text.length, i + MAX_LABEL);
  let j = i + 1, d = 0;
  while (j < cap) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "[") d++;
    else if (c === "]") { if (d === 0) return j; d--; }
    j++;
  }
  return -1;
}

// Index of the ")" closing the destination that starts at i, allowing ONE level
// of nesting (`Foo_(bar)`) and a quoted title. Whitespace is legal inside a
// destination — markdownify writes `<img src="my photo.png">` out verbatim as
// `![p](my photo.png)`, which the old `\s`-excluding pattern refused to parse.
function findDestEnd(text, i) {
  let j = i, depth = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === '"') {
      let k = j + 1;
      while (k < text.length && !(text[k] === '"' && text[k - 1] !== "\\")) k++;
      if (k >= text.length) return -1;
      j = k + 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) return j; depth--; }
    j++;
  }
  return -1;
}

// Split a destination into url + optional quoted title. markdownify escapes
// quotes inside titles as \" (so `title='He said "hi"'` round-trips), which the
// old `"([^"]*)"` group could not span — the whole token degraded to text.
const TITLE_RE = /^([\s\S]*?)[ \t]+"((?:[^"\\]|\\.)*)"[ \t]*$/;
function splitTitle(raw) {
  const t = raw.match(TITLE_RE);
  if (t) return { url: t[1].trim(), title: t[2].replace(/\\"/g, '"') };
  return { url: raw.trim(), title: "" };
}

function imageNode(alt, src, title) {
  if (TRUNCATED_URI_RE.test(src)) {
    return imgPlaceholder(alt, "image data truncated",
      "This conversion truncated the embedded image. Enable “keep data URIs” to retain the full base64 payload.");
  }
  if (!SAFE_URL_RE.test(src)) {
    return imgPlaceholder(alt, "image source not renderable", describeSrc(src));
  }
  const img = document.createElement("img");
  // Listener BEFORE src: assigning src starts the fetch, and although the spec
  // queues the load/error task rather than firing it inline, attaching first
  // makes the ordering independent of that detail.
  //
  // A remote URL with the network off (this is an offline-first PWA) lands
  // here, as does any src the browser refuses. Swap in the same placeholder
  // instead of leaving a broken-image icon. { once: true } so the replacement
  // node can never re-enter this handler. The parentNode guard does NOT stop a
  // listener from a superseded render: replaceChildren() detaches only the
  // top-level children, so an old <img> keeps its old <p> as parentNode. The
  // mutation then lands in the orphaned subtree and is invisible — correct, but
  // by accident, so it is asserted in tests rather than relied on here.
  img.addEventListener("error", () => {
    if (!img.parentNode) return;
    img.replaceWith(imgPlaceholder(alt || "image", "image not available in the preview",
      describeSrc(src)));
  }, { once: true });
  img.src = src;
  if (alt) img.alt = unesc(alt);
  if (title) img.title = title;
  img.loading = "lazy";
  img.decoding = "async";
  return img;
}

function linkNode(label, url, title, depth) {
  if (TRUNCATED_URI_RE.test(url) || !SAFE_URL_RE.test(url)) {
    // Unrenderable target: keep the readable text, drop the markup noise.
    return inlineMd(label || url, depth + 1);
  }
  const a = document.createElement("a");
  a.href = url;
  if (title) a.title = title;
  // Recurse into the label, not textContent: markdownify emits
  // `[**bold link**](url)` for <a><b>…</b></a> and, for <a><img></a> and its
  // own convert_video, `[![alt](poster)](url)` — a LINK CONTAINING AN IMAGE.
  // Flattening either to text leaked literal asterisks, and for the nested
  // image it parsed the whole shape as an image whose src was the poster, so
  // the anchor pointed at the wrong URL entirely.
  a.appendChild(inlineMd(label || url, depth + 1));
  // New tab on purpose: navigating this frame would discard the in-memory
  // conversion queue.
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// Render one span's inline markdown (images, links, **bold**, `code`) into a
// DocumentFragment. Anything unrecognised stays a text node.
function inlineMd(text, depth = 0) {
  const frag = document.createDocumentFragment();
  if (!text) return frag;
  // A label recursion is bounded by MAX_INLINE_DEPTH so a pathological
  // `[a](b)`-in-`[a](b)` nest cannot build an arbitrarily deep tree.
  if (depth >= MAX_INLINE_DEPTH) {
    frag.appendChild(document.createTextNode(unesc(text)));
    return frag;
  }
  let i = 0;          // scan position
  let start = 0;      // first index of pending literal text
  // One skip cursor PER KIND: a failed "**" scan proves nothing about a later
  // "[link]", so skipping every kind after any failure would drop real tokens.
  // Each cursor is monotonic, so each kind costs O(line) at most.
  const skip = { code: 0, star: 0, under: 0, link: 0 };
  const kindAt = (j) => {
    const c = text[j];
    if (c === "`") return "code";
    if (c === "*") return "star";
    if (c === "_") return "under";
    if (c === "[" || (c === "!" && text[j + 1] === "[")) return "link";
    return null;
  };
  const flush = (end) => {
    if (end > start) frag.appendChild(document.createTextNode(unesc(text.slice(start, end))));
  };
  while (i < text.length) {
    const kind = kindAt(i);
    if (kind && i >= skip[kind]) {
      const tok = tokenAt(text, i, depth);
      if (tok.node) {
        flush(i);
        frag.appendChild(tok.node);
        i = tok.end;
        start = i;
        continue;
      }
      if (tok.examined > skip[kind]) skip[kind] = tok.examined;
    }
    i++;
  }
  flush(text.length);
  return frag;
}

// Undo markdownify's backslash escapes (asterisks, underscores, pipes, …).
// Only punctuation is unescaped, so a Windows path like C:\temp survives.
const UNESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|~>])/g;
const unesc = (s) => s.replace(UNESCAPE_RE, "$1");

// Split on newlines, tolerating CRLF and lone CR from converted documents.
const lines = (md) => (md ?? "").split(/\r\n?|\n/);

// First/last CODE POINT of a string. addText uses these to decide whether a
// soft line break needs a space, and a UTF-16 half of an astral character is
// not a character — slicing one would make CJK_RE test a lone surrogate.
const firstCP = (s) => (!s ? "" : s.slice(0, /^[\uD800-\uDBFF]/.test(s) ? 2 : 1));
const lastCP = (s) => (!s ? "" : s.slice(/[\uDC00-\uDFFF]$/.test(s) ? -2 : -1));

function renderPreview(md) {
  const root = els.renderedOut;
  root.replaceChildren();

  let para = null;      // open <p> collecting soft-wrapped lines
  let paraTail = "";    // its last visible code point
  let list = null;      // open <ul>/<ol>
  let listKind = null;
  let lastLi = null;    // its last item, for indented continuation lines
  let liTail = "";      // last visible code point in that item
  let liHard = false;   // whether it ended with a two-space hard break
  let quote = null;     // open <blockquote>
  let quoteTail = "";
  let tableBuf = [];
  let inCode = false;
  let codeBuf = [];
  let codeFence = "";   // which fence opened the block, so ``` and ~~~ pair up

  const endPara = () => { para = null; paraTail = ""; };
  const endList = () => { list = null; listKind = null; lastLi = null; liTail = ""; liHard = false; };
  const endQuote = () => { quote = null; quoteTail = ""; };
  const endCode = () => {
    if (!inCode) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeBuf.join("\n");
    pre.appendChild(code);
    root.appendChild(pre);
    inCode = false;
    codeBuf = [];
    codeFence = "";
  };
  // markitdown's CSV converter escapes a pipe inside a cell as "\|" (see
  // _csv_converter._escape_table_cell), so a naive split("|") would slice
  // "x|y" into two cells and shift every following column right. Split on
  // UNESCAPED pipes only, then unescape inside the cell.
  const splitRow = (row) => {
    const cells = [];
    let cur = "", j = 0;
    const s = row.trim().replace(/^\|/, "").replace(/\|\s*$/, "");
    while (j < s.length) {
      if (s[j] === "\\" && j + 1 < s.length) { cur += s[j] + s[j + 1]; j += 2; continue; }
      if (s[j] === "|") { cells.push(cur.trim()); cur = ""; j++; continue; }
      cur += s[j];
      j++;
    }
    cells.push(cur.trim());
    return cells.map(unesc);
  };
  const endTable = () => {
    if (tableBuf.length === 0) return;
    // Row 2 is the |---|---| separator: drop it, keep head + body.
    const rows = tableBuf
      .map(splitRow)
      .filter((cells, i) => i !== 1 || !cells.every((c) => /^:?-{1,}:?$/.test(c)));
    const t = document.createElement("table");
    const [head, ...body] = rows;
    if (head) {
      const thead = t.createTHead();
      const hrow = thead.insertRow();
      for (const c of head) {
        const th = document.createElement("th");
        th.appendChild(inlineMd(c));
        hrow.appendChild(th);
      }
    }
    if (body.length > 0) {
      const tbody = t.createTBody();
      for (const r of body) {
        const row = tbody.insertRow();
        for (const c of r) {
          const td = row.insertCell();
          td.appendChild(inlineMd(c));
        }
      }
    }
    root.appendChild(t);
    tableBuf = [];
  };
  // Close every open block that a differently-typed line terminates.
  const endBlocks = () => { endPara(); endList(); endQuote(); endTable(); };

  const addText = (line) => {
    if (!para) {
      para = document.createElement("p");
      root.appendChild(para);
      paraTail = "";
    } else if (!(CJK_RE.test(paraTail) && CJK_RE.test(firstCP(line)))) {
      para.appendChild(document.createTextNode(" "));
    }
    para.appendChild(inlineMd(line));
    paraTail = lastCP(line);
  };

  for (const line of lines(md)) {
    // A fence closes any other open block; the MATCHING fence closes the code
    // block. (The old version pushed the unbalanced strings "<pre><code>" and
    // "</code></pre>" as two separate text nodes.) Pairing on the same
    // character matters: markdownify emits ~~~ for HTML <pre> content, and a
    // ``` line inside it is CONTENT, not a closer — so it must be pushed to
    // codeBuf rather than swallowed (an earlier draft did `continue` here and
    // silently dropped the line).
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (inCode) {
        if (fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length) {
          endCode();
        } else {
          codeBuf.push(line);
        }
      } else {
        endBlocks();
        inCode = true;
        codeBuf = [];
        codeFence = fence[1];
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      endPara(); endList(); endQuote();
      tableBuf.push(line);
      continue;
    }
    endTable();

    if (line.trim() === "") { endBlocks(); continue; }

    let m;
    // An indented line while a list item is open is that item's continuation,
    // NOT a new block. markdownify emits exactly this for <li>Line<br/>Line2</li>
    // ("* Line one  \n  Line two") and for <li><p>..</p><p>..</p></li>; without
    // it the list was split in two with an orphan <p> between.
    if (lastLi && /^\s{2,}\S/.test(line)) {
      const cont = line.trim();
      // Join with a <br> when the previous item line asked for a hard break
      // (markdownify's two trailing spaces) or when both edges are CJK, since
      // hard-wrapped CJK prose has no word boundary to put a space at.
      if (liHard || (CJK_RE.test(liTail) && CJK_RE.test(firstCP(cont)))) {
        lastLi.appendChild(document.createElement("br"));
      } else {
        lastLi.appendChild(document.createTextNode(" "));
      }
      lastLi.appendChild(inlineMd(/^>\s?/.test(cont) ? cont.replace(/^>\s?/, "") : cont));
      liTail = lastCP(cont);
      liHard = /\s\s$/.test(cont);
      continue;
    }
    // A thematic break needs THREE-OR-MORE of the SAME character, optionally
    // spaced. The old mixed-character pattern ate real list items: markdownify
    // turns <ul><li>item</li><li>--</li><li>item2</li></ul> into "* item\n
    // * --\n* item2", and "* --" is a 3-char run of dashes and spaces — it
    // rendered as an <hr> and split the list in two.
    if (/^\s*(?:([-*_])(?:\s*\1){2,})\s*$/.test(line)) {
      endBlocks();
      root.appendChild(document.createElement("hr"));
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      endBlocks();
      const h = document.createElement(`h${m[1].length}`);
      h.appendChild(inlineMd(m[2].replace(/\s+#+\s*$/, "")));
      root.appendChild(h);
    } else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      endPara(); endQuote();
      const kind = /^\d/.test(m[2]) ? "ol" : "ul";
      if (!list || listKind !== kind) {
        endList();
        list = document.createElement(kind);
        listKind = kind;
        root.appendChild(list);
        // <ol start="7"> → "7. seven" in markdownify; honour the first number,
        // else every numbered list visibly restarts at 1. m[2] keeps the
        // punctuation ("5." / "5)"), so match the digits out of it.
        if (kind === "ol") {
          const n = parseInt(m[2], 10);
          if (n > 1) list.start = n;
        }
      }
      const li = document.createElement("li");
      // A trailing two-space hard break inside the item's own text tells a
      // following indented continuation to use <br> rather than a space.
      const body = m[3];
      liHard = /\s\s$/.test(body);
      li.appendChild(inlineMd(body.replace(/\s+$/, "")));
      liTail = lastCP(body);
      list.appendChild(li);
      lastLi = li;
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      endPara(); endList();
      if (!quote) {
        quote = document.createElement("blockquote");
        root.appendChild(quote);
        quoteTail = "";
      } else if (!(CJK_RE.test(quoteTail) && CJK_RE.test(firstCP(m[1])))) {
        quote.appendChild(document.createTextNode(" "));
      }
      quote.appendChild(inlineMd(m[1]));
      quoteTail = lastCP(m[1]);
    } else {
      endList(); endQuote();
      addText(line);
    }
  }
  endCode();
  endTable();
}

// Exported for tests/e2e-test.mjs, which drives the REAL renderer over
// synthetic markdown to cover block types the converted fixtures never
// produce (lists, links, code fences, blockquotes, h2–h6). app.js is loaded as
// a module script, so exporting costs nothing at runtime and keeps the tests
// pointed at production code rather than a copy of it.
export { renderPreview };

async function enqueueFiles(fileList) {
  const files = Array.from(fileList).filter(Boolean);
  if (files.length === 0) return;
  const jobs = files.map((f) => ({ file: f, state: "queued" }));
  for (const j of jobs) queue.push(j);
  renderQueue();

  // Kick the engine download in the background as soon as files arrive so
  // the network wait overlaps with the user picking files.
  engine.boot().catch((e) => {
    setEngineStatus("loading", "✗ engine failed");
    console.error(e);
    toast("engine failed to load: " + e.message, true);
  });

  // Iterate THIS BATCH's job objects (identity), never queue indices: after
  // a clear-queue + re-drop while this loop was parked on an in-flight
  // conversion, index-based iteration would walk the NEW queue's rows —
  // converting them out of order alongside the new batch's own loop and
  // auto-displaying the wrong "first" result. A job no longer in the queue
  // was cleared away: skip it; its detached pass (if any) settles harmlessly
  // (reconvertJob's identity-keyed finally and the indexOf guard below both
  // ignore cleared jobs).
  for (const job of jobs) {
    // A keep-data-URIs flip may have taken over a QUEUED job out of order
    // (reconvertJob runs immediately on queued jobs) and finished it while
    // earlier jobs were still converting. Never convert the same job twice:
    // skip anything that already settled. (A job still "busy" here can only
    // be one such takeover still in flight — likewise skip it.)
    if (job.state !== "queued") continue;
    if (!queue.includes(job)) continue; // cleared away mid-flight
    await reconvertJob(job);
    // Auto-display the first result only while nothing has been selected
    // (the first showJob sets activeJob, so later settles never yank). Use
    // the job's CURRENT index, never one captured before the long awaits:
    // indexOf() is -1 for a cleared-away job → no-op, so a detached settle
    // can never reveal the panel on a still-busy row's empty markdown.
    // Refresh of the VIEWED job on settle is reconvertJob's finally guard.
    if (activeJob === -1) {
      const idx = queue.indexOf(job);
      if (idx !== -1) showJob(idx);
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring: dropzone, picker, paste, buttons
// ---------------------------------------------------------------------------
els.dropzone.addEventListener("click", (e) => {
  if (e.target.tagName !== "LABEL") els.fileInput.click();
});
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener("change", () => {
  enqueueFiles(els.fileInput.files);
  els.fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [];
  if (e.dataTransfer.items) {
    for (const item of e.dataTransfer.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length === 0 && e.dataTransfer.files) files.push(...e.dataTransfer.files);
  enqueueFiles(files);
});

// Paste support (only when clipboard holds files).
window.addEventListener("paste", (e) => {
  const files = [];
  if (e.clipboardData?.items) {
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    enqueueFiles(files);
  }
});
if (!("onpaste" in window) || !navigator.clipboard) {
  els.pasteHint.hidden = true;
}

els.clearQueue.addEventListener("click", () => {
  queue.length = 0;
  activeJob = -1;
  renderQueue();
  els.result.hidden = true;
});

els.copyBtn.addEventListener("click", async () => {
  const job = queue[activeJob];
  if (!job?.markdown) return;
  try {
    await navigator.clipboard.writeText(job.markdown);
    toast("Markdown copied");
  } catch {
    toast("copy failed", true);
  }
});

els.downloadBtn.addEventListener("click", () => {
  const job = queue[activeJob];
  if (!job?.markdown) return;
  const base = job.file.name.replace(/\.[^.]+$/, "") || "document";
  const blob = new Blob([job.markdown], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${base}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

els.toggleRenderBtn.addEventListener("click", () => {
  const showingMd = !els.markdownOut.hidden;
  els.markdownOut.hidden = showingMd;
  els.renderedOut.hidden = !showingMd;
  // Label names what the click switches TO next, i.e. the OPPOSITE of the
  // pane now shown — and showJob() re-derives the pane from this label, so
  // getting it backwards makes every viewed-job refresh snap back to raw
  // markdown (the preview-yank regression the race probe asserts against).
  els.toggleRenderBtn.textContent = showingMd ? "Raw markdown" : "Preview";
});

// ---------------------------------------------------------------------------
// PWA: service worker + File Handling (launchQueue)
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("sw.js", BASE), { scope: "./" })
      .catch((e) => console.warn("service worker registration failed:", e));
  });
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  els.offlineStatus.dataset.state = online ? "online" : "offline";
  els.offlineStatus.textContent = online ? "online" : "offline";
}
window.addEventListener("online", updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);
updateOnlineStatus();

// File Handling API: OS "Open with…" / double-click launches us with files.
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || launchParams.files.length === 0) return;
    const files = [];
    for (const handle of launchParams.files) {
      try {
        const file = await handle.getFile();
        // Enrich: keep the full path-derived name when available
        file.displayName = handle.name || file.name;
        files.push(file);
      } catch (e) {
        console.warn("failed to read launched file:", e);
      }
    }
    if (files.length > 0) enqueueFiles(files);
  });
}

// ---------------------------------------------------------------------------
// Deferred engine warm-up: start loading once the page is idle so the first
// drop feels instant, but don't compete with first paint.
// ---------------------------------------------------------------------------
const warmUp = () =>
  engine.boot().catch((e) => {
    // Surface boot failures on the page; enqueueFiles() re-triggers boot
    // and shows a toast, so only log here.
    console.error("engine boot failed:", e);
 setEngineStatus("loading", "✗ engine failed");
 engine._readyPromise = null; // allow retry on next file drop
  });
if ("requestIdleCallback" in window) {
  requestIdleCallback(warmUp, { timeout: 4000 });
} else {
  setTimeout(warmUp, 2500);
}
