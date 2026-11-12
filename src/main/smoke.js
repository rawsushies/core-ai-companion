'use strict';

// Self-test mode for CI and release gates:
//   COre --smoke-test=<result.json> [--user-data-dir=<dir>]
// COre starts normally (no updater, network services or greetings), waits for
// its windows to load and the orb to draw its first frame, checks that the
// packaged native modules and worker files are present, writes a JSON report
// and exits with 0 (pass) or 1 (fail). A hard timeout guarantees it never hangs.

const fs = require('fs');
const path = require('path');

const FLAG = '--smoke-test';

function smokeTarget(argv = process.argv) {
  const a = argv.find((x) => x === FLAG || x.startsWith(`${FLAG}=`));
  if (!a) return null;
  return a.includes('=') ? a.slice(FLAG.length + 1) : path.join(process.cwd(), 'core-smoke.json');
}

// Checks that don't need a window: files the packaged app must contain and
// native modules that must load.
// Bundled with the installer (resources/): the Cortex knowledge engine and the local
// models (speech recognition, voice at both qualities, memory embeddings).
const BUNDLED = ['cortex/Cortex.exe', 'models/onnx-community/whisper-base/onnx/encoder_model_quantized.onnx', 'models/onnx-community/whisper-base/onnx/decoder_model_merged_q4.onnx',
  'models/onnx-community/moonshine-base-ONNX/onnx/encoder_model_quantized.onnx', 'models/onnx-community/moonshine-base-ONNX/onnx/decoder_model_merged_quantized.onnx',
  'models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_q4.onnx', 'models/onnx-community/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx', 'models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx'];
function bundledChecks(resourcesPath, platform = process.platform) {
  if (!resourcesPath || platform !== 'win32') return [];
  return BUNDLED.map((rel) => ({ name: `bundled ${rel.split('/').slice(0, rel.startsWith('models/') ? 3 : 1).join('/')}${rel.endsWith('.onnx') ? ` ${path.basename(rel)}` : ''}`, ok: fs.existsSync(path.join(resourcesPath, rel)), detail: rel }));
}

function staticChecks(root, requireFn = require) {
  const checks = [];
  const file = (name, rel) => checks.push({ name, ok: fs.existsSync(path.join(root, rel)), detail: rel });
  file('tts worker', 'src/main/tts/worker.mjs');
  file('stt worker', 'src/main/stt/worker.mjs');
  file('overlay page', 'src/renderer/overlay/index.html');
  file('dock page', 'src/renderer/dock/index.html');
  file('settings page', 'src/renderer/settings/index.html');
  file('app icon', 'assets/icon.png');
  for (const mod of ['onnxruntime-node', 'kokoro-js', '@huggingface/transformers']) {
    try {
      // Resolving is enough for the pure-JS packages; onnxruntime-node loads
      // its native binding on require, which is what breaks when packaging goes wrong.
      if (mod === 'onnxruntime-node') requireFn(mod);
      else requireFn.resolve(mod);
      checks.push({ name: `module ${mod}`, ok: true });
    } catch (err) {
      checks.push({ name: `module ${mod}`, ok: false, detail: String(err.message).slice(0, 300) });
    }
  }
  return checks;
}

class SmokeTest {
  constructor({ target, root, version, packaged, resourcesPath = '', timeoutMs = 90_000, onDone }) {
    this.target = target;
    this.started = Date.now();
    this.report = { ok: false, version, packaged, platform: process.platform, checks: [...staticChecks(root), ...(packaged ? bundledChecks(resourcesPath) : [])] };
    this.waiting = new Set(['overlay-ready', 'dock-loaded']);
    this.onDone = onDone;
    this.timer = setTimeout(() => this.finish(`timed out waiting for: ${[...this.waiting].join(', ')}`), timeoutMs);
  }

  mark(what, ok = true, detail) {
    this.report.checks.push({ name: what, ok, ...(detail ? { detail } : {}) });
    this.waiting.delete(what);
    if (!ok) return this.finish(`${what} failed`);
    if (!this.waiting.size) this.finish(null);
  }

  finish(error) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.report.ms = Date.now() - this.started;
    this.report.error = error;
    this.report.ok = !error && this.report.checks.every((c) => c.ok);
    try {
      fs.mkdirSync(path.dirname(this.target), { recursive: true });
      fs.writeFileSync(this.target, JSON.stringify(this.report, null, 2));
    } catch {}
    this.onDone(this.report.ok ? 0 : 1, this.report);
  }
}

module.exports = { smokeTarget, staticChecks, bundledChecks, BUNDLED, SmokeTest, FLAG };
