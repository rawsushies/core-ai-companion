'use strict';

// Taint tracking for injection resistance (13.0). Text COre did not get from the user
// (files, web pages, emails, screen text, phone uploads) is recorded as untrusted. An
// action's *targets* (a recipient, a URL host, a path, a command's program and
// arguments) are tainted when they appear in untrusted text but not in anything the user
// gave (the goal, the grant). Tainted targets can never be auto-allowed above R1, so an
// instruction hidden in a document cannot pick who receives data, where it goes or what
// runs, whether or not the detector noticed the instruction.

const norm = (s) => String(s || '').toLowerCase().replace(/\\/g, '/').trim();

class Taint {
  constructor({ trusted = [] } = {}) {
    this.trusted = trusted.map(norm).join('\n');
    this.sources = []; // { source, text }
  }

  trust(text) { this.trusted += `\n${norm(text)}`; }

  // Record untrusted content (keeps the last ~400 kB).
  add(text, source = 'content') {
    const t = norm(text);
    if (!t) return;
    this.sources.push({ source, text: t });
    let total = this.sources.reduce((a, s) => a + s.text.length, 0);
    while (total > 400000 && this.sources.length > 1) total -= this.sources.shift().text.length;
  }

  // -> list of sources a target string came from (empty = not tainted).
  origin(target) {
    const t = norm(target);
    if (t.length < 3) return [];
    if (this.trusted.includes(t)) return [];
    return [...new Set(this.sources.filter((s) => s.text.includes(t)).map((s) => s.source))];
  }

  // Targets of an action that came from untrusted content: [{ target, from }]
  check(targets) {
    return (targets || []).map((target) => ({ target, from: this.origin(target) })).filter((x) => x.from.length);
  }
}

module.exports = { Taint };
