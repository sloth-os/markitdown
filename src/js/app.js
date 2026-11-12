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
    this._readyPromise = this._boot();
    return this._readyPromise;
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

    return await this.api.convert.callKwargs(bytes, {
      mimetype,
      extension,
      filename: file.name,
      magika_prediction: prediction,
    });
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
    return;
  }
  els.errorBox.hidden = true;
  const md = job.markdown ?? "";
  els.markdownOut.textContent = md;
  els.markdownOut.hidden = false;
  els.renderedOut.hidden = true;
  els.toggleRenderBtn.textContent = "Preview";
  renderPreview(md);
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
  const firstNew = queue.length;
  for (const f of files) queue.push({ file: f, state: "queued" });
  renderQueue();

  // Kick the engine download in the background as soon as files arrive so
  // the network wait overlaps with the user picking files.
  engine.boot().catch((e) => {
    setEngineStatus("loading", "✗ engine failed");
    console.error(e);
    toast("engine failed to load: " + e.message, true);
  });

  for (let i = firstNew; i < queue.length; i++) {
    const job = queue[i];
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
    }
    renderQueue();
    if (activeJob === -1) showJob(firstNew);
    else if (activeJob === i) showJob(i);
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
  els.toggleRenderBtn.textContent = showingMd ? "Preview" : "Raw markdown";
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
