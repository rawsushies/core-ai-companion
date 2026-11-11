'use strict';

// Meiosis Mode identities: six cores total. Prime is COre itself (the main
// orb and session); Scout, Forge, Sentinel, Archivist and Navigator are specialist role profiles
// that run as helper clones over the SAME Brain provider chain. Roles, names,
// colours and voices are configurable (config.json → meiosis.cores).

const DEFAULTS = [
  {
    id: 'prime', name: 'COre', aliases: ['core', 'prime'], role: 'Prime', color: '#3dff85', voice: null, semitones: null,
    prompt: '',
  },
  {
    id: 'scout', name: 'Scout', aliases: ['scout', 'research'], role: 'Research', color: '#40ccff', voice: 'am_fenrir', semitones: -1,
    prompt: 'You are Scout, the research specialist. Gather evidence, compare alternatives, and state your uncertainty plainly. You cannot browse the web or open files: answer from what you know, say what should be verified and where (official docs, sources), and never invent citations.',
  },
  {
    id: 'forge', name: 'Forge', aliases: ['forge', 'build', 'builder'], role: 'Builder', color: '#ff7a24', voice: 'bm_george', semitones: -2,
    prompt: 'You are Forge, the builder. Turn requests into concrete implementations: code, designs, plans and drafts, written out in full. You cannot edit files or run commands yet: give the exact changes (file names and code) for the user to apply, and say how to test them.',
  },
  {
    id: 'sentinel', name: 'Sentinel', aliases: ['sentinel', 'qa', 'review', 'reviewer'], role: 'QA', color: '#b475ff', voice: 'am_michael', semitones: 0,
    prompt: 'You are Sentinel, the reviewer. Find bugs, edge cases, security problems and regressions in what you are given, and challenge unsupported conclusions. Be specific: what fails, how to reproduce it, how to fix it. Say clearly when something looks correct. When you review a proposal, end with one line: "Verdict: ship it", "Verdict: fix first" or "Verdict: reject".',
  },
  {
    id: 'archivist', name: 'Archivist', aliases: ['archivist', 'memory', 'librarian', 'archive'], role: 'Memory', color: '#ffd166', voice: 'bm_lewis', semitones: -3,
    prompt: 'You are Archivist, the keeper of memory and files. You are given what COre remembers about the user (with how sure it is), the history of past work, and the files the user dropped in. Answer from those first and say which memory or file each point comes from. Point out memories that contradict each other or look out of date, and suggest what to forget or correct. Never invent memories; say plainly when nothing is stored.',
  },
  {
    id: 'navigator', name: 'Navigator', aliases: ['navigator', 'operator', 'nav', 'pilot'], role: 'Operator', color: '#ff5c8a', voice: 'am_eric', semitones: -1,
    prompt: 'You are Navigator, the desktop and browser operator. Plan how to get things done on this computer: which app or site, which clicks, menus and shortcuts, step by step, and what could go wrong. You do not act yourself. When the plan can be carried out by the desktop agent, end with exactly one line "Task: <one short instruction for the agent>" so the user can start it. Never plan steps that enter passwords or payment details.',
  },
];

const ID_ORDER = DEFAULTS.map((c) => c.id);
const NAME_RE = /^[\p{L}][\p{L}\p{N} _-]{0,23}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const VOICE_RE = /^[a-z]{2}_[a-z]+$/;
const clean = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Merge user overrides onto the defaults, rejecting anything invalid or
// ambiguous (two cores answering to the same name).
function buildCores(overrides) {
  const byId = new Map((Array.isArray(overrides) ? overrides : []).filter((o) => o && ID_ORDER.includes(o.id)).map((o) => [o.id, o]));
  const cores = DEFAULTS.map((d) => {
    const o = byId.get(d.id) || {};
    const c = { ...d };
    if (typeof o.name === 'string' && NAME_RE.test(o.name.trim())) c.name = o.name.trim();
    if (typeof o.role === 'string' && o.role.trim().length <= 24) c.role = o.role.trim() || d.role;
    if (typeof o.color === 'string' && COLOR_RE.test(o.color)) c.color = o.color.toLowerCase();
    if (d.id !== 'prime' && typeof o.voice === 'string' && VOICE_RE.test(o.voice)) c.voice = o.voice;
    if (d.id !== 'prime' && Number.isFinite(+o.semitones)) c.semitones = Math.max(-12, Math.min(6, +o.semitones));
    if (Array.isArray(o.aliases)) c.aliases = [...new Set([...d.aliases, ...o.aliases.map(clean).filter(Boolean)])];
    c.keys = [...new Set([clean(c.name), ...c.aliases.map(clean)])].filter(Boolean);
    return c;
  });
  // A key claimed by two cores belongs to neither (except a core's own name).
  const owners = new Map();
  for (const c of cores) for (const k of c.keys) owners.set(k, owners.has(k) ? null : c.id);
  for (const c of cores) c.keys = c.keys.filter((k) => owners.get(k) === c.id || k === clean(c.name));
  return cores;
}

function findCore(cores, name) {
  const k = clean(name);
  return k ? cores.find((c) => c.keys.includes(k)) || null : null;
}

// Leading mentions decide the recipients:
//   "@Scout @Sentinel check this"  -> { targets: ['scout','sentinel'], text: 'check this' }
//   "Scout, find me ..." (spoken)  -> only with spoken=true, and only a known name
// Unknown @names are reported, never guessed.
function parseMentions(cores, input, { spoken = false } = {}) {
  let text = String(input || '').trim();
  const targets = [];
  const unknown = [];
  for (;;) {
    const m = /^@([\p{L}\p{N}_-]+)[\s,:]*/u.exec(text);
    if (!m) break;
    const c = findCore(cores, m[1]);
    if (c) { if (!targets.includes(c.id)) targets.push(c.id); } else unknown.push(m[1]);
    text = text.slice(m[0].length);
  }
  if (!targets.length && !unknown.length && spoken) {
    const v = /^(?:hey\s+)?([\p{L}]+)\s*[,:]\s*/iu.exec(text);
    const c = v && findCore(cores, v[1]);
    if (c) { targets.push(c.id); text = text.slice(v[0].length); }
  }
  return { targets, unknown, text: text.trim() };
}

// Prime's [[delegate ROLE TASK]] / the older [[clone TASK]]: which specialist?
function roleForTask(task) {
  const t = String(task || '').toLowerCase();
  if (/\b(remember(ed)?|recall|memor(y|ies)|what do you know about me|history|my (notes|files|documents)|last time|archive)\b/.test(t)) return 'archivist';
  if (/\b(open|click|go to|navigate|browse|website|desktop|operate|fill (in|out)|download|install)\b/.test(t)) return 'navigator';
  if (/\b(review|check|audit|test|verify|qa|security|bug|edge case|critique|proofread)/.test(t)) return 'sentinel';
  if (/\b(research|find out|look up|compare|investigate|what is|which|sources?|evidence|documentation|docs)\b/.test(t)) return 'scout';
  return 'forge';
}

module.exports = { DEFAULTS, buildCores, findCore, parseMentions, roleForTask, clean };
