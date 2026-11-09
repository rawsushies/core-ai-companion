'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCores, findCore, parseMentions, roleForTask } = require('../src/main/cores');

test('four cores total, Prime first, specialists with distinct colours and voices', () => {
  const c = buildCores();
  assert.deepStrictEqual(c.map((x) => x.id), ['prime', 'scout', 'forge', 'sentinel']);
  assert.strictEqual(new Set(c.map((x) => x.color)).size, 4);
  assert.strictEqual(new Set(c.slice(1).map((x) => x.voice)).size, 3);
  assert.strictEqual(c[0].name, 'COre');
});

test('overrides are validated; ambiguous aliases belong to nobody', () => {
  const c = buildCores([
    { id: 'scout', name: 'Pathfinder', color: '#00FF00', aliases: ['pf', 'shared'] },
    { id: 'forge', name: '<script>', color: 'red', voice: 'rm -rf', aliases: ['shared'] },
    { id: 'evil', name: 'X' },
  ]);
  const scout = c.find((x) => x.id === 'scout');
  const forge = c.find((x) => x.id === 'forge');
  assert.strictEqual(scout.name, 'Pathfinder');
  assert.strictEqual(scout.color, '#00ff00');
  assert.strictEqual(forge.name, 'Forge', 'invalid name ignored');
  assert.strictEqual(forge.color, '#ff7a24');
  assert.strictEqual(forge.voice, 'bm_george');
  assert.strictEqual(c.length, 4, 'unknown ids ignored');
  assert.strictEqual(findCore(c, 'pf').id, 'scout');
  assert.strictEqual(findCore(c, 'shared'), null);
  assert.strictEqual(findCore(c, 'scout').id, 'scout', 'default alias kept');
});

test('mentions route to cores; unknown names are reported, not guessed', () => {
  const c = buildCores();
  assert.deepStrictEqual(parseMentions(c, 'research the best approach'), { targets: [], unknown: [], text: 'research the best approach' });
  assert.deepStrictEqual(parseMentions(c, '@Scout research the best approach'), { targets: ['scout'], unknown: [], text: 'research the best approach' });
  assert.deepStrictEqual(parseMentions(c, '@scout, @SENTINEL: check this'), { targets: ['scout', 'sentinel'], unknown: [], text: 'check this' });
  assert.deepStrictEqual(parseMentions(c, '@Forge @Bob build it'), { targets: ['forge'], unknown: ['Bob'], text: 'build it' });
  assert.deepStrictEqual(parseMentions(c, '@COre explain this').targets, ['prime']);
  assert.deepStrictEqual(parseMentions(c, 'email me@scout.com later').targets, [], 'only leading mentions');
  assert.deepStrictEqual(parseMentions(c, 'Scout, find the docs', { spoken: true }), { targets: ['scout'], unknown: [], text: 'find the docs' });
  assert.deepStrictEqual(parseMentions(c, 'Scout, find the docs').targets, [], 'vocative only when spoken');
  assert.deepStrictEqual(parseMentions(c, 'Well, find the docs', { spoken: true }).targets, []);
});

test('delegated tasks pick a sensible specialist', () => {
  assert.strictEqual(roleForTask('review the login code for security bugs'), 'sentinel');
  assert.strictEqual(roleForTask('research which charting library is lighter'), 'scout');
  assert.strictEqual(roleForTask('write a haiku about rain'), 'forge');
});

test('specialist prompts keep the user text intact and name the role', () => {
  const { corePrompt } = require('../src/main/clones');
  const [, scout] = buildCores();
  const code = 'if (a && b || c < d) { echo "x" | grep y; } 100% done!';
  const p = corePrompt(scout, code);
  assert.ok(p.startsWith('[core Scout]'));
  assert.ok(p.includes(code), 'code and shell symbols survive (prompts go over stdin)');
  assert.match(corePrompt(scout, 'x', { id: 'task-1' }), /shared task task-1/);
});

test('delegate tags parse', () => {
  const { parseTag } = require('../src/main/brain/tags');
  assert.deepStrictEqual(parseTag('delegate Scout compare SQLite and LevelDB'), { name: 'delegate', core: 'Scout', task: 'compare SQLite and LevelDB' });
  assert.strictEqual(parseTag('delegate Scout'), null);
});
