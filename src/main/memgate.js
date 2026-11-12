'use strict';

// Memory gateway: the one memory interface COre's brain, specialists and agent
// use. It coordinates two existing systems, never a third:
//   - COre native memory (memory.js) = ACTIVE memory: profile, preferences,
//     recent facts, confidence, contradictions, task episodes.
//   - Cortex (cortex.js, MCP) = LONG-TERM knowledge: project decisions,
//     lessons, research, linked notes, cross-AI logbook, version history.
// Each kind of memory has one authoritative destination (DESTINATION). Reads
// merge both within a token budget and keep their sources. Retrieved text is
// data, never instructions (fenced by guard.js). If Cortex is unavailable,
// COre keeps working on native memory and long-term writes wait in a queue.

const fs = require('fs');
const path = require('path');
const GUARD = require('./guard');

const DESTINATION = { profile: 'native', preference: 'native', fact: 'native', episode: 'native', project: 'native', decision: 'cortex', lesson: 'cortex', knowledge: 'cortex', research: 'cortex' };
const SECTION = { decision: 'Decisions', lesson: 'Lessons', knowledge: 'Notes', research: 'Research' };

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A remembered sentence that is really a project decision belongs to Cortex.
function isDecision(text) { return /\b(decided|decision|we chose|chose|agreed|will use|going with|settled on|approved)\b/i.test(String(text)); }

class MemoryGateway {
  // memory: native Memory; cortex: CortexClient or null; enabled(): Cortex on?;
  // queueFile: where long-term writes wait while Cortex is down.
  constructor({ memory, cortex = null, enabled = () => !!cortex, queueFile = '', recallTimeoutMs = 5000 } = {}) {
    this.memory = memory;
    this.cortex = cortex;
    this.enabled = enabled;
    this.queueFile = queueFile;
    this.recallTimeoutMs = recallTimeoutMs;
    this.last = null;
  }

  cortexOn() { return !!(this.cortex && this.enabled() && this.cortex.configured()); }

  async _withTimeout(p) {
    let t;
    try { return await Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('Cortex took too long')), this.recallTimeoutMs); })]); } finally { clearTimeout(t); }
  }

  // -> { text, sources: [{ system, path }], cortex: 'ok'|'off'|'empty'|'unavailable: …' }
  async context(query, { budget = 1600, k = 8 } = {}) {
    const blocks = [];
    const sources = [];
    let native = '';
    try { native = this.memory ? (await this.memory.contextForAsync(query, k)) || '' : ''; } catch {}
    if (native) { blocks.push(native); sources.push({ system: 'core', path: 'active memory' }); }
    let cortex = 'off';
    if (this.cortexOn()) {
      try {
        const r = await this._withTimeout(this.cortex.call('brain_recall', { query: String(query).slice(0, 500), budget: Math.max(300, Math.round(budget * 0.6)), hops: 1 }));
        const paths = [...String(r).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).slice(0, 8);
        if (paths.length) {
          const g = GUARD.untrusted(String(r).slice(0, budget * 5), 'long-term notes (Cortex)');
          blocks.push(`[Knowledge] From the user's long-term notes in Cortex. Cite the note path when you use it.\n${g.text}`);
          for (const p of paths) sources.push({ system: 'cortex', path: p });
          cortex = 'ok';
        } else cortex = 'empty';
        this._flushQueue().catch(() => {});
      } catch (err) { cortex = `unavailable: ${String(err.message || err).slice(0, 120)}`; }
    }
    this.last = { query: String(query).slice(0, 200), at: Date.now(), cortex, sources };
    return { text: blocks.join('\n\n'), sources, cortex };
  }

  // Store something in its one authoritative place. kind: profile | preference |
  // fact | episode | decision | lesson | knowledge | research. project: name.
  // -> { stored: 'native'|'cortex'|'queued'|'duplicate', detail }
  async remember(text, { kind = 'fact', project = '', source = 'core' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!t) return { stored: 'nothing' };
    const dest = DESTINATION[kind] || 'native';
    if (dest === 'native' || !this.cortexOn()) {
      if (dest === 'cortex' && this.cortex && this.enabled() && this.cortex.configured()) return this._queue({ text: t, kind, project });
      const r = this.memory ? this.memory.remember(t, { source: { via: source }, kind: kind === 'decision' || kind === 'lesson' ? 'project' : undefined }) : null;
      return { stored: 'native', detail: r && r.created === false ? 'reinforced' : 'saved' };
    }
    try { return await this._cortexWrite({ text: t, kind, project }); } catch (err) { return this._queue({ text: t, kind, project, error: err.message }); }
  }

  async _cortexWrite({ text, kind, project }) {
    // No duplicates: the same statement already in the vault is not written again.
    const hits = String(await this.cortex.call('brain_search', { query: text.slice(0, 200), scope: 'notes', limit: 5 }));
    // Results are "- path | title" lines with snippets (matches marked «»); "No notes match" means none.
    const found = /^No notes match/i.test(hits.trim()) ? '' : norm(hits.replace(/[«»]/g, ''));
    const probe = norm(text).slice(0, 60);
    if (probe && found.includes(probe)) return { stored: 'duplicate', detail: 'already in Cortex' };
    const date = new Date().toISOString().slice(0, 10);
    const line = `- ${date}: ${text} (via COre)`;
    if (project) {
      const notePath = `Projects/${String(project).replace(/[\\/:*?"<>|#[\]]/g, '').slice(0, 60) || 'General'}.md`;
      await this.cortex.call('brain_edit', { path: notePath, section: SECTION[kind] || 'Notes', content: line, mode: 'append' });
      return { stored: 'cortex', detail: `${notePath} › ${SECTION[kind] || 'Notes'}` };
    }
    await this.cortex.call('brain_capture', { text: `${kind}: ${text}` });
    return { stored: 'cortex', detail: "today's daily note" };
  }

  // The shared logbook in Cortex: what COre did, for the user and other AIs.
  async log(summary, { kind = 'work', target = '' } = {}) {
    if (!this.cortexOn()) return false;
    try { await this.cortex.call('brain_log', { summary: String(summary).slice(0, 300), kind, ...(target ? { target } : {}) }); return true; } catch { return false; }
  }

  _readQueue() { try { return JSON.parse(fs.readFileSync(this.queueFile, 'utf8')); } catch { return []; } }
  _writeQueue(q) {
    if (!this.queueFile) return;
    fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
    const tmp = `${this.queueFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(q.slice(-200)));
    fs.renameSync(tmp, this.queueFile);
  }
  _queue(item) {
    const q = this._readQueue();
    if (!q.some((x) => norm(x.text) === norm(item.text))) q.push({ text: item.text, kind: item.kind, project: item.project, at: Date.now() });
    this._writeQueue(q);
    return { stored: 'queued', detail: item.error ? `Cortex unavailable (${item.error}); will retry` : 'waiting for Cortex' };
  }

  async _flushQueue() {
    if (!this.cortexOn() || this.flushing) return 0;
    const q = this._readQueue();
    if (!q.length) return 0;
    this.flushing = true;
    let done = 0;
    const left = [];
    try {
      for (const item of q) {
        try { await this._cortexWrite(item); done++; } catch { left.push(item); }
      }
      this._writeQueue(left);
    } finally { this.flushing = false; }
    return done;
  }

  pending() { return this._readQueue().length; }

  // Knowledge maintenance, two steps: plan() reports, apply(plan) changes only
  // what the user approved. Cortex is checked (health) but never rewritten here.
  async maintenancePlan() {
    const native = this.memory ? this.memory.consolidate(Date.now(), { dryRun: true }) : { merged: 0, retired: 0, total: 0, plan: { merges: [], retirements: [] } };
    let cortex = 'off';
    if (this.cortexOn()) {
      try { cortex = String(await this._withTimeout(this.cortex.call('brain_health', {}))).slice(0, 1500); } catch (err) { cortex = `unavailable: ${String(err.message || err).slice(0, 120)}`; }
    }
    let pending = 0; try { pending = (this._readQueue() || []).length; } catch {}
    return { at: Date.now(), native, cortex, pending };
  }

  async applyMaintenance(plan, { merge = true, retire = false, flush = true } = {}) {
    const out = { merged: 0, retired: 0, delivered: 0 };
    if (this.memory && (merge || retire) && plan && (plan.native.merged || plan.native.retired)) {
      const r = this.memory.consolidate(Date.now(), { retire });
      out.merged = r.merged; out.retired = r.retired;
    }
    if (flush && plan && plan.pending) { const before = plan.pending; await this._flushQueue().catch(() => {}); let now = 0; try { now = (this._readQueue() || []).length; } catch {} out.delivered = Math.max(0, before - now); }
    return out;
  }

  async status() {
    const s = { cortex: 'off', pending: this.pending(), last: this.last };
    if (!this.cortex || !this.enabled()) return s;
    if (!this.cortex.configured()) return { ...s, cortex: 'not set up' };
    try { s.health = (await this._withTimeout(this.cortex.call('brain_health', {}))).slice(0, 800); s.cortex = 'connected'; } catch (err) { s.cortex = `unavailable: ${err.message}`; }
    return s;
  }
}

module.exports = { MemoryGateway, DESTINATION, isDecision };
