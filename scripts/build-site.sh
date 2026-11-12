#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Assemble the deployable site into ./site/ from:
#   - src/                      (app shell: html/js/css/icons/manifest)
#   - a markitdown wheel        (built from a markitdown checkout, or PyPI)
#   - pure-python dep wheels    (resolved for the pyodide python version)
#   - pyodide runtime + packages(npm + CDN)
#   - onnxruntime-web           (npm)
#   - magika model + configs    (extracted from the magika wheel)
#
# Everything is vendored so the site works fully offline once installed.
#
# Usage: scripts/build-site.sh [MARKITDOWN_SOURCE_DIR]
#   MARKITDOWN_SOURCE_DIR defaults to ~/software/markitdown (a git checkout
#   of microsoft/markitdown). Pass a dir containing packages/markitdown.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src"
OUT="$ROOT/site"
MARKITDOWN_SRC="${1:-$HOME/software/markitdown}"

PYODIDE_VERSION="0.29.5"          # Python 3.13.2, abi 2025_0
PYODIDE_PY="3.13"                 # interpreter tag used for wheel selection
ORT_VERSION="1.31.1"              # onnxruntime-web
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pure-python wheels we vendor ourselves. The full transitive closure is
# listed explicitly so micropip can install with deps=False and never touch
# the network. Packages provided by the pyodide distribution (wasm-compiled:
# numpy, pandas, lxml, requests, bs4, six, click, xlrd, Pillow, cryptography
# + their deps) are NOT vendored — they load via pyodide.loadPackage.
WHEEL_SPECS=(
  # --- markitdown core deps (pure python only; charset-normalizer,
  #     beautifulsoup4, requests etc. come from the pyodide distribution) ---
  "markdownify"
  "magika"
  "defusedxml"
  # --- optional format deps (pure python) ---
  "python-pptx"
  "mammoth"
  "openpyxl"
  # pdfplumber 0.11.10 needs Pillow>=12.2 (pyodide ships 11.3), so pin the
  # last release that accepts Pillow 11; it pairs with pdfminer.six==20251230.
  "pdfplumber==0.11.9"
  "pdfminer.six==20251230"
  "olefile"
  "et-xmlfile"
  "XlsxWriter"
  "cobble"
  # markitdown requires certifi>=2026.10.19 but the pyodide distribution
  # bundles 2026.1.4 — vendor the newer pure wheel and reinstall it over
  # the pyodide copy.
  "certifi"
)

echo "==> build dir: $WORK"
mkdir -p "$OUT"
# Clear previously-vendored artifacts (app shell files are re-copied anyway)
rm -rf "$OUT/wheels" "$OUT/magika" "$OUT/pyodide" "$OUT/ort" "$OUT/icons" "$OUT/python"

# ---------------------------------------------------------------------------
# 1. markitdown wheel: build from the local checkout (weekly CI checks out
#    upstream main), or reuse one already in dist/.
# ---------------------------------------------------------------------------
MD_WHEEL_DIR="$ROOT/dist"
mkdir -p "$MD_WHEEL_DIR"
if compgen -G "$MD_WHEEL_DIR/markitdown-*.whl" > /dev/null; then
  echo "==> using existing markitdown wheel(s) in dist/"
else
  if [ ! -d "$MARKITDOWN_SRC/packages/markitdown" ]; then
    echo "ERROR: markitdown source not found at $MARKITDOWN_SRC" >&2
    exit 1
  fi
  echo "==> building markitdown wheel from $MARKITDOWN_SRC"
  python3 -m pip wheel --no-deps --wheel-dir "$MD_WHEEL_DIR" \
    --index-url https://pypi.org/simple \
    "$MARKITDOWN_SRC/packages/markitdown"
fi

# ---------------------------------------------------------------------------
# 2. Vendor pure-python wheels (pinned set, no network resolution surprises:
#    pip resolves against PyPI but only the exact specs we ask for).
# ---------------------------------------------------------------------------
WHEELS="$OUT/wheels"
mkdir -p "$WHEELS"
echo "==> downloading pure-python wheels"
python3 -m pip download \
  --no-deps \
  --only-binary :all: \
  --python-version "$PYODIDE_PY" \
  --implementation cp \
  --platform any \
  --index-url https://pypi.org/simple \
  --dest "$WHEELS" \
  "${WHEEL_SPECS[@]}"

cp "$MD_WHEEL_DIR"/markitdown-*.whl "$WHEELS/"

# Pull the pyodide lock now (needed to dedup wheels against the pyodide
# distribution) and stage the runtime tarball for step 4.
curl -sfL "https://registry.npmjs.org/pyodide/-/pyodide-${PYODIDE_VERSION}.tgz" -o "$WORK/pyodide.tgz"
mkdir -p "$WORK/package"
tar xzf "$WORK/pyodide.tgz" -C "$WORK"

# wheels.json: the exact install list for micropip (order-independent,
# installed with deps=False). Wheels for packages the pyodide distribution
# already provides are excluded to avoid version clashes.
python3 - "$WHEELS" "$WORK/package/pyodide-lock.json" <<'PY'
import json, os, sys
wheels_dir, lock_path = sys.argv[1], sys.argv[2]
# Packages we deliberately reinstall over the pyodide copy (newer versions
# required by markitdown's own pins):
force_vendor = {"certifi"}
pyodide_pkgs = {p["name"].lower() for p in json.load(open(lock_path))["packages"].values()} - force_vendor
names = []
for n in sorted(os.listdir(wheels_dir)):
    if not n.endswith(".whl"):
        continue
    pkg = n.split("-")[0].lower()
    if pkg in pyodide_pkgs:
        print(f"    skipping {n} (provided by pyodide)")
        os.remove(os.path.join(wheels_dir, n))
        continue
    names.append(n)
json.dump({"wheels": names}, open(os.path.join(wheels_dir, "wheels.json"), "w"), indent=1)
print(f"    {len(names)} wheels vendored")
PY

# ---------------------------------------------------------------------------
# 3. magika model + configs (extracted from the magika wheel)
# ---------------------------------------------------------------------------
echo "==> extracting magika model assets"
MAGIKA_OUT="$OUT/magika"
mkdir -p "$MAGIKA_OUT"
MAGIKA_WHEEL=$(ls "$WHEELS"/magika-*.whl | head -1)
python3 - "$MAGIKA_WHEEL" "$MAGIKA_OUT" <<'PY'
import json, sys, zipfile
wheel, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(wheel)
model_dir = next(n for n in z.namelist() if n.endswith("/model.onnx")).rsplit("/", 1)[0]
with open(f"{out}/model.onnx", "wb") as f:
    f.write(z.read(f"{model_dir}/model.onnx"))
cfg = json.loads(z.read(f"{model_dir}/config.min.json"))
kb = json.loads(z.read("magika/config/content_types_kb.min.json"))
json.dump(cfg, open(f"{out}/model-config.json", "w"))
json.dump(kb, open(f"{out}/content-types-kb.json", "w"))
print(f"    model={model_dir}")
PY

# ---------------------------------------------------------------------------
# 4. pyodide runtime + packages
# ---------------------------------------------------------------------------
echo "==> staging pyodide $PYODIDE_VERSION runtime + packages"
PYODIDE_OUT="$OUT/pyodide"
mkdir -p "$PYODIDE_OUT"
cp "$WORK/package/pyodide.mjs" \
   "$WORK/package/pyodide.asm.js" \
   "$WORK/package/pyodide.asm.wasm" \
   "$WORK/package/python_stdlib.zip" \
   "$WORK/package/pyodide-lock.json" \
   "$PYODIDE_OUT/"

# Download the wasm-compiled packages the app needs from the pyodide CDN,
# guided by the lock file (correct filenames, full transitive closure).
PYODIDE_LOCK="$PYODIDE_OUT/pyodide-lock.json"
PYODIDE_PKG_NAMES="numpy pandas lxml requests beautifulsoup4 six click xlrd Pillow cryptography micropip"
python3 - "$PYODIDE_LOCK" "$PYODIDE_PKG_NAMES" > "$WORK/pyodide-pkg-list.txt" <<'PY'
import json, sys
lock = sys.argv[1]
names = sys.argv[2].split()
d = json.load(open(lock))
pkgs = {p["name"].lower(): p for p in d["packages"].values()}
seen, order = set(), []
def add(n):
    n = n.lower()
    if n in seen or n not in pkgs:
        return
    seen.add(n)
    order.append(n)
    for dep in pkgs[n].get("depends", []):
        add(dep)
for n in names:
    add(n)
for n in order:
    print(pkgs[n]["file_name"])
PY
# A local cache (dist/cache) makes rebuilds fast and protects against
# partial downloads: files are fetched to the cache, size-checked against
# the lock file, then copied into the site.
export PYODIDE_CDN="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/"
PYODIDE_CACHE="$ROOT/dist/cache/pyodide-$PYODIDE_VERSION"
mkdir -p "$PYODIDE_CACHE"
python3 - "$PYODIDE_LOCK" "$WORK/pyodide-pkg-list.txt" "$PYODIDE_CACHE" "$PYODIDE_OUT" <<'PY'
import hashlib, json, os, shutil, sys
lock_path, list_path, cache, out = sys.argv[1:5]
sha256s = {p["file_name"]: p["sha256"] for p in json.load(open(lock_path))["packages"].values()}
def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
names = open(list_path).read().split()
for fname in names:
    expected = sha256s.get(fname)
    cached = os.path.join(cache, fname)
    if not os.path.exists(cached) or (expected and digest(cached) != expected):
        import subprocess
        url = os.environ["PYODIDE_CDN"] + fname
        print(f"    downloading {fname}", flush=True)
        subprocess.run(
            ["curl", "-sfL", "--retry", "3", url, "-o", cached], check=True
        )
    if expected and digest(cached) != expected:
        raise SystemExit(f"sha256 mismatch for {fname}")
    shutil.copy2(cached, os.path.join(out, fname))
print(f"    staged {len(names)} pyodide packages")
PY

# ---------------------------------------------------------------------------
# 5. onnxruntime-web
# ---------------------------------------------------------------------------
echo "==> fetching onnxruntime-web $ORT_VERSION"
ORT_OUT="$OUT/ort"
mkdir -p "$ORT_OUT"
# Fetch the three files we ship directly from a CDN mirror of the npm
# package (registry.npmjs.org can be slow; jsdelivr serves the same files):
#   ort.mjs                       — the ESM entry (bundle variant)
#   ort-wasm-simd-threaded.mjs    — emscripten loader, dynamically imported
#   ort-wasm-simd-threaded.wasm   — the wasm binary
ORT_DIST_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"
curl -sfL --retry 3 "$ORT_DIST_BASE/ort.wasm.bundle.min.mjs"     -o "$ORT_OUT/ort.mjs"
curl -sfL --retry 3 "$ORT_DIST_BASE/ort-wasm-simd-threaded.mjs"  -o "$ORT_OUT/ort-wasm-simd-threaded.mjs"
curl -sfL --retry 3 "$ORT_DIST_BASE/ort-wasm-simd-threaded.wasm" -o "$ORT_OUT/ort-wasm-simd-threaded.wasm"
ls -la "$ORT_OUT"

# ---------------------------------------------------------------------------
# 6. app shell
# ---------------------------------------------------------------------------
echo "==> copying app shell"
cp "$SRC/index.html" "$SRC/styles.css" "$SRC/manifest.webmanifest" "$OUT/"
cp "$SRC/js/app.js" "$SRC/js/magika.js" "$SRC/js/ort-setup.js" "$OUT/"
mkdir -p "$OUT/python" "$OUT/icons"
cp "$SRC/python/api.py" "$OUT/python/"
cp "$SRC/icons/"*.png "$OUT/icons/"

# ort-setup.js ships from src/ (app.js imports it directly).

# ---------------------------------------------------------------------------
# 7. service worker with the full precache manifest
# ---------------------------------------------------------------------------
echo "==> generating service worker"
BUILD_ID="$(date -u +%Y%m%d-%H%M%S)"
python3 - "$SRC/js/sw-template.js" "$OUT/sw.js" "$BUILD_ID" "$OUT" <<'PY'
import json, os, sys
template, out_path, build_id, site_dir = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
)

skip = {"sw.js"}
sw = open(template).read()

# Extract APP_SHELL entries from the template so the engine list doesn't
# duplicate them (both lists feed the same cache.addAll call).
import re as _re
m = _re.search(r"const APP_SHELL = \[(.*?)\];", sw, _re.S)
shell_files = {
    e.strip().strip('",').removeprefix("./")
    for e in (m.group(1).splitlines() if m else [])
    if e.strip().strip('",')
}
engine_urls = []
for root, _, files in os.walk(site_dir):
    for f in files:
        rel = os.path.relpath(os.path.join(root, f), site_dir).replace(os.sep, "/")
        if rel in skip or rel in shell_files:
            continue
        engine_urls.append("./" + rel)
engine_urls.sort()

sw = sw.replace("__BUILD_ID__", build_id)
sw = sw.replace(
 "__PRECACHE_URLS__", json.dumps(engine_urls, indent=2)
)
open(out_path, "w").write(sw)
print(f"    precached {len(engine_urls)} engine assets")
PY

echo "==> done: $OUT"
du -sh "$OUT" || true
