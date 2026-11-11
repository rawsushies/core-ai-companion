'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PB = require('../src/main/playbooks');

const NOTES = `---
name: Meeting Notes
description: Turn a meeting recording into decisions and action items.
triggers:
  - meeting notes
  - minutes
core: archivist
schedule: weekdays 17:30
---

1. Decisions
2. Action items
`;

test('SKILL.md frontmatter is parsed (lists, core, schedule) and validated', () => {
  const s = PB.parseSkill(NOTES, '/x/meeting-notes/SKILL.md');
  assert.strictEqual(s.name, 'meeting-notes');
  assert.match(s.description, /decisions and action items/);
  assert.deepStrictEqual(s.triggers, ['meeting notes', 'minutes']);
  assert.strictEqual(s.core, 'archivist');
  assert.strictEqual(s.schedule, 'weekdays 17:30');
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.body, '1. Decisions\n2. Action items');

  const plain = PB.parseSkill('# Title\nSummarise invoices by vendor.', '/x/invoices.md');
  assert.strictEqual(plain.name, 'invoices');
  assert.strictEqual(plain.description, 'Summarise invoices by vendor.');
  assert.strictEqual(plain.core, 'prime');

  const bad = PB.parseSkill('---\nname: x\ncore: root\nschedule: every 1m\nenabled: no\n---\nbody');
  assert.strictEqual(bad.core, 'prime', 'unknown cores fall back to Prime');
  assert.strictEqual(bad.schedule, '', 'too-frequent schedules are dropped');
  assert.strictEqual(bad.enabled, false);
  assert.strictEqual(PB.parseSkill('---\nname: ../../etc\n---\nx').name, 'etc', 'names are slugs');
});

test('playbooks load from folders and loose .md files; matching uses triggers, then description overlap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-pb-'));
  fs.mkdirSync(path.join(dir, 'meeting-notes'));
  fs.writeFileSync(path.join(dir, 'meeting-notes', 'SKILL.md'), NOTES);
  fs.writeFileSync(path.join(dir, 'invoice-totals.md'), '---\ndescription: Add up supplier invoices and flag duplicates by vendor.\n---\nSteps');
  fs.writeFileSync(path.join(dir, 'off.md'), '---\nname: off-one\ndescription: meeting minutes too\nenabled: false\n---\nx');
  fs.writeFileSync(path.join(dir, 'plugin.json'), '{}');
  const list = PB.loadSkills(dir);
  assert.deepStrictEqual(list.map((s) => s.name), ['invoice-totals', 'meeting-notes', 'off-one']);
  assert.deepStrictEqual(PB.matchSkills(list, 'can you write the meeting notes from this?').map((s) => s.name), ['meeting-notes']);
  assert.deepStrictEqual(PB.matchSkills(list, 'add up these supplier invoices please').map((s) => s.name), ['invoice-totals']);
  assert.deepStrictEqual(PB.matchSkills(list, 'what is the weather'), []);
  assert.match(PB.catalog(list), /meeting-notes \(Turn a meeting/);
  assert.doesNotMatch(PB.catalog(list), /off-one/);
  assert.match(PB.skillBlock(list[1], 'call.m4a'), /^\[Playbook "meeting-notes"\][^\n]*Input: call\.m4a\n1\. Decisions/);
});

test('schedules: daily, weekdays, named days, intervals; next run is strictly later', () => {
  assert.deepStrictEqual(PB.parseSchedule('daily 08:30'), { days: [0, 1, 2, 3, 4, 5, 6], h: 8, min: 30 });
  assert.deepStrictEqual(PB.parseSchedule('mon, wed,fri at 9:05').days, [1, 3, 5]);
  assert.deepStrictEqual(PB.parseSchedule('every 2h'), { every: 120 });
  assert.deepStrictEqual(PB.parseSchedule('hourly'), { every: 60 });
  for (const bad of ['every 5m', 'daily 25:00', 'sometimes', 'weekdays']) assert.strictEqual(PB.parseSchedule(bad), null, bad);

  const fri = new Date(2026, 10, 13, 18, 0).getTime(); // Friday 18:00
  assert.strictEqual(new Date(PB.nextRun('weekdays 17:30', fri)).toString(), new Date(2026, 10, 16, 17, 30).toString(), 'skips the weekend');
  const thu = new Date(2026, 10, 12, 17, 0).getTime();
  assert.strictEqual(PB.nextRun('weekdays 17:30', thu), new Date(2026, 10, 12, 17, 30).getTime());
  assert.strictEqual(PB.nextRun('every 30m', thu), thu + 30 * 60000);
  assert.strictEqual(PB.nextRun('every 30m', thu, thu - 10 * 60000), thu + 20 * 60000, 'intervals count from the last run');
});

test('the scheduler fires on time, remembers the last run, and re-arms', async () => {
  let now = new Date(2026, 10, 12, 17, 29, 0).getTime();
  const timers = [];
  const store = {};
  const ran = [];
  const sch = new PB.Scheduler({
    run: async (s) => { ran.push(s.name); },
    state: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  sch.sync([PB.parseSkill(NOTES, '/x/SKILL.md'), PB.parseSkill('---\nname: idle\n---\nx')]);
  assert.strictEqual(sch.upcoming().length, 1);
  assert.strictEqual(timers[0].at, new Date(2026, 10, 12, 17, 30).getTime());
  now = timers[0].at;
  await timers[0].fn();
  assert.deepStrictEqual(ran, ['meeting-notes']);
  assert.strictEqual(store.playbookRuns['meeting-notes'], now);
  assert.strictEqual(timers[1].at, new Date(2026, 10, 13, 17, 30).getTime(), 'armed for the next weekday');
  sch.stop();
  assert.ok(timers[1].cleared);
});

test('saving a drafted playbook: frontmatter fixed up, plain drafts wrapped, never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-pbs-'));
  const s = PB.saveSkill(dir, '```markdown\n---\nname: something-else\ndescription: Export the weekly report as PDF.\ntriggers: weekly report\n---\n1. Open the sheet\n2. Export\n```', 'Weekly Report');
  assert.strictEqual(s.name, 'weekly-report');
  assert.deepStrictEqual(s.triggers, ['weekly report']);
  assert.match(fs.readFileSync(path.join(dir, 'weekly-report', 'SKILL.md'), 'utf8'), /^---\nname: weekly-report\n/);
  assert.throws(() => PB.saveSkill(dir, 'x', 'weekly-report'), /already exists/);
  const p = PB.saveSkill(dir, 'Check the backup folder.\nThen report sizes.', 'backup-check');
  assert.strictEqual(p.description, 'Check the backup folder.');
  assert.throws(() => PB.saveSkill(dir, 'x', '!!!'), /short name/);
});

test('bundled examples are copied once into an empty folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-pbe-'));
  const n = PB.seedExamples(dir, path.join(__dirname, '..', 'assets', 'skills'));
  assert.ok(n >= 3);
  const list = PB.loadSkills(dir);
  assert.ok(list.find((s) => s.name === 'meeting-notes' && s.core === 'archivist'));
  assert.ok(list.find((s) => s.name === 'daily-briefing' && !s.enabled && s.schedule === 'weekdays 08:45'));
  assert.strictEqual(PB.seedExamples(dir, path.join(__dirname, '..', 'assets', 'skills')), 0);
});
