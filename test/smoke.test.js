'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { smokeTarget, staticChecks, SmokeTest } = require('../src/main/smoke');

const ROOT = path.join(__dirname, '..');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-smoke-')), 'r.json');

test('smoke flag parsing', () => {
  assert.strictEqual(smokeTarget(['electron', '.']), null);
  assert.strictEqual(smokeTarget(['x', '--smoke-test=C:\\t\\r.json']), 'C:\\t\\r.json');
  assert.match(smokeTarget(['x', '--smoke-test']), /core-smoke\.json$/);
});

test('static checks find the real app files and modules', () => {
  const c = staticChecks(ROOT);
  assert.ok(c.length >= 9);
  for (const x of c) assert.ok(x.ok, `${x.name}: ${x.detail || ''}`);
  const broken = staticChecks(os.tmpdir(), Object.assign(() => { throw new Error('no binding'); }, { resolve: () => { throw new Error('missing'); } }));
  assert.ok(broken.every((x) => !x.ok));
});

function run(opts) {
  return new Promise((resolve) => {
    const target = tmp();
    const s = new SmokeTest({ target, root: ROOT, version: '1.0.0', packaged: false, ...opts, onDone: (code, report) => resolve({ code, report, s, file: JSON.parse(fs.readFileSync(target, 'utf8')) }) });
    if (opts.act) opts.act(s);
  });
}

test('passes when the windows load', async () => {
  const r = await run({ act: (s) => { s.mark('dock-loaded'); s.mark('overlay-ready'); } });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.file.ok, true);
});

test('fails on a failed step or a timeout, and always writes a report', async () => {
  const f = await run({ act: (s) => s.mark('overlay-ready', false, 'WebGL2 is not available') });
  assert.strictEqual(f.code, 1);
  assert.match(f.file.error, /overlay-ready failed/);
  const t = await run({ timeoutMs: 50, act: (s) => s.mark('dock-loaded') });
  assert.strictEqual(t.code, 1);
  assert.match(t.file.error, /timed out waiting for: overlay-ready/);
});
