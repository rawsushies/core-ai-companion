'use strict';

// Interruption cost (13.0 P4): one place that decides whether something COre wants to say on its
// own is worth interrupting you for, and how. Every proactive moment (chit-chat, the morning
// briefing, heads-ups, mission milestones) asks here first. Deterministic and explainable: each
// answer carries the reason.
//
//   decide({ kind, importance, state, history, cfg }) -> { act, channel, why }
//     act      'now' | 'later' (ask again on a later tick) | 'drop' (not worth it today)
//     channel  'speak' (voice + chat) | 'chat' (silent, in the chat only) | 'phone' (a phone notice)
//
// importance: 'urgent' (COre is blocked on you: an approval, a mission that needs you)
//             'high'   (a failure, a deadline today)
//             'normal' (the morning briefing, a useful suggestion)
//             'low'    (small talk)
// state: { hour, idleSec, typingSec (seconds since the last key), fullscreen, inMeeting, hidden, busy,
//          phonePaired }
// history: { ignored: { [kind]: streak }, todayCount, lastAt: { [kind]: ms }, now }

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
const DEFAULTS = { quietFrom: 22, quietTo: 8, maxPerDay: 8, awaySec: 600, gapMin: { low: 25, normal: 10, high: 2, urgent: 0 } };

function inQuietHours(hour, from, to) {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function decide({ kind = 'misc', importance = 'normal', state = {}, history = {}, cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...cfg, gapMin: { ...DEFAULTS.gapMin, ...(cfg.gapMin || {}) } };
  const r = RANK[importance] ?? 1;
  const now = history.now || Date.now();
  const away = (state.idleSec || 0) >= c.awaySec;
  const quiet = inQuietHours(state.hour ?? 12, c.quietFrom, c.quietTo);
  const typing = state.typingSec !== undefined && state.typingSec < 5;
  const focused = !!(state.fullscreen || state.inMeeting);
  const ignored = (history.ignored && history.ignored[kind]) || 0;
  const last = (history.lastAt && history.lastAt[kind]) || 0;
  const out = (act, channel, why) => ({ act, channel, why });

  // Blocked on you: always delivered, never spoken when you are away, in a meeting, typing or at night.
  if (r >= RANK.urgent) {
    if (away) return out('now', state.phonePaired ? 'phone' : 'chat', 'COre is waiting for you and you are away');
    if (quiet || focused || typing) return out('now', 'chat', quiet ? 'quiet hours: shown, not spoken' : focused ? 'you are in a meeting or full screen: shown, not spoken' : 'you are typing: shown, not spoken');
    return out('now', 'speak', 'COre is waiting for you');
  }
  // Backoff: something of this kind you keep ignoring is asked less often, then not at all today.
  if (ignored >= 3 && r <= RANK.normal) return out('drop', 'chat', `you ignored the last ${ignored} of these`);
  const gap = (c.gapMin[importance] ?? 10) * 60000 * Math.min(8, 2 ** ignored);
  if (last && now - last < gap) return out('later', 'chat', `too soon after the last one (${Math.round(gap / 60000)} min apart)`);
  if (r <= RANK.normal && (history.todayCount || 0) >= c.maxPerDay) return out('drop', 'chat', `the daily limit of ${c.maxPerDay} is reached`);
  if (state.hidden || state.busy) return out('later', 'chat', state.busy ? 'COre is busy with something you asked' : 'COre is hidden');
  if (quiet) return r >= RANK.high ? out('now', 'chat', 'quiet hours: shown, not spoken') : out('later', 'chat', 'quiet hours');
  if (away) return r >= RANK.high && state.phonePaired ? out('now', 'phone', 'you are away; it matters enough for the phone') : out('later', 'chat', 'you are away');
  if (focused) return r >= RANK.high ? out('now', 'chat', 'you are in a meeting or full screen: shown, not spoken') : out('later', 'chat', 'you are in a meeting or full screen');
  if (typing) return r >= RANK.high ? out('now', 'chat', 'you are typing: shown, not spoken') : out('later', 'chat', 'you are typing');
  return out('now', 'speak', 'a good moment');
}

// A small store-backed history: per-kind ignore streaks, the last time of each kind, today's count.
class InterruptHistory {
  constructor({ store, now = () => Date.now() } = {}) { this.store = store; this.now = now; }
  _day() { const d = new Date(this.now()); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  _get() {
    const v = (this.store && this.store.get('interrupts')) || {};
    return v.day === this._day() ? v : { day: this._day(), ignored: v.ignored || {}, lastAt: v.lastAt || {}, count: 0 };
  }
  snapshot() { const v = this._get(); return { ignored: v.ignored, lastAt: v.lastAt, todayCount: v.count, now: this.now() }; }
  delivered(kind, importance) {
    const v = this._get();
    v.lastAt = { ...v.lastAt, [kind]: this.now() };
    if (RANK[importance] <= RANK.normal) v.count = (v.count || 0) + 1;
    if (this.store) this.store.set('interrupts', v);
  }
  answered(kind) { const v = this._get(); v.ignored = { ...v.ignored, [kind]: 0 }; if (this.store) this.store.set('interrupts', v); }
  ignoredOnce(kind) { const v = this._get(); v.ignored = { ...v.ignored, [kind]: Math.min(8, (v.ignored[kind] || 0) + 1) }; if (this.store) this.store.set('interrupts', v); }
}

module.exports = { decide, inQuietHours, InterruptHistory, RANK };
