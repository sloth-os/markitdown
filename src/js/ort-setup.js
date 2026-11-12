// SPDX-License-Identifier: MIT
// Loads onnxruntime-web from ./ort/ and exposes it on globalThis for
// app.js/magika.js. The ort/ directory is vendored at build time.
import * as ort from "./ort/ort.mjs";

ort.env.wasm.wasmPaths = new URL("./ort/", import.meta.url).href;
ort.env.wasm.numThreads = 1;    // no COOP/COEP headers on GitHub Pages
ort.env.wasm.proxy = false;     // keep inference on the main thread
ort.env.logLevel = "error";

globalThis.ort = ort;
