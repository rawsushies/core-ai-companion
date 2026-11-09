'use strict';

// Reminders and timers set with [[remind WHEN TEXT]]. Stored in state so they
// survive restarts; overdue ones fire right after start ("missed").

const { randomUUID } = require('crypto');

const UNIT = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
const MAX_DELAY = 7 * 24 * 3600 * 1000;

// "10m", "1h30m", "90 s", "18:30", "at 7pm", "7:15 am" -> epoch ms (or null).
function parseWhen(when, now = new Date()) {
  const w = String(when || '').trim().toLowerCase().replace(/^at\s+/, '');
  const parts = [...w.matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?=\d|\s|$)/g)];
  if (parts.length && parts.map((p) => p[0]).join('').replace(/\s/g, '') === w.replace(/\s/g, '')) {
    const secs = parts.reduce((n, p) => n + Number(p[1]) * UNIT[p[2]], 0);
    return secs > 0 && secs * 1000 <= MAX_DELAY ? now.getTime() + secs * 1000 : null;
  }
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(w);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2] || 0);
    if (clock[3] === 'pm' && h < 12) h += 12;
    if (clock[3] === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const t = new Date(now);
    t.setHours(h, min, 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1); // next occurrence
    return t.getTime();
  }
  return null;
}

class Reminders {
  // store: { get(key), set(key, value) }; onFire({ id, at, text }, missed)
  constructor({ store, onFire }) {
    this.store = store;
    this.onFire = onFire;
    this.timers = new Map();
  }

  get items() {
    return (this.store.get('reminders') || []).slice().sort((a, b) => a.at - b.at);
  }

  _save(list) {
    this.store.set('reminders', list);
  }

  start() {
    for (const r of this.items) this._arm(r);
  }

  add(when, text) {
    const at = parseWhen(when);
    if (!at) return null;
    const r = { id: randomUUID(), at, text: String(text).trim().slice(0, 200) };
    this._save([...this.items, r]);
    this._arm(r);
    return r;
  }

  cancel(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const list = this.items;
    const gone = list.find((r) => r.id === id);
    this._save(list.filter((r) => r.id !== id));
    return gone || null;
  }

  _arm(r) {
    clearTimeout(this.timers.get(r.id));
    const delay = r.at - Date.now();
    const fire = () => {
      this.timers.delete(r.id);
      this._save(this.items.filter((x) => x.id !== r.id));
      this.onFire(r, delay < -60_000);
    };
    // setTimeout can't wait more than ~24.8 days; re-check daily for long ones.
    if (delay > 86_400_000) this.timers.set(r.id, setTimeout(() => this._arm(r), 86_400_000));
    else this.timers.set(r.id, setTimeout(fire, Math.max(0, delay)));
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

module.exports = { Reminders, parseWhen };
