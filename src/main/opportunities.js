'use strict';

// Opportunity detection (COre 2.3): unfinished work and things that need the
// user, offered as a few suggestions. It only reads; nothing runs until the
// user picks a suggestion (each carries the command that would do it).
//
// Sources, each named on the suggestion:
//   agent       an interrupted desktop task (its checkpoint)
//   cortex      overdue / open to-dos in the user's Cortex vault (brain_tasks)
//   automation  rules whose last run failed or could not be verified
//   memory      long-term notes still waiting to reach Cortex
//   vault       notes with a sync conflict copy (two versions kept)
// Suggestions are history-informed, not assumed correct: wording says what is
// known ("last run failed") rather than what to conclude.

function parseTasks(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^- \[ \] (.+?)(?: \(due (\d{4}-\d{2}-\d{2})(, OVERDUE)?\))? — (.+)$/.exec(line.trim());
    // Cortex keeps the due date in the task text too ("… 📅 2026-11-10"): drop it.
    if (m) out.push({ text: m[1].replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*$/u, '').trim(), due: m[2] || '', overdue: !!m[3], path: m[4].trim() });
  }
  return out;
}

// Cortex 1.6+ returns the tasks as data; older versions only as "- [ ] …" lines.
async function openTasks(cortex) {
  if (typeof cortex.callData === 'function') {
    const { text, data } = await cortex.callData('brain_tasks', { action: 'list', status: 'open' });
    if (data && Array.isArray(data.tasks)) {
      return data.tasks.filter((t) => !t.done).map((t) => ({ text: String(t.text).replace(/\s*📅\s*\d{4}-\d{2}-\d{2}\s*$/u, '').trim(), due: t.due || '', overdue: !!t.overdue, path: t.path }));
    }
    return parseTasks(text);
  }
  return parseTasks(await cortex.call('brain_tasks', { action: 'list', status: 'open' }));
}

class Opportunities {
  // deps: agentTask() -> checkpoint|null; cortex: { call } | null; cortexOn() -> bool;
  //       automationHistory() -> { ruleId: [outcomes] }; pending() -> number; now()
  constructor(deps = {}) {
    this.d = { max: 3, now: () => Date.now(), cortexOn: () => !!deps.cortex, ...deps };
    this.dismissed = new Set(deps.dismissed || []);
  }

  async find() {
    const now = this.d.now();
    const found = [];
    // An interrupted desktop task.
    try {
      const t = this.d.agentTask && this.d.agentTask();
      if (t && t.status === 'running' && t.goal && now - (t.at || 0) < 7 * 864e5) {
        found.push({ id: `agent:${t.taskId || t.goal}`, source: 'agent', score: 90, text: `Your desktop task "${String(t.goal).slice(0, 80)}" stopped at step ${t.step || 0}.`, action: '/do resume' });
      }
    } catch {}
    // Overdue and due-today to-dos from Cortex.
    if (this.d.cortex && this.d.cortexOn()) {
      try {
        const tasks = await openTasks(this.d.cortex);
        const today = new Date(now).toISOString().slice(0, 10);
        for (const t of tasks.filter((x) => x.overdue).slice(0, 3)) found.push({ id: `task:${t.path}:${t.text}`, source: 'cortex', score: 80, text: `Overdue since ${t.due}: "${t.text.slice(0, 90)}" (${t.path}).`, action: `/do ${t.text.slice(0, 120)}` });
        for (const t of tasks.filter((x) => !x.overdue && x.due === today).slice(0, 2)) found.push({ id: `task:${t.path}:${t.text}`, source: 'cortex', score: 70, text: `Due today: "${t.text.slice(0, 90)}" (${t.path}).`, action: `/do ${t.text.slice(0, 120)}` });
      } catch {}
    }
    // Automations that need a look.
    try {
      const hist = (this.d.automationHistory && this.d.automationHistory()) || {};
      for (const [rule, runs] of Object.entries(hist)) {
        const last = (runs || [])[runs.length - 1];
        if (!last || now - (last.at || 0) > 3 * 864e5) continue;
        if (last.status === 'failed') found.push({ id: `auto:${rule}:${last.at}`, source: 'automation', score: 75, text: `Automation ${rule} last failed on ${String(last.what || '').slice(0, 60)}${last.summary ? `: ${String(last.summary).slice(0, 80)}` : ''}.`, action: '/automations' });
        else if (last.status === 'done' && !last.verified) found.push({ id: `auto:${rule}:${last.at}`, source: 'automation', score: 40, text: `Automation ${rule} finished ${String(last.what || '').slice(0, 60)} but the result was not verified.`, action: '/automations' });
      }
    } catch {}
    // Notes with two versions (two devices edited them while apart): both are kept until merged.
    try {
      for (const c of ((this.d.conflicts && this.d.conflicts()) || []).slice(0, 2)) found.push({ id: `conflict:${c.copy}`, source: 'vault', score: 85, text: `"${c.original}" has two versions (edited on two devices). Both are kept; merge them in Obsidian.`, action: `/obsidian ${c.copy}` });
    } catch {}
    // Long-term notes waiting for Cortex.
    try {
      const n = this.d.pending ? this.d.pending() : 0;
      if (n > 0) found.push({ id: `queue:${n}`, source: 'memory', score: 50, text: `${n} long-term note${n === 1 ? ' is' : 's are'} waiting to be saved to Cortex.`, action: '/memory maintain' });
    } catch {}
    return found.filter((s) => !this.dismissed.has(s.id)).sort((a, b) => b.score - a.score).slice(0, this.d.max);
  }

  dismiss(id) { this.dismissed.add(id); }

  static format(list) {
    if (!list.length) return 'Nothing waiting on you right now.';
    return `Things that may need you (from what COre can see; nothing has been done):\n${list.map((s, i) => `${i + 1}. ${s.text} [${s.source}] → ${s.action}`).join('\n')}`;
  }
}

module.exports = { openTasks,  Opportunities, parseTasks };
