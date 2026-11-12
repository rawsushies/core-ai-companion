'use strict';

// Turn latency tracer: how long each step of a conversation turn takes, measured
// on the real path (no sampling, no network). A turn starts at the user's last
// word (voice: the end of speech the microphone heard; typed: Enter) and records
// marks as they happen:
//
//   heard        end of speech reached COre (voice; includes the end-of-turn wait)
//   react        COre visibly reacted (orb "thinking", or an acknowledgement)
//   transcript   speech recognition finished (voice)
//   firstToken   the brain's first words arrived
//   firstAudio   COre's voice started playing
//   done         the turn finished
//
// Spans (ms from the turn's start) are kept for the last 200 turns per kind, so
// /diagnostics and the benchmark can show p50/p95 against the targets.

const MARKS = ['heard', 'react', 'transcript', 'firstToken', 'firstAudio', 'done'];

// Targets from docs/dev/PLAN-12.1.md (ms from the user's last word).
const TARGETS = { voice: { react: 300, firstAudio: 1000 }, typed: { firstToken: 400 }, instant: { firstAudio: 100, firstToken: 100 } };

function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

class Latency {
  constructor({ now = () => Date.now(), keep = 200 } = {}) {
    this.now = now;
    this.keep = keep;
    this.turn = null;
    this.history = []; // finished turns: { kind, start, marks: { name: ms } }
  }

  // kind: 'voice' | 'typed' | 'instant'; start: epoch ms of the user's last word.
  begin(kind, start = this.now()) {
    if (this.turn && !this.turn.marks.done) this.finish();
    this.turn = { kind, start: Number(start) || this.now(), marks: {} };
    return this.turn;
  }

  // The first time a mark happens in the turn counts.
  mark(name, at = this.now()) {
    const t = this.turn;
    if (!t || t.marks[name] != null || !MARKS.includes(name)) return null;
    t.marks[name] = Math.max(0, Math.round(at - t.start));
    return t.marks[name];
  }

  // A turn can turn out to be an instant answer after it started.
  reclassify(kind) { if (this.turn) this.turn.kind = kind; }

  finish(at = this.now()) {
    const t = this.turn;
    if (!t) return null;
    this.mark('done', at);
    this.history.push(t);
    if (this.history.length > this.keep) this.history.shift();
    this.turn = null;
    return t;
  }

  // -> { voice: { n, react: {p50,p95,target}, ... }, typed: {...}, instant: {...} }
  stats() {
    const out = {};
    for (const kind of ['voice', 'typed', 'instant']) {
      const turns = this.history.filter((t) => t.kind === kind);
      if (!turns.length) continue;
      const k = { n: turns.length };
      for (const m of MARKS) {
        const v = turns.map((t) => t.marks[m]).filter((x) => x != null);
        if (v.length) k[m] = { p50: pct(v, 50), p95: pct(v, 95), n: v.length, ...(TARGETS[kind] && TARGETS[kind][m] ? { target: TARGETS[kind][m] } : {}) };
      }
      out[kind] = k;
    }
    return out;
  }

  static format(stats) {
    const names = { heard: 'heard', react: 'reacted', transcript: 'transcript', firstToken: 'first words (brain)', firstAudio: 'first sound', done: 'finished' };
    const lines = [];
    for (const [kind, k] of Object.entries(stats)) {
      const parts = MARKS.filter((m) => k[m]).map((m) => `${names[m]} ${k[m].p50}/${k[m].p95} ms${k[m].target ? (k[m].p50 <= k[m].target ? ' ✓' : ` (target ${k[m].target})`) : ''}`);
      lines.push(`${kind} (${k.n} turns, p50/p95 from your last word): ${parts.join(', ')}`);
    }
    return lines.length ? lines.join('\n') : 'No turns measured yet.';
  }
}

// End of turn: is this transcript a finished sentence? (ends with . ? or !, at least two
// words, and does not trail off with "and", "so", "um" or an ellipsis). Used to stop
// listening without the full silence wait.
function turnLooksComplete(t) {
  const s = String(t || '').trim();
  if (!/[.?!]["')\]]?$/.test(s) || /\.\.\.["')\]]?$|…$/.test(s)) return false;
  const words = s.replace(/[.?!"')\]]+$/, '').split(/\s+/).filter(Boolean);
  return words.length >= 2 && !/^(and|but|so|or|um+|uh+|because|the|a|an|to|of|with|like|then)$/i.test(words[words.length - 1]);
}

module.exports = { Latency, MARKS, TARGETS, pct, turnLooksComplete };
