'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { UiaClient, outline } = require('../src/main/uia');
const AG = require('../src/main/agent');

// A fake helper process that answers JSON lines like uia-helper.ps1.
function fakeSpawn(handler) {
  return () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter(); p.stdout.setEncoding = () => {};
    p.stderr = new EventEmitter(); p.stderr.setEncoding = () => {};
    p.stdin = { write: (line) => { const req = JSON.parse(line); setImmediate(() => { const out = handler(req, p); if (out !== undefined) p.stdout.emit('data', `${JSON.stringify({ id: req.id, ...out })}\n`); }); }, end() {} };
    p.kill = () => p.emit('exit', 0);
    return p;
  };
}

const SNAP = {
  window: { name: 'Untitled - Notepad', process: 'notepad' },
  elements: [
    { id: 1, type: 'Window', name: 'Untitled - Notepad', depth: 0, bounds: { x: 0, y: 0, w: 800, h: 600 }, patterns: ['Window'] },
    { id: 2, type: 'Pane', name: '', depth: 1, bounds: { x: 0, y: 0, w: 800, h: 30 }, patterns: [] },
    { id: 3, type: 'MenuItem', name: 'File', depth: 2, bounds: { x: 0, y: 0, w: 40, h: 20 }, patterns: ['ExpandCollapse'], expanded: 'Collapsed' },
    { id: 4, type: 'Document', name: 'Text Editor', aid: '15', depth: 1, bounds: { x: 0, y: 30, w: 800, h: 560 }, patterns: ['Value', 'Text'], value: 'hi', focused: true },
    { id: 5, type: 'Button', name: 'Save', depth: 1, enabled: false, bounds: { x: 700, y: 560, w: 80, h: 30 }, patterns: ['Invoke'] },
    { id: 6, type: 'Button', name: 'Offscreen', depth: 1, bounds: null, patterns: ['Invoke'] },
  ],
};

test('client: JSON-lines requests, errors flag missing patterns, timeouts and helper exits reject', async () => {
  const c = new UiaClient({ spawnImpl: fakeSpawn((req) => {
    if (req.op === 'snapshot') return { ok: true, result: SNAP };
    if (req.op === 'invoke') return { ok: false, error: 'NO_PATTERN: this control has no press action; click its centre instead.' };
    if (req.op === 'hang') return undefined;
    if (req.op === 'die') return undefined;
    return { ok: true, result: 'ok' };
  }), timeoutMs: 200 });
  const s = await c.snapshot();
  assert.strictEqual(s.elements.length, 6);
  assert.strictEqual(c.element(4).type, 'Document');
  await assert.rejects(c.invoke(3), (e) => e.noPattern === true);
  await assert.rejects(c.request('hang'), /timed out/);
  const p = c._ensure();
  const dying = c.request('die');
  p.emit('exit', 1);
  await assert.rejects(dying, /stopped/);
  assert.strictEqual(c.proc, null, 'restarts on next use');
});

test('outline: actionable and named controls only, with state, in a compact form', () => {
  const o = outline(SNAP);
  assert.match(o, /^Window "Untitled - Notepad" \(notepad\)\. Controls:/);
  assert.match(o, /\[3\] MenuItem "File" \(collapsed\)/);
  assert.match(o, /\[4\] Document "Text Editor" #15 value="hi" \(focused\)/);
  assert.match(o, /\[5\] Button "Save" \(disabled\)/);
  assert.doesNotMatch(o, /\[2\]/, 'unnamed layout panes are skipped');
  assert.doesNotMatch(o, /Offscreen/, 'controls without bounds are skipped');
});

test('control actions are validated against the current list', () => {
  const shot = { width: 800, height: 600 };
  assert.strictEqual(AG.validateAction({ type: 'press', el: 3 }, shot, SNAP).action.label, 'MenuItem "File"');
  assert.match(AG.validateAction({ type: 'press', el: 5 }, shot, SNAP).error, /disabled/);
  assert.match(AG.validateAction({ type: 'press', el: 99 }, shot, SNAP).error, /not in the current list/);
  assert.match(AG.validateAction({ type: 'press', el: 3 }, shot, null).error, /UI Automation is not available/);
  assert.strictEqual(AG.validateAction({ type: 'fill', el: 4, text: 'hello' }, shot, SNAP).action.text, 'hello');
  assert.ok(AG.validateAction({ type: 'fill', el: 4, text: 'a\u0007' }, shot, SNAP).error);
  assert.strictEqual(AG.describe(AG.validateAction({ type: 'fill', el: 4, text: 'hello' }, shot, SNAP).action), 'Fill Document "Text Editor" with "hello"');
});

function runner(replies, uia, extra = {}) {
  const prompts = [];
  const performed = [];
  let i = 0;
  const r = new AG.AgentRunner({
    screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1, windows: [] }),
    think: async ({ text }) => { prompts.push(text); return replies[Math.min(i++, replies.length - 1)]; },
    driver: { perform: async (a, p) => { performed.push({ a, p }); } },
    approve: async () => 'yes', openApp: async () => {}, onStep: () => {}, settleMs: 0, verify: false, uia, ...extra,
  });
  return { r, prompts, performed };
}

test('the agent sees the control list and presses, fills and checks controls by id', async () => {
  const calls = [];
  let value = 'hi';
  const uia = {
    snapshot: async () => SNAP,
    invoke: async (el) => { calls.push(['invoke', el]); return 'invoked'; },
    setValue: async (el, t) => { calls.push(['set', el, t]); value = t; },
    value: async () => ({ value }),
    expand: async (el) => { calls.push(['expand', el]); },
    focus: async (el) => { calls.push(['focus', el]); },
  };
  const { r, prompts } = runner(['[[act {"type":"expand","el":3}]]', '[[act {"type":"fill","el":4,"text":"hello world"}]]', '[[act {"type":"done","summary":"typed"}]]'], uia);
  const out = await r.run('type hello world');
  assert.strictEqual(out.status, 'done');
  assert.match(prompts[0], /\[4\] Document "Text Editor"/);
  assert.match(prompts[0], /Control actions \(preferred/);
  assert.deepStrictEqual(calls, [['expand', 3], ['set', 4, 'hello world']]);
  assert.match(prompts[2], /filled and checked/, 'the value was read back');
});

test('fallbacks: a control without a press action is clicked at its centre; a field that ignores text is typed into', async () => {
  const noPattern = () => Object.assign(new Error('NO_PATTERN'), { noPattern: true });
  const uia = { snapshot: async () => SNAP, invoke: async () => { throw noPattern(); }, setValue: async () => { throw noPattern(); }, focus: async () => {}, value: async () => ({ value: 'other' }) };
  const { r, performed, prompts } = runner(['[[act {"type":"press","el":3}]]', '[[act {"type":"fill","el":4,"text":"abc"}]]', '[[act {"type":"done","summary":"x"}]]'], uia);
  await r.run('x');
  assert.deepStrictEqual(performed[0].p, { x: 20, y: 10 }, 'centre of the File menu');
  assert.deepStrictEqual(performed.slice(1).map((x) => x.a.type), ['key', 'type']);
  assert.match(prompts[2], /now reads "other", not what was typed/, 'a mismatch is reported back to the brain');
});
