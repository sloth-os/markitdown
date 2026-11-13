# SPDX-License-Identifier: MIT
"""Glue between the browser (JS) and markitdown running inside Pyodide.

The JS side pre-identifies each file with magika's ONNX model via
onnxruntime-web (there is no onnxruntime build for Pyodide), then calls
``convert()`` here with the detected mimetype/extension.  MarkItDown's own
magika calls are stubbed out so no onnxruntime import is ever needed inside
the WASM sandbox.
"""

import io
import sys
import types
from typing import Any, BinaryIO, Optional

# ---------------------------------------------------------------------------
# 1. Fake ``onnxruntime`` module.
#
# ``markitdown`` imports ``magika`` at module import time, and ``magika``
# imports ``onnxruntime`` at module import time.  Pyodide has no onnxruntime
# build, so we install a do-nothing stub *before* markitdown is imported.
# The stub's InferenceSession is never actually used: we replace the whole
# Magika instance on the MarkItDown object (see ``_install_js_magika_stub``).
# ---------------------------------------------------------------------------


class _StubInferenceSession:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def run(self, *args: Any, **kwargs: Any) -> list:
        raise RuntimeError(
            "onnxruntime is stubbed out in the browser build; "
            "magika inference runs in JS via onnxruntime-web"
        )


def _install_onnxruntime_stub() -> None:
    if "onnxruntime" in sys.modules:
        return
    stub = types.ModuleType("onnxruntime")
    stub.InferenceSession = _StubInferenceSession  # type: ignore[attr-defined]
    stub.disable_telemetry_events = lambda: None  # type: ignore[attr-defined]
    stub.__version__ = "0.0.0+stub"  # type: ignore[attr-defined]
    sys.modules["onnxruntime"] = stub


# ---------------------------------------------------------------------------
# 2. Magika stub fed from JS.
#
# MarkItDown._get_stream_info_guesses() calls
# ``self._magika.identify_stream(file_stream)`` and inspects the result.
# Our stub ignores the stream (JS already identified the same bytes) and
# returns the prediction the browser computed.  The result shape mirrors
# magika's MagikaResult just enough for markitdown's use.
# ---------------------------------------------------------------------------


def _field(payload: Any, key: str, default: Any) -> Any:
    """Read a field from a dict or a pyodide JsProxy (JS object)."""
    if payload is None:
        return default
    getter = getattr(payload, "get", None)
    if getter is not None:
        value = getter(key)
    else:
        value = getattr(payload, key, None)
    return default if value is None else value


class _PredictionOutput:
    def __init__(self, payload: Any) -> None:
        self.label = _field(payload, "label", "unknown")
        self.mime_type = _field(payload, "mime_type", "application/octet-stream")
        self.is_text = bool(_field(payload, "is_text", False))
        self.extensions = list(_field(payload, "extensions", []))


class _Prediction:
    def __init__(self, payload: Any) -> None:
        self.output = _PredictionOutput(payload)


class _MagikaResult:
    def __init__(self, payload: Any) -> None:
        self.status = "ok" if payload else "disabled"
        self.prediction = _Prediction(payload) if payload else None


class _JSMagikaStub:
    """Magika stand-in whose prediction comes from the JS side of the app."""

    def __init__(self) -> None:
        self._current: Optional[dict] = None

    def set_prediction(self, payload: Optional[dict]) -> None:
        self._current = payload

    def identify_stream(self, stream: BinaryIO) -> _MagikaResult:  # noqa: ARG002
        return _MagikaResult(self._current)


# ---------------------------------------------------------------------------
# 3. Public API exposed to JS.
# ---------------------------------------------------------------------------

_mdm = None  # MarkItDown instance
_magika_stub = _JSMagikaStub()


def initialize() -> dict:
    """Import markitdown lazily and build the converter. Returns versions."""
    global _mdm
    if _mdm is not None:
        return _versions()

    _install_onnxruntime_stub()

    from markitdown import MarkItDown

    _mdm = MarkItDown(enable_plugins=False)
    # Swap the real magika (whose stub session can't run) for our JS-fed stub.
    _mdm._magika = _magika_stub  # noqa: SLF001
    return _versions()


def _versions() -> dict:
    from markitdown import __version__

    return {"markitdown": __version__, "python": sys.version.split()[0]}


def convert(
    data: bytes,
    *,
    mimetype: Optional[str] = None,
    extension: Optional[str] = None,
    charset: Optional[str] = None,
    filename: Optional[str] = None,
    magika_prediction: Optional[dict] = None,
    keep_data_uris: bool = False,
) -> dict:
    """Convert ``data`` (raw file bytes) to markdown.

    ``magika_prediction`` is the JS-side magika result dict:
 ``{"label": ..., "mime_type": ..., "is_text": ..., "extensions": [...]}``.

    ``keep_data_uris`` mirrors the CLI flag of the same name: by default
    markitdown truncates embedded base64 images (``data:...;base64,...``)
    to ``data:...;base64...`` in the output; with this enabled the raw
    image data is retained in the markdown.
    """
    if _mdm is None:
        raise RuntimeError("call initialize() first")

    from markitdown import StreamInfo

    # JS passes file bytes as a Uint8Array; Pyodide wraps it in a JsBuffer.
    to_bytes = getattr(data, "to_bytes", None)
    if to_bytes is not None:
        data = to_bytes()

    _magika_stub.set_prediction(magika_prediction)

    stream = io.BytesIO(data)

    # Build the same base guess markitdown would have produced from a local
    # path, extended with the JS-side magika identification.
    base = dict(
        mimetype=mimetype,
        extension=extension,
        charset=charset,
        filename=filename,
    )
    stream_info = StreamInfo(**{k: v for k, v in base.items() if v})

    converter_kwargs: dict[str, Any] = {}
    if keep_data_uris:
        converter_kwargs["keep_data_uris"] = True

    try:
        result = _mdm.convert_stream(
            stream, stream_info=stream_info, **converter_kwargs
        )
    except Exception as exc:  # surface a readable error to JS
        return {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }
    finally:
        _magika_stub.set_prediction(None)

    return {
        "ok": True,
        "markdown": result.markdown,
        "title": result.title,
    }


def convert_file(path: str, **kwargs: Any) -> dict:
    """Convert a file already present in the Pyodide virtual FS."""
    if _mdm is None:
        raise RuntimeError("call initialize() first")
    with open(path, "rb") as fh:
        data = fh.read()
    kwargs.setdefault("filename", path.rsplit("/", 1)[-1])
    return convert(data, **kwargs)


def health() -> dict:
    """Cheap smoke test used by the test page."""
    res = convert(b"hello markitdown web\n", mimetype="text/plain", extension=".txt")
    if not res.get("ok"):
        raise RuntimeError(res.get("error"))
    if "hello markitdown web" not in res["markdown"]:
        raise RuntimeError(f"unexpected markdown: {res['markdown']!r}")
    return {"ok": True, **_versions()}


# Make the module importable and functions reachable via pyodide.pyimport.
__all__ = ["initialize", "convert", "convert_file", "health"]
