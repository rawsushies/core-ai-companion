'use strict';

const test = require('node:test');
const assert = require('node:assert');
const AG = require('../src/main/agent');

const shot = { width: 1000, height: 600, displayWidth: 2000, displayHeight: 1200, displayX: 0, displayY: 0, scaleFactor: 1, windows: [] };

test('actions are validated: bounds, lengths, key allowlist and blocked combos', () => {
  assert.deepStrictEqual(AG.validateAction({ type: 'click', x: 10.4, y: 20, why: 'x' }, shot).action, { type: 'click', x: 10, y: 20, button: 'left', double: false, why: 'x' });
  assert.ok(AG.validateAction({ type: 'click', x: 1000, y: 5 }, shot).error, 'outside the screenshot');
  assert.ok(AG.validateAction({ type: 'type', text: 'x'.repeat(501) }, shot).error);
  assert.ok(AG.validateAction({ type: 'type', text: 'a\u0007b' }, shot).error);
  assert.strictEqual(AG.validateAction({ type: 'type', text: 'hello\nworld' }, shot).action.text, 'hello\nworld');
  assert.strictEqual(AG.validateAction({ type: 'key', combo: 'Ctrl + S' }, shot).action.combo, 'ctrl+s');
  assert.ok(AG.validateAction({ type: 'key', combo: 'ctrl+alt+delete' }, shot).error, 'blocked');
  assert.ok(AG.validateAction({ type: 'key', combo: 'super+l' }, shot).error, 'blocked');
  assert.ok(AG.validateAction({ type: 'key', combo: 'rm -rf /' }, shot).error, 'not a key');
  assert.strictEqual(AG.validateAction({ type: 'scroll', dy: 99 }, shot).action.dy, 20);
  assert.ok(AG.validateAction({ type: 'shell', cmd: 'ls' }, shot).error, 'no such action');
});

test('the action tag is extracted from a reply', () => {
  assert.deepStrictEqual(AG.extractAction('Opening the menu. [[act {"type":"click","x":1,"y":2}]]').raw, { type: 'click', x: 1, y: 2 });
  assert.ok(AG.extractAction('no tag here').error);
  assert.ok(AG.extractAction('[[act {not json}]]').error);
});

test('screenshot pixels map to physical screen pixels', () => {
  assert.deepStrictEqual(AG.toScreen({ x: 100, y: 50 }, shot), { x: 200, y: 100 });
  assert.deepStrictEqual(AG.toScreen({ x: 100, y: 50 }, { ...shot, displayX: 1920, scaleFactor: 1.5 }), { x: 1920 * 1.5 + 300, y: 150 });
});

test('keys map to xdotool names and Windows virtual keys', () => {
  assert.strictEqual(AG.LinuxDriver.xdoCombo('ctrl+enter'), 'ctrl+Return');
  assert.strictEqual(AG.LinuxDriver.xdoCombo('alt+tab'), 'alt+Tab');
  assert.deepStrictEqual(AG.vkCodes('ctrl+s'), [0x11, 0x53]);
  assert.deepStrictEqual(AG.vkCodes('f5'), [0x74]);
});

test('the Linux driver retries a click without --sync when the window manager refuses it', async () => {
  const calls = [];
  const d = new AG.LinuxDriver({ run: async (args) => { calls.push(args); if (args.includes('--sync')) throw new Error('Command failed'); } });
  await d.perform({ type: 'click', button: 'left', double: false }, { x: 5, y: 6 });
  assert.deepStrictEqual(calls, [['mousemove', '--sync', '5', '6', 'click', '1'], ['mousemove', '5', '6'], ['click', '1']]);
});

test('the Linux driver passes arguments as data', async () => {
  const calls = [];
  const d = new AG.LinuxDriver({ run: async (args) => calls.push(args) });
  await d.perform({ type: 'type', text: '$(rm -rf ~); echo hi' });
  await d.perform({ type: 'click', button: 'left', double: false }, { x: 5, y: 6 });
  assert.deepStrictEqual(calls[0], ['type', '--delay', '12', '--', '$(rm -rf ~); echo hi']);
  assert.deepStrictEqual(calls[1], ['mousemove', '--sync', '5', '6', 'click', '1']);
});

function runner(replies, extra = {}) {
  const performed = [];
  const asked = [];
  let i = 0;
  const r = new AG.AgentRunner({ plan: false,
    settleMs: 0,
    screenshot: async () => shot,
    think: async () => replies[Math.min(i++, replies.length - 1)],
    driver: { perform: async (a, p) => performed.push([a.type, p]) },
    approve: async (a, info) => { asked.push(info.label); return extra.answer ? extra.answer(asked.length) : 'yes'; },
    openApp: async () => {},
    onStep: () => {},
    ...extra.deps,
  });
  return { r, performed, asked };
}

test('a task runs step by step with approval and finishes on done', async () => {
  const { r, performed, asked } = runner([
    'Click it. [[act {"type":"click","x":100,"y":50}]]',
    'Wait. [[act {"type":"wait","ms":200}]]',
    'Type. [[act {"type":"type","text":"hi"}]]',
    'Finished. [[act {"type":"done","summary":"typed hi"}]]',
  ]);
  const res = await r.run('type hi');
  assert.strictEqual(res.status, 'done');
  assert.strictEqual(res.summary, 'typed hi');
  assert.deepStrictEqual(performed, [['click', { x: 200, y: 100 }], ['type', null]]);
  assert.deepStrictEqual(asked, ['Click at 100, 50', 'Type "hi"'], 'waiting needs no approval');
});

test('"allow all" stops asking for the rest of the task; "no" ends it', async () => {
  const a = runner(['[[act {"type":"key","combo":"enter"}]]', '[[act {"type":"key","combo":"tab"}]]', '[[act {"type":"done"}]]'], { answer: () => 'all' });
  await a.r.run('x');
  assert.strictEqual(a.asked.length, 1);
  assert.strictEqual(a.performed.length, 2);
  const b = runner(['[[act {"type":"key","combo":"enter"}]]'], { answer: () => 'no' });
  const res = await b.r.run('x');
  assert.strictEqual(res.status, 'stopped');
  assert.strictEqual(b.performed.length, 0);
});

test('invalid actions are retried a little, then the task fails; the step limit holds', async () => {
  const bad = runner(['[[act {"type":"shell","cmd":"ls"}]]']);
  assert.strictEqual((await bad.r.run('x')).status, 'failed');
  const loop = runner(['[[act {"type":"wait","ms":200}]]'], { deps: { maxSteps: 3 } });
  const res = await loop.r.run('x');
  assert.strictEqual(res.status, 'limit');
  assert.strictEqual(res.steps.length, 3);
});

test('stop ends the task before the next action', async () => {
  let r;
  const performed = [];
  r = new AG.AgentRunner({ plan: false,
    settleMs: 0,
    screenshot: async () => shot,
    think: async () => { r.stop('you pressed Esc'); return '[[act {"type":"click","x":1,"y":1}]]'; },
    driver: { perform: async (a) => performed.push(a) },
    approve: async () => 'yes',
    onStep: () => {},
  });
  const res = await r.run('x');
  assert.strictEqual(res.status, 'stopped');
  assert.strictEqual(res.reason, 'you pressed Esc');
  assert.strictEqual(performed.length, 0);
});

test('ask hands the question back to the user', async () => {
  const { r } = runner(['[[act {"type":"ask","question":"Which account?"}]]']);
  assert.deepStrictEqual(await r.run('x').then((x) => [x.status, x.question]), ['ask', 'Which account?']);
});

test('the agent prompt warns about passwords and lists the actions', () => {
  const p = AG.agentPrompt('save the file', [], shot, 1, 25);
  assert.match(p, /Never enter passwords/);
  assert.match(p, /\[\[act/);
});
