'use strict';
// COre's chat archived in Cortex. Unit tests use a fake Cortex; the live test needs a Cortex 2 checkout (CORTEX_DIR).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ConversationCapture, dayOf } = require('../src/main/convcapture');
const { CortexClient } = require('../src/main/cortex');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version']).status === 0;
const hasGateway = fs.existsSync(path.join(CORTEX_DIR, 'cortex_gateway', '__init__.py'));
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : !hasGateway ? 'this Cortex has no memory gateway (2.0+)' : false;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-cap-'));
const T = new Date(2026, 10, 13, 10, 0, 0).getTime();

function fakeCortex({ fail = false, status = 'archived' } = {}) {
  const calls = [];
  return { calls, has: async (f) => f === 'events_ingest', callData: async (name, args) => {
    calls.push(args.events);
    if (fail) throw new Error('Cortex stopped');
    return { data: { results: args.events.map(() => ({ status })) } };
  } };
}

test('only your messages and the cores\' replies are kept, one session per day', async () => {
  const c = fakeCortex();
  const cap = new ConversationCapture({ cortex: c, queueFile: path.join(tmp(), 'q.json'), flushMs: 999999 });
  cap.add({ role: 'user', text: 'plan the cabin roof', ts: T });
  cap.add({ role: 'core', text: 'A metal roof suits it.', ts: T + 1000, author: 'forge' });
  cap.add({ role: 'core', text: 'thinking…', ts: T + 1500, kind: 'progress' });
  cap.add({ role: 'system', text: 'Remembered: x', ts: T + 2000 });
  cap.add({ role: 'core', text: '   ', ts: T + 3000 });
  cap.agentEvent('Desktop task "export PDF": done (verified)', { ts: T + 4000 });
  assert.strictEqual(cap.waiting(), 3);
  const r = await cap.flush();
  assert.strictEqual(r.archived, 3);
  const [evs] = c.calls;
  assert.deepStrictEqual(evs.map((e) => [e.kind, e.message.role]), [['message', 'user'], ['message', 'assistant'], ['agent_event', 'tool']]);
  assert.strictEqual(evs[0].session.id, `core-${dayOf(T)}`);
  assert.strictEqual(evs[1].message.model, 'COre forge');
  assert.strictEqual(cap.waiting(), 0);
});

test('Cortex down: messages wait and go out later; off means nothing is kept', async () => {
  const file = path.join(tmp(), 'q.json');
  const down = new ConversationCapture({ cortex: fakeCortex({ fail: true }), queueFile: file, flushMs: 999999 });
  down.add({ role: 'user', text: 'hello', ts: T });
  assert.strictEqual((await down.flush()).failed, 1);
  assert.strictEqual(down.waiting(), 1);
  const up = new ConversationCapture({ cortex: fakeCortex(), queueFile: file, flushMs: 999999 });
  assert.strictEqual((await up.flush()).archived, 1);
  assert.strictEqual(up.waiting(), 0);
  const off = new ConversationCapture({ cortex: fakeCortex(), queueFile: path.join(tmp(), 'q.json'), enabled: () => false });
  off.add({ role: 'user', text: 'private', ts: T });
  assert.strictEqual(off.waiting(), 0);
});

test('an older Cortex without the gateway: nothing is sent, messages keep waiting', async () => {
  const old = { has: async () => false, callData: async () => { throw new Error('should not be called'); } };
  const cap = new ConversationCapture({ cortex: old, queueFile: path.join(tmp(), 'q.json'), flushMs: 999999 });
  cap.add({ role: 'user', text: 'hi', ts: T });
  assert.deepStrictEqual(await cap.flush(), { sent: 0, unsupported: true });
  assert.strictEqual(cap.waiting(), 1);
});

test('live: COre chat lands in Conversations/COre once, even when sent twice', { skip, timeout: 120000 }, async () => {
  const dir = tmp();
  const vault = path.join(dir, 'vault');
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault, env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 60000 });
  try {
    const cap = new ConversationCapture({ cortex, queueFile: path.join(dir, 'q.json'), flushMs: 999999 });
    const msgs = [{ role: 'user', text: 'what roof should the cabin get? my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123', ts: T }, { role: 'core', text: 'Green metal, 30 degree pitch.', ts: T + 2000, author: 'prime' }];
    msgs.forEach((m) => cap.add(m));
    assert.strictEqual((await cap.flush()).archived, 2);
    msgs.forEach((m) => cap.add(m));
    assert.strictEqual((await cap.flush()).duplicate, 2);
    const dirC = path.join(vault, 'Conversations', 'COre');
    const files = fs.readdirSync(dirC, { recursive: true }).filter((f) => String(f).endsWith('.md'));
    assert.strictEqual(files.length, 1);
    const note = fs.readFileSync(path.join(dirC, files[0]), 'utf8');
    assert.match(note, /provider: core/);
    assert.match(note, /Green metal, 30 degree pitch\./);
    assert.doesNotMatch(note, /sk-ant-abc/); // redacted by Cortex
    const found = await cortex.callData('brain_conversation', { provider: 'core' });
    assert.strictEqual(found.data.conversations[0].session, `core-${dayOf(T)}`);
  } finally { cortex.dispose(); }
});
