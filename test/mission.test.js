'use strict';

// Mission engine (13.0 P2): planning into checked subgoals, deterministic verification,
// the judge only without a check, one retry with the failure, then asking; budgets; and a
// full mission through the real agent loop, policy and journal (scripted reasoning).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/main/missions/engine');
const AG = require('../src/main/agent');
const AT = require('../src/main/agentTools');
const { Policy, createGrant, loadKey } = require('../src/main/policy');
const { Journal } = require('../src/main/missions/journal');

const ws = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mission-')); const W = path.join(root, 'work'); fs.mkdirSync(W); return { root, W, SAFE: path.join(root, 'userData') }; };

test('plans parse into subgoals with checks; checks outside the workspace are dropped', () => {
  const p = E.parseMissionPlan('1. Copy the drawings | check: count closeout/*.pdf = 2\n2. Write the register | check: contains closeout/register.csv :: A01 A02\n3. Tell the team | check: none\n4. Sneaky | check: exists ../../etc/passwd\nchatter');
  assert.strictEqual(p.length, 4);
  assert.deepStrictEqual(p[0].check, { type: 'count', glob: 'closeout/*.pdf', n: 2 });
  assert.strictEqual(p[1].check.type, 'contains');
  assert.ok(new RegExp(p[1].check.re, 'i').test('A01 and A02'));
  assert.strictEqual(p[2].check, null);
  assert.strictEqual(p[3].check, null, 'a check that leaves the workspace is not trusted');
  assert.match(E.missionPlanPrompt('g', { grant: { folders: ['/w'] } }), /check: <check>/);
});

test('deterministic verification beats the agent\'s claim; a failed subgoal is retried once with the reason, then the mission asks', async () => {
  const { W } = ws();
  const notes = [];
  let judged = 0;
  const eng = new E.MissionEngine({
    think: async () => '1. Write a.md | check: exists a.md\n2. Write b.md | check: contains b.md :: hello',
    runSubgoal: async (sg, { note }) => {
      notes.push(note);
      if (/a\.md/.test(sg.text)) fs.writeFileSync(path.join(W, 'a.md'), 'x');
      return { status: 'done', summary: 'wrote it', steps: 2 }; // b.md is claimed but never written
    },
    judge: async () => { judged++; return { ok: true, why: 'looks fine' }; },
  });
  const r = await eng.run({ id: 'm', goal: 'two files', grant: { folders: [W], budget: { steps: 50, minutes: 5 } } });
  assert.strictEqual(r.status, 'ask');
  assert.strictEqual(r.subgoals[0].status, 'done');
  assert.strictEqual(r.subgoals[0].evidence.kind, 'deterministic');
  assert.strictEqual(r.subgoals[1].attempts, 2);
  assert.match(notes[2], /did not succeed: contains b\.md/);
  assert.strictEqual(judged, 0, 'the judge is never asked when a file check exists');
  assert.match(r.question, /could not finish "Write b\.md" after two tries/);
  assert.match(E.formatReport(r), /✓ Write a\.md \(verified/);
});

test('without a check, Sentinel judges and the report says it was judged; budgets stop a runaway mission', async () => {
  const { W } = ws();
  const eng = new E.MissionEngine({
    think: async () => '1. Tidy the desktop | check: none',
    runSubgoal: async () => ({ status: 'done', summary: 'closed 3 windows', steps: 3 }),
    judge: async ({ evidence }) => ({ ok: /closed/.test(evidence), why: 'the agent closed the windows it listed' }),
  });
  const r = await eng.run({ id: 'm', goal: 'tidy', grant: { folders: [W] } });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.subgoals[0].evidence.kind, 'judged');
  assert.match(E.formatReport(r), /judged by Sentinel/);
  const runaway = new E.MissionEngine({ think: async () => '1. a | check: exists x\n2. b | check: exists y', runSubgoal: async () => ({ status: 'failed', summary: 'no', steps: 40 }) });
  const r2 = await runaway.run({ id: 'm2', goal: 'g', grant: { folders: [W], budget: { steps: 50, minutes: 5 } } });
  assert.strictEqual(r2.status, 'limit');
  assert.match(r2.reason, /step budget \(50\)/);
});

test('a whole mission through the real agent loop, policy and journal: zero approvals, every subgoal verified from disk', async () => {
  const { W, SAFE } = ws();
  fs.writeFileSync(path.join(W, 'notes.txt'), 'ana, ben there\ndecided: glass facade');
  const key = loadKey(SAFE);
  const grant = createGrant({ goal: 'make minutes and a summary', folders: [W] }, key);
  const journal = new Journal(path.join(SAFE, 'missions', 'm3', 'journal.jsonl'));
  journal.append('start', { id: 'm3', goal: grant.goal });
  const policy = new Policy({ grant, key, safeguardPaths: [SAFE] });
  const files = new AT.FileOps({ roots: [W], backupDir: path.join(SAFE, 'backups') });
  let asked = 0;
  // Scripted reasoning per subgoal (the real loop, policy, tools and journal do the rest).
  const scripts = {
    minutes: [{ type: 'read', path: path.join(W, 'notes.txt') }, { type: 'write', path: path.join(W, 'minutes.md'), text: '## Attendees\nAna, Ben\n## Decisions\nglass facade' }, { type: 'done', summary: 'minutes written' }],
    summary: [{ type: 'write', path: path.join(W, 'summary.md'), text: 'We chose a glass facade.' }, { type: 'done', summary: 'summary written' }],
  };
  const runSubgoal = async (sg, { signal }) => {
    const script = /minutes/i.test(sg.text) ? scripts.minutes : scripts.summary;
    let i = 0;
    const r = await new AG.AgentRunner({
      plan: false, verify: false, settleMs: 0, maxSteps: 10, policy,
      think: async () => `[[act ${JSON.stringify(script[Math.min(i++, script.length - 1)])}]]`,
      screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1 }),
      driver: { perform: async () => {} }, openApp: async () => {}, onStep: () => {},
      approve: async () => { asked++; return 'no'; },
      tools: { read: async (a) => files.read(a.path), write: async (a) => { files.write('m3', a.path, a.text); return 'wrote'; } },
      journal: (e) => journal.append(e.phase, { step: e.step, action: { type: e.action.type, path: e.action.path } }),
    }).run(sg.text);
    return { status: r.status, summary: r.summary, steps: r.steps.length };
  };
  const eng = new E.MissionEngine({ journal, runSubgoal, think: async () => '1. Write the minutes from notes.txt | check: contains minutes.md :: Attendees Decisions glass facade\n2. Write a one-line summary | check: contains summary.md :: glass facade' });
  const r = await eng.run({ id: 'm3', goal: grant.goal, grant });
  assert.strictEqual(r.status, 'done', E.formatReport(r));
  assert.strictEqual(asked, 0, 'routine work in scope needed no approval');
  assert.ok(r.subgoals.every((s) => s.status === 'done' && s.evidence.kind === 'deterministic'));
  const s = Journal.replay(path.join(SAFE, 'missions', 'm3', 'journal.jsonl'));
  assert.ok(s.intact);
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.plan.length, 2);
  assert.ok(s.steps.length >= 3);
});
