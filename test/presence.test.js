'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Presence, shouldChat, inQuietHours, chitchatPrompt } = require('../src/main/presence');
const { TouchDetector, releaseVelocity } = require('../src/renderer/overlay/interactions');

const MIN = 60_000;
const base = { now: 100 * MIN, cfg: { minutes: 25 }, busy: false, hidden: false, hour: 14, idleSec: 40, lastInteraction: 70 * MIN, lastChat: 0, ignoredStreak: 0, chatsToday: 0 };

test('quiet hours wrap around midnight', () => {
  assert.ok(inQuietHours(23, 22, 8));
  assert.ok(inQuietHours(3, 22, 8));
  assert.ok(!inQuietHours(12, 22, 8));
  assert.ok(inQuietHours(13, 12, 14));
  assert.ok(!inQuietHours(13, 5, 5));
});

test('chats only when quiet long enough and the user is present but paused', () => {
  assert.ok(shouldChat(base));
  assert.ok(!shouldChat({ ...base, lastInteraction: 90 * MIN }), 'too soon');
  assert.ok(!shouldChat({ ...base, idleSec: 5 }), 'typing');
  assert.ok(!shouldChat({ ...base, idleSec: 900 }), 'away');
  assert.ok(!shouldChat({ ...base, hour: 23 }), 'quiet hours');
  assert.ok(!shouldChat({ ...base, busy: true }));
  assert.ok(!shouldChat({ ...base, hidden: true }));
  assert.ok(!shouldChat({ ...base, chatsToday: 6 }));
  assert.ok(!shouldChat({ ...base, cfg: { chitchat: false } }));
});

test('backs off when ignored', () => {
  assert.ok(!shouldChat({ ...base, ignoredStreak: 1 }), '30 min < 50 min');
  assert.ok(shouldChat({ ...base, ignoredStreak: 1, lastInteraction: 40 * MIN }));
});

test('Presence fires once, counts per day, and treats silence as ignored', () => {
  let t = 0;
  const store = new Map();
  const chats = [];
  const p = new Presence({
    getConfig: () => ({ minutes: 10 }),
    idleSec: () => 30,
    isBusy: () => false,
    isHidden: () => false,
    store: { get: (k) => store.get(k), set: (k, v) => store.set(k, v) },
    onChat: (info) => chats.push(info),
    now: () => t,
  });
  t = new Date(2026, 0, 1, 12).getTime();
  p.lastInteraction = t;
  t += 11 * MIN;
  assert.ok(p.tick());
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].quietMinutes, 11);
  assert.ok(!p.tick(), 'not again right away');
  t += 6 * MIN;
  p.tick();
  assert.strictEqual(p.ignoredStreak, 1);
  p.noteInteraction();
  assert.strictEqual(p.ignoredStreak, 0);
  assert.strictEqual(p.chatsToday(), 1);
});

test('chit-chat prompt is shell-safe and mentions the time', () => {
  const s = chitchatPrompt({ quietMinutes: 30, date: new Date(2026, 0, 1, 9, 5), windows: ['Report "final" & co', 'VS Code'] });
  assert.ok(s.startsWith('[idle]'));
  assert.ok(!/["&|<>^%!]/.test(s));
  assert.ok(s.includes('VS Code'));
});

function strokes(det, { amp, period, n, cx = 100, cy = 100, step = 16 }) {
  let out = null;
  for (let t = 0; t < n; t += step) {
    const x = cx + Math.sin((t / period) * Math.PI * 2) * amp;
    const k = det.feed(x, cy + Math.sin(t / 50) * 2, t);
    if (k) out = out || k;
  }
  return out;
}

test('touch detector tells petting from tickling, and ignores passing by', () => {
  assert.strictEqual(strokes(new TouchDetector({ r: 60 }), { amp: 50, period: 600, n: 1300 }), 'pet');
  assert.strictEqual(strokes(new TouchDetector({ r: 60 }), { amp: 10, period: 120, n: 1000 }), 'tickle');
  const d = new TouchDetector({ r: 60 });
  let k = null;
  for (let t = 0; t < 1000; t += 16) k = k || d.feed(t * 0.3, 100, t);
  assert.strictEqual(k, null);
});

test('release velocity uses the last moments of a drag', () => {
  const v = releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 500 }, { x: 110, y: 50, t: 600 }]);
  assert.strictEqual(Math.round(v.x), 1000);
  assert.strictEqual(Math.round(v.y), 500);
});
