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

function renderPreview(md) {
  // Very small, dependency-free markdown preview for tables/headings/code.
  // Deliberately minimal: the authoritative output is the raw markdown.
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.split("\n");
  const out = [];
  let inCode = false, tableBuf = [];
  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const rows = tableBuf.map((r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const [head, , ...body] = rows;
    const t = document.createElement("table");
    const thead = t.createTHead();
    const hrow = thead.insertRow();
    head.forEach((c) => { const th = document.createElement("th"); th.innerHTML = esc(c); hrow.appendChild(th); });
    const tbody = t.createTBody();
    body.forEach((r) => {
      const row = tbody.insertRow();
      r.forEach((c) => { const td = row.insertCell(); td.innerHTML = esc(c); });
    });
    out.push(t);
    tableBuf = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushTable();
      inCode = !inCode;
      out.push(inCode ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (inCode) { out.push(esc(line)); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { tableBuf.push(line); continue; }
    flushTable();
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      out.push(`<h${m[1].length}>${esc(m[2])}</h${m[1].length}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      out.push(`<li>${esc(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
    } else if (line.trim() === "") {
      out.push("");
    } else {
      out.push(esc(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>"));
    }
  }
  flushTable();
  els.renderedOut.replaceChildren();
  for (const item of out) {
    if (typeof item === "string") {
      els.renderedOut.appendChild(document.createTextNode(item + "\n"));
    } else {
      els.renderedOut.appendChild(item);
    }
  }
}

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
