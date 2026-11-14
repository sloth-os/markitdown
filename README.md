# markitdown-web

> **[MarkItDown Web]** — convert documents to Markdown entirely in your
> browser, with no server. A weekly GitHub Actions workflow builds the
> [microsoft/markitdown](https://github.com/microsoft/markitdown) Python
> package to WebAssembly (via [Pyodide]) and publishes it as an offline-capable
> PWA to GitHub Pages.

**Live site:** <https://sloth-os.github.io/markitdown/>

## What it does

- Converts **PDF, DOCX, PPTX, XLSX, XLS, HTML, CSV, JSON, EPUB, IPYNB, ZIP,
  Outlook MSG, RSS** and plain text to Markdown — the same output as the
  markitdown CLI, because it *is* markitdown running under Pyodide.
- **Works offline.** The service worker precaches the entire engine
  (~54 MB: Pyodide + wheels + onnxruntime-web + the magika model). After the
  first load the app runs with the network fully disconnected.
- **PWA File Handling.** The manifest registers the app as an OS handler for
  document types, so you can "Open with → MarkItDown Web" from the file
  manager (Chrome/Edge on desktop, "Open in app" on Android) and the file
  arrives through the File Handling API (`launchQueue`).
- Files **never leave the device** — conversion happens 100 % client-side.
- **"keep data URIs" toggle.** By default markitdown truncates embedded
  images to keep the markdown readable — DOCX/EPUB/HTML show a truncated
  placeholder (`data:image/png;base64…` → `data:image/png;base64...`), while
  PPTX substitutes the image's filename (`![image.png](Picture2.jpg)`).
  Enable the toggle in the result view to retain the raw base64 image data
  for all formats, matching the CLI's `--keep-data-uris`. Applies to
  DOCX/EPUB/HTML (markdownify) and PPTX (direct emission), and re-converts
  the file you're viewing when flipped. The choice is remembered per browser.
- **Markdown preview pane.** The result view toggles between the raw markdown
  (authoritative — byte-for-byte what markitdown emitted) and a rendered
  preview: headings, paragraphs, bold, emphasis, inline code, fenced code,
  ordered and unordered lists, blockquotes, horizontal rules, tables, links and
  embedded images. An image whose payload survived the conversion renders inline in
  keep-data-URIs mode; where it did not — truncated placeholder, PPTX filename
  substitution, or a remote URL that can't be reached while offline — the
  preview shows a labelled stand-in instead of a broken-image icon. Nothing on
  this path parses HTML: converted documents are untrusted input, so every
  fragment of them lands in a text node, never in the DOM as markup.
  The preview is deliberately minimal — a construct it doesn't model (a nested
  list, `~~strikethrough~~`, a setext heading) degrades to plain text rather
  than being dropped or guessed at, and the raw pane always has the exact bytes
  markitdown emitted.
- Updated **weekly** from upstream `microsoft/markitdown@main`, so new
  converters and fixes roll out automatically.

## Supported inputs

Anything markitdown supports that can run in the browser sandbox:
`.pdf .docx .pptx .xlsx .xls .html .htm .csv .tsv .json .xml .md .txt .log
.ipynb .epub .zip .msg .rss .atom` and more. Audio transcription, image
captioning (both need external services) and exiftool metadata are out of
scope for the offline build.

## How it works

```
┌─────────────────────────── browser ────────────────────────────┐
│                                                                │
│  JS side (app.js / magika.js)        Python side (Pyodide)     │
│  ───────────────────────────         ────────────────────      │
│  file → magika feature extract ┌──▶ api.py                    │
│       → ONNX inference         │    (onnxruntime stubbed out)  │
│       (onnxruntime-web) ────────┘ markitdown.convert_stream │
│  prediction {mime, ext, label} ▲                         │
│  ────────────────────────────────────┘                         │
│                                                                │
│  service worker precaches the whole engine → offline mode      │
└────────────────────────────────────────────────────────────────┘
```

- **Pyodide 0.29.5** (Python 3.13) provides the interpreter plus wasm builds
  of numpy, pandas, lxml, Pillow, cryptography, requests, …
- Pure-python wheels (markitdown, python-pptx, mammoth, openpyxl,
  pdfminer.six, pdfplumber, markdownify, magika, …) are **vendored** into
  `site/wheels/` and installed at runtime with `micropip` from the virtual
  filesystem — no PyPI access needed at runtime.
- **magika** (markitdown's content sniffer) needs onnxruntime, which has no
  Pyodide build. The browser build instead runs the *same* ONNX model with
  **onnxruntime-web** in JS, replicating magika's feature extraction
  (beg/end byte windows) and its high-confidence threshold logic. The
  prediction is handed to Python as a `stream_info` guess — outputs match
  the native magika (verified by the test suite against `magika` on CPython).
  Inside Pyodide, `onnxruntime` is a stub module so `import markitdown`
  succeeds.

## Repo layout

| Path | What |
|---|---|
| `src/index.html`, `src/styles.css` | App shell (drop zone, queue, result view) |
| `src/js/app.js` | Engine boot, queue, drag&drop/paste, `launchQueue` file handling, markdown preview renderer |
| `src/js/magika.js` | magika re-implementation on onnxruntime-web |
| `src/js/ort-setup.js` | Loads onnxruntime-web, configures single-thread wasm |
| `src/js/sw-template.js` | Service worker template (precache manifest injected at build) |
| `src/python/api.py` | Pyodide-side glue: onnxruntime stub, magika stub, `convert()` |
| `src/manifest.webmanifest` | PWA manifest incl. `file_handlers` |
| `scripts/build-site.sh` | Assembles `site/` from all the pieces above |
| `.github/workflows/deploy-pages.yml` | Weekly build + test + Pages deploy |
| `tests/e2e-test.mjs` | Playwright end-to-end suite (boot, conversions vs Python reference, keep-data-URIs toggle, offline, manifest, JS-magika vs native-magika agreement, preview-pane DOM over converted fixtures and over synthetic markdown fed to the real `renderPreview` — including hostile-input and render-time bounds) |
| `tests/race-probe.mjs` | Playwright race probe for the keep-data-URIs reconvert path: deterministic mid-conversion toggle flips (stalled `arrayBuffer` + timed flips), view-yank, duplicate-conversion, clear-queue stale-index, error-pane and boot-retry scenarios (S1–S7). Not wired into the deploy workflow — run it by hand before touching the queue or reconvert logic |
| `tests/fixtures/`, `tests/reference-*.json` | Test documents + outputs produced by native markitdown (`reference-keep-data-uris.json` holds the `--keep-data-uris` outputs) |

## Building locally

```bash
# assumes a markitdown checkout at ~/software/markitdown
bash scripts/build-site.sh [path/to/markitdown]

# serve + test
python3 -m http.server 8977 --directory site &
cd tests && TEST_BASE_URL=http://localhost:8977/ node e2e-test.mjs

# race probe (optional; not run by CI), from tests/ with its own port
python3 -m http.server 8933 --directory ../site &
PROBE_BASE_URL=http://localhost:8933/ node race-probe.mjs
```

Both suites drive the production source: `site/app.js` is a verbatim copy of
`src/js/app.js`, and the e2e suite imports `renderPreview` straight out of it,
so there is no test-only copy of the renderer to drift.

The deploy workflow runs the same script against a fresh checkout of
`microsoft/markitdown@main` every Monday 03:00 UTC, then publishes only if
`tests/e2e-test.mjs` passes (the race probe is not part of that gate).

## PWA notes

- **Offline:** the first load installs the service worker, which precaches
  all 50+ assets. Subsequent loads work with `navigator.onLine === false` (this
  is asserted by the e2e suite).
- **File Handling:** `file_handlers` in the manifest + a `launchQueue`
  consumer in `app.js`. Install the PWA (install button in the URL bar /
  "Install app" menu), and the OS will offer MarkItDown Web when opening
  documents. Files can also arrive by drag & drop, file picker, or paste.
- Weekly builds rotate the service-worker cache atomically (build-id-stamped
  cache name), so engine updates land on the second visit.

## License

MIT, matching upstream markitdown. This repository is a build/packaging
project and is not affiliated with Microsoft.

[MarkItDown Web]: https://sloth-os.github.io/markitdown/
[Pyodide]: https://pyodide.org
