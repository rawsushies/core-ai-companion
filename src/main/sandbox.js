'use strict';

// OS-level isolation for commands the desktop agent runs.
//
// Linux (bubblewrap): the command sees the whole system read-only, a private
// /tmp, an empty home folder, writable access only to the shared project
// folders, no network, its own process and IPC namespaces, and it dies with
// COre. Secrets in the home folder (SSH keys, browser profiles, tokens) are
// simply not there.
//
// Windows (ps/job-run.ps1): a Job Object kills the whole process tree with
// COre, caps process count and memory, and blocks the clipboard, desktop
// switching, system settings and logoff. With isolation 'appcontainer' (the
// default) the command also runs in the COre AppContainer (ps/appcontainer.cs):
// it reads only system folders plus the project folders (read-write) and its
// own program folder, cannot see the user's profile, and has no network. If
// the container cannot be set up the command is refused, not run weaker.
//
// macOS: no backend yet. Commands still run argv-only with a scrubbed
// environment, a folder jail, a timeout and per-command approval; with
// agent.sandbox = 'required' they are refused instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const JOB_RUN = path.join(__dirname, 'ps', 'job-run.ps1');

let probed = null;
// -> { ok, kind, reason }
function detect(platform = process.platform) {
  if (probed && probed.platform === platform) return probed;
  let r = { ok: false, kind: 'none', reason: 'no sandbox backend on this system', platform };
  if (platform === 'win32') r = { ok: true, kind: 'job', platform };
  if (platform === 'linux') {
    const bin = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'].find((b) => fs.existsSync(b));
    if (!bin) r.reason = 'bubblewrap (bwrap) is not installed';
    else {
      const t = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', 'true'], { timeout: 5000, encoding: 'utf8' });
      r = t.status === 0 ? { ok: true, kind: 'bwrap', bin, platform } : { ok: false, kind: 'none', reason: `bubblewrap cannot create a sandbox here (${String(t.stderr || t.error || '').trim().slice(0, 120)})`, platform };
    }
  }
  probed = r;
  return r;
}

// argv -> { file, args, sandboxed, note }. roots: folders the command may write.
function wrap(argv, { cwd, roots = [], network = false, platform = process.platform, home = os.homedir(), memoryMB = 1024, maxProcs = 32, isolation = 'appcontainer' } = {}) {
  const d = detect(platform);
  if (!d.ok) return { file: argv[0], args: argv.slice(1), sandboxed: false, note: d.reason };
  if (d.kind === 'job') {
    const b64 = (v) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
    const box = isolation === 'appcontainer';
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', JOB_RUN, '-Cwd', cwd || '.', '-MemoryMB', String(memoryMB), '-MaxProcs', String(maxProcs), '-Argv', b64(argv)];
    if (box) args.push('-Isolate', '-Roots', b64(roots.filter(Boolean)));
    return {
      file: 'powershell.exe',
      args,
      sandboxed: true,
      level: box ? 'container' : 'process',
      note: box
        ? `sandboxed (Windows AppContainer: writes only in ${roots.map((r) => path.basename(r)).join(', ') || 'nothing'}, profile hidden, no network; Job Object ${memoryMB} MB / ${maxProcs}-process limits)`
        : `sandboxed (Windows Job Object: process tree, ${memoryMB} MB and ${maxProcs}-process limits, no clipboard or system changes; file access is not restricted)`,
    };
  }
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  if (home && fs.existsSync(home)) args.push('--tmpfs', home); // hide the real home folder
  for (const r of roots) if (r && fs.existsSync(r)) args.push('--bind', r, r); // after the tmpfs: project folders stay visible
  args.push('--unshare-all');
  if (network) args.push('--share-net');
  args.push('--die-with-parent', '--new-session', '--setenv', 'HOME', home || '/tmp');
  if (cwd) args.push('--chdir', cwd);
  args.push('--', ...argv);
  return { file: d.bin, args, sandboxed: true, note: `sandboxed: read-only system, writes only in ${roots.map((r) => path.basename(r)).join(', ') || 'nothing'}, ${network ? 'network allowed' : 'no network'}` };
}

function reset() { probed = null; }

module.exports = { detect, wrap, reset };
