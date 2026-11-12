'use strict';

// Environmental intelligence (COre 2.2): what is on the desktop, which project
// it belongs to, and what both memory systems already know about it, as a list
// of facts that each carry their source. The brain explains the situation from
// this list; groundCheck() then flags names in its answer that no source backs.
//
// Sources:
//   observed  read from Windows UI Automation just now (window titles, states,
//             dialogs, the focused window's controls)
//   memory    COre active memory (via the memory gateway)
//   cortex    Cortex long-term notes (via the memory gateway), with the note path
//   inferred  COre's own conclusion from the above, with the evidence named
//
// Nothing here acts on the desktop; it only reads.

const GUARD = require('./guard');

const DIALOG_CLASSES = new Set(['#32770']); // Win32 dialog / message box class

function clip(s, n = 120) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

// Window title -> { app, document } using the common "Document - App" shape.
function splitTitle(title) {
  const parts = String(title || '').split(/\s+[-–—|]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { app: '', document: '' };
  return { app: parts[parts.length - 1], document: parts.slice(0, -1).join(' - ') };
}

class Situation {
  constructor({ uia = null, gateway = null, memory = null, controlLimit = 40 } = {}) {
    this.uia = uia;
    this.gateway = gateway;
    this.memory = memory;
    this.controlLimit = controlLimit;
    this.prev = null; // last observation, for change detection
  }

  // -> { at, active, windows, dialogs, controls, changes, error }
  async observe() {
    const at = Date.now();
    if (!this.uia) return { at, active: null, windows: [], dialogs: [], controls: [], changes: [], error: 'UI Automation is not available on this system' };
    let windows = [];
    try { windows = await this.uia.windows({ owned: true }); } catch (err) { return { at, active: null, windows: [], dialogs: [], controls: [], changes: [], error: `could not read windows: ${clip(err.message || err)}` }; }
    windows = windows.filter((w) => w && w.name);
    const dialogs = windows.filter((w) => w.modal || w.dialog || DIALOG_CLASSES.has(w.cls));
    const active = windows.find((w) => w.foreground) || null;
    let controls = [];
    if (active) {
      try {
        const snap = await this.uia.snapshot({ target: active.id, depth: 8, max: 120 });
        controls = (snap.elements || []).filter((e) => e.name || e.value).slice(0, this.controlLimit)
          .map((e) => ({ type: e.type, name: clip(e.name, 60), value: e.value != null ? clip(e.value, 60) : undefined, toggle: e.toggle }));
      } catch {}
    }
    const changes = [];
    if (this.prev) {
      const before = new Map(this.prev.windows.map((w) => [w.handle || w.id, w]));
      const now = new Map(windows.map((w) => [w.handle || w.id, w]));
      for (const [k, w] of now) if (!before.has(k)) changes.push(`opened: "${clip(w.name, 80)}"`);
      for (const [k, w] of before) if (!now.has(k)) changes.push(`closed: "${clip(w.name, 80)}"`);
      for (const [k, w] of now) { const b = before.get(k); if (b && b.name !== w.name) changes.push(`retitled: "${clip(b.name, 60)}" -> "${clip(w.name, 60)}"`); }
      const pa = this.prev.active && this.prev.active.name;
      if (active && pa && pa !== active.name) changes.push(`switched to: "${clip(active.name, 80)}"`);
    }
    const obs = { at, active, windows, dialogs, controls, changes, error: '' };
    this.prev = obs;
    return obs;
  }

  // Projects the desktop seems to be about, each with its evidence.
  // names: known project names (COre memory projects + Cortex Projects/ notes).
  static matchProjects(obs, names) {
    const out = [];
    const seen = new Set();
    const titles = (obs.windows || []).map((w) => w.name);
    for (const n of names) {
      const name = String(n || '').trim();
      if (!name || name.length < 3 || seen.has(name.toLowerCase())) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu');
      const hit = titles.find((t) => re.test(t));
      if (hit) { seen.add(name.toLowerCase()); out.push({ project: name, evidence: `window title "${clip(hit, 80)}"`, active: !!(obs.active && obs.active.name === hit) }); }
    }
    return out.sort((a, b) => Number(b.active) - Number(a.active));
  }

  _knownProjects(sources) {
    const names = new Set();
    try { for (const i of (this.memory && this.memory.items) || []) if (i.project) names.add(i.project); } catch {}
    for (const s of sources || []) { const m = /^Projects\/(.+?)\.md$/i.exec(s.path || ''); if (s.system === 'cortex' && m) names.add(m[1]); }
    return [...names];
  }

  // -> { facts: [{ text, source, ref }], projects, memory: {text, sources, cortex}, obs, prompt }
  async describe(question = '') {
    const obs = await this.observe();
    const facts = [];
    const add = (text, source, ref = '') => facts.push({ text, source, ref });
    if (obs.error) add(`Desktop could not be read: ${obs.error}`, 'observed', 'uia');
    if (obs.active) {
      const st = obs.active.state && obs.active.state !== 'normal' ? ` (${obs.active.state})` : '';
      add(`Active window: "${clip(obs.active.name, 100)}"${obs.active.process ? ` from ${obs.active.process}` : ''}${st}`, 'observed', 'uia');
      const { app, document } = splitTitle(obs.active.name);
      if (document) add(`The active window appears to show "${clip(document, 80)}" in ${app}`, 'inferred', 'from the window title');
    } else if (!obs.error) add('No window is in the foreground', 'observed', 'uia');
    for (const d of obs.dialogs) add(`Dialog open: "${clip(d.name, 100)}"${d.owner ? ` over "${clip(d.owner, 60)}"` : ''}${d.process ? ` (${d.process})` : ''}`, 'observed', 'uia');
    const others = obs.windows.filter((w) => w !== obs.active && !obs.dialogs.includes(w)).slice(0, 12);
    if (others.length) add(`Other windows: ${others.map((w) => `"${clip(w.name, 50)}"${w.state === 'minimized' ? ' (minimized)' : ''}`).join(', ')}`, 'observed', 'uia');
    if (obs.controls.length) add(`Controls in the active window: ${obs.controls.map((c) => `${c.type}${c.name ? ` "${c.name}"` : ''}${c.value ? ` = "${c.value}"` : ''}${c.toggle ? ` [${c.toggle}]` : ''}`).join('; ')}`, 'observed', 'uia');
    for (const c of obs.changes) add(`Since the last look: ${c}`, 'observed', 'uia');

    // Recall from both memory systems, steered by what is on screen.
    const query = [question, obs.active && obs.active.name, ...obs.dialogs.map((d) => d.name), ...obs.windows.filter((w) => w !== obs.active).slice(0, 6).map((w) => clip(w.name, 60))].filter(Boolean).join(' | ').slice(0, 500);
    let memory = { text: '', sources: [], cortex: 'off' };
    if (this.gateway && query) { try { memory = await this.gateway.context(query); } catch {} }
    const projects = Situation.matchProjects(obs, this._knownProjects(memory.sources));
    for (const p of projects) add(`Project in view: ${p.project}`, 'inferred', p.evidence);
    for (const s of memory.sources) add(s.system === 'cortex' ? `Long-term note: ${s.path}` : 'Active memory has related entries', s.system === 'cortex' ? 'cortex' : 'memory', s.path);
    return { facts, projects, memory, obs, prompt: Situation.prompt(facts, memory) };
  }

  // The block the brain receives. Observations are data (window titles can be
  // written by anyone), memory is fenced as data by the gateway.
  static prompt(facts, memory = { text: '' }) {
    const lines = facts.map((f) => `- [${f.source}${f.ref && f.source !== 'observed' ? `: ${f.ref}` : ''}] ${f.text}`).join('\n');
    const obs = GUARD.untrusted(lines, 'desktop observation (UI Automation)');
    return [
      '[Situation] What COre can see on the desktop right now, and what memory knows about it. Each line is tagged with where it comes from.',
      'When you explain the situation: state [observed] items as facts, say "it looks like" for [inferred] items, cite note paths for [cortex] items, and do not mention any window, file, project or decision that is not listed here or in the memory below. If something is not visible, say so.',
      obs.text,
      memory.text || '',
    ].filter(Boolean).join('\n\n');
  }
}

// Names the answer asserts (quoted strings and file names) that appear in no
// fact or memory text. -> { ok, unsupported: [..] }
function groundCheck(answer, facts, memoryText = '') {
  const hay = `${facts.map((f) => `${f.text} ${f.ref || ''}`).join('\n')}\n${memoryText}`.toLowerCase();
  const claims = new Set();
  for (const m of String(answer || '').matchAll(/["“]([^"”\n]{3,80})["”]/g)) claims.add(m[1].trim());
  for (const m of String(answer || '').matchAll(/[\w()-][\w().-]{0,60}\.(?:xlsx?|docx?|pptx?|pdf|txt|md|csv|dwg|dxf|ifc|pln|js|ts|py|json|png|jpe?g)\b/gi)) claims.add(m[0]);
  const unsupported = [...claims].filter((c) => {
    const lc = c.toLowerCase();
    if (hay.includes(lc)) return false;
    const base = lc.split(/[\s/\\]/).pop(); // "the Budget.xlsx" -> "budget.xlsx"
    return !(base && base.length >= 3 && hay.includes(base));
  });
  return { ok: unsupported.length === 0, unsupported };
}

module.exports = { Situation, groundCheck, splitTitle };
