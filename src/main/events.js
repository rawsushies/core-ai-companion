'use strict';

// Proactive intelligence (COre 2.3): permissioned event monitoring that starts
// authorized workflows.
//
//   event source (permitted by the user)  ->  rule match (relevance)
//     ->  cooldown + hourly budget  ->  history of this rule + memory context
//     ->  workflow (ask first, or run if the rule allows it)  ->  verified report
//
// Sources: 'files' (new or changed files under the folders the user shared),
// 'windows' (a window title appears). Every source is off until the user
// allows it; a rule never widens what its workflow may do: the workflow runs
// through COre's normal tools and approval policy. Only the event text itself
// is untrusted data (file names and window titles can be written by anyone).

const fs = require('fs');
const path = require('path');

const SOURCES = ['files', 'windows'];

// "*.pdf", "invoices/**/*.xlsx", "Error*" -> RegExp (case-insensitive)
function globRe(glob) {
  const g = String(glob || '*').trim() || '*';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/\\\\]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function ruleMatches(rule, ev) {
  if (!rule || rule.enabled === false || rule.source !== ev.source) return false;
  const re = globRe(rule.match);
  if (ev.source === 'files') return (!rule.on || rule.on === ev.kind) && (re.test(ev.rel) || re.test(path.basename(ev.rel)));
  if (ev.source === 'windows') return re.test(ev.title);
  return false;
}

class EventMonitor {
  // deps:
  //   getRules() -> [{ id, name, source, match, on?, workflow, mode: 'ask'|'auto', cooldownMin? }]
  //   permitted(source) -> bool          the user's per-source switch
  //   roots() -> [folders]               for 'files'
  //   listTitles() -> Promise<string[]>  for 'windows'
  //   context(query) -> Promise<string>  memory gateway recall
  //   history(ruleId) -> [{ at, status, summary, verified }]   past outcomes
  //   record(ruleId, outcome)            store an outcome
  //   ask(rule, ev, ctx) -> Promise<bool>  the user approves this run
  //   runWorkflow(rule, ev, ctx) -> Promise<{ status, summary, verified }>
  //   report(text, outcome)              tell the user
  //   log(entry)                         audit
  constructor(deps) {
    this.d = { maxPerHour: 6, debounceMs: 1500, pollMs: 4000, now: () => Date.now(), ...deps };
    this.watchers = [];
    this.pending = new Map(); // debounce key -> timer
    this.lastFire = new Map(); // rule id -> time
    this.fired = []; // times, for the hourly budget
    this.titles = null;
    this.poll = null;
    this.busy = Promise.resolve();
  }

  start() {
    this.stop();
    if (this.d.permitted('files')) {
      for (const root of (this.d.roots() || []).filter((r) => r && fs.existsSync(r))) {
        try {
          const w = fs.watch(root, { recursive: true }, (type, name) => {
            if (!name) return;
            const rel = String(name).replace(/\\/g, '/');
            if (/(^|\/)(\.git|node_modules|\.core-trash)(\/|$)/.test(rel) || /(~|\.tmp|\.crdownload|\.part)$/i.test(rel)) return;
            const key = `${root}|${rel}`;
            clearTimeout(this.pending.get(key));
            this.pending.set(key, setTimeout(() => {
              this.pending.delete(key);
              const full = path.join(root, rel);
              let st = null; try { st = fs.statSync(full); } catch {}
              if (!st || !st.isFile()) return;
              this.emit({ source: 'files', kind: Math.abs(st.birthtimeMs - st.mtimeMs) < 2000 ? 'created' : 'changed', root, rel, path: full, size: st.size });
            }, this.d.debounceMs));
          });
          this.watchers.push(w);
        } catch (err) { this.d.log({ event: 'monitor-error', source: 'files', root, error: String(err.message || err) }); }
      }
    }
    if (this.d.permitted('windows') && this.d.listTitles) {
      this.poll = setInterval(() => this.scanWindows().catch(() => {}), this.d.pollMs);
    }
    return this;
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    clearInterval(this.poll); this.poll = null;
  }

  async scanWindows() {
    const now = new Set((await this.d.listTitles()).filter(Boolean));
    const before = this.titles;
    this.titles = now;
    if (!before) return; // first scan is the baseline
    for (const t of now) if (!before.has(t)) this.emit({ source: 'windows', kind: 'opened', title: t });
  }

  describe(ev) {
    return ev.source === 'files' ? `File ${ev.kind}: ${ev.rel}` : `Window opened: "${ev.title}"`;
  }

  // An event arrived. Runs one at a time so workflows never overlap.
  emit(ev) {
    if (!SOURCES.includes(ev.source) || !this.d.permitted(ev.source)) return null;
    const rules = (this.d.getRules() || []).filter((r) => ruleMatches(r, ev));
    if (!rules.length) return null;
    const p = this.busy.then(() => this.handle(rules[0], ev)).catch((err) => this.d.log({ event: 'monitor-error', error: String(err.message || err) }));
    this.busy = p;
    return p;
  }

  async handle(rule, ev) {
    const now = this.d.now();
    const what = this.describe(ev);
    const cool = Math.max(0, Number(rule.cooldownMin == null ? 10 : rule.cooldownMin)) * 60000;
    if (now - (this.lastFire.get(rule.id) || -Infinity) < cool) { this.d.log({ event: 'monitor-skip', rule: rule.id, reason: 'cooldown', what }); return { status: 'skipped', reason: 'cooldown' }; }
    this.fired = this.fired.filter((t) => now - t < 3600000);
    if (this.fired.length >= this.d.maxPerHour) { this.d.log({ event: 'monitor-skip', rule: rule.id, reason: 'hourly budget', what }); return { status: 'skipped', reason: 'hourly budget' }; }
    this.lastFire.set(rule.id, now);
    this.fired.push(now);

    // What happened the last times, and what memory knows. Past outcomes are
    // shown as history to weigh, not as instructions or guaranteed truth.
    const past = (this.d.history(rule.id) || []).slice(-3);
    const pastText = past.length ? `[Earlier runs of "${rule.name}"] (history, may be outdated)\n${past.map((h) => `- ${new Date(h.at).toISOString().slice(0, 16)} ${h.status}${h.verified ? ' (verified)' : ' (unverified)'}: ${String(h.summary || '').slice(0, 160)}`).join('\n')}` : '';
    let mem = '';
    try { mem = (await this.d.context(`${rule.name} ${rule.workflow} ${what}`)) || ''; } catch {}
    const ctx = { what, history: past, text: [pastText, mem].filter(Boolean).join('\n\n') };
    this.d.log({ event: 'monitor-event', rule: rule.id, what, mode: rule.mode || 'ask' });

    if ((rule.mode || 'ask') !== 'auto') {
      let ok = false;
      try { ok = await this.d.ask(rule, ev, ctx); } catch {}
      if (!ok) { this.d.log({ event: 'monitor-declined', rule: rule.id, what }); return { status: 'declined' }; }
    }
    let out;
    try { out = await this.d.runWorkflow(rule, ev, ctx); } catch (err) { out = { status: 'failed', summary: String(err.message || err), verified: false }; }
    out = { status: out.status || 'failed', summary: out.summary || '', verified: !!out.verified };
    this.d.record(rule.id, { at: now, what, ...out });
    this.d.log({ event: 'monitor-outcome', rule: rule.id, what, status: out.status, verified: out.verified });
    const tag = out.verified ? 'verified' : out.status === 'done' ? 'not verified' : out.status;
    this.d.report(`${rule.name}: ${what}. ${out.status === 'done' ? 'Done' : out.status === 'stopped' ? 'Stopped' : 'Did not finish'} (${tag})${out.summary ? `: ${out.summary.slice(0, 200)}` : ''}`, out);
    return out;
  }
}

module.exports = { EventMonitor, globRe, ruleMatches, SOURCES };
