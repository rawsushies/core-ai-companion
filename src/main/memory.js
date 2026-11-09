'use strict';

const { quarantine } = require('./config');

// COre's long-term memory: short facts about the user that the model saves
// with [[remember ...]]. Retrieval is a small BM25-style keyword match with a
// recency bonus, so it needs no extra model and works with every brain. The
// best few facts are prepended to each message as "[Memory] ...".

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_ITEMS = 400;
const STOP = new Set(('a an the and or but if of to in on at for with from by is are was were be been am i you he she it we they me my your our their this that these those do does did have has had not no yes so as than then there here what which who whom how why when where can could should would will just about into over under up down out very really').split(' '));

function tokens(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}

function similar(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / Math.min(ta.size, tb.size) >= 0.8;
}

class Memory {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.recovered = null;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    if (text !== null) {
      try {
        const data = JSON.parse(text);
        if (!data || !Array.isArray(data.items)) throw new Error('no items list');
        this.items = data.items.filter((i) => i && typeof i.text === 'string' && i.text.trim());
      } catch {
        // Never overwrite memories we couldn't read: set the file aside.
        this.recovered = quarantine(file);
      }
    }
    this.backedUp = false;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Once per session, keep the previous good file as memory.json.bak.
    if (!this.backedUp && fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch {}
      this.backedUp = true;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  // Returns { item, created } — an updated near-duplicate replaces the old fact.
  remember(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (t.length < 3) return null;
    const dup = this.items.find((i) => similar(i.text, t));
    if (dup) {
      dup.text = t;
      dup.ts = Date.now();
      this.save();
      return { item: dup, created: false };
    }
    const item = { id: randomUUID(), text: t, ts: Date.now() };
    this.items.push(item);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    this.save();
    return { item, created: true };
  }

  // Forget by id, or the best match for a description.
  forget(idOrText) {
    let idx = this.items.findIndex((i) => i.id === idOrText);
    if (idx === -1) {
      const best = this.search(idOrText, 1)[0];
      if (best && (similar(best.text, idOrText) || best.score > 1.5)) idx = this.items.findIndex((i) => i.id === best.id);
    }
    if (idx === -1) return null;
    const [gone] = this.items.splice(idx, 1);
    this.save();
    return gone;
  }

  clear() {
    this.items = [];
    this.save();
  }

  list() {
    return this.items.slice().sort((a, b) => b.ts - a.ts);
  }

  search(query, k = 6) {
    const q = tokens(query);
    if (!this.items.length) return [];
    const N = this.items.length;
    const docs = this.items.map((i) => tokens(i.text));
    const df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
    const avg = docs.reduce((n, d) => n + d.length, 0) / N || 1;
    const now = Date.now();
    const scored = this.items.map((item, i) => {
      const d = docs[i];
      let s = 0;
      for (const t of new Set(q)) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
      }
      const days = (now - item.ts) / 86_400_000;
      return { ...item, score: s + 0.3 / (1 + days) };
    });
    return scored.filter((x) => x.score > 0.31).sort((a, b) => b.score - a.score).slice(0, k);
  }

  // Context block for a message: the most relevant facts plus the newest few
  // (identity facts like the user's name stay in play).
  contextFor(query, k = 6) {
    if (!this.items.length) return '';
    const picked = new Map();
    for (const i of this.search(query, k)) picked.set(i.id, i);
    for (const i of this.list().slice(0, 3)) if (picked.size < k + 2) picked.set(i.id, i);
    const lines = [...picked.values()].map((i) => `- ${i.text}`);
    return lines.length ? `[Memory] Things you know about the user:\n${lines.join('\n')}` : '';
  }
}

module.exports = { Memory, tokens, similar };
