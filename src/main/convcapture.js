'use strict';

// Conversation capture: COre's own chat, kept in the user's Cortex archive like every other AI app's
// (Conversations/COre/…), through Cortex's memory gateway (brain_ingest_events, Cortex 2.0+).
// What is said is stored as it was said: append-only, deduplicated by message id on every device,
// credentials redacted by Cortex. One archived conversation per day ("COre · 2026-11-13").
// Only your messages and the cores' replies are kept; progress lines, tool chatter and tutorials are not.
// If Cortex is down, messages wait in a small file and go out on the next flush (never silently lost:
// anything over the cap is counted). Off when memory or Cortex is off, or captureConversations is false.

const fs = require('fs');
const path = require('path');

const KEEP_KINDS = new Set([undefined, '', 'message']);
const MAX_WAITING = 2000;

function dayOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class ConversationCapture {
  // cortex: CortexClient-like ({ callData, has }); enabled(): capture allowed now?;
  // queueFile: where messages wait while Cortex is unavailable; flushMs: batching delay.
  constructor({ cortex, enabled = () => true, queueFile = '', flushMs = 3000, now = () => Date.now() } = {}) {
    this.cortex = cortex;
    this.enabled = enabled;
    this.queueFile = queueFile;
    this.flushMs = flushMs;
    this.now = now;
    this.timer = null;
    this.flushing = null;
    this.last = null;
  }

  // A transcript entry: { role: 'user'|'core'|…, text, ts, author, kind }.
  event(entry) {
    if (!entry || !['user', 'core'].includes(entry.role) || !KEEP_KINDS.has(entry.kind) || !String(entry.text || '').trim()) return null;
    const ts = Number(entry.ts) || this.now();
    const day = dayOf(ts);
    const author = entry.role === 'core' ? (entry.author || 'prime') : '';
    return {
      provider: 'core', adapter: 'core-chat@1', capture: 'mcp', kind: 'message',
      session: { id: `core-${day}`, title: `COre · ${day}`, started: `${day}T00:00:00` },
      message: { id: `${ts}:${entry.role}:${author}`, role: entry.role === 'user' ? 'user' : 'assistant', text: String(entry.text).slice(0, 100000), ts: new Date(ts).toISOString(), model: author ? `COre ${author}` : '' },
    };
  }

  // An agent outcome (a desktop task finished, an automation ran): kept as an agent event.
  agentEvent(text, { id = '', ts = this.now(), actor = 'agent' } = {}) {
    if (!this.enabled() || !String(text || '').trim()) return;
    const day = dayOf(ts);
    this._push({
      provider: 'core', adapter: 'core-chat@1', capture: 'mcp', kind: 'agent_event',
      session: { id: `core-${day}`, title: `COre · ${day}`, started: `${day}T00:00:00` },
      message: { id: id || `${ts}:event:${actor}`, role: 'tool', text: String(text).slice(0, 20000), ts: new Date(ts).toISOString(), model: `COre ${actor}` },
    });
  }

  add(entry) {
    if (!this.enabled()) return;
    const ev = this.event(entry);
    if (ev) this._push(ev);
  }

  _read() { try { return JSON.parse(fs.readFileSync(this.queueFile, 'utf8')); } catch { return []; } }
  _write(q) {
    if (!this.queueFile) return;
    fs.mkdirSync(path.dirname(this.queueFile), { recursive: true });
    if (q.length > MAX_WAITING) {
      try { fs.writeFileSync(`${this.queueFile}.dropped`, String(this.dropped() + q.length - MAX_WAITING)); } catch {}
      q = q.slice(-MAX_WAITING);
    }
    fs.writeFileSync(`${this.queueFile}.tmp`, JSON.stringify(q));
    fs.renameSync(`${this.queueFile}.tmp`, this.queueFile);
  }
  dropped() { try { return Number(fs.readFileSync(`${this.queueFile}.dropped`, 'utf8')) || 0; } catch { return 0; } }
  waiting() { return this._read().length; }

  _push(ev) {
    const q = this._read();
    q.push(ev);
    this._write(q);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, this.flushMs);
      if (this.timer.unref) this.timer.unref(); // never keeps the app (or a test run) alive on its own
    }
  }

  // Send what's waiting. -> { sent, archived, duplicate, failed }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const q = this._read();
      if (!q.length || !this.enabled() || !this.cortex) return { sent: 0 };
      if (typeof this.cortex.has !== 'function' || !(await this.cortex.has('events_ingest'))) return { sent: 0, unsupported: true };
      const batch = q.slice(0, 200);
      try {
        const { data } = await this.cortex.callData('brain_ingest_events', { events: batch });
        const res = (data && data.results) || [];
        // Keep only what Cortex couldn't take yet ("queued"); archived, duplicate, invalid and
        // skipped (by the user's capture rules) are done. Invalid ones are kept by Cortex for inspection.
        const retry = batch.filter((_, i) => res[i] && res[i].status === 'queued');
        const rest = this._read().slice(batch.length);
        this._write([...retry, ...rest]);
        const count = (s) => res.filter((r) => r.status === s).length;
        this.last = { at: this.now(), archived: count('archived'), duplicate: count('duplicate'), skipped: count('skipped'), invalid: count('invalid') };
        if (rest.length) { const t = setTimeout(() => this.flush().catch(() => {}), 50); if (t.unref) t.unref(); }
        return { sent: batch.length, ...this.last };
      } catch (err) {
        this.last = { at: this.now(), error: String(err.message || err).slice(0, 200) };
        return { sent: 0, failed: batch.length };
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}

module.exports = { ConversationCapture, dayOf };
