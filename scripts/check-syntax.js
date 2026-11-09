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
console.log(`syntax ok: ${files.length} files`);
