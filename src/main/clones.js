'use strict';

// Helper clones ("Many COres"): pure pieces, kept free of Electron so they
// can be tested. The window and brain glue lives in main.js.

const MAX_CLONES = 3;

// Each helper gets its own colour, voice and pitch so you can tell them apart
// by eye and by ear.
const LOOKS = [
  { name: 'Cyan', emoji: '🔵', tint: [0.2, 0.8, 1.0], voice: 'am_fenrir', semitones: -1 },
  { name: 'Amber', emoji: '🟠', tint: [1.0, 0.68, 0.18], voice: 'bm_george', semitones: -2 },
  { name: 'Violet', emoji: '🟣', tint: [0.76, 0.46, 1.0], voice: 'am_michael', semitones: 0 },
];

const overlaps = (a, b, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

// Where a new helper should float: as close to `near` as possible, fully
// inside `area`, overlapping none of the `avoid` rectangles (COre, the chat,
// the other helpers). `size` is the square the helper's smoke and hands need.
// Returns the centre { x, y }, or null when there's no room.
function placeClone({ area, avoid = [], size, near, margin = 10 }) {
  const half = size / 2;
  const step = Math.max(12, Math.round(size / 4));
  let best = null;
  for (let cy = area.y + half; cy <= area.y + area.height - half; cy += step) {
    for (let cx = area.x + half; cx <= area.x + area.width - half; cx += step) {
      const r = { x: cx - half, y: cy - half, w: size, h: size };
      if (avoid.some((a) => overlaps(r, a, margin))) continue;
      const d = Math.hypot(cx - near.x, cy - near.y);
      if (!best || d < best.d) best = { x: Math.round(cx), y: Math.round(cy), d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// Square around an orb centre that its smoke and arms can reach.
function orbRect(x, y, r, reach = 2.6) {
  const h = r * reach;
  return { x: x - h, y: y - h, w: h * 2, h: h * 2 };
}

// What a helper is told. Kept free of double quotes and cmd.exe
// metacharacters (see persona.js).
function cloneTaskPrompt(task, name) {
  const t = String(task || '').replace(/["&|<>^%!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return [
    `[helper] You are ${name}, a helper copy that COre split off to work on one task in parallel while COre keeps talking with the user.`,
    `Your task: ${t}`,
    'Do the task as well as you can on your own; nobody will answer questions. You cannot browse or open files.',
    'Answer format: first ONE short spoken sentence that sums up the result (it is read aloud), then a blank line, then the full result with as much detail as is useful (markdown welcome).',
    'No [[tags]].',
  ].join('\n');
}

// The message a specialist core receives (Meiosis Mode). The user's text is
// passed through untouched (code and symbols intact): prompts reach the brain
// over stdin, never through a shell.
function corePrompt(core, text, task) {
  return [
    `[core ${core.name}] ${core.prompt}`,
    task
      ? `This is part of shared task ${task.id}, coordinated by COre (Prime). Other specialists may work on the same request in parallel: stay within your role.`
      : "The user is talking to you directly in COre's shared chat.",
    'Answer format: first ONE short spoken sentence that sums up your answer (it is read aloud), then a blank line, then the full answer (markdown welcome).',
    'If the user shared a project folder you may look at it, read-only, with these tags only: [[list PATH]] [[read PATH]] [[find TEXT]] (paths relative to the project). Use them, then wait: the results come back in the next message. To propose a change, write the COMPLETE new file in a fenced code block whose opening line names it, like ```js file=src/app.js — the user sees a diff and decides; nothing is written without them. No other [[tags]].',
    '',
    String(text || '').slice(0, 8000),
  ].join('\n');
}

// First paragraph as a short spoken summary, without markdown or tags.
function spokenSummary(reply, max = 220) {
  const first = String(reply || '').trim().split(/\n\s*\n/)[0] || '';
  let s = first.replace(/\[\[[^\]]*\]\]/g, '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > 40 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
  }
  return s;
}

// One voice at a time. COre itself always has priority; helpers queue for
// the floor and speak only while COre is quiet.
class SpeechFloor {
  constructor({ mainBusy }) {
    this.mainBusy = mainBusy;
    this.queue = []; // [{ id, start }]
    this.holder = null;
  }

  request(id, start) {
    if (this.holder === id || this.queue.some((q) => q.id === id)) return;
    this.queue.push({ id, start });
    this.pump();
  }

  release(id) {
    if (this.holder === id) this.holder = null;
    this.queue = this.queue.filter((q) => q.id !== id);
    this.pump();
  }

  // Grant the floor if nobody holds it and COre is quiet. Call periodically.
  pump() {
    if (this.holder || !this.queue.length || this.mainBusy()) return false;
    const next = this.queue.shift();
    this.holder = next.id;
    next.start();
    return true;
  }
}

module.exports = { MAX_CLONES, LOOKS, placeClone, orbRect, cloneTaskPrompt, corePrompt, spokenSummary, SpeechFloor, overlaps };
