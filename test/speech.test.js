const test = require('node:test');
const assert = require('node:assert/strict');
const { SentenceChunker, SpeechPlanner, FenceFilter, cleanForSpeech } = require('../src/main/brain/speech');

test('chunker waits for whitespace after a period (decimals survive streaming)', () => {
  const c = new SentenceChunker(1);
  assert.deepEqual(c.feed('Pi is 3.'), []);
  assert.deepEqual(c.feed('14 roughly. Next'), ['Pi is 3.14 roughly.']);
  assert.deepEqual(c.flush(), ['Next']);
});

test('chunker releases the first sentence at once, then merges short ones', () => {
  const c = new SentenceChunker(24);
  assert.deepEqual(c.feed('Fine. '), ['Fine.'], 'first sentence goes out immediately');
  assert.deepEqual(c.feed('Hi. Yes. '), []);
  assert.deepEqual(c.feed('That works well for me. '), ['Hi. Yes. That works well for me.']);
});

test('planner orders speech and gestures as the model wrote them', () => {
  const items = [];
  const p = new SpeechPlanner((i) => items.push(i));
  for (const d of ['Okay, let me show you around here. [[poi', 'nt 10,20]] This is ', 'the **save** button. ']) p.feed(d);
  const full = p.finish();
  assert.deepEqual(items, [
    { type: 'say', text: 'Okay, let me show you around here.' },
    { type: 'gesture', name: 'point', x: 10, y: 20 },
    { type: 'say', text: 'This is the save button.' },
    { type: 'end' },
  ]);
  assert.equal(full, 'Okay, let me show you around here.  This is the **save** button.');
});

test('cleanForSpeech strips markdown', () => {
  assert.equal(cleanForSpeech('# Title\n**bold** and `code` and [link](http://x)'), 'Title bold and code and link');
});

test('cleanForSpeech drops list markers so the voice never says "dash"', () => {
  assert.equal(cleanForSpeech('- Name things well.'), 'Name things well.');
  assert.equal(cleanForSpeech('1. First\n2) Second'), 'First Second');
});

test('code blocks are never spoken, even when the fences arrive split across chunks', () => {
  const said = [];
  let shown = '';
  const p = new SpeechPlanner((i) => { if (i.type === 'say') said.push(i.text); }, { onText: (t) => { shown += t; } });
  for (const d of ['Here is the fix, nothing fancy at all. `', '``js\nconst answer = 42;\nconsole.log(answer);\n`', '``\nThat prints the answer for you. ']) p.feed(d);
  p.finish();
  assert.ok(!said.join(' ').includes('const'), said.join(' | '));
  assert.ok(said.join(' ').includes('That prints the answer'));
  assert.ok(shown.includes('const answer = 42;'), 'the chat still shows the code');
});

test('FenceFilter keeps inline backticks outside fences', () => {
  const f = new FenceFilter();
  assert.equal(f.feed('use `x` here') + f.flush(), 'use `x` here');
});

test('a long opening clause is spoken before the sentence ends', () => {
  const c = new SentenceChunker(24);
  assert.deepEqual(c.feed('Honestly, if you want my opinion, that really depends on what you mean'), ['Honestly,']);
  assert.deepEqual(c.feed(' by fast. And more. '), ['if you want my opinion, that really depends on what you mean by fast.']);
  assert.deepEqual(c.flush(), ['And more.']);
});

test('a short opener like "Here\'s one:" is spoken on its own, right away', () => {
  const c = new SentenceChunker(24);
  assert.deepEqual(c.feed("Here's one: work in a single block"), ["Here's one:"]);
});

test('a long opening with no punctuation is split after a few words', () => {
  const c = new SentenceChunker(24);
  const out = c.feed('so the thing you really want to do first is open the settings and look at the voice panel ');
  assert.equal(out.length, 1);
  assert.ok(out[0].length <= 49 && out[0].split(' ').length >= 5, out[0]);
});
