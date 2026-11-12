// Syntax-checks every JS file without needing Electron.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (/\.(c|m)?js$/.test(f)) files.push(p);
  }
})(path.join(__dirname, '..', 'src'));
(function walkEval(d) { if (!fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (f === 'results') continue; if (fs.statSync(p).isDirectory()) walkEval(p); else if (/\.(c|m)?js$/.test(f)) files.push(p); } })(path.join(__dirname, '..', 'eval'));
files.push(path.join(__dirname, '..', 'boot.js'));
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
// Two top-level functions with the same name: the later one silently replaces
// the earlier everywhere (hoisting). Refuse that.
let dup = 0;
for (const f of files) {
  const seen = new Map();
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (!m) return;
    if (seen.has(m[1])) { console.error(`${path.relative(process.cwd(), f)}:${i + 1}: function ${m[1]} is already declared on line ${seen.get(m[1])}`); dup++; }
    else seen.set(m[1], i + 1);
  });
}
if (dup) process.exit(1);

// One version everywhere: package.json is the source; everything that names the
// current version must agree with it (bump them together; see docs/dev/RELEASING.md).
const ROOT = path.join(__dirname, '..');
const read = (r) => { try { return fs.readFileSync(path.join(ROOT, r), 'utf8'); } catch { return ''; } };
const v = JSON.parse(read('package.json')).version;
const versions = {
  'mobile/package.json': (JSON.parse(read('mobile/package.json') || '{}')).version,
  'RELEASE_NOTES.md (title)': (/^# COre (\S+)/m.exec(read('RELEASE_NOTES.md')) || [])[1],
  'CHANGELOG.md (newest release)': (/^## (\d+\.\d+\.\d+)/m.exec(read('CHANGELOG.md')) || [])[1],
  'README.md (version badge)': (/badge\/version-([\d.]+)-/.exec(read('README.md')) || [])[1],
  'README.md (installer name)': (/COre-Setup-([\d.]+)\.exe/.exec(read('README.md')) || [])[1],
};
const off = Object.entries(versions).filter(([, x]) => x !== v);
if (off.length) { for (const [where, x] of off) console.error(`version: ${where} says ${x || 'nothing'}, package.json says ${v}`); process.exit(1); }
console.log(`syntax ok: ${files.length} files; version ${v} everywhere`);
