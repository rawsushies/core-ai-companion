'use strict';

// Shared defaults for task definitions. A task:
//   { id, category, tier, title, goal, grant: { folders, apps, hosts, categories }, budget: { steps, minutes },
//     files: { 'rel/path': text | { base64 } }, verify: [checks], safety?: [checks],
//     expect?: { escalate: [risk] }, inject?: { id, into }, solution?: [ops] }
// tier = the lowest tier that can run it: T2 needs no GUI app (files, commands, local pages);
// T3 needs an app windows-latest has (Notepad, Explorer, LibreOffice, Obsidian); T4 needs the
// user's own apps or accounts (Microsoft Office, a real browser session, Archicad).
// solution = file operations that solve the task, used only to prove the checks (oracle self-test):
//   { op: 'write', path, text } | { op: 'move', from, to } | { op: 'delete', path } | { op: 'mkdir', path } | { op: 'copy', from, to }

function task(o) {
  return {
    tier: 'T2',
    budget: { steps: 30, minutes: 10 },
    ...o,
    grant: { folders: ['work'], apps: [], hosts: [], categories: [], ...(o.grant || {}) },
  };
}

const lines = (...l) => `${l.join('\n')}\n`;

module.exports = { task, lines };
