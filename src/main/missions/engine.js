'use strict';

// Mission engine (13.0, P2). A mission is a goal the user approved once, with a signed
// grant. The engine:
//   1. plans: the goal becomes 1-10 subgoals, each with a check of when it is done
//      (a deterministic file check where possible);
//   2. runs each subgoal through the existing desktop agent loop (agent.js) under the
//      same policy, so nothing here can do more than the grant allows;
//   3. verifies each subgoal: deterministic checks first; only when none exists, an
//      independent judge (Sentinel) looks at the evidence, and the report says so;
//   4. recovers: a failed or unverified subgoal is retried once with what went wrong;
//      then the mission stops and asks the user with a diagnosis;
//   5. keeps a budget (steps, minutes) and writes everything to the mission journal;
//   6. reports: every subgoal with its evidence, attempts, and what can be undone.
// No new engine for actions, memory or routing: it reuses AgentRunner, the policy, the
// journal, memgate (lessons) and playbooks (learned routes) through its dependencies.

const path = require('path');
const { check } = require('./checks');

// Planner prompt: subgoals, each with a check in a tiny language the engine can verify.
function missionPlanPrompt(goal, { grant, experience = '' } = {}) {
  return [
    '[mission-plan] Break this goal into the smallest list of subgoals that finishes it. Each subgoal must be something one desktop task can do and check.',
    `Goal: ${goal}`,
    `You may work only in: ${(grant && grant.folders || []).join(', ') || 'nowhere (ask)'}${grant && grant.apps && grant.apps.length ? `; apps: ${grant.apps.join(', ')}` : ''}${grant && grant.hosts && grant.hosts.length ? `; websites: ${grant.hosts.join(', ')}` : ''}.`,
    ...(experience ? [`What worked or failed on similar goals before (may be outdated):\n${experience}`] : []),
    'Reply with 1 to 10 numbered lines: "N. <subgoal> | check: <check>". Checks (paths relative to the first folder):',
    '  exists <path>     |  absent <path>     |  contains <path> :: <words that must appear>',
    '  count <glob> = <n>     |  none   (only when no file shows it; a reviewer will judge)',
    'No other text.',
  ].join('\n');
}

// "contains a.md :: glass facade" -> { type: 'contains', path, re } (words matched in order, case-insensitive)
function parseCheck(s) {
  const t = String(s || '').trim();
  let m;
  if (!t || /^none$/i.test(t)) return null;
  if ((m = /^exists\s+(.+)$/i.exec(t))) return { type: 'exists', path: m[1].trim() };
  if ((m = /^absent\s+(.+)$/i.exec(t))) return { type: 'absent', path: m[1].trim() };
  if ((m = /^contains\s+(.+?)\s*::\s*(.+)$/i.exec(t))) return { type: 'contains', path: m[1].trim(), re: m[2].trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*') };
  if ((m = /^count\s+(.+?)\s*=\s*(\d+)$/i.exec(t))) return { type: 'count', glob: m[1].trim(), n: Number(m[2]) };
  return null;
}

function parseMissionPlan(reply) {
  const out = [];
  for (const m of String(reply || '').matchAll(/^\s*\d+[.)]\s+(.+?)(?:\s*\|\s*check:\s*(.+))?\s*$/gm)) {
    const text = m[1].replace(/\[\[[\s\S]*?\]\]/g, '').trim().slice(0, 240);
    if (text.length < 3) continue;
    // A check that tries to leave the workspace is dropped (the judge decides instead).
    let c = parseCheck(m[2]);
    if (c && /(^|[\\/])\.\.([\\/]|$)|^[a-z]:|^[\\/]/i.test(c.path || c.glob || '')) c = null;
    out.push({ text, check: c });
    if (out.length >= 10) break;
  }
  return out;
}

class MissionEngine {
  // deps: {
  //   think({ text, signal }) -> reply                       planner (Jev picks the model)
  //   runSubgoal(subgoal, { attempt, note, signal }) -> { status, summary, steps }   the agent loop under the policy
  //   judge({ goal, subgoal, evidence }) -> { ok, why }       Sentinel, only when no deterministic check exists
  //   journal?: Journal, onEvent?(e), now?(), experience?: string
  // }
  constructor(deps) { this.d = { now: () => Date.now(), onEvent: () => {}, ...deps }; this.ac = null; }

  stop(reason = 'stopped') { if (this.ac && !this.ac.signal.aborted) { this.reason = reason; this.ac.abort(); } }

  _ev(type, data) {
    try { if (this.d.journal) this.d.journal.append(type, data); } catch {}
    try { this.d.onEvent({ type, ...data }); } catch {}
  }

  async run({ id, goal, grant, plan = null, resumeFrom = 0 }) {
    this.ac = new AbortController();
    const signal = this.ac.signal;
    const t0 = this.d.now();
    const root = grant && grant.folders && grant.folders[0];
    const budget = (grant && grant.budget) || { steps: 60, minutes: 30 };
    const report = { id, goal, status: 'running', subgoals: [], steps: 0, startedAt: t0, ms: 0 };
    const finish = (status, extra = {}) => { Object.assign(report, { status, ms: this.d.now() - t0, ...extra }); this._ev('end', { status, reason: extra.reason || '' }); return report; };

    if (!plan) {
      let reply = '';
      try { reply = await this.d.think({ text: missionPlanPrompt(goal, { grant, experience: this.d.experience || '' }), signal }); } catch (err) { if (signal.aborted) return finish('stopped', { reason: this.reason }); return finish('failed', { reason: `could not plan: ${err.message}` }); }
      plan = parseMissionPlan(reply);
      if (!plan.length) plan = [{ text: goal, check: null }];
    }
    this._ev('plan', { plan });
    report.subgoals = plan.map((s) => ({ text: s.text, check: s.check, status: 'pending', attempts: 0, evidence: null }));

    for (let i = resumeFrom; i < plan.length; i++) {
      const sg = report.subgoals[i];
      let note = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal.aborted) return finish('stopped', { reason: this.reason });
        if (report.steps >= budget.steps) return finish('limit', { reason: `the step budget (${budget.steps}) is used up` });
        if (this.d.now() - t0 > budget.minutes * 60000) return finish('limit', { reason: `the time budget (${budget.minutes} min) is used up` });
        sg.attempts = attempt;
        sg.status = 'running';
        this._ev('subgoal', { index: i, text: sg.text, attempt });
        let r;
        try { r = await this.d.runSubgoal(sg, { index: i, attempt, note, signal, goal }); } catch (err) { r = { status: 'failed', summary: err.message, steps: 0 }; }
        report.steps += Number(r.steps) || 0;
        if (signal.aborted || r.status === 'stopped') return finish('stopped', { reason: this.reason || r.summary || 'stopped' });
        if (report.steps > budget.steps) return finish('limit', { reason: `the step budget (${budget.steps}) is used up`, at: i });
        if (r.status === 'ask') { sg.status = 'waiting'; return finish('ask', { question: r.summary, at: i }); }
        // Verify: the file system first; the judge only when there is nothing deterministic.
        let ok = false;
        let evidence;
        if (sg.check && root) {
          const c = check(root, sg.check);
          ok = c.ok;
          evidence = { kind: 'deterministic', detail: `${sg.check.type} ${sg.check.path || sg.check.glob}: ${c.ok ? 'holds' : `does not hold (${c.detail})`}` };
        } else if (r.status === 'done' && this.d.judge) {
          let j = { ok: false, why: 'no verdict' };
          try { j = await this.d.judge({ goal, subgoal: sg.text, evidence: r.summary || '' }); } catch (err) { j = { ok: false, why: err.message }; }
          ok = !!j.ok;
          evidence = { kind: 'judged', detail: j.why };
        } else evidence = { kind: 'none', detail: r.summary || r.status };
        if (r.status !== 'done' && !sg.check) ok = false;
        sg.evidence = evidence;
        this._ev('verify', { index: i, ok, evidence });
        if (ok) { sg.status = 'done'; break; }
        sg.status = 'failed';
        if (attempt === 2) return finish('ask', { at: i, question: `I could not finish "${sg.text}" after two tries. ${evidence.kind === 'deterministic' ? evidence.detail : `Last result: ${evidence.detail}`}. How should I continue?` });
        note = `A previous attempt at this subgoal did not succeed: ${evidence.detail}. ${r.summary ? `It reported: ${String(r.summary).slice(0, 200)}. ` : ''}Do not repeat the same approach.`;
      }
    }
    return finish('done');
  }
}

// One-line-per-subgoal text for the chat and the phone.
function formatReport(r) {
  const icon = { done: '✓', failed: '✗', waiting: '…', pending: '·', running: '…' };
  const lines = [`Mission ${r.status === 'done' ? 'complete' : r.status === 'ask' ? 'needs you' : r.status}: ${r.goal}`];
  for (const s of r.subgoals) lines.push(`${icon[s.status] || '·'} ${s.text}${s.evidence ? ` (${s.evidence.kind === 'deterministic' ? 'verified' : s.evidence.kind === 'judged' ? 'judged by Sentinel' : 'unverified'}: ${String(s.evidence.detail).slice(0, 120)})` : ''}${s.attempts > 1 ? ` [${s.attempts} tries]` : ''}`);
  lines.push(`${r.steps} steps, ${Math.round(r.ms / 1000)} s.${r.question ? ` ${r.question}` : ''}${r.reason ? ` ${r.reason}` : ''}`);
  return lines.join('\n');
}

module.exports = { MissionEngine, missionPlanPrompt, parseMissionPlan, parseCheck, formatReport, path };
