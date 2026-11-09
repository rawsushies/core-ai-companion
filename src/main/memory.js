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

// Facts that can only have one current value ("where the user lives"). A new
// fact in the same slot supersedes the old one (kept in the item's history)
// instead of piling up contradictions.
// Conservative on purpose: only facts clearly about the user themself
// ("the user's name is", "I live in"), so "a companion called COre" or "her
// sister lives in Bali" never overwrite the user's own name or home.
const WHO = String.raw`(?:the user|user|i)`;
const WHOSE = String.raw`(?:the user's|user's|users|my)`;
const SLOTS = [
  ['name', new RegExp(String.raw`\b${WHOSE} name is\b|\b${WHO} (?:am|is) called\b|\b${WHO} goes? by\b|\bcall me\b`)],
  ['home', new RegExp(String.raw`\b${WHO} (?:now |currently )?(?:lives?|live|resides?|is based|am based) in\b|\b${WHO} (?:has )?moved to\b|\b${WHOSE} home is in\b`)],
  ['work', new RegExp(String.raw`\b${WHO} (?:now |currently )?works? (?:at|for|as)\b|\b${WHOSE} (?:job|occupation|employer) is\b`)],
  ['birthday', new RegExp(String.raw`\b${WHOSE} birthday\b|\b${WHO} (?:was )?born on\b`)],
  ['age', new RegExp(String.raw`\b${WHO} (?:is|am) \d{1,3}(?: years old)?\b|\b${WHOSE} age is\b`)],
  ['pronouns', new RegExp(String.raw`\b${WHOSE} pronouns\b`)],
  ['timezone', new RegExp(String.raw`\b${WHOSE} time ?zone\b`)],
];

function slotOf(text) {
  const t = String(text || '').toLowerCase().replace(/’/g, "'");
  const fav = new RegExp(String.raw`\b${WHOSE} favou?rite (\w+)`).exec(t);
  if (fav) return `favorite:${fav[1]}`;
  for (const [slot, re] of SLOTS) if (re.test(t)) return slot;
  return null;
}

// "#Project fact" -> { project, text }
function splitProject(text) {
  const m = /^#([\p{L}\p{N}_.-]{1,40})\s+([\s\S]+)$/u.exec(String(text || '').trim());
  return m ? { project: m[1], text: m[2] } : { project: null, text: String(text || '') };
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

  // Returns { item, created, replaced? }. A near-duplicate is refreshed; a
  // fact in the same slot (name, home, work...) supersedes the old value,
  // which is kept in item.history. source: { via: 'chat'|'voice'|'you' }.
  remember(text, { source } = {}) {
    const sp = splitProject(text);
    const t = sp.text.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (t.length < 3) return null;
    const now = Date.now();
    const project = sp.project;
    const sameScope = (i) => (i.project || null) === project;
    const dup = this.items.find((i) => sameScope(i) && similar(i.text, t));
    if (dup) {
      dup.text = t;
      dup.ts = now;
      dup.updatedAt = now;
      if (source) dup.source = source;
      this.save();
      return { item: dup, created: false };
    }
    const slot = slotOf(t);
    const rival = slot && this.items.find((i) => sameScope(i) && slotOf(i.text) === slot);
    if (rival) {
      const replaced = rival.text;
      rival.history = [{ text: rival.text, ts: rival.updatedAt || rival.ts }, ...(rival.history || [])].slice(0, 5);
      rival.text = t;
      rival.ts = now;
      rival.updatedAt = now;
      if (source) rival.source = source;
      this.save();
      return { item: rival, created: false, replaced };
    }
    const item = { id: randomUUID(), text: t, ts: now, createdAt: now, ...(project ? { project } : {}), ...(source ? { source } : {}) };
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

  // The user corrected a fact by hand.
  edit(id, text) {
    const item = this.items.find((i) => i.id === id);
    const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    if (!item || t.length < 3) return null;
    if (t !== item.text) item.history = [{ text: item.text, ts: item.updatedAt || item.ts }, ...(item.history || [])].slice(0, 5);
    item.text = t;
    item.ts = Date.now();
    item.updatedAt = item.ts;
    item.source = { via: 'you' };
    this.save();
    return item;
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
      // Project facts count when the message mentions the project.
      const proj = item.project && q.includes(item.project.toLowerCase()) ? 1.5 : 0;
      return { ...item, score: s + proj + 0.3 / (1 + days) };
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
    const lines = [...picked.values()].map((i) => `- ${i.project ? `[${i.project}] ` : ''}${i.text}`);
    return lines.length ? `[Memory] Things you know about the user:\n${lines.join('\n')}` : '';
  }
}

module.exports = { Memory, tokens, similar, slotOf, splitProject };
