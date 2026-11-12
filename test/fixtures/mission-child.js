'use strict';

// Child process for test/recovery.test.js: runs the real agent loop under a grant with the
// real policy, FileOps and journal, writing one file per step slowly, until it is killed.
//   node mission-child.js <work dir> <userData dir>

const path = require('path');
const AG = require('../../src/main/agent');
const AT = require('../../src/main/agentTools');
const { Policy, createGrant, loadKey } = require('../../src/main/policy');
const { Journal } = require('../../src/main/missions/journal');

const [W, SAFE] = process.argv.slice(2);
const key = loadKey(SAFE);
const grant = createGrant({ goal: 'write 40 notes', folders: [W] }, key);
const files = new AT.FileOps({ roots: [W], backupDir: path.join(SAFE, 'agent-backups') });
const journal = new Journal(path.join(SAFE, 'missions', 'crash', 'journal.jsonl'));
journal.append('start', { id: 'crash', goal: grant.goal, grant: { id: grant.id } });
let n = 0;
new AG.AgentRunner({
  plan: false, verify: false, settleMs: 0, maxSteps: 40,
  policy: new Policy({ grant, key, safeguardPaths: [SAFE] }),
  think: async () => { n++; return n <= 40 ? `[[act {"type":"write","path":"note-${n}.md","text":"note ${n}"}]]` : '[[act {"type":"done","summary":"x"}]]'; },
  screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1 }),
  driver: { perform: async () => {} }, openApp: async () => {}, onStep: () => {}, approve: async () => 'no',
  tools: { write: async (a) => { await new Promise((r) => setTimeout(r, 40)); files.write('crash', path.resolve(W, a.path), a.text); return 'wrote'; } },
  journal: (e) => journal.append(e.phase, { step: e.step, action: { type: e.action.type, path: e.action.path }, ...(e.phase === 'result' ? { ok: e.ok } : {}) }),
}).run(grant.goal).then(() => process.exit(0));
