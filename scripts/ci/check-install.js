'use strict';

// Installer completeness gate: after a silent install, every COre source file and
// asset the build includes must be in the installed app, the bundled Cortex and
// models must be there, and the installed Cortex.exe must work as COre's
// knowledge engine (MCP: write a decision into a fresh vault, recall it).
//   node scripts/ci/check-install.js <install dir>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BUNDLED } = require('../../src/main/smoke');
const { CortexClient } = require('../../src/main/cortex');
const { MemoryGateway } = require('../../src/main/memgate');
const { Memory } = require('../../src/main/memory');

const ROOT = path.join(__dirname, '..', '..');
const dir = path.resolve(process.argv[2] || '');
const res = path.join(dir, 'resources');
const app = path.join(res, 'app');
const fail = [];

// Mirrors package.json build.files exclusions that apply to src/ and assets/.
const excluded = (rel) => /\.map$/.test(rel) || rel.startsWith('assets/brand/v11/');
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const r = rel ? `${rel}/${e.name}` : e.name;
  return e.isDirectory() ? walk(path.join(d, e.name), r) : [r];
});
const expected = [...walk(path.join(ROOT, 'src')).map((r) => `src/${r}`), ...walk(path.join(ROOT, 'assets')).map((r) => `assets/${r}`), 'boot.js', 'package.json'].filter((r) => !excluded(r));
const missing = expected.filter((r) => !fs.existsSync(path.join(app, r)));
if (missing.length) fail.push(`${missing.length} app file(s) missing, e.g. ${missing.slice(0, 5).join(', ')}`);
console.log(`app files: ${expected.length - missing.length}/${expected.length} present`);

const BUNDLED_HERE = BUNDLED.map((r) => (process.platform === 'win32' ? r : r.replace(/Cortex\.exe$/, 'Cortex')));
for (const rel of BUNDLED_HERE) if (!fs.existsSync(path.join(res, rel))) fail.push(`bundled ${rel} missing`);
console.log(`bundled: ${BUNDLED_HERE.filter((r) => fs.existsSync(path.join(res, r))).length}/${BUNDLED_HERE.length} present`);
try { console.log(fs.readFileSync(path.join(res, 'cortex', 'SOURCE.txt'), 'utf8').trim()); } catch {}

(async () => {
  const exe = path.join(res, 'cortex', process.platform === 'win32' ? 'Cortex.exe' : 'Cortex');
  if (fs.existsSync(exe)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-inst-'));
    const cortex = new CortexClient({ cfg: { command: exe, args: ['mcp'], vault: path.join(tmp, 'vault'), env: { CORTEX_LOCAL_DIR: path.join(tmp, 'local') } }, timeoutMs: 60000 });
    const gate = new MemoryGateway({ memory: new Memory(path.join(tmp, 'm.json')), cortex, queueFile: path.join(tmp, 'q.json'), recallTimeoutMs: 60000 });
    try {
      const r = await gate.remember('The installer test decided the lobby is terrazzo', { kind: 'decision', project: 'Install Check' });
      if (r.stored !== 'cortex') throw new Error(`write went to ${r.stored}`);
      if (!fs.existsSync(path.join(tmp, 'vault', 'Projects', 'Install Check.md'))) throw new Error('note not written to the vault');
      const c = await gate.context('lobby terrazzo installer');
      if (!/terrazzo/.test(c.text)) throw new Error('recall did not find the note');
      console.log('bundled Cortex: MCP write + recall OK');
    } catch (err) { fail.push(`bundled Cortex does not work: ${err.message}`); } finally { cortex.dispose(); }
  }
  if (fail.length) { console.error(`INSTALL CHECK FAILED:\n- ${fail.join('\n- ')}`); process.exit(1); }
  console.log('install check passed');
})();
