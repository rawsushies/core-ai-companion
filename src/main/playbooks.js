'use strict';

// Playbooks: reusable skills written as SKILL.md files (the same shape used
// by Claude's Agent Skills, OpenClaw and Open Interpreter), plus scheduled
// workflows. A playbook lives in userData/skills/<name>/SKILL.md (or
// userData/skills/<name>.md):
//
//   ---
//   name: meeting-notes
//   description: Turn a transcript or recording into decisions, owners and dates.
//   triggers: meeting notes, minutes, action items
//   core: archivist            (optional: which core runs it)
//   schedule: weekdays 17:30   (optional: makes it a workflow)
//   enabled: true
//   ---
//   Instructions in plain language...
//
// COre sees every playbook's name and description; a matching playbook's
// instructions join the request. "/skill NAME input" runs one on purpose.

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CORES = ['prime', 'scout', 'forge', 'sentinel', 'archivist', 'navigator'];
const MAX_BODY = 12000;

function slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }

// Frontmatter: simple "key: value" lines (lists as comma-separated or "- item" lines).
function parseSkill(text, file = '') {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  const fm = {};
  let body = src;
  if (m) {
    body = m[2];
    let key = null;
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) { key = kv[1].toLowerCase(); fm[key] = kv[2].trim().replace(/^["']|["']$/g, ''); continue; }
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item && key) fm[key] = fm[key] ? `${fm[key]}, ${item[1].trim()}` : item[1].trim();
    }
  }
  const fallback = file ? (path.basename(file).toLowerCase() === 'skill.md' ? path.basename(path.dirname(file)) : path.basename(file, path.extname(file))) : '';
  const name = slug(fm.name || fallback);
  if (!NAME_RE.test(name)) return null;
  const description = String(fm.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const triggers = String(fm.triggers || fm.when || '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3).slice(0, 12);
  const core = CORES.includes(String(fm.core || '').toLowerCase()) ? String(fm.core).toLowerCase() : 'prime';
  const schedule = fm.schedule && parseSchedule(fm.schedule) ? fm.schedule.trim() : '';
  const enabled = !/^(false|no|off|0)$/i.test(String(fm.enabled ?? 'true'));
  const trimmed = body.trim();
  return { name, description, triggers, core, schedule, enabled, body: trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}\n…(cut)` : trimmed, file };
}

function loadSkills(dir) {
  const out = [];
  const seen = new Set();
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    let file = null;
    if (e.isDirectory()) { const f = path.join(dir, e.name, 'SKILL.md'); if (fs.existsSync(f)) file = f; }
    else if (/\.md$/i.test(e.name)) file = path.join(dir, e.name);
    if (!file) continue;
    try {
      const st = fs.statSync(file);
      if (st.size > 256 * 1024) continue;
      const s = parseSkill(fs.readFileSync(file, 'utf8'), file);
      if (s && !seen.has(s.name)) { seen.add(s.name); out.push(s); }
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

const STOP = new Set('the a an and or to of for in on at is are be with my me i you it this that what how can please do make from about into your our'.split(' '));
const toks = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));

// Playbooks that fit a request: a trigger phrase in the text wins outright;
// otherwise enough overlap with the name and description.
function matchSkills(skills, text, k = 2) {
  const low = String(text || '').toLowerCase();
  const words = new Set(toks(low));
  const scored = [];
  for (const s of skills) {
    if (!s.enabled) continue;
    let score = 0;
    if (s.triggers.some((t) => low.includes(t))) score += 10;
    if (low.includes(s.name.replace(/-/g, ' ')) || low.includes(s.name)) score += 6;
    const desc = new Set([...toks(s.description), ...toks(s.name.replace(/-/g, ' '))]);
    let hit = 0;
    for (const w of desc) if (words.has(w)) hit++;
    if (hit >= 2) score += hit * 1.5;
    if (score >= 3) scored.push({ s, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.s);
}

function catalog(skills) {
  const on = skills.filter((s) => s.enabled);
  if (!on.length) return '';
  return `[Playbooks] Saved how-tos the user can run with /skill NAME: ${on.slice(0, 40).map((s) => `${s.name} (${s.description})`).join('; ')}`;
}

function skillBlock(s, input = '') {
  return `[Playbook "${s.name}"] Follow these saved instructions from the user for this request.${input ? ` Input: ${input}` : ''}\n${s.body}`;
}

// ------------------------------------------------------------------ schedules

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// "daily 08:30" | "weekdays 17:00" | "weekends 10:00" | "mon,wed,fri 09:15" | "every 2h" | "every 30m" | "hourly"
function parseSchedule(s) {
  const t = String(s || '').trim().toLowerCase();
  let m = /^every\s+(\d+)\s*(m|min|minutes?|h|hours?)$/.exec(t);
  if (m) { const mins = Number(m[1]) * (m[2].startsWith('h') ? 60 : 1); return mins >= 15 && mins <= 7 * 1440 ? { every: mins } : null; }
  if (t === 'hourly') return { every: 60 };
  m = /^(daily|every day|weekdays|weekends|((?:sun|mon|tue|wed|thu|fri|sat)(?:\s*,\s*(?:sun|mon|tue|wed|thu|fri|sat))*))\s+(?:at\s+)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[3]);
  const min = Number(m[4]);
  if (h > 23 || min > 59) return null;
  let days = [0, 1, 2, 3, 4, 5, 6];
  if (m[1] === 'weekdays') days = [1, 2, 3, 4, 5];
  else if (m[1] === 'weekends') days = [0, 6];
  else if (m[2]) days = m[2].split(/\s*,\s*/).map((d) => DAYS[d]);
  return { days, h, min };
}

// The next run strictly after `from` (local time).
function nextRun(schedule, from = Date.now(), last = 0) {
  const p = typeof schedule === 'string' ? parseSchedule(schedule) : schedule;
  if (!p) return null;
  if (p.every) {
    const base = last && last > from - p.every * 60000 ? last : from;
    return base + p.every * 60000;
  }
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, p.h, p.min, 0, 0);
    if (c.getTime() > from && p.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

// Runs scheduled playbooks. state: { get(k), set(k,v) } remembers last runs.
class Scheduler {
  constructor({ run, state, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.run = run;
    this.state = state;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map();
  }

  last(name) { return (this.state.get('playbookRuns') || {})[name] || 0; }
  _mark(name, at) { const r = { ...(this.state.get('playbookRuns') || {}) }; r[name] = at; this.state.set('playbookRuns', r); }

  // (Re)arm every enabled scheduled playbook.
  sync(skills) {
    for (const t of this.timers.values()) this.clearTimer(t.timer);
    this.timers.clear();
    for (const s of skills) if (s.enabled && s.schedule) this._arm(s);
  }

  upcoming() { return [...this.timers.values()].map((t) => ({ name: t.skill.name, at: t.at, schedule: t.skill.schedule })).sort((a, b) => a.at - b.at); }

  _arm(s) {
    const at = nextRun(s.schedule, this.now(), this.last(s.name));
    if (!at) return;
    const delay = Math.min(at - this.now(), 2 ** 31 - 1);
    const timer = this.setTimer(() => this._fire(s, at), Math.max(0, delay));
    this.timers.set(s.name, { skill: s, at, timer });
  }

  async _fire(s, at) {
    if (this.now() < at - 1000) { this._arm(s); return; } // a long delay was capped: wait again
    this._mark(s.name, this.now());
    try { await this.run(s); } catch {}
    this._arm(s);
  }

  stop() { for (const t of this.timers.values()) this.clearTimer(t.timer); this.timers.clear(); }
}

// ------------------------------------------------------------------ writing

function skillFile({ name, description, triggers = [], core = '', schedule = '', body }) {
  const lines = ['---', `name: ${slug(name)}`, `description: ${String(description || '').replace(/\n/g, ' ').slice(0, 200)}`];
  if (triggers.length) lines.push(`triggers: ${triggers.join(', ')}`);
  if (core && core !== 'prime') lines.push(`core: ${core}`);
  if (schedule) lines.push(`schedule: ${schedule}`);
  lines.push('enabled: true', '---', '', String(body || '').trim(), '');
  return lines.join('\n');
}

// Save a playbook the brain drafted ("/skill save NAME"). Never overwrites.
function saveSkill(dir, draft, name) {
  const n = slug(name);
  if (!NAME_RE.test(n)) throw new Error('Use a short name: letters, numbers and dashes.');
  const folder = path.join(dir, n);
  if (fs.existsSync(folder) || fs.existsSync(path.join(dir, `${n}.md`))) throw new Error(`A playbook called ${n} already exists.`);
  let text = String(draft || '').trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/m, '$1');
  let s = parseSkill(text, path.join(folder, 'SKILL.md'));
  if (!s || !/^---\n/.test(text)) {
    text = skillFile({ name: n, description: text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || n, body: text });
    s = parseSkill(text, path.join(folder, 'SKILL.md'));
  } else if (s.name !== n) {
    text = text.replace(/^name:.*$/m, `name: ${n}`);
    s = parseSkill(text, path.join(folder, 'SKILL.md'));
  }
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'SKILL.md'), text.endsWith('\n') ? text : `${text}\n`);
  return s;
}

// First run: a few example playbooks so the feature is discoverable.
function seedExamples(dir, examplesDir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).some((f) => f.endsWith('.md') || fs.existsSync(path.join(dir, f, 'SKILL.md')))) return 0;
    let n = 0;
    for (const name of fs.readdirSync(examplesDir)) {
      const src = path.join(examplesDir, name, 'SKILL.md');
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.copyFileSync(src, path.join(dir, name, 'SKILL.md'));
      n++;
    }
    return n;
  } catch { return 0; }
}

module.exports = { parseSkill, loadSkills, matchSkills, catalog, skillBlock, parseSchedule, nextRun, Scheduler, skillFile, saveSkill, seedExamples, slug };
