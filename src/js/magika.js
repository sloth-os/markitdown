// SPDX-License-Identifier: MIT
//
// Browser-side re-implementation of Google's magika file-type identification
// (https://github.com/google/magika), using onnxruntime-web for inference.
//
// markitdown depends on magika for content sniffing, but there is no
// onnxruntime build that runs inside Pyodide.  Instead we run the same ONNX
// model in the browser via onnxruntime-web and hand the prediction to the
// Python side (see src/python/api.py).
//
// This module mirrors magika 1.x semantics:
//   - feature extraction v2 (beg 1024 / end 1024 / block 4096 / pad 256)
//   - the "few bytes" fast path for files under min_file_size_for_dl
//   - the high-confidence threshold + overwrite-map post-processing
//
// The model and config files are extracted from the magika wheel at build
// time and served from ./magika/.

// Bytes that Python's bytes.lstrip()/rstrip() strip by default (ASCII whitespace).
const WS = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

function lstrip(u8) {
  let i = 0;
  while (i < u8.length && WS.has(u8[i])) i++;
  return u8.subarray(i);
}

function rstrip(u8) {
  let j = u8.length;
  while (j > 0 && WS.has(u8[j - 1])) j--;
  return u8.subarray(0, j);
}

/**
 * Extract the2048-int feature vector, exactly like
 * magika.Magika._extract_features_from_seekable().
 * Returns null when the file is too small/whitespace-only for the DL model
 * (the caller then uses the few-bytes fallback).
 */
export function extractFeatures(bytes, cfg) {
  const size = bytes.length;
  const toRead = Math.min(cfg.block_size, size);

  const beg = lstrip(bytes.subarray(0, toRead)).subarray(0, cfg.beg_size);
  const end = rstrip(bytes.subarray(size - toRead)).subarray(-cfg.end_size);

  // Not enough meaningful bytes? Mirrors the Python check:
  // beg[min_file_size_for_dl - 1] == padding_token  →  few-bytes path.
  const begInts = new Array(cfg.beg_size).fill(cfg.padding_token);
  for (let i = 0; i < beg.length && i < cfg.beg_size; i++) begInts[i] = beg[i];
  if (begInts[cfg.min_file_size_for_dl - 1] === cfg.padding_token) return null;

  const endInts = new Array(cfg.end_size).fill(cfg.padding_token);
  const endOff = cfg.end_size - end.length;
  for (let i = 0; i < end.length && i < cfg.end_size; i++) {
    endInts[endOff + i] = end[i];
  }
  return new Int32Array([...begInts, ...endInts]);
}

/** Few-bytes fallback: valid UTF-8 → "txt", else "unknown". */
export function fewBytesLabel(bytes) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "txt";
  } catch {
    return "unknown";
  }
}

export class MagikaJS {
  constructor(modelConfig, contentTypesKb, session, ort) {
    this.cfg = modelConfig;
    this.cts = contentTypesKb; // label -> {mime_type, is_text, extensions}
    this.session = session; // ort.InferenceSession
    this.ort = ort;
  }

  /**
   * Identify a file. Returns the prediction dict consumed by api.py:
   * {label, mime_type, is_text, extensions, score}
   * or null when identification should be skipped (empty file → status != ok).
   */
  async identify(bytes) {
    if (bytes.length === 0) return null; // markitdown treats non-"ok" as skip

    if (bytes.length < this.cfg.min_file_size_for_dl) {
      return this.resultFrom(fewBytesLabel(bytes), 1.0);
    }

    const features = extractFeatures(bytes, this.cfg);
    if (features === null) {
      const toRead = Math.min(this.cfg.block_size, bytes.length);
      return this.resultFrom(fewBytesLabel(bytes.subarray(0, toRead)), 1.0);
    }

    const feeds = {};
    feeds[this.session.inputNames[0] ?? "bytes"] = new this.ort.Tensor(
      "int32",
      features,
      [1, features.length]
    );
    const results = await this.session.run(feeds);
    const logits = results[this.session.outputNames[0] ?? "target_label"];

    // argmax
    const data = logits.data;
    let best = 0;
    for (let i = 1; i < data.length; i++) if (data[i] > data[best]) best = i;
    const score = data[best];

    const dlLabel = this.cfg.target_labels_space[best];
    return this.resultFromDl(dlLabel, score);
  }

  /** Apply overwrite map + high-confidence thresholds (magika default mode). */
  resultFromDl(dlLabel, score) {
    let outputLabel = this.cfg.overwrite_map[dlLabel] ?? dlLabel;
    const threshold =
      this.cfg.thresholds[dlLabel] ?? this.cfg.medium_confidence_threshold;
    if (score < threshold) {
      // LOW_CONFIDENCE: fall back to generic labels
      const info = this.cts[outputLabel];
      outputLabel = info && info.is_text ? "txt" : "unknown";
    }
    return this.resultFrom(outputLabel, score);
  }

  resultFrom(label, score) {
    const info = this.cts[label] ?? {
      mime_type: "application/octet-stream",
      is_text: false,
      extensions: [],
    };
    return {
      label,
      mime_type: info.mime_type,
      is_text: !!info.is_text,
      extensions: info.extensions || [],
      score,
    };
  }
}

/**
 * Load model + configs (served from ./magika/, extracted from the magika
 * wheel at build time) and create the ort session.
 */
export async function createMagika(ort, basePath = "./magika/") {
  const cfgUrl = new URL("model-config.json", new URL(basePath, location.href));
  const kbUrl = new URL("content-types-kb.json", new URL(basePath, location.href));
  const [cfgRes, kbRes] = await Promise.all([fetch(cfgUrl), fetch(kbUrl)]);
  if (!cfgRes.ok || !kbRes.ok) throw new Error("failed to load magika configs");
  const modelConfig = await cfgRes.json();
  const kb = await kbRes.json();

  // Normalize config to plain lookups
  const cfg = {
    beg_size: modelConfig.beg_size,
    mid_size: modelConfig.mid_size,
    end_size: modelConfig.end_size,
    block_size: modelConfig.block_size,
    padding_token: modelConfig.padding_token,
    min_file_size_for_dl: modelConfig.min_file_size_for_dl,
    medium_confidence_threshold: modelConfig.medium_confidence_threshold,
    thresholds: modelConfig.thresholds || {},
    overwrite_map: modelConfig.overwrite_map || {},
    target_labels_space: modelConfig.target_labels_space,
  };

  const modelUrl = new URL("model.onnx", new URL(basePath, location.href));
  const modelArrayBuffer = await (await fetch(modelUrl)).arrayBuffer();

  const session = await ort.InferenceSession.create(modelArrayBuffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });

  return new MagikaJS(cfg, kb, session, ort);
}
