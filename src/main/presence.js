'use strict';

// Companion presence: after a quiet while, COre starts a short conversation
// on its own. Polite by design:
//  - only when you're at the computer but paused (idle 20 s .. 3 min), never
//    while you're away and never in the middle of typing;
//  - not during quiet hours, not while COre is hidden or busy;
//  - a few times a day at most, and it backs off (2x, 4x the wait) when
//    you ignore it, resetting when you interact again.

const DEFAULTS = { chitchat: true, minutes: 25, quietFrom: 22, quietTo: 8, maxPerDay: 6 };

function inQuietHours(hour, from, to) {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

// Pure decision, for tests: should COre speak up now?
function shouldChat(s) {
  const c = { ...DEFAULTS, ...(s.cfg || {}) };
  if (!c.chitchat || s.busy || s.hidden) return false;
  if (inQuietHours(s.hour, c.quietFrom, c.quietTo)) return false;
  if (s.chatsToday >= c.maxPerDay) return false;
  if (s.idleSec < 20 || s.idleSec > 180) return false;
  const wait = c.minutes * 60_000 * Math.min(4, 2 ** (s.ignoredStreak || 0));
  const since = s.now - Math.max(s.lastInteraction || 0, s.lastChat || 0);
  return since >= wait;
}

class Presence {
  // getConfig() -> presence config; idleSec() -> OS idle seconds;
  // isBusy(), isHidden() -> booleans; onChat(info) starts the conversation.
  constructor({ getConfig, idleSec, isBusy, isHidden, onChat, store, now = () => Date.now() }) {
    this.getConfig = getConfig;
    this.idleSec = idleSec;
    this.isBusy = isBusy;
    this.isHidden = isHidden;
    this.onChat = onChat;
    this.store = store; // { get(k), set(k, v) } so the daily count survives restarts
    this.now = now;
    this.lastInteraction = now();
    this.lastChat = 0;
    this.ignoredStreak = 0;
    this.awaitingReply = false;
    this.timer = null;
  }

  noteInteraction() {
    this.lastInteraction = this.now();
    this.ignoredStreak = 0;
    this.awaitingReply = false;
  }

  _day() {
    const d = new Date(this.now());
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  chatsToday() {
    const v = this.store && this.store.get('presence');
    return v && v.day === this._day() ? v.count : 0;
  }

  tick() {
    const now = this.now();
    // A chat nobody answered within 5 minutes counts as ignored.
    if (this.awaitingReply && now - this.lastChat > 5 * 60_000) {
      this.awaitingReply = false;
      this.ignoredStreak = Math.min(this.ignoredStreak + 1, 4);
    }
    const ok = shouldChat({
      now,
      cfg: this.getConfig(),
      busy: this.isBusy(),
      hidden: this.isHidden(),
      hour: new Date(now).getHours(),
      idleSec: this.idleSec(),
      lastInteraction: this.lastInteraction,
      lastChat: this.lastChat,
      ignoredStreak: this.ignoredStreak,
      chatsToday: this.chatsToday(),
    });
    if (!ok) return false;
    this.lastChat = now;
    this.awaitingReply = true;
    if (this.store) this.store.set('presence', { day: this._day(), count: this.chatsToday() + 1 });
    this.onChat({ quietMinutes: Math.round((now - this.lastInteraction) / 60_000) });
    return true;
  }

  start(everyMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[core] presence:', e.message); } }, everyMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

// The prompt COre gets when it decides to speak up. Kept free of double
// quotes and cmd.exe metacharacters (see persona.js).
function chitchatPrompt({ quietMinutes, date, windows, hasMemory }) {
  const d = date || new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString([], { weekday: 'long' });
  const lines = [
    `[idle] Nobody has talked to you for about ${quietMinutes} minutes. It is ${day}, ${time}.`,
    'Start a short, natural bit of conversation on your own: one or two spoken sentences.',
    'Make it relevant: the time of day, what the user seems to be working on, something you remember about them, a fun fact, or offer a quick game (riddle, trivia or 20 questions).',
    'Do not say you were told to start a conversation. Do not ask more than one question.',
  ];
  if (windows && windows.length) lines.push(`Open windows: ${windows.slice(0, 8).join(' / ').replace(/["&|<>^%!]/g, '').slice(0, 400)}`);
  if (hasMemory) lines.push('Use the [Memory] block if something there fits.');
  return lines.join('\n');
}

module.exports = { Presence, shouldChat, inQuietHours, chitchatPrompt, DEFAULTS };
