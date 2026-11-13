'use strict';
// CortexClient: structured results, the contract handshake and push events.
// The fake-process tests always run; the real-Cortex test needs a Cortex checkout (CORTEX_DIR) and Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const { CortexClient } = require('../src/main/cortex');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version']).status === 0;
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : false;

// A fake Cortex process: answers initialize and tools/call, and can push notifications.
function fakeCortex({ features = ['structured'], structured = true } = {}) {
  const seen = [];
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = () => {};
  const say = (o) => proc.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  proc.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      seen.push(m);
      if (m.method === 'initialize') say({ jsonrpc: '2.0', id: m.id, result: { serverInfo: { name: 'cortex', version: '2.0.0' }, capabilities: features ? { experimental: { cortex: { contract: 1, features } } } : {} } });
      if (m.method === 'tools/call') say({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `ran ${m.params.name}` }], ...(structured ? { structuredContent: { tool: m.params.name, args: m.params.arguments } } : {}) } });
    }
  });
  return { spawn: () => proc, seen, push: (method, params) => say({ jsonrpc: '2.0', method, params }) };
}

test('callData returns text and structured data; call still returns text', async () => {
  const f = fakeCortex();
  const c = new CortexClient({ cfg: { command: 'cortex' }, spawnImpl: f.spawn });
  const r = await c.callData('brain_tasks', { action: 'list' });
  assert.strictEqual(r.text, 'ran brain_tasks');
  assert.deepStrictEqual(r.data, { tool: 'brain_tasks', args: { action: 'list' } });
  assert.strictEqual(await c.call('brain_health'), 'ran brain_health');
  assert.deepStrictEqual(await c.contract(), { contract: 1, features: ['structured'] });
  assert.strictEqual(await c.has('structured'), true);
  assert.strictEqual(await c.has('undo'), false);
  c.dispose();
});

test('an older Cortex: no structured data, contract 0', async () => {
  const f = fakeCortex({ features: null, structured: false });
  const c = new CortexClient({ cfg: { command: 'cortex' }, spawnImpl: f.spawn });
  assert.strictEqual((await c.callData('brain_recall', { query: 'x' })).data, null);
  assert.deepStrictEqual(await c.contract(), { contract: 0, features: [] });
  c.dispose();
});

test('events: asked for only with a handler, delivered by name', async () => {
  const quiet = fakeCortex();
  const c0 = new CortexClient({ cfg: { command: 'cortex' }, spawnImpl: quiet.spawn });
  await c0.contract();
  assert.deepStrictEqual(quiet.seen[0].params.capabilities, {});
  c0.dispose();
  const f = fakeCortex();
  const got = [];
  const c = new CortexClient({ cfg: { command: 'cortex' }, spawnImpl: f.spawn, onEvent: (name, p) => got.push([name, p]) });
  await c.contract();
  assert.strictEqual(f.seen[0].params.capabilities.experimental.cortex.events, true);
  f.push('notifications/cortex/changed', { paths: ['Obsidian edit.md'], outside: true });
  f.push('notifications/other/thing', { x: 1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(got, [['changed', { paths: ['Obsidian edit.md'], outside: true }]]);
  c.dispose();
});

test('real Cortex: contract, structured recall, push event for an outside edit', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cortex-'));
  const vault = path.join(dir, 'vault');
  const events = [];
  const c = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault, env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl'), CORTEX_EVENT_INTERVAL: '0.3' } }, timeoutMs: 60000, onEvent: (n, p) => events.push([n, p]) });
  try {
    const k = await c.contract();
    if (!k.contract) return; // a pre-1.6 Cortex checkout: nothing structured to check
    assert.ok(k.features.includes('structured'));
    await c.call('brain_write', { path: 'Projects/Lakeside.md', content: '# Lakeside\nWe use sqlite for the search index.', mode: 'create' });
    const r = await c.callData('brain_recall', { query: 'lakeside search index', budget: 400 });
    assert.strictEqual(r.data.passages[0].path, 'Projects/Lakeside.md');
    assert.strictEqual(events.length, 0); // COre's own write is not echoed back
    await new Promise((res) => setTimeout(res, 500));
    fs.writeFileSync(path.join(vault, 'Edited in Obsidian.md'), '# Edited in Obsidian\nhello');
    for (let i = 0; i < 40 && !events.length; i++) await new Promise((res) => setTimeout(res, 100));
    assert.deepStrictEqual(events[0][0], 'changed');
    assert.deepStrictEqual(events[0][1].paths, ['Edited in Obsidian.md']);
  } finally { c.dispose(); }
});
