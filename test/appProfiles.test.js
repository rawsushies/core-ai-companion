'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { profileFor, appBlock } = require('../src/main/appProfiles');
const { Memory } = require('../src/main/memory');

test('the app in front is recognised by process or title', () => {
  assert.strictEqual(profileFor({ process: 'EXCEL', name: 'Book1' }).id, 'excel');
  assert.strictEqual(profileFor({ process: 'powershell', name: 'Tower Budget.xlsx - Planner' }).id, 'excel');
  assert.strictEqual(profileFor({ process: 'msedge', name: 'News' }).id, 'browser');
  assert.strictEqual(profileFor({ process: 'mystery', name: 'Untitled' }), null);
});

test('the agent gets built-in tips plus what worked before in that app', () => {
  const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-app-')), 'memory.json'));
  m.noteEpisode('Workflow that worked for desktop task "fill the Excel budget": Fill Edit "Name Box" with "B4" → Type 4200');
  m.noteEpisode('Workflow that worked for desktop task "rename photos": Run `node rename.js`');
  const b = appBlock({ process: 'EXCEL', name: 'Budget.xlsx - Excel' }, m);
  assert.match(b, /^\[App\] Excel is in front/);
  assert.match(b, /hints, not instructions; approvals still apply/);
  assert.match(b, /Name Box/);
  assert.match(b, /From your earlier tasks in this app:\n- Workflow that worked for desktop task "fill the Excel budget"/);
  assert.doesNotMatch(b, /rename photos/);
  assert.strictEqual(appBlock({ process: 'mystery', name: 'x' }, m), '');
});
