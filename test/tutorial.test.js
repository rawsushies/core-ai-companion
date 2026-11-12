'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Tutorial, LESSONS, fill } = require('../src/main/tutorial');

const GESTURES = require('fs').readFileSync(require('path').join(__dirname, '../src/renderer/overlay/gestures.js'), 'utf8');

test('every lesson is well formed and uses gestures the orb knows', () => {
  const ids = new Set();
  for (const l of LESSONS) {
    assert.ok(!ids.has(l.id), `duplicate lesson ${l.id}`); ids.add(l.id);
    assert.ok(l.title && l.steps.length >= 3, l.id);
    for (const s of l.steps) {
      assert.ok(s.say && s.say.length < 260, `${l.id}: step text`);
      assert.doesNotMatch(s.say, /["&|<>^%!]/, `${l.id}: speech text must be safe for the system voice`);
      if (s.gesture) assert.match(GESTURES, new RegExp(`\\b${s.gesture}:`), `${l.id}: unknown gesture ${s.gesture}`);
      if (s.task) assert.ok(s.task.hint && typeof s.task.match === 'function', `${l.id}: task`);
    }
  }
});

test('a lesson waits for its task, then moves on; finishing records it', () => {
  let saved = null;
  const t = new Tutorial({ save: (p) => { saved = p; } });
  const c = t.start('basics');
  assert.strictEqual(c.lesson.id, 'basics');
  assert.strictEqual(c.index, 0);
  assert.deepStrictEqual(saved.active, { lesson: 'basics', step: 0 });
  t.advance(); // to the "type hello" step
  assert.strictEqual(t.observe({ text: '/vault' }), null, 'a command is not "type a message"');
  assert.deepStrictEqual(t.observe({ text: 'hello' }), { completed: true });
  t.advance(); // to the voice step
  assert.strictEqual(t.observe({ text: 'hello again' }), null, 'typing does not finish a voice task');
  assert.deepStrictEqual(t.observe({ text: 'hello', voice: true }), { completed: true });
  let r;
  do r = t.advance(); while (r && !r.finished);
  assert.strictEqual(r.finished.id, 'basics');
  assert.ok(!t.running);
  assert.deepStrictEqual(saved.done, ['basics']);
  assert.strictEqual(t.next().id, 'memory');
});

test('next, skip and stop are tutorial words only while a lesson runs', () => {
  const t = new Tutorial();
  assert.strictEqual(t.observe({ text: 'next' }), null, 'no lesson: the brain answers');
  t.start('vault');
  assert.deepStrictEqual(t.observe({ text: 'Next.' }), { control: 'next' });
  assert.deepStrictEqual(t.observe({ text: 'skip' }), { control: 'next' });
  assert.deepStrictEqual(t.observe({ text: 'stop' }), { control: 'stop' });
  assert.strictEqual(t.observe({ text: 'next week we ship' }), null, 'ordinary sentences are not controls');
  assert.deepStrictEqual(t.observe({ text: '/vault' }), { completed: true });
});

test('progress survives a restart and unknown saved lessons are dropped', () => {
  const t = new Tutorial({ progress: { done: ['basics', 'gone'], active: { lesson: 'vault', step: 2 } } });
  assert.deepStrictEqual([...t.done], ['basics']);
  assert.strictEqual(t.current().index, 2);
  assert.strictEqual(new Tutorial({ progress: { active: { lesson: 'nope', step: 1 } } }).running, false);
});

test('lessons are found by id, number or title; the menu shows progress', () => {
  assert.strictEqual(Tutorial.lesson('2').id, 'memory');
  assert.strictEqual(Tutorial.lesson('Desk').id, 'desktop');
  assert.strictEqual(Tutorial.lesson('knowledge vault').id, 'vault');
  assert.strictEqual(Tutorial.lesson('nothing'), null);
  const t = new Tutorial({ progress: { done: ['basics'] } });
  assert.match(t.menu(), /✓ Talking with COre/);
  assert.match(t.menu(), /2\. What COre remembers/);
  assert.match(t.menu(), /start the next one: What COre remembers/);
  t.reset();
  assert.strictEqual(t.done.size, 0);
});

test('placeholders are filled with the user\'s hotkeys', () => {
  assert.strictEqual(fill('Press {listen} or {x}', { listen: 'Ctrl+Space' }), 'Press Ctrl+Space or {x}');
});
