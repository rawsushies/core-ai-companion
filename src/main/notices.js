'use strict';

// Phone notices (13.0 P3): the few moments worth a notification on the phone: a step waiting
// for an answer, a mission finished, needing you or stopped, a /do task ending. Kept in a short
// ring on the PC and sent with every phone sync; the phone raises each id once (it remembers
// the ids it showed), so a missed poll never loses one and a repeated poll never repeats one.
// Text stays short; the phone's notification channel hides it on the lock screen.

class Notices {
  constructor({ now = () => Date.now(), max = 20, ttlMs = 60 * 60000 } = {}) {
    this.now = now;
    this.max = max;
    this.ttlMs = ttlMs;
    this.list = [];
    this.n = 0;
    this.boot = now().toString(36); // ids stay unique across PC restarts
  }

  // kind: approval | mission | task; -> the notice
  add(kind, title, body = '') {
    const n = { id: `${this.boot}-${++this.n}`, kind: String(kind), title: String(title).slice(0, 80), body: String(body).replace(/\s+/g, ' ').trim().slice(0, 160), at: this.now() };
    this.list.push(n);
    while (this.list.length > this.max) this.list.shift();
    return n;
  }

  // Notices from the last hour, oldest first.
  recent() {
    const t = this.now();
    return this.list.filter((n) => t - n.at <= this.ttlMs);
  }
}

// The phone's side: which of these it has not shown yet. seen: the ids it showed (kept small).
function unseen(notices, seen = []) {
  const s = new Set(seen);
  return (notices || []).filter((n) => n && typeof n.id === 'string' && !s.has(n.id));
}

module.exports = { Notices, unseen };
