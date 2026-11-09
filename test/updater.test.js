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

test('updater (main channel) downloads, applies a newer version and reports it', { skip: !hasZip() }, async () => {
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
  makeZip(zip, 'core-main', path.join(root, 'stage'));
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
  const u = new Updater({ appRoot: app, getConfig: () => ({ source: 'someone/core', branch: 'main', channel: 'main' }), fetchImpl: fakeFetch, log: (m) => logs.push(m), backupDir: path.join(root, 'bak') });
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

// Windows: bsdtar (tar.exe, Windows 10+) writes and reads zips. Elsewhere: zip/unzip.
function makeZip(zip, dir, cwd) {
  if (process.platform === 'win32') execFileSync('tar', ['-a', '-c', '-f', zip, dir], { cwd });
  else execFileSync('zip', ['-qr', zip, dir], { cwd });
}

function hasZip() {
  try {
    if (process.platform === 'win32') { execFileSync('tar', ['--version'], { stdio: 'ignore' }); return true; }
    execFileSync('zip', ['-v'], { stdio: 'ignore' }); execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true;
  } catch { return false; }
}

// A fake install (app/) plus a "GitHub" zip of a new version built from `files`.
function fixture(appFiles, newFiles, top = 'core-v0.2.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-upd3-'));
  const app = path.join(root, 'app');
  const write = (base, files) => {
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true });
      fs.writeFileSync(path.join(base, f), c);
    }
  };
  write(app, appFiles);
  const stage = path.join(root, 'stage');
  write(path.join(stage, top), newFiles);
  const zip = path.join(root, 'u.zip');
  makeZip(zip, top, stage);
  return { root, app, zip };
}

const pkg = (version) => JSON.stringify({ name: 'core-companion', version, dependencies: { x: '1' } });

function releaseFetch(zip, release, calls = []) {
  return async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) return release ? { ok: true, status: 200, json: async () => release } : { ok: false, status: 404 };
    if (url.includes('codeload.github.com')) {
      const b = fs.readFileSync(zip);
      return { ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    }
    return { ok: false, status: 500 };
  };
}

test('release channel (default) follows the latest published release tag', { skip: !hasZip() }, async () => {
  const f = fixture({ 'package.json': pkg('0.1.0'), 'src/main.js': 'old' }, { 'package.json': pkg('0.2.0'), 'src/main.js': 'new' });
  const calls = [];
  let meta = null;
  const u = new Updater({ appRoot: f.app, getConfig: () => ({ source: 'someone/core' }), fetchImpl: releaseFetch(f.zip, { tag_name: 'v0.2.0', draft: false, prerelease: false }, calls), backupDir: path.join(f.root, 'bak') });
  const r = await u.check({ onUpdated: (v, ni, install, m) => { meta = m; } });
  assert.equal(r.status, 'updated');
  assert.equal(fs.readFileSync(path.join(f.app, 'src/main.js'), 'utf8'), 'new');
  assert.deepEqual(calls, ['https://api.github.com/repos/someone/core/releases/latest', 'https://codeload.github.com/someone/core/zip/refs/tags/v0.2.0']);
  assert.equal(meta.from, '0.1.0');
  assert.ok(fs.existsSync(path.join(meta.backup, 'src/main.js')), 'previous version backed up');
  // The backup can bring the old version back (crash-loop rollback uses this).
  u.restore(meta.backup);
  assert.equal(fs.readFileSync(path.join(f.app, 'src/main.js'), 'utf8'), 'old');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, 'package.json'), 'utf8')).version, '0.1.0');
});

test('release channel ignores drafts, pre-releases, odd tags and missing releases', async () => {
  for (const rel of [null, { tag_name: 'v9.9.9', draft: true }, { tag_name: 'v9.9.9', prerelease: true }, { tag_name: 'nightly' }, { tag_name: 'v9.9.9-beta.1' }]) {
    const u = new Updater({ appRoot: path.join(__dirname, '..'), getConfig: () => ({ source: 'someone/core' }), fetchImpl: releaseFetch(null, rel) });
    assert.equal((await u.check({ quiet: true })).status, 'current', JSON.stringify(rel));
  }
});

test('a release whose code has a different version is refused, and nothing changes', { skip: !hasZip() }, async () => {
  const f = fixture({ 'package.json': pkg('0.1.0'), 'src/main.js': 'old' }, { 'package.json': pkg('6.6.6'), 'src/main.js': 'evil' });
  const u = new Updater({ appRoot: f.app, getConfig: () => ({ source: 'someone/core' }), fetchImpl: releaseFetch(f.zip, { tag_name: 'v0.2.0' }), backupDir: path.join(f.root, 'bak') });
  await assert.rejects(u.check({ quiet: true }), /refusing update: v0.2.0 contains version 6.6.6.*kept v0.1.0/);
  assert.equal(fs.readFileSync(path.join(f.app, 'src/main.js'), 'utf8'), 'old');
});

test('an update that fails half-way is rolled back completely', { skip: !hasZip() }, async () => {
  // The new version turns the assets folder into a file: copying fails after
  // src/ was already pruned, the worst moment to stop.
  const f = fixture(
    { 'package.json': pkg('0.1.0'), 'src/main.js': 'old', 'src/old-module.js': 'still needed', 'assets/icon.png': 'png' },
    { 'package.json': pkg('0.2.0'), 'src/main.js': 'new', 'assets': 'not a folder' },
  );
  const u = new Updater({ appRoot: f.app, getConfig: () => ({ source: 'someone/core' }), fetchImpl: releaseFetch(f.zip, { tag_name: 'v0.2.0' }), backupDir: path.join(f.root, 'bak') });
  await assert.rejects(u.check({ quiet: true }), /kept v0.1.0/);
  assert.equal(fs.readFileSync(path.join(f.app, 'src/main.js'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(f.app, 'src/old-module.js'), 'utf8'), 'still needed');
  assert.equal(fs.readFileSync(path.join(f.app, 'assets/icon.png'), 'utf8'), 'png');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, 'package.json'), 'utf8')).version, '0.1.0');
});

test('restore refuses an incomplete backup', () => {
  const u = new Updater({ appRoot: os.tmpdir(), getConfig: () => ({}) });
  assert.throws(() => u.restore(fs.mkdtempSync(path.join(os.tmpdir(), 'core-nobak-'))), /no complete backup/);
});
