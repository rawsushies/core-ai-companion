'use strict';

// Mission journal (13.0): an append-only, hash-chained, write-ahead log per mission.
// Every side effect is written as an "intent" (fsync'd) BEFORE it happens and a "result"
// after, so a crash at any point leaves a journal that replays to the exact state:
// finished steps, and at most one step "in flight" whose outcome is unknown and must be
// re-observed before the mission continues. The hash chain makes tampering visible.
//
//   missions/<id>/journal.jsonl   one JSON event per line: { seq, at, type, ..., prev, hash }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const H = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

class Journal {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = Journal.read(file);
    this.seq = r.events.length ? r.events[r.events.length - 1].seq : 0;
    this.prev = r.events.length ? r.events[r.events.length - 1].hash : '';
  }

  // Durable append: the line is on disk (fsync) when this returns.
  append(type, data = {}) {
    const ev = { seq: this.seq + 1, at: this.now(), type, ...data, prev: this.prev };
    ev.hash = H(JSON.stringify(ev));
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, `${JSON.stringify(ev)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.seq = ev.seq;
    this.prev = ev.hash;
    return ev;
  }

  // -> { events, intact, brokenAt }
  static read(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { events: [], intact: true, brokenAt: null }; }
    const events = [];
    let prev = '';
    let brokenAt = null;
    const lines = text.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      let ev;
      try { ev = JSON.parse(lines[i]); } catch { if (i === lines.length - 1) break; brokenAt = i + 1; break; } // a torn last line from a crash is dropped
      const { hash, ...rest } = ev;
      if (ev.prev !== prev || H(JSON.stringify(rest)) !== hash) { brokenAt = i + 1; break; }
      events.push(ev);
      prev = hash;
    }
    return { events, intact: brokenAt === null, brokenAt };
  }

  // Rebuild mission state from the journal.
  // -> { id, goal, grant, status, plan, steps: [{ step, action, decision, ok, error }], inFlight, escalations, intact }
  static replay(file) {
    const { events, intact, brokenAt } = Journal.read(file);
    const s = { id: null, goal: '', grant: null, status: 'new', plan: null, steps: [], inFlight: null, escalations: [], intact, brokenAt, lastStep: 0 };
    for (const ev of events) {
      if (ev.type === 'start') Object.assign(s, { id: ev.id, goal: ev.goal, grant: ev.grant || null, status: 'running' });
      else if (ev.type === 'plan') s.plan = ev.plan;
      else if (ev.type === 'intent') s.inFlight = { step: ev.step, action: ev.action, decision: ev.decision };
      else if (ev.type === 'result') {
        s.steps.push({ step: ev.step, action: (s.inFlight && s.inFlight.action) || ev.action, decision: s.inFlight && s.inFlight.decision, ok: ev.ok, error: ev.error || '' });
        s.inFlight = null;
        s.lastStep = Math.max(s.lastStep, ev.step);
      } else if (ev.type === 'escalation') s.escalations.push({ step: ev.step, action: ev.action, answer: ev.answer, reasons: ev.reasons });
      else if (ev.type === 'end') s.status = ev.status;
      else if (ev.type === 'resume') s.status = 'running';
    }
    if (s.status === 'running' && s.inFlight) s.status = 'interrupted';
    return s;
  }
}

module.exports = { Journal };
