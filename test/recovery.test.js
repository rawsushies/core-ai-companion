'use strict';

// Recovery (13.0, T2): a real OS process runs a mission and is killed with SIGKILL at
// random moments. After each kill the journal must replay to a state that matches the
// disk exactly, and undo must restore the folder to what it was before the mission.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Journal } = require('../src/main/missions/journal');
const AT = require('../src/main/agentTools');

const CHILD = path.join(__dirname, 'fixtures', 'mission-child.js');

async function killedRun(delayMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-crash-'));
  const W = path.join(root, 'work');
  const SAFE = path.join(root, 'userData');
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, 'keep.md'), 'existing');
  const child = spawn(process.execPath, [CHILD, W, SAFE], { stdio: 'ignore' });
  // Start the clock once the mission has made progress (a busy machine starts Node slowly).
  const jf = path.join(SAFE, 'missions', 'crash', 'journal.jsonl');
  for (let i = 0; i < 200 && !/"type":"result"/.test(fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, delayMs));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  return { W, SAFE, s: Journal.replay(path.join(SAFE, 'missions', 'crash', 'journal.jsonl')) };
}

test('SIGKILL at random moments: the journal always matches the disk; undo restores the folder', { timeout: 120000 }, async () => {
  const delays = [0, 90, 170, 260, 410];
  for (const ms of delays) {
    const { W, SAFE, s } = await killedRun(ms);
    assert.ok(s.intact, `journal intact after a kill at ${ms} ms`);
    assert.strictEqual(s.id, 'crash');
    // Every step the journal says finished is on disk.
    for (const st of s.steps) assert.ok(fs.existsSync(path.join(W, st.action.path)), `${st.action.path} finished but missing (kill at ${ms} ms)`);
    // Nothing is on disk that the journal does not know about (finished, or the one in flight).
    const known = new Set([...s.steps.map((x) => x.action.path), ...(s.inFlight ? [s.inFlight.action.path] : []), 'keep.md']);
    for (const f of fs.readdirSync(W)) if (!f.endsWith('.core-tmp')) assert.ok(known.has(f), `${f} on disk but not in the journal (kill at ${ms} ms)`);
    assert.ok(s.steps.length >= 1, `the mission made progress before the kill at ${ms} ms`);
    // Undo restores the folder exactly: only the pre-existing file remains, unchanged.
    new AT.FileOps({ roots: [W], backupDir: path.join(SAFE, 'agent-backups') }).rollback('crash');
    const left = fs.readdirSync(W).filter((f) => !f.endsWith('.core-tmp'));
    assert.deepStrictEqual(left, ['keep.md'], `after undo (kill at ${ms} ms)`);
    assert.strictEqual(fs.readFileSync(path.join(W, 'keep.md'), 'utf8'), 'existing');
  }
});

test('a crash while the undo manifest is being written leaves the previous manifest intact; undo also removes cut-off writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-man-'));
  const W = path.join(root, 'work');
  fs.mkdirSync(W);
  fs.writeFileSync(path.join(W, 'keep.md'), 'existing');
  const files = new AT.FileOps({ roots: [W], backupDir: path.join(root, 'b') });
  files.write('t', path.join(W, 'keep.md'), 'changed');
  files.write('t', path.join(W, 'new.md'), 'new');
  const man = path.join(root, 'b', 't', 'manifest.json');
  // The crash: the next manifest was only half written, and a file write was cut off.
  fs.writeFileSync(`${man}.tmp`, '[{"path":');
  fs.writeFileSync(path.join(W, 'new.md.core-tmp'), 'partial');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(man, 'utf8')), 'the manifest itself is never torn');
  files.rollback('t');
  assert.deepStrictEqual(fs.readdirSync(W).sort(), ['keep.md']);
  assert.strictEqual(fs.readFileSync(path.join(W, 'keep.md'), 'utf8'), 'existing');
});
