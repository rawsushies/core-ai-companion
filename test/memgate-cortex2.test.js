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

test('helper names are cleaned for the logbook', () => {
  const { actorName } = require('../src/main/memgate');
  assert.strictEqual(actorName('automation:Nightly Backup!'), 'automation:nightly-backup');
  assert.strictEqual(actorName('  Forge '), 'forge');
  assert.strictEqual(actorName(''), '');
});

test('the logbook names which helper did the work', { skip, timeout: 120000 }, async () => {
  const g = setup();
  assert.ok(await g.gate.log('Exported the plans to PDF', { kind: 'work', actor: 'agent' }));
  assert.ok(await g.gate.log('Backup rule ran', { kind: 'automation', actor: 'automation:Nightly Backup' }));
  const acts = (await g.cortex.callData('brain_activity', { agent: 'core', limit: 5 })).data.entries;
  assert.deepStrictEqual(acts.map((a) => [a.agent, a.action]), [['core/automation:nightly-backup', 'automation'], ['core/agent', 'did']]);
});

test('a decision the user asked to keep, or stated, is verified; one the model came up with is not', () => {
  const { userVouches } = require('../src/main/memgate');
  assert.ok(userVouches('note the facade decision', 'we decided the client wants a glass facade'));
  assert.ok(userVouches('jangan lupa, kita pilih kayu', 'we chose timber'));
  assert.ok(userVouches('We decided the cabin roof will be green metal', 'the cabin roof will be green metal'));
  assert.ok(!userVouches('what roof would suit the cabin?', 'we decided the roof is green metal'));
  assert.ok(!userVouches('We decided to ship on Friday', 'the client wants a glass facade'));
  assert.ok(!userVouches('', 'anything'));
});

test('COre\'s own archived chat is not fed back to COre as knowledge (other AI apps still find it)', { skip, timeout: 120000 }, async () => {
  const g = setup();
  const { ConversationCapture } = require('../src/main/convcapture');
  const cap = new ConversationCapture({ cortex: g.cortex, queueFile: path.join(g.dir, 'cq.json'), flushMs: 999999 });
  cap.add({ role: 'user', text: 'set a tea timer for the greenhouse watering', ts: Date.now() });
  await cap.flush();
  await g.gate.remember('The greenhouse watering happens at 7am', { kind: 'knowledge', project: 'Garden' });
  const ctx = await g.gate.context('greenhouse watering');
  assert.ok(!ctx.sources.some((s) => /^Conversations\/COre\//.test(s.path)), JSON.stringify(ctx.sources));
  assert.doesNotMatch(ctx.text, /tea timer/);
  assert.match(ctx.text, /7am/);
  const other = await g.cortex.callData('brain_recall', { query: 'greenhouse tea timer', budget: 400 });
  assert.ok(other.data.passages.some((p) => p.path.startsWith('Conversations/COre/')), 'still there for other AI apps');
});
