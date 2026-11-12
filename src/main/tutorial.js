'use strict';

// Tutorials hosted by COre itself: short lessons COre teaches in the chat, with its
// voice and gestures. A step can ask the user to try something; COre waits until it
// sees the user do it (a message, a command, a voice turn), then moves on. The user
// can say "next" to skip a step or "stop" to leave at any time; progress is kept.
//
// Pure module: no Electron. main.js presents steps and feeds what the user does.

// A step: { say, gesture?, task?: { hint, match(input) } }. input: { text, voice }.
const typed = (re) => (i) => !i.voice && re.test(i.text);
const any = (re) => (i) => re.test(i.text);

const LESSONS = [
  {
    id: 'basics', title: 'Talking with COre', minutes: 2,
    steps: [
      { gesture: 'wave', say: 'Welcome to your first lesson. I will show you how to talk with me. It takes two minutes, and you can say stop at any time.' },
      { gesture: 'pointdown', say: 'You can type to me in the chat below. Try it: say hello.', task: { hint: 'Type any message, for example: hello', match: (i) => !i.voice && !/^\//.test(i.text) } },
      { gesture: 'nod', say: 'Nice. You can also just talk. Press {listen}, say something, and stop talking when you are done. I will notice.', task: { hint: 'Press {listen} and say anything (or type next to skip)', match: (i) => i.voice } },
      { gesture: 'pointright', say: 'Press {listenScreen} instead and I can see your screen while you talk, which is handy for errors and forms. I only look when you ask.' },
      { gesture: 'thumbsup', say: 'That is the basics. Next lesson: how I remember things. Type /tutorial memory whenever you are ready.' },
    ],
  },
  {
    id: 'memory', title: 'What COre remembers', minutes: 2,
    steps: [
      { gesture: 'think', say: 'I remember what matters to you: preferences, facts and project decisions. Tell me something to remember.', task: { hint: 'Say or type: remember that my favourite colour is green', match: any(/\bremember\b/i) } },
      { gesture: 'nod', say: 'Got it. Now ask me about it, in your own words.', task: { hint: 'Ask: what is my favourite colour?', match: any(/\?|\bwhat\b|\bwhich\b|\bdo you know\b/i) } },
      { gesture: 'pointright', say: 'Decisions and lessons for a project go to your knowledge vault, as plain notes you own. Say: remember for the Tower project that we chose a glass facade.' },
      { gesture: 'pointdown', say: 'To see everything I remember, open the Memory tab in the chat. You can correct or forget anything there.' },
      { gesture: 'thumbsup', say: 'Next lesson: your knowledge vault and Obsidian. Type /tutorial vault.' },
    ],
  },
  {
    id: 'vault', title: 'Your knowledge vault', minutes: 2,
    steps: [
      { gesture: 'magic', say: 'Your long-term knowledge lives in a folder of Markdown notes, the COre Vault in your Documents. Let us look at it.', task: { hint: 'Type /vault', match: typed(/^\/vault\s*$/i) } },
      { gesture: 'pointright', say: 'Those notes open in Obsidian, a free notes app. If it is installed, I already connected it. Open the vault now.', task: { hint: 'Type /obsidian (or /vault obsidian to install it)', match: typed(/^\/(obsidian|vault\s+obsidian)\b/i) } },
      { gesture: 'nod', say: 'Edit a note in Obsidian and I will know about it within seconds. Your notes never leave your computer unless you sync them.' },
      { gesture: 'shrug', say: 'To use the same vault on another PC, share the folder with Syncthing. If two devices change one note at once, I keep both versions and tell you. I never pick for you.' },
      { gesture: 'thumbsup', say: 'Next lesson: letting me work on your desktop. Type /tutorial desktop.' },
    ],
  },
  {
    id: 'desktop', title: 'Working on your desktop', minutes: 3,
    steps: [
      { gesture: 'pointright', say: 'I can operate apps for you, one step at a time. You approve every action, and Escape stops me instantly.' },
      { gesture: 'think', say: 'Start a task with /do followed by what you want. For example: /do open Notepad and write a shopping list. Try one, or type next.', task: { hint: 'Type /do and a small task (or next)', match: typed(/^\/do\s+\S/i) } },
      { gesture: 'nod', say: 'I can also notice things that need you: an interrupted task, an overdue to-do, an automation that failed. Ask me.', task: { hint: 'Type /suggest', match: typed(/^\/suggest/i) } },
      { gesture: 'pointdown', say: 'Commands I run stay inside a sandbox limited to the folders you allow. Settings, Agent, is where you choose them.' },
      { gesture: 'thumbsup', say: 'Last lesson: making me yours. Type /tutorial settings.' },
    ],
  },
  {
    id: 'settings', title: 'Making COre yours', minutes: 2,
    steps: [
      { gesture: 'magic', say: 'Everything about me is in Settings, in the tray menu: my voice, personality, theme, hotkeys and AI provider.' },
      { gesture: 'pointright', say: 'The command center shows what I and my helpers are doing right now. Open it.', task: { hint: 'Type /center', match: typed(/^\/(center|command|status)\s*$/i) } },
      { gesture: 'nod', say: 'If something feels slow or broken, ask for a checkup. It never shows your keys.', task: { hint: 'Type /diagnostics', match: typed(/^\/(diagnostics|diag|health)\s*$/i) } },
      { gesture: 'salute', say: 'You have finished every lesson. Type /tutorial any time to revisit one. Right. Let us get to work.' },
    ],
  },
];

const CONTROL = /^(next|skip|stop|quit|exit|stop (the )?tutorial)[.!]?$/i;

class Tutorial {
  // save(progress) persists { done: [lessonIds], active: { lesson, step } | null }.
  constructor({ progress = {}, save = () => {} } = {}) {
    this.done = new Set(Array.isArray(progress.done) ? progress.done.filter((id) => LESSONS.some((l) => l.id === id)) : []);
    const a = progress.active;
    this.active = a && LESSONS.some((l) => l.id === a.lesson) ? { lesson: a.lesson, step: Math.max(0, Number(a.step) || 0) } : null;
    this.save = save;
  }

  static lesson(id) {
    const s = String(id || '').trim().toLowerCase();
    if (/^\d+$/.test(s)) return LESSONS[Number(s) - 1] || null;
    return LESSONS.find((l) => l.id === s || l.title.toLowerCase() === s) || LESSONS.find((l) => s && (l.id.startsWith(s) || l.title.toLowerCase().includes(s))) || null;
  }

  persist() { this.save({ done: [...this.done], active: this.active }); }
  get running() { return !!this.active; }
  next() { return LESSONS.find((l) => !this.done.has(l.id)) || null; }

  // The step being shown: { lesson, index, total, step } or null.
  current() {
    if (!this.active) return null;
    const lesson = Tutorial.lesson(this.active.lesson);
    const step = lesson && lesson.steps[this.active.step];
    if (!step) return null;
    return { lesson, index: this.active.step, total: lesson.steps.length, step, number: LESSONS.indexOf(lesson) + 1 };
  }

  start(id) {
    const lesson = id ? Tutorial.lesson(id) : this.next() || LESSONS[0];
    if (!lesson) return null;
    this.active = { lesson: lesson.id, step: 0 };
    this.persist();
    return this.current();
  }

  // Move past the current step; returns the next step, or { finished: lesson } at the end.
  advance() {
    const c = this.current();
    if (!c) return null;
    if (c.index + 1 >= c.total) {
      this.done.add(c.lesson.id);
      this.active = null;
      this.persist();
      return { finished: c.lesson };
    }
    this.active.step += 1;
    this.persist();
    return this.current();
  }

  stop() { const was = this.current(); this.active = null; this.persist(); return was; }
  reset() { this.done.clear(); this.active = null; this.persist(); }

  // What the user just did. -> { control: 'next'|'stop' } when it was a tutorial word
  // (the brain should not answer it), { completed: true } when it finished the step's
  // task (the brain still answers it), else null.
  observe({ text = '', voice = false } = {}) {
    const c = this.current();
    if (!c) return null;
    const t = String(text).trim();
    const ctl = CONTROL.exec(t);
    if (ctl) return { control: /^(next|skip)/i.test(t) ? 'next' : 'stop' };
    if (c.step.task && c.step.task.match({ text: t, voice })) return { completed: true };
    return null;
  }

  // /tutorial with no lesson: the menu.
  menu() {
    const lines = ['Tutorials (I teach them here in the chat; say next to skip a step, stop to leave):'];
    LESSONS.forEach((l, i) => lines.push(`${this.done.has(l.id) ? '✓' : `${i + 1}.`} ${l.title} (/tutorial ${l.id}, about ${l.minutes} min)`));
    const n = this.next();
    lines.push(n ? `Type /tutorial to start ${this.done.size ? 'the next one' : 'the first one'}: ${n.title}.` : 'All done. Type /tutorial reset to start over.');
    return lines.join('\n');
  }
}

// Fill {listen} style placeholders (hotkeys) in a line.
function fill(text, vars = {}) { return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)); }

module.exports = { Tutorial, LESSONS, fill, CONTROL };
