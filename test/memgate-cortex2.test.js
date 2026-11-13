'use strict';
// The memory gateway on Cortex 1.8+ (structured results, brain_ingest, review, actor).
// Needs a Cortex checkout with those features (CORTEX_DIR) and Python; skipped otherwise.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version']).status === 0;
const hasIngest = fs.existsSync(path.join(CORTEX_DIR, 'cortex', 'organize.py'));
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)'
  : !pyOk ? 'Python not available' : !hasIngest ? 'this Cortex predates brain_ingest (1.8)' : false;

const clients = [];
test.after(() => { for (const c of clients) c.dispose(); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mg2-'));
  const vault = path.join(dir, 'vault');
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault, env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 60000 });
  clients.push(cortex);
  return { dir, vault, cortex, gate: new MemoryGateway({ memory: null, cortex, queueFile: path.join(dir, 'q.json'), recallTimeoutMs: 30000 }) };
}

test('a verified decision is filed in the project with the helper named; a model proposal waits for review', { skip, timeout: 120000 }, async () => {
  const g = setup();
  const ok = await g.gate.remember('The team decided to use a timber frame', { kind: 'decision', project: 'Cabin', actor: 'forge' });
  assert.strictEqual(ok.stored, 'cortex');
  assert.match(ok.detail, /Projects\/Cabin\.md › Decisions/);
  const note = fs.readFileSync(path.join(g.vault, 'Projects', 'Cabin.md'), 'utf8');
  assert.match(note, /timber frame .*\[type:: decision\].*\[by:: core\/forge\]/);
  const proposed = await g.gate.remember('We decided to paint the cabin red', { kind: 'decision', project: 'Cabin', verified: false, actor: 'prime' });
  assert.strictEqual(proposed.stored, 'review');
  assert.doesNotMatch(fs.readFileSync(path.join(g.vault, 'Projects', 'Cabin.md'), 'utf8'), /paint the cabin red/);
  assert.match(fs.readFileSync(path.join(g.vault, 'Inbox', 'Review.md'), 'utf8'), /paint the cabin red.*\[verified:: false\]/);
  assert.strictEqual((await g.gate.remember('The team decided to use a timber frame', { kind: 'decision', project: 'Cabin' })).stored, 'duplicate');
});

test('recall sources come from structured data and carry the unverified flag', { skip, timeout: 120000 }, async () => {
  const g = setup();
  await g.gate.remember('We decided the cabin roof is green metal', { kind: 'decision', project: 'Cabin', verified: false });
  await g.gate.remember('The cabin roof pitch is 30 degrees, confirmed by the engineer', { kind: 'knowledge', project: 'Cabin' });
  const ctx = await g.gate.context('cabin roof');
  assert.strictEqual(ctx.cortex, 'ok');
  const review = ctx.sources.find((s) => s.path === 'Inbox/Review.md');
  assert.ok(review && review.verified === false, JSON.stringify(ctx.sources));
  assert.match(ctx.text, /\[Unverified\] Inbox\/Review\.md/);
  assert.ok(ctx.sources.some((s) => s.path === 'Projects/Cabin.md' && s.verified !== false));
});

test('the offline queue counts what it has to drop instead of dropping silently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mgq-'));
  const g = new MemoryGateway({ memory: null, cortex: null, queueFile: path.join(dir, 'q.json') });
  const many = Array.from({ length: 5003 }, (_, i) => ({ text: `item ${i}`, kind: 'decision', at: i }));
  g._writeQueue(many);
  assert.strictEqual(g.pending(), 5000);
  assert.strictEqual(g.dropped(), 3);
  assert.strictEqual(g._readQueue()[0].text, 'item 3'); // the oldest go first
});
