'use strict';

// The Windows Job Object sandbox against the real OS. Windows only (CI windows-latest).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SBX = require('../src/main/sandbox');
const T = require('../src/main/agentTools');

const win = process.platform === 'win32';
const dir = win ? fs.mkdtempSync(path.join(os.tmpdir(), 'core-job-')) : '';
const run = (code, opts = {}) => { const w = SBX.wrap([process.execPath, '-e', code], { cwd: dir, roots: [dir], ...opts }); assert.ok(w.sandboxed); return T.runCommand([w.file, ...w.args], { cwd: dir, timeoutMs: opts.timeoutMs || 60000 }); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Windows job: commands run and return output inside the job', { skip: !win, timeout: 90000 }, async () => {
  const r = await run("console.log('inside the job')");
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /inside the job/);
});

test('Windows job: a timeout kills the whole process tree, grandchildren included', { skip: !win, timeout: 90000 }, async () => {
  const pidFile = path.join(dir, 'grandchild.pid');
  const code = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(()=>{},1000);`;
  const r = await run(code, { timeoutMs: 6000 });
  assert.ok(r.timedOut);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) { await new Promise((res) => setTimeout(res, 300)); gone = !alive(pid); }
  assert.ok(gone, `grandchild ${pid} was killed with the job`);
});

test('Windows job: process count and memory are capped', { skip: !win, timeout: 90000 }, async () => {
  // Children run at the same time (sequential ones never exceed the cap).
  const many = await run("const cp=require('child_process');let ok=0,fail=0;const kids=[];for(let i=0;i<8;i++){try{const c=cp.spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{stdio:'ignore'});if(c.pid)ok++;else fail++;c.on('error',()=>{});kids.push(c)}catch{fail++}}console.log('ok',ok,'fail',fail);kids.forEach(k=>{try{k.kill()}catch{}})", { maxProcs: 3 });
  assert.match(many.out, /fail [1-9]/, `some children refused: ${many.out}`);
  const big = await run("try{const a=[];for(let i=0;i<64;i++)a.push(Buffer.alloc(32*1024*1024,1));console.log('LEAK')}catch(e){console.log('blocked',e.message)}", { memoryMB: 256 });
  assert.doesNotMatch(big.out, /LEAK/, `memory cap enforced (exit ${big.code}): ${big.out.slice(0, 200)}`);
});

test('Windows job: no clipboard access', { skip: !win, timeout: 90000 }, async () => {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Set-Clipboard -Value 'secret-from-outside'"]);
  const r = await run("const r=require('child_process').spawnSync('powershell.exe',['-NoProfile','-Command','Get-Clipboard'],{encoding:'utf8'});console.log('clip=['+String(r.stdout).trim()+']')");
  assert.doesNotMatch(r.out, /secret-from-outside/, r.out);
});

// AppContainer boundary: real unauthorized operations, each compared with the
// same operation outside the container so a pass proves the boundary, not a
// broken command.
const http = require('http');
const outsideDir = win ? fs.mkdtempSync(path.join(os.tmpdir(), 'core-outside-')) : '';
const homeSecret = win ? path.join(os.homedir(), `core-secret-${process.pid}.txt`) : '';

test('Windows AppContainer: commands run, and may write inside the project folder', { skip: !win, timeout: 90000 }, async () => {
  const w = SBX.wrap([process.execPath, '-e', '0'], { cwd: dir, roots: [dir] });
  assert.strictEqual(w.level, 'container');
  const target = path.join(dir, 'made-inside.txt');
  const r = await run(`require('fs').writeFileSync(${JSON.stringify(target)}, 'ok'); console.log('wrote')`);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'ok');
});

test('Windows AppContainer: files outside the project (home, other folders) cannot be read or written', { skip: !win, timeout: 90000 }, async () => {
  fs.writeFileSync(homeSecret, 'home-secret-value');
  const otherSecret = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(otherSecret, 'other-secret-value');
  try {
    const probe = `const fs=require('fs');const t=(f)=>{try{f();return 'ALLOWED'}catch(e){return 'denied:'+e.code}};
console.log('readHome', t(()=>fs.readFileSync(${JSON.stringify(homeSecret)},'utf8')));
console.log('readOther', t(()=>fs.readFileSync(${JSON.stringify(otherSecret)},'utf8')));
console.log('writeHome', t(()=>fs.writeFileSync(${JSON.stringify(path.join(os.homedir(), `core-planted-${process.pid}.txt`))},'x')));
console.log('listHome', t(()=>fs.readdirSync(${JSON.stringify(os.homedir())})));`;
    const boxed = await run(probe);
    for (const k of ['readHome', 'readOther', 'writeHome', 'listHome']) assert.match(boxed.out, new RegExp(`${k} denied:`), `${k} must be denied in the container:\n${boxed.out}`);
    assert.doesNotMatch(boxed.out, /secret-value/);
    // The same probe outside the container succeeds: the denial comes from the boundary.
    const plain = await run(probe.replace(/console\.log\('writeHome'[^\n]*\n/, ''), { isolation: 'job' });
    assert.match(plain.out, /readHome ALLOWED/, plain.out);
  } finally {
    try { fs.unlinkSync(homeSecret); } catch {}
    try { fs.unlinkSync(path.join(os.homedir(), `core-planted-${process.pid}.txt`)); } catch {}
  }
});

test('Windows AppContainer: no network, not even the host loopback', { skip: !win, timeout: 90000 }, async () => {
  const srv = http.createServer((q, s) => s.end('reachable')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/`;
    const probe = `require('http').get(${JSON.stringify(url)},(s)=>{let b='';s.on('data',(d)=>b+=d);s.on('end',()=>console.log('NET',b))}).on('error',(e)=>console.log('blocked',e.code)).setTimeout(5000,function(){console.log('blocked timeout');this.destroy()})`;
    const boxed = await run(probe);
    assert.match(boxed.out, /blocked/, boxed.out);
    assert.doesNotMatch(boxed.out, /NET reachable/);
    const plain = await run(probe, { isolation: 'job' });
    assert.match(plain.out, /NET reachable/, plain.out);
  } finally { srv.close(); }
});
