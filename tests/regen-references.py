#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Regenerate the native-Python reference outputs the e2e suite compares
against (run from the repo root with the markitdown package importable):

    PYTHONPATH=/path/to/markitdown/packages/markitdown/src \
        python3 tests/regen-references.py [path/to/markitdown/src]

Writes tests/reference-conversions.json (markitdown convert_stream via the
same api.py glue used in the browser) and tests/reference-magika.json
(native magika predictions, to catch drift in the JS re-implementation).
"""
import io
import json
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(REPO, "src", "python"))

import api  # noqa: E402

MAGIKA_MAP = {
    "sample.docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx", "docx"),
    "sample.xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx", "xlsx"),
    "sample.pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx", "pptx"),
    "sample.html": ("text/html", ".html", "html"),
    "sample.csv": ("text/csv", ".csv", "csv"),
    "sample.json": ("application/json", ".json", "json"),
    "sample.txt": ("text/plain", ".txt", "txt"),
    "sample.md": ("text/markdown", ".md", "markdown"),
    "sample.pdf": ("application/pdf", ".pdf", "pdf"),
    "sample.epub": ("application/epub+zip", ".epub", "epub"),
    "sample.zip": ("application/zip", ".zip", "zip"),
}

FIXTURES = os.path.join(REPO, "tests", "fixtures")


def main():
    api.initialize()

    conversions = {}
    for name, (mime, ext, label) in MAGIKA_MAP.items():
        with open(os.path.join(FIXTURES, name), "rb") as fh:
            data = fh.read()
        pred = {
            "label": label,
            "mime_type": mime,
            "is_text": mime.startswith("text/"),
            "extensions": [ext.lstrip(".")],
        }
        conversions[name] = api.convert(
            data, mimetype=mime, extension=ext, filename=name,
            magika_prediction=pred,
        )
        state = "OK" if conversions[name].get("ok") else "FAIL"
        print(f"{state} {name}")
    with open(os.path.join(REPO, "tests", "reference-conversions.json"), "w") as fh:
        json.dump(conversions, fh, indent=1)

    # Native magika predictions for validating the JS re-implementation.
    # Drop the onnxruntime stub that api.initialize() installed so the real
    # onnxruntime (and real magika inference) is used here.
    sys.modules.pop("onnxruntime", None)
    for mod in list(sys.modules):
        if mod == "magika" or mod.startswith("magika."):
            del sys.modules[mod]
    import magika

    mag = magika.Magika()
    preds = {}
    for name in sorted(os.listdir(FIXTURES)):
        with open(os.path.join(FIXTURES, name), "rb") as fh:
            data = fh.read()
        r = mag.identify_stream(io.BytesIO(data))
        preds[name] = {
            "label": r.prediction.output.label,
            "mime_type": r.prediction.output.mime_type,
            "is_text": r.prediction.output.is_text,
            "extensions": list(r.prediction.output.extensions),
            "score": r.score,
            "dl_label": r.prediction.dl.label,
            "status": r.status,
        }
        print(f"MAGIKA {name} -> {r.prediction.output.label}")
    with open(os.path.join(REPO, "tests", "reference-magika.json"), "w") as fh:
        json.dump(preds, fh, indent=1)


if __name__ == "__main__":
    main()
