'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Notices, unseen } = require('../src/main/notices');

test('phone notices: a short ring, unique ids across restarts, the last hour only; each raised once', () => {
  let t = 1_000_000;
  const a = new Notices({ now: () => t, max: 3 });
  a.add('approval', 'COre needs your answer', 'A step is waiting');
  a.add('mission', 'Mission complete', 'tidy\n  the   report');
  assert.strictEqual(a.recent()[1].body, 'tidy the report', 'whitespace folded');
  for (let i = 0; i < 5; i++) a.add('task', `t${i}`);
  assert.strictEqual(a.recent().length, 3, 'only the newest few are kept');
  t += 61 * 60000;
  assert.strictEqual(a.recent().length, 0, 'an hour later nothing is sent');
  const b = new Notices({ now: () => t + 5 });
  const n = b.add('task', 'x');
  assert.ok(!a.list.some((m) => m.id === n.id), 'a restarted PC never reuses an id');
  // The phone side: what it already showed is not shown again; malformed entries are ignored.
  const list = [{ id: 'k-1', title: 'a' }, { id: 'k-2', title: 'b' }, { title: 'no id' }, null];
  assert.deepStrictEqual(unseen(list, ['k-1']).map((x) => x.id), ['k-2']);
  assert.strictEqual('x'.repeat(200).length > new Notices().add('t', 'x'.repeat(200)).title.length, true, 'titles are capped');
});
