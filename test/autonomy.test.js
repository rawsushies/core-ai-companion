'use strict';

// 13.0 foundation: the real agent loop (src/main/agent.js) under a mission grant, with the
// real policy engine, the real FileOps tools (backups) and the write-ahead journal. The
// reasoning is scripted (T1/T2: no model), everything else is the production code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AG = require('../src/main/agent');
const AT = require('../src/main/agentTools');
const { Policy, createGrant, loadKey } = require('../src/main/policy');
const { Journal } = require('../src/main/missions/journal');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-auto-'));
  const W = path.join(root, 'work');
  const SAFE = path.join(root, 'userData');
  fs.mkdirSync(path.join(W, 'report'), { recursive: true });
  fs.writeFileSync(path.join(W, 'report', 'final.txt'), 'final');
  fs.writeFileSync(path.join(W, 'report', 'a.tmp'), 'tmp');
  fs.mkdirSync(path.join(root, 'private'));
  fs.writeFileSync(path.join(root, 'private', 'diary.md'), 'private');
  return { root, W, SAFE, key: loadKey(SAFE) };
}

function runner({ W, SAFE, key }, { grant, script, approve = async () => 'no', journal, taskId = 't1' }) {
  const files = new AT.FileOps({ roots: [W], backupDir: path.join(SAFE, 'agent-backups') });
  const asked = [];
  let i = 0;
  const policy = new Policy({ grant, key, safeguardPaths: [SAFE] });
  const r = new AG.AgentRunner({
    plan: false, verify: false, settleMs: 0, maxSteps: 20, policy,
    think: async () => `[[act ${JSON.stringify(script[Math.min(i++, script.length - 1)])}]]`,
    screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1 }),
    driver: { perform: async () => {} }, openApp: async () => {}, onStep: () => {},
    approve: async (a, info) => { asked.push({ type: a.type, category: info.policy && info.policy.category }); return approve(a, info); },
    tools: {
      read: async (a) => files.read(path.resolve(W, a.path)),
      write: async (a) => { files.write(taskId, path.resolve(W, a.path), a.text); return 'wrote'; },
      rename: async (a) => { files.move(taskId, path.resolve(W, a.from), path.resolve(W, a.to)); return 'moved'; },
      delete: async (a) => { files.remove(taskId, path.resolve(W, a.path)); return 'deleted'; },
      run: async () => 'exit code 0', fetch: async () => '',
    },
    journal: journal ? (e) => journal.append(e.phase, { step: e.step, action: e.action, ...(e.decision ? { decision: { decision: e.decision.decision, category: e.decision.category } } : {}), ...(e.phase === 'result' ? { ok: e.ok, error: e.error } : {}) }) : null,
  });
  return { r, asked, files, policy };
}

test('under a grant, routine work in scope runs with zero approvals; deletion asks; a password is refused', async () => {
  const w = world();
  const grant = createGrant({ goal: 'tidy work/report', folders: [w.W] }, w.key);
  const abs = (p) => path.join(w.W, p);
  const { r, asked } = runner(w, {
    grant,
    script: [
      { type: 'read', path: abs('report') },
      { type: 'delete', path: abs('report/a.tmp') },
      { type: 'write', path: abs('report/summary.md'), text: '# Summary' },
      { type: 'rename', from: abs('report/final.txt'), to: abs('report/final-v1.txt') },
      { type: 'write', path: path.join(w.root, 'private', 'diary.md'), text: 'x' },
      { type: 'done', summary: 'tidied' },
    ],
  });
  const res = await r.run('tidy work/report');
  assert.strictEqual(res.status, 'done');
  assert.ok(fs.existsSync(abs('report/summary.md')));
  assert.ok(fs.existsSync(abs('report/final-v1.txt')));
  assert.ok(fs.existsSync(abs('report/a.tmp')), 'the declined delete did not happen');
  assert.strictEqual(fs.readFileSync(path.join(w.root, 'private', 'diary.md'), 'utf8'), 'private', 'outside the grant untouched');
  assert.deepStrictEqual(asked.map((x) => x.category), ['delete', 'outside-scope'], 'only the high-impact steps asked');
  assert.ok(res.steps.some((s) => s.declined), 'the agent was told the user declined');
});

test('with the delete category granted, deletion in scope needs no approval; credentials are refused outright', async () => {
  const w = world();
  const grant = createGrant({ goal: 'clean temp files', folders: [w.W], categories: ['delete'] }, w.key);
  const ui = { elements: [{ id: 2, type: 'Edit', name: 'Password', patterns: ['Value'], password: true }] };
  const { r, asked } = runner(w, { grant, script: [{ type: 'delete', path: path.join(w.W, 'report/a.tmp') }, { type: 'done', summary: 'ok' }] });
  assert.strictEqual((await r.run('clean')).status, 'done');
  assert.ok(!fs.existsSync(path.join(w.W, 'report/a.tmp')));
  assert.strictEqual(asked.length, 0);
  // A password field: refused by policy (the user types passwords), never asked.
  const p = new Policy({ grant, key: w.key, safeguardPaths: [w.SAFE] });
  const v = AG.validateAction({ type: 'fill', el: 2, text: 'hunter2' }, { width: 800, height: 600 }, ui);
  assert.strictEqual(p.decide(v.action, { ui }).decision, 'deny');
});

test('write-ahead journal: a crash mid-step replays to the in-flight step; undo restores every file', async () => {
  const w = world();
  const grant = createGrant({ goal: 'rewrite the report', folders: [w.W] }, w.key);
  const jf = path.join(w.SAFE, 'missions', 'm1', 'journal.jsonl');
  const j = new Journal(jf);
  j.append('start', { id: 'm1', goal: 'rewrite the report', grant: { id: grant.id } });
  const abs = (p) => path.join(w.W, p);
  const { r, files } = runner(w, { grant, journal: j, taskId: 'm1', script: [{ type: 'write', path: abs('report/final.txt'), text: 'rewritten' }, { type: 'write', path: abs('report/new.md'), text: 'new' }, { type: 'done', summary: 'ok' }] });
  await r.run('rewrite the report');
  let s = Journal.replay(jf);
  assert.strictEqual(s.steps.length, 2);
  assert.strictEqual(s.inFlight, null);
  assert.ok(s.intact);
  // Simulate a crash between an intent and its result.
  j.append('intent', { step: 3, action: { type: 'write', path: abs('report/x.md') } });
  s = Journal.replay(jf);
  assert.strictEqual(s.status, 'interrupted');
  assert.strictEqual(s.inFlight.step, 3, 'the unknown step is known');
  // A torn last line (power loss mid-write) is dropped, not fatal.
  fs.appendFileSync(jf, '{"seq":99,"type":"res');
  assert.ok(Journal.replay(jf).intact);
  // Undo: every change the mission made is restored from the backups.
  assert.strictEqual(fs.readFileSync(abs('report/final.txt'), 'utf8'), 'rewritten');
  const n = files.rollback('m1');
  assert.ok(n >= 2);
  assert.strictEqual(fs.readFileSync(abs('report/final.txt'), 'utf8'), 'final');
  assert.ok(!fs.existsSync(abs('report/new.md')), 'files the mission created are removed');
});

test('journal tampering is detected', () => {
  const w = world();
  const jf = path.join(w.SAFE, 'missions', 'm2', 'journal.jsonl');
  const j = new Journal(jf);
  j.append('start', { id: 'm2', goal: 'g' });
  j.append('intent', { step: 1, action: { type: 'delete', path: 'a' } });
  j.append('result', { step: 1, ok: true });
  const lines = fs.readFileSync(jf, 'utf8').trim().split('\n');
  lines[1] = lines[1].replace('"delete"', '"write"');
  fs.writeFileSync(jf, `${lines.join('\n')}\n`);
  const s = Journal.replay(jf);
  assert.strictEqual(s.intact, false);
  assert.strictEqual(s.brokenAt, 2);
});

test('the dead-man rule: a stopped policy halts the agent before the next action', async () => {
  const w = world();
  const grant = createGrant({ goal: 'g', folders: [w.W] }, w.key);
  const { r, policy } = runner(w, { grant, script: [{ type: 'write', path: path.join(w.W, 'a.md'), text: '1' }, { type: 'write', path: path.join(w.W, 'b.md'), text: '2' }, { type: 'done', summary: 'x' }] });
  const orig = policy.decide.bind(policy);
  let n = 0;
  policy.decide = (a, c) => { if (++n === 2) policy.stop(); return orig(a, c); };
  const res = await r.run('g');
  assert.ok(fs.existsSync(path.join(w.W, 'a.md')));
  assert.ok(!fs.existsSync(path.join(w.W, 'b.md')), 'nothing after the stop');
  assert.notStrictEqual(res.status, 'done');
});

test('hands lease: mouse and keyboard steps wait while the user is busy; tool steps do not', async () => {
  const w = world();
  const grant = createGrant({ goal: 'g', folders: [w.W] }, w.key);
  const files = new AT.FileOps({ roots: [w.W], backupDir: path.join(w.SAFE, 'b') });
  const order = [];
  let userBusy = true;
  setTimeout(() => { userBusy = false; }, 300);
  const script = [{ type: 'write', path: path.join(w.W, 'a.md'), text: '1' }, { type: 'key', combo: 'ctrl+s' }, { type: 'done', summary: 'x' }];
  let i = 0;
  const r = await new AG.AgentRunner({
    plan: false, verify: false, settleMs: 0, maxSteps: 5, policy: new Policy({ grant, key: w.key, safeguardPaths: [w.SAFE] }),
    think: async () => `[[act ${JSON.stringify(script[Math.min(i++, script.length - 1)])}]]`,
    screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1 }),
    driver: { perform: async (a) => { order.push(`${a.type}@${userBusy ? 'busy' : 'idle'}`); } }, openApp: async () => {}, onStep: () => {}, approve: async () => 'no',
    tools: { write: async (a) => { order.push(`write@${userBusy ? 'busy' : 'idle'}`); files.write('t', a.path, a.text); return 'ok'; } },
    waitHands: async () => { while (userBusy) await new Promise((res) => setTimeout(res, 20)); },
  }).run('g');
  assert.strictEqual(r.status, 'done');
  assert.deepStrictEqual(order, ['write@busy', 'key@idle'], 'the file step ran while the user was busy; the key waited');
});
