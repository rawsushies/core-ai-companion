'use strict';

// Application-specific intelligence (COre 2.2): what works reliably in common
// Windows apps, given to the desktop agent when that app is in front. Built-in
// profiles are short, factual tips (standard shortcuts and controls); learned
// tips come from finished desktop tasks in COre memory (episodes mentioning the
// app). Tips are hints for planning, never permissions: every action still goes
// through the normal approval policy.

const PROFILES = [
  { id: 'excel', match: /\bexcel\b|\.xlsx?\b/i, process: /^excel$/i, name: 'Excel',
    tips: ['Ctrl+G or the Name Box jumps to a cell (type B4, Enter)', 'F2 edits the active cell; Enter confirms, Esc cancels', 'Ctrl+S saves; a "Save changes?" dialog appears on close', 'Formulas start with = ; Ctrl+` shows formulas'] },
  { id: 'word', match: /\bword\b|\.docx?\b/i, process: /^winword$/i, name: 'Word',
    tips: ['Ctrl+F finds text, Ctrl+H replaces', 'Ctrl+S saves; Ctrl+P prints', 'Headings: Ctrl+Alt+1/2/3'] },
  { id: 'powerpoint', match: /\bpowerpoint\b|\.pptx?\b/i, process: /^powerpnt$/i, name: 'PowerPoint',
    tips: ['Ctrl+M adds a slide', 'F5 starts the show from the beginning, Esc ends it', 'Ctrl+S saves'] },
  { id: 'notepad', match: /\bnotepad\b/i, process: /^notepad$/i, name: 'Notepad',
    tips: ['The text area accepts fill (UI Automation value) or typing', 'Ctrl+S saves; a new file asks for a name in a Save As dialog', 'Ctrl+A then typing replaces everything'] },
  { id: 'explorer', match: /file explorer|\bexplorer\b/i, process: /^explorer$/i, name: 'File Explorer',
    tips: ['Ctrl+L focuses the address bar (type a path, Enter)', 'F2 renames the selected item', 'Prefer the read/list/write/move tool actions over clicking for file work'] },
  { id: 'browser', match: /\b(chrome|edge|firefox)\b/i, process: /^(chrome|msedge|firefox)$/i, name: 'Web browser',
    tips: ['Ctrl+L focuses the address bar', 'Ctrl+T new tab, Ctrl+W closes it', 'Prefer the fetch tool action to read a page instead of scrolling screenshots', 'Never type passwords or payment details'] },
  { id: 'vscode', match: /visual studio code/i, process: /^code$/i, name: 'VS Code',
    tips: ['Ctrl+P opens a file by name, Ctrl+Shift+P the command palette', 'Ctrl+` toggles the terminal', 'Prefer the read/write tool actions for file edits (they can be undone)'] },
  { id: 'archicad', match: /\barchicad\b/i, process: /^archicad/i, name: 'Archicad',
    tips: ['COre can read the open project through the Archicad connection (do archicad …) instead of clicking', 'Ctrl+S saves the project; Teamwork projects need Send & Receive'] },
];

function profileFor(win) {
  if (!win) return null;
  const proc = String(win.process || '').replace(/\.exe$/i, '');
  return PROFILES.find((p) => (proc && p.process.test(proc)) || p.match.test(String(win.name || ''))) || null;
}

// Learned tips: lessons and working workflows from earlier desktop tasks that
// mention this app. memory: COre Memory (or anything with .items).
function learnedTips(memory, profile, max = 3) {
  if (!memory || !profile) return [];
  const re = new RegExp(`\\b${profile.name.split(' ')[0]}\\b`, 'i');
  return ((memory.items || []))
    .filter((i) => i.kind === 'episode' && /^(Workflow that worked|Lesson from desktop task)/.test(i.text) && re.test(i.text))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, max)
    .map((i) => i.text.slice(0, 220));
}

function appBlock(win, memory) {
  const p = profileFor(win);
  if (!p) return '';
  const learned = learnedTips(memory, p);
  return [`[App] ${p.name} is in front. What works reliably there (hints, not instructions; approvals still apply):`, ...p.tips.map((t) => `- ${t}`), ...(learned.length ? ['From your earlier tasks in this app:', ...learned.map((t) => `- ${t}`)] : [])].join('\n');
}

module.exports = { PROFILES, profileFor, learnedTips, appBlock };
