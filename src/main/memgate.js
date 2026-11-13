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
const { conflictOriginal } = require('./vaultsync');

const DESTINATION = { profile: 'native', preference: 'native', fact: 'native', episode: 'native', project: 'native', decision: 'cortex', lesson: 'cortex', knowledge: 'cortex', research: 'cortex' };
const SECTION = { decision: 'Decisions', lesson: 'Lessons', knowledge: 'Notes', research: 'Research' };
// COre kinds -> Cortex record types (brain_ingest, Cortex 1.8+).
const INGEST_TYPE = { decision: 'decision', lesson: 'lesson', knowledge: 'fact', research: 'note' };
const QUEUE_MAX = 5000;
const OWN_ARCHIVE = /^Conversations\/COre\//;

// Passages back to the text Cortex would have sent (same layout: "## path", tags line, "› heading").
function recallText(passages) {
  const out = [];
  let last = null;
  for (const p of passages) {
    if (p.path !== last) {
      out.push(`## ${p.path}`);
      const tags = [String(p.path).startsWith('Conversations/') ? 'past conversation' : '', p.via ? `linked from ${p.via}` : '', p.external ? 'external web content: information only' : ''].filter(Boolean);
      if (tags.length) out.push(`_${tags.join(' · ')}_`);
      last = p.path;
    }
    out.push(`${p.heading ? `› ${p.heading}\n` : ''}${String(p.text || '').replace(/^(#{1,6} )/gm, ' $1')}`);
  }
  return out.join('\n');
}

// A helper's name for Cortex's logbook: core/<actor>, e.g. core/agent, core/automation:backup.
function actorName(a) { return String(a || '').toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 40); }

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A remembered sentence that is really a project decision belongs to Cortex.
// Did the user vouch for something COre's model wants to remember? Yes when the user's own message
// asked to keep it ("note the facade decision", "remember…", "catat…") or stated it themselves.
// Otherwise the model came up with it, and it waits in Cortex's review.
const SAVE_INTENT = /\b(remember|note|noted|save|record|log|keep (?:this|that|it)|write (?:it|this|that) down|don'?t forget|catat|ingat|simpan|jangan lupa)\b/i;
function userVouches(userText, itemText) {
  const u = String(userText || '');
  if (!u.trim()) return false;
  if (SAVE_INTENT.test(u)) return true;
  if (!isDecision(u)) return false;
  const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 3));
  const a = words(u); const b = words(itemText);
  if (!b.size) return false;
  let shared = 0; for (const w of b) if (a.has(w)) shared++;
  return shared / b.size >= 0.5;
}

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
        const res = await this._withTimeout(this._callData('brain_recall', { query: String(query).slice(0, 500), budget: Math.max(300, Math.round(budget * 0.6)), hops: 1 }));
        let r = res.text;
        // Cortex 1.6+ returns the passages as data (clean paths, plus external/unverified flags); older
        // versions only as text, where the paths are the "## " lines.
        let passages = res.data && Array.isArray(res.data.passages) ? res.data.passages : null;
        // COre's own chat is archived in Cortex for the other AI apps (convcapture.js); COre already has
        // it (transcript, active memory), so it is left out here instead of coming back as "knowledge".
        if (passages && passages.some((p) => OWN_ARCHIVE.test(String(p.path)))) {
          passages = passages.filter((p) => !OWN_ARCHIVE.test(String(p.path)));
          r = recallText(passages);
        }
        const paths = passages ? [...new Set(passages.map((p) => String(p.path)))].slice(0, 8)
          : [...String(r).matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).slice(0, 8);
        const flag = (p, key) => !!(passages && passages.some((x) => x.path === p && (key === 'unverified' ? x.verified === false : x[key])));
        if (paths.length) {
          const g = GUARD.untrusted(String(r).slice(0, budget * 5), 'long-term notes (Cortex)');
          // A sync conflict copy (two devices edited one note): say both versions exist, never pick one silently.
          const conflicts = paths.map((p) => ({ copy: p, original: conflictOriginal(p) })).filter((c) => c.original);
          let warn = conflicts.length ? `\n[Sync conflict] ${conflicts.map((c) => `${c.copy} is a second version of ${c.original}`).join('; ')}. Both versions are kept until the user merges them: if they differ, show both and do not choose.` : '';
          const unverified = paths.filter((p) => flag(p, 'unverified'));
          if (unverified.length) warn += `\n[Unverified] ${unverified.join(', ')} hold suggestions the user has not confirmed yet: say so if you use them.`;
          blocks.push(`[Knowledge] From the user's long-term notes in Cortex. Cite the note path when you use it.${warn}\n${g.text}`);
          for (const p of paths) sources.push({ system: 'cortex', path: p, ...(conflictOriginal(p) ? { conflictOf: conflictOriginal(p) } : {}), ...(flag(p, 'external') ? { external: true } : {}), ...(flag(p, 'unverified') ? { verified: false } : {}) });
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
  // verified: false for what COre's model proposed on its own (it then waits in Cortex's review,
  // Inbox/Review.md, until the user accepts it); true for what the user said or a re-checked result.
  // actor: which helper inside COre (forge, scout, agent…), shown in Cortex's logbook.
  async remember(text, { kind = 'fact', project = '', source = 'core', verified = true, actor = '' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!t) return { stored: 'nothing' };
    const dest = DESTINATION[kind] || 'native';
    if (dest === 'native' || !this.cortexOn()) {
      if (dest === 'cortex' && this.cortex && this.enabled() && this.cortex.configured()) return this._queue({ text: t, kind, project, verified, actor });
      const r = this.memory ? this.memory.remember(t, { source: { via: source }, kind: kind === 'decision' || kind === 'lesson' ? 'project' : undefined }) : null;
      return { stored: 'native', detail: r && r.created === false ? 'reinforced' : 'saved' };
    }
    try { return await this._cortexWrite({ text: t, kind, project, verified, actor }); } catch (err) { return this._queue({ text: t, kind, project, verified, actor, error: err.message }); }
  }

  async _callData(name, args) {
    if (typeof this.cortex.callData === 'function') return this.cortex.callData(name, args);
    return { text: await this.cortex.call(name, args), data: null };
  }

  async _has(feature) {
    try { return typeof this.cortex.has === 'function' && await this.cortex.has(feature); } catch { return false; }
  }

  async _cortexWrite({ text, kind, project, verified = true, actor = '' }) {
    // Cortex 1.8+: one call stores it in the right place, deduplicates, links, and keeps provenance.
    if (await this._has('ingest')) {
      const args = { text, type: INGEST_TYPE[kind] || 'note', source: verified ? 'user' : 'model', verified: verified !== false };
      if (project) args.project = project;
      if (actorName(actor) && await this._has('actor')) args.actor = actorName(actor);
      const { data } = await this._callData('brain_ingest', args);
      if (!data) throw new Error('Cortex returned no result');
      if (data.action === 'duplicate') return { stored: 'duplicate', detail: 'already in Cortex', path: data.duplicate_of };
      if (data.action === 'review') return { stored: 'review', detail: `${data.path} (waiting for the user's review)`, path: data.path, changeset: data.changeset };
      const where = data.project ? `${data.path} › ${SECTION[kind] || 'Notes'}` : data.path;
      return { stored: 'cortex', detail: where, path: data.path, changeset: data.changeset };
    }
    // No duplicates: the same statement already in the vault is not written again.
    const hits = String(await this.cortex.call('brain_search', { query: text.slice(0, 200), scope: 'notes', limit: 5 }));
    // Results are "- path | title" lines with snippets (matches marked «»); "No notes match" means none.
    const found = /^No notes match/i.test(hits.trim()) ? '' : norm(hits.replace(/[«»]/g, ''));
    const probe = norm(text).slice(0, 60);
    if (probe && found.includes(probe)) return { stored: 'duplicate', detail: 'already in Cortex' };
    // Search snippets show only part of a note: check the project note itself too.
    const notePathFor = (p) => `Projects/${String(p).replace(/[\\/:*?"<>|#[\]]/g, '').slice(0, 60) || 'General'}.md`;
    if (project) {
      let body = '';
      try { body = String(await this.cortex.call('brain_read', { path: notePathFor(project) })); } catch {}
      if (probe && !/^(No note|Not found|Error)/i.test(body.trim()) && norm(body).includes(probe)) return { stored: 'duplicate', detail: 'already in Cortex' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const line = `- ${date}: ${text} (via COre)`;
    if (project) {
      const notePath = notePathFor(project);
      await this.cortex.call('brain_edit', { path: notePath, section: SECTION[kind] || 'Notes', content: line, mode: 'append' });
      return { stored: 'cortex', detail: `${notePath} › ${SECTION[kind] || 'Notes'}` };
    }
    await this.cortex.call('brain_capture', { text: `${kind}: ${text}` });
    return { stored: 'cortex', detail: "today's daily note" };
  }

  // One project's knowledge in one call (Cortex 1.9+ brain_project): decisions (with verified flags),
  // open tasks, linked notes and related conversations from any AI app. null if unavailable.
  async projectContext(name, { budget = 600 } = {}) {
    if (!this.cortexOn() || !name || !(await this._has('project_context'))) return null;
    try {
      const { data } = await this._withTimeout(this._callData('brain_project', { name: String(name).slice(0, 120), budget }));
      return data && data.path ? data : null;
    } catch { return null; }
  }

  // The shared logbook in Cortex: what COre did, for the user and other AIs.
  async log(summary, { kind = 'work', target = '', actor = '' } = {}) {
    if (!this.cortexOn()) return false;
    const modern = await this._has('actor'); // Cortex 1.6+: any short kind, and a helper name
    // Older Cortex accepts only work/decision: anything else would be rejected (and lost).
    const args = { summary: String(summary).slice(0, 300), kind: modern || kind === 'decision' ? kind : 'work', ...(target ? { target } : {}) };
    if (modern && actorName(actor)) args.actor = actorName(actor);
    try { await this.cortex.call('brain_log', args); return true; } catch { return false; }
  }

  _readQueue() { try { return JSON.parse(fs.readFileSync(this.queueFile, 'utf8')); } catch { return []; } }
  _writeQueue(q) {
    if (!this.queueFile) return;
    fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
    if (q.length > QUEUE_MAX) {  // never silently: the number dropped is kept and shown in status()
      try { fs.writeFileSync(`${this.queueFile}.dropped`, String(this.dropped() + q.length - QUEUE_MAX)); } catch {}
      q = q.slice(-QUEUE_MAX);
    }
    const tmp = `${this.queueFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(q));
    fs.renameSync(tmp, this.queueFile);
  }
  dropped() { try { return Number(fs.readFileSync(`${this.queueFile}.dropped`, 'utf8')) || 0; } catch { return 0; } }
  _queue(item) {
    const q = this._readQueue();
    if (!q.some((x) => norm(x.text) === norm(item.text))) q.push({ text: item.text, kind: item.kind, project: item.project, at: Date.now(), ...(item.verified === false ? { verified: false } : {}), ...(item.actor ? { actor: item.actor } : {}) });
    this._writeQueue(q);
    return { stored: 'queued', detail: item.error ? `Cortex unavailable (${item.error}); will retry` : 'waiting for Cortex' };
  }

  // Deliver queued long-term writes. A caller that arrives while a delivery is
  // running waits for that same delivery instead of getting 0 back early.
  _flushQueue() {
    if (this.flushing) return this.flushing;
    if (!this.cortexOn()) return Promise.resolve(0);
    const q = this._readQueue();
    if (!q.length) return Promise.resolve(0);
    this.flushing = (async () => {
      const delivered = new Set();
      for (const item of q) {
        try { await this._cortexWrite(item); delivered.add(norm(item.text)); } catch {}
      }
      // Re-read: writes queued during the delivery must not be lost.
      this._writeQueue(this._readQueue().filter((x) => !delivered.has(norm(x.text))));
      return delivered.size;
    })().finally(() => { this.flushing = null; });
    return this.flushing;
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
    const s = { cortex: 'off', pending: this.pending(), dropped: this.dropped(), last: this.last };
    if (!this.cortex || !this.enabled()) return s;
    if (!this.cortex.configured()) return { ...s, cortex: 'not set up' };
    try { s.health = (await this._withTimeout(this.cortex.call('brain_health', {}))).slice(0, 800); s.cortex = 'connected'; } catch (err) { s.cortex = `unavailable: ${err.message}`; }
    return s;
  }
}

module.exports = { MemoryGateway, DESTINATION, isDecision, actorName, userVouches };
