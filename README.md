# markitdown-web

> **[MarkItDown Web]** — convert documents to Markdown entirely in your
> browser, with no server. A GitHub Actions workflow (weekly, plus on every
> push to `main` and on demand) builds the
> [microsoft/markitdown](https://github.com/microsoft/markitdown) Python
> package to WebAssembly (via [Pyodide]) and publishes it as an offline-capable
> PWA to GitHub Pages.

**Live site:** <https://sloth-os.github.io/markitdown/>

## What it does

- Converts **PDF, DOCX, PPTX, XLSX, XLS, HTML, CSV, EPUB, IPYNB, ZIP,
  Outlook MSG, RSS/Atom** to structured Markdown, and any text-like file
  (plain text, Markdown, JSON, TSV, logs, source code) through verbatim —
  the same output as the markitdown CLI, because it *is* markitdown running
  under Pyodide.
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
  Enable the toggle in the result view to retain the raw base64 image data,
  matching the CLI's `--keep-data-uris`. Applies to DOCX/EPUB/HTML
  (markdownify) and PPTX (direct emission), and re-converts the file you're
  viewing when flipped. The choice is remembered per browser.
  - **PDF and XLSX never emit embedded images** in either mode, so the
    toggle has no visible effect on them. This is upstream markitdown
    behaviour, not a bug in this build: `PdfConverter.convert()` ignores its
    `**kwargs` (so `keep_data_uris` can't reach it) and emits no image
    markdown at all, and `XlsxConverter._image_to_html()` returns `None`.
    A PDF full of images converts to text and tables only.
- **Markdown preview pane.** The result view toggles between the raw markdown
  (authoritative — byte-for-byte what markitdown emitted) and a rendered
  preview: headings (all six levels), paragraphs, bold/italic (including
  `***bold italic***` and `_emphasis_` with the intraword rule, so
  `snake_case` stays literal), inline code, fenced code, ordered and
  unordered lists (with `start=` offsets and indented continuation lines),
  blockquotes, horizontal rules, pipe tables (escaped `\|` kept inside its
  cell), links and embedded images — plus markdownify's backslash escapes
  unescaped in visible text, and CJK-aware soft-wrap joining so hard-wrapped
  Chinese/Japanese prose doesn't grow spaces at every line break.
  - **Images:** an embedded image renders inline when its payload survived
    the conversion *and* its source passes the URL allowlist — raster
    `data:` URIs (png/jpeg/gif/webp/bmp/avif), `http(s)` URLs, and relative
    paths. Where it didn't — truncated placeholder in default mode, PPTX's
    filename substitution, a refused source (SVG and other non-raster
    payloads are script-capable or unsupported), or a remote URL that can't
    be reached while offline — the preview shows a labelled stand-in instead
    of a broken-image icon. Note that an allowed `http(s)` image *is*
    fetched when you're online (the file's own bytes still never leave the
    device; only the reference inside it does).
  - **Security:** nothing on this path parses HTML — there is no `innerHTML`
    anywhere, and every fragment of a converted (untrusted) document lands in
    a text node or a `textContent`, never in the DOM as markup. The one place
    document data reaches an attribute (`<img src>`, `<a href>`) is gated by
    that URL allowlist: `javascript:`, `data:text/html`, `data:image/svg+xml`
    and backslash-rooted paths (`/\host`, which the URL parser treats as
    `//host`) are refused, and links open with
    `target="_blank" rel="noopener noreferrer"`.
  - **Deliberately minimal:** a construct the renderer doesn't model degrades
    to visible plain text rather than being dropped or guessed at. That
    includes nested lists, setext headings, reference-style links,
    autolinks — and the raw HTML markitdown itself emits for some formats
    (PPTX's `<!-- Slide number: N -->`, DOCX underlines as `<u>…</u>`,
    strikethrough as `~~text~~`), which you'll see as literal characters.
    Inline parsing is linear per line, so even a multi-hundred-KB verbatim
    `.txt`/`.log` line can't freeze the tab (the e2e suite bounds it).
    The raw pane always has the exact bytes markitdown emitted.
- Updated **weekly** from upstream `microsoft/markitdown@main`. The e2e gate
  compares conversions byte-for-byte against checked-in reference outputs,
  so an upstream change that alters output (or a magika bump that moves
  predictions) fails the build and blocks that week's publish until
  `tests/regen-references.py` is re-run — fixes and new converters roll out
  automatically only while the references still match.

## Supported inputs

Anything markitdown supports that can run in the browser sandbox.
Converted to structured markdown:
`.pdf .docx .pptx .xlsx .xls .html .htm .csv .ipynb .epub .zip .msg .rss
.atom`, plus `.xml` when it's an RSS/Atom feed. Any other file magika
identifies as `text/*` (`.txt .md .json .jsonl .tsv`, non-feed `.xml`,
`.log .ini .toml .yaml`, source code, …) passes through **verbatim** as
plain text — markitdown's `PlainTextConverter`, not a table/feed converter.
Standalone images (`.png .jpg`) are accepted but produce empty output: both
metadata paths upstream (exiftool, LLM captioning) need external services,
as does audio transcription — all out of scope for the offline build.

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
| `.github/workflows/deploy-pages.yml` | Build + e2e test + precache-coverage check + Pages deploy (weekly, on pushes to `main`, and on demand) |
| `tests/e2e-test.mjs` | Playwright end-to-end suite (boot, conversions vs Python reference, keep-data-URIs toggle, offline, manifest, JS-magika vs native-magika agreement, preview-pane DOM over converted fixtures and over synthetic markdown fed to the real `renderPreview` — including hostile-input and render-time bounds) |
| `tests/race-probe.mjs` | Playwright race probe for the keep-data-URIs reconvert path: deterministic mid-conversion toggle flips (stalled `arrayBuffer` + timed flips), view-yank, duplicate-conversion, clear-queue stale-index, error-pane and boot-retry scenarios (S1–S7). Not wired into the deploy workflow — run it by hand before touching the queue or reconvert logic |
| `tests/fixtures/`, `tests/reference-*.json` | Test documents + outputs produced by native markitdown (`reference-keep-data-uris.json` holds the `--keep-data-uris` outputs) |
| `tests/regen-references.py` | Regenerates the `reference-*.json` files from native markitdown + native magika on CPython — run it when upstream output drifts, which is what turns the weekly gate red |

## Building locally

The build itself needs network access (pip, npm, CDN downloads); only the
runtime doesn't. It also reuses an existing `dist/markitdown-*.whl` if one is
present — delete it to force a rebuild from your markitdown checkout.

```bash
# assumes a markitdown checkout at ~/software/markitdown
bash scripts/build-site.sh [path/to/markitdown]

# one-time: the test suites need Playwright (tests/node_modules is gitignored)
cd tests && npm install --no-save playwright@1.65.0 \
  && npx playwright install chromium --with-deps

# serve + test
python3 -m http.server 8977 --directory site &
cd tests && TEST_BASE_URL=http://localhost:8977/ node e2e-test.mjs

# race probe (optional; not run by CI), from tests/ with its own port
python3 -m http.server 8933 --directory ../site &
PROBE_BASE_URL=http://localhost:8933/ node race-probe.mjs
```

Both suites exercise the production build: `site/app.js` is a verbatim copy
of `src/js/app.js` (`site/` is generated, not committed), and the e2e suite
imports `renderPreview` straight out of the served file, so there is no
test-only copy of the renderer to drift.

The deploy workflow runs the same script against a fresh checkout of
`microsoft/markitdown@main` every Monday 03:00 UTC, then publishes only if
`tests/e2e-test.mjs` passes (the race probe is not part of that gate).

## PWA notes

- **Offline:** the first load installs the service worker, which precaches
  all 50+ assets. Subsequent loads work with the browser's network fully
  disabled — the e2e suite reloads the app offline and converts a file
  entirely from cache.
- **File Handling:** `file_handlers` in the manifest + a `launchQueue`
  consumer in `app.js`. Install the PWA (install button in the URL bar /
  "Install app" menu), and the OS will offer MarkItDown Web when opening
  documents. Files can also arrive by drag & drop, file picker, or paste.
- Weekly builds rotate the service-worker cache atomically (build-id-stamped
  cache name), so engine updates land on the second visit.

## License

MIT, matching upstream markitdown (declared per-file via
`SPDX-License-Identifier` headers; the repo has no top-level `LICENSE` yet).
The built `site/` also redistributes third-party code under its own terms —
notably Pyodide, onnxruntime-web, and the vendored wheels: magika
(Apache-2.0), certifi (MPL-2.0), mammoth/cobble/olefile/XlsxWriter (BSD)
and defusedxml (PSF), the rest MIT. This repository is a build/packaging
project and is not affiliated with Microsoft.

[MarkItDown Web]: https://sloth-os.github.io/markitdown/
[Pyodide]: https://pyodide.org
