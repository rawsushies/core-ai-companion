const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Updater, isNewer, depsChanged, copyTree, pruneTree } = require('../src/main/updater');

test('version comparison', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('v0.3.0', '0.2.5'), true);
  assert.equal(isNewer('0.1.0', '0.2.0'), false);
  assert.equal(isNewer('garbage', '0.1.0'), false);
});

test('dependency change detection', () => {
  assert.equal(depsChanged({ dependencies: { a: '1' } }, { dependencies: { a: '1' } }), false);
  assert.equal(depsChanged({ dependencies: { a: '1' } }, { dependencies: { a: '2' } }), true);
});

test('copyTree never touches node_modules or .git, pruneTree removes deleted src files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-upd-'));
  const app = path.join(root, 'app');
  const neu = path.join(root, 'new');
  for (const [f, c] of [['src/a.js', 'old'], ['src/gone.js', 'x'], ['node_modules/m/i.js', 'keep'], ['.git/HEAD', 'keep']]) {
    fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true });
    fs.writeFileSync(path.join(app, f), c);
  }
  for (const [f, c] of [['src/a.js', 'new'], ['src/b.js', 'added'], ['node_modules/m/i.js', 'EVIL'], ['package.json', '{}']]) {
    fs.mkdirSync(path.dirname(path.join(neu, f)), { recursive: true });
    fs.writeFileSync(path.join(neu, f), c);
  }
  pruneTree(neu, app, 'src');
  copyTree(neu, app);
  assert.equal(fs.readFileSync(path.join(app, 'src/a.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(app, 'src/b.js'), 'utf8'), 'added');
  assert.equal(fs.existsSync(path.join(app, 'src/gone.js')), false);
  assert.equal(fs.readFileSync(path.join(app, 'node_modules/m/i.js'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(app, '.git/HEAD'), 'utf8'), 'keep');
});

test('updater is off until a source repo is configured, and validates it', async () => {
  const u = new Updater({ appRoot: path.join(__dirname, '..'), getConfig: () => ({ source: '' }), fetchImpl: () => { throw new Error('no fetch'); } });
  assert.equal((await u.check({ quiet: true })).status, 'disabled');
  const bad = new Updater({ appRoot: path.join(__dirname, '..'), getConfig: () => ({ source: 'https://evil.example/x' }), fetchImpl: () => {} });
  await assert.rejects(bad.check({ quiet: true }), /owner\/repo/);
});

test('updater downloads, applies a newer version and reports it', { skip: process.platform === 'win32' || !hasZip() }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-upd2-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'core-companion', version: '0.1.0', dependencies: { x: '1' } }));
  fs.writeFileSync(path.join(app, 'src', 'main.js'), 'old');
  // Build the "GitHub" zip: core-main/package.json + src/main.js
  const stage = path.join(root, 'stage', 'core-main');
  fs.mkdirSync(path.join(stage, 'src'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'core-companion', version: '0.2.0', dependencies: { x: '1' } }));
  fs.writeFileSync(path.join(stage, 'src', 'main.js'), 'new');
  const zip = path.join(root, 'u.zip');
  execFileSync('zip', ['-qr', zip, 'core-main'], { cwd: path.join(root, 'stage') });
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('raw.githubusercontent.com')) return { ok: true, json: async () => ({ version: '0.2.0' }) };
    if (url.includes('codeload.github.com')) {
      const b = fs.readFileSync(zip);
      return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    return { ok: false, status: 404 };
  };
  const logs = [];
  let updatedTo = null;
  let install = null;
  const u = new Updater({ appRoot: app, getConfig: () => ({ source: 'someone/core', branch: 'main' }), fetchImpl: fakeFetch, log: (m) => logs.push(m) });
  const r = await u.check({ onUpdated: (v, needsInstall) => { updatedTo = v; install = needsInstall; } });
  assert.equal(r.status, 'updated');
  assert.equal(updatedTo, '0.2.0');
  assert.equal(install, false, 'same dependencies: no reinstall after restart');
  assert.equal(fs.readFileSync(path.join(app, 'src', 'main.js'), 'utf8'), 'new');
  assert.deepEqual(calls, [
    'https://raw.githubusercontent.com/someone/core/main/package.json',
    'https://codeload.github.com/someone/core/zip/refs/heads/main',
  ]);
  assert.equal((await u.check({ quiet: true })).status, 'current');
});

function hasZip() {
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}
