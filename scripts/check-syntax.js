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
console.log(`syntax ok: ${files.length} files`);
