'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProjectTools, LIMITS } = require('../src/main/tools');
const { parseTag } = require('../src/main/brain/tags');

function project() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'core-tools-'));
  const root = path.join(base, 'proj');
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  w('src/app.js', 'function main() {\n  // TODO: handle errors\n  return 42;\n}\n');
  w('README.md', '# Demo project\n');
  w('.env', 'API_KEY=supersecret');
  w('config/credentials.json', '{"token":"x"}');
  w('keys/server.pem', '-----BEGIN PRIVATE KEY-----');
  w('node_modules/lib/index.js', 'TODO inside deps');
  w('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
  w('big.txt', 'x'.repeat(LIMITS.readBytes + 5000));
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside secret');
  try { fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'link-out.txt')); } catch {}
  return { base, root, t: new ProjectTools({ root }) };
}

test('reads, lists and searches inside the shared folder', () => {
  const { t } = project();
  const r = t.read('src/app.js');
  assert.ok(r.ok && r.text.includes('return 42'));
  assert.match(r.summary, /read src\/app.js/);
  const l = t.list('.');
  assert.ok(l.text.includes('src/') && l.text.includes('README.md'));
  assert.ok(!l.text.includes('.env') && !l.text.includes('node_modules'), 'secrets and noise hidden from listings');
  const f = t.find('todo');
  assert.ok(f.text.includes('src/app.js:2'));
  assert.ok(!f.text.includes('node_modules'), 'dependency folders skipped');
});

test('nothing outside the folder is reachable', () => {
  const { base, t } = project();
  for (const p of ['../outside.txt', 'src/../../outside.txt', path.join(base, 'outside.txt'), '/etc/passwd', 'C:\\Windows\\win.ini', '~/.ssh/id_rsa']) {
    const r = t.run({ tool: 'read', arg: p });
    assert.strictEqual(r.ok, false, p);
  }
  if (fs.existsSync(path.join(t.root, 'link-out.txt'))) {
    const r = t.run({ tool: 'read', arg: 'link-out.txt' });
    assert.strictEqual(r.ok, false, 'symlink escaping the folder refused');
    assert.match(r.error, /outside/);
  }
});

test('secret-looking files are never read', () => {
  const { t } = project();
  for (const p of ['.env', 'config/credentials.json', 'keys/server.pem']) {
    const r = t.run({ tool: 'read', arg: p });
    assert.strictEqual(r.ok, false, p);
    assert.match(r.error, /secret/);
  }
});

test('binary files refused, big files capped, nothing shared when disabled', () => {
  const { root, t } = project();
  assert.match(t.run({ tool: 'read', arg: 'img.bin' }).error, /binary/);
  const big = t.read('big.txt');
  assert.ok(big.text.length <= LIMITS.outChars + 200);
  assert.match(big.text, /output cut|file continues/);
  assert.match(new ProjectTools({ root, enabled: false }).run({ tool: 'list', arg: '.' }).error, /No project folder/);
  assert.match(new ProjectTools({ root: '' }).run({ tool: 'read', arg: 'x' }).error, /No project folder/);
});

test('tool tags parse; unknown tools are refused', () => {
  assert.deepStrictEqual(parseTag('read src/app.js'), { name: 'tool', tool: 'read', arg: 'src/app.js' });
  assert.deepStrictEqual(parseTag('list'), { name: 'tool', tool: 'list', arg: '.' });
  const { t } = project();
  assert.strictEqual(t.run({ tool: 'write', arg: 'x' }).ok, false);
});
