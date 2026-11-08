const test = require('node:test');
const assert = require('node:assert/strict');
const { TagStreamParser, parseTag, stripTags } = require('../src/main/brain/tags');

function run(chunks) {
  const p = new TagStreamParser();
  const out = [];
  for (const c of chunks) out.push(...p.feed(c));
  out.push(...p.flush());
  // merge adjacent text for easy comparison
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (s.type === 'text' && last && last.type === 'text') last.text += s.text;
    else merged.push({ ...s });
  }
  return merged;
}

test('parses point and explain tags', () => {
  assert.deepEqual(parseTag('point 812, 440'), { name: 'point', x: 812, y: 440 });
  assert.deepEqual(parseTag('explain'), { name: 'explain' });
  assert.equal(parseTag('point here'), null);
  assert.equal(parseTag('dance'), null);
});

test('tags split across chunks are recognised and never leak into text', () => {
  const out = run(['Look ', '[[po', 'int 81', '2,440', ']] that button.']);
  assert.deepEqual(out, [
    { type: 'text', text: 'Look ' },
    { type: 'tag', tag: { name: 'point', x: 812, y: 440 } },
    { type: 'text', text: ' that button.' },
  ]);
});

test('single bracket held back then released as text', () => {
  const out = run(['array[', '0] is first']);
  assert.deepEqual(out, [{ type: 'text', text: 'array[0] is first' }]);
});

test('unknown tags are dropped silently', () => {
  const out = run(['Hi [[dance wildly]] there']);
  assert.deepEqual(out, [{ type: 'text', text: 'Hi  there' }]);
});

test('unterminated long bracket run becomes text', () => {
  const long = '[[' + 'x'.repeat(60) + ' and more';
  const out = run([long]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.ok(out[0].text.startsWith('[['));
});

test('stripTags removes tags', () => {
  assert.equal(stripTags('a [[explain]] b [[point 1,2]] c'), 'a b c');
});
