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
  await new Promise((r) => setTimeout(r, delayMs));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));
  return { W, SAFE, s: Journal.replay(path.join(SAFE, 'missions', 'crash', 'journal.jsonl')) };
}

test('SIGKILL at random moments: the journal always matches the disk; undo restores the folder', { timeout: 120000 }, async () => {
  const delays = [350, 520, 700, 880, 1100];
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
