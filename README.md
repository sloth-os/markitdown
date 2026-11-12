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
| `src/js/app.js` | Engine boot, queue, drag&drop/paste, `launchQueue` file handling |
| `src/js/magika.js` | magika re-implementation on onnxruntime-web |
| `src/js/ort-setup.js` | Loads onnxruntime-web, configures single-thread wasm |
| `src/js/sw-template.js` | Service worker template (precache manifest injected at build) |
| `src/python/api.py` | Pyodide-side glue: onnxruntime stub, magika stub, `convert()` |
| `src/manifest.webmanifest` | PWA manifest incl. `file_handlers` |
| `scripts/build-site.sh` | Assembles `site/` from all the pieces above |
| `.github/workflows/deploy-pages.yml` | Weekly build + test + Pages deploy |
| `tests/e2e-test.mjs` | Playwright end-to-end suite (boot, conversions vs Python reference, offline, manifest) |
| `tests/fixtures/`, `tests/reference-*.json` | Test documents + outputs produced by native markitdown |

## Building locally

```bash
# assumes a markitdown checkout at ~/software/markitdown
bash scripts/build-site.sh [path/to/markitdown]

# serve + test
python3 -m http.server 8977 --directory site &
cd tests && TEST_BASE_URL=http://localhost:8977/ node e2e-test.mjs
```

The deploy workflow runs the same script against a fresh checkout of
`microsoft/markitdown@main` every Monday 03:00 UTC, then publishes only if
the end-to-end tests pass.

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
