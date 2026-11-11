'use strict';

const { quarantine } = require('./config');

// COre's Memory Intelligence Engine. Short facts about the user, kept with
// kind (profile / preference / project / episode / fact), confidence, sources
// and history. Facts arrive from [[remember ...]], from clear statements in the
// user's own messages (automatic capture, can be turned off), from finished
// tasks (project history) and from the user's edits.
//
// Retrieval is hybrid: BM25 keywords + fuzzy trigrams, plus semantic vectors
// when a local embedding model is available (embed/), weighted by confidence,
// pins, use and recency. Contradictions supersede the older fact (kept in its
// history and in a conflict log the user can review). consolidate() merges
// near-duplicates and retires stale, unused episodes.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_ITEMS = 1000;
const MAX_EPISODES = 300;
const CONF = { you: 1, model: 0.85, cloud: 0.75, auto: 0.7, episode: 0.6 };
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

// ------------------------------------------------------------------ kinds, polarity

function kindOf(text, project) {
  if (project) return 'project';
  if (slotOf(text)) return 'profile';
  if (polarity(text)) return 'preference';
  return 'fact';
}

// "the user likes X" -> { sign: 1, object: 'x' }; "dislikes / hates X" -> -1.
const POS = /\b(?:likes?|loves?|enjoys?|prefers?|is into|is a fan of)\b\s+(.+)$/i;
const NEG = /\b(?:dislikes?|hates?|can't stand|cannot stand|doesn't like|does not like|don't like|do not like|avoids?)\b\s+(.+)$/i;
function polarity(text) {
  const t = String(text || '').toLowerCase().replace(/’/g, "'");
  const n = NEG.exec(t);
  if (n) return { sign: -1, object: tokens(n[1]).join(' ') };
  const p = POS.exec(t);
  if (p) return { sign: 1, object: tokens(p[1]).join(' ') };
  return null;
}

function trigrams(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  const out = new Set();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

const vecToB64 = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const b64ToVec = (s) => { try { const b = Buffer.from(s, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); } catch { return null; } };
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s; // vectors are normalised
}

// ------------------------------------------------------------------ automatic capture

// Clear first-person statements in the user's own message become facts about
// "the user". Questions, hypotheticals and long rambles are skipped.
const CAPTURE = [
  [/\b(?:remember|note|don't forget) (?:that )?(.{4,160})/i, (m) => toThird(m[1])],
  [/\bmy name is ([\p{L}][\p{L}' -]{1,40})/iu, (m) => `the user's name is ${m[1].trim()}`],
  [/\bcall me ([\p{L}][\p{L}' -]{1,30})/iu, (m) => `the user's name is ${m[1].trim()}`],
  [/\bi(?:'m| am) (?:now )?(?:living|based) in ([\p{L}][\p{L}' ,.-]{1,50})/iu, (m) => `the user lives in ${m[1].trim()}`],
  [/\bi (?:now )?live in ([\p{L}][\p{L}' ,.-]{1,50})/iu, (m) => `the user lives in ${m[1].trim()}`],
  [/\bi (?:now )?work (at|for|as) ([\p{L}\p{N}][\p{L}\p{N}' &,.-]{1,60})/iu, (m) => `the user works ${m[1].toLowerCase()} ${m[2].trim()}`],
  [/\bi(?:'m| am) an? ([\p{L}][\p{L} -]{2,40}?)(?: by trade| by profession)?$/iu, (m) => `the user is a ${m[1].trim()}`],
  [/\bmy favou?rite (\w+) is (.{2,60})/i, (m) => `the user's favorite ${m[1].toLowerCase()} is ${m[2].trim()}`],
  [/\bi (?:really )?(love|like|enjoy|prefer) (.{2,80})/i, (m) => `the user ${m[1].toLowerCase()}s ${toThird(m[2])}`],
  [/\bi (?:really )?(?:hate|dislike|can't stand|don't like|do not like) (.{2,80})/i, (m) => `the user dislikes ${toThird(m[1])}`],
  [/\bi(?:'m| am) allergic to (.{2,60})/i, (m) => `the user is allergic to ${m[1].trim()}`],
  [/\bmy birthday is (.{3,40})/i, (m) => `the user's birthday is ${m[1].trim()}`],
  [/\bmy pronouns are ([a-z/ ]{3,30})/i, (m) => `the user's pronouns are ${m[1].trim()}`],
  // Bahasa Indonesia
  [/\bnama saya ([\p{L}][\p{L}' -]{1,40})/iu, (m) => `the user's name is ${m[1].trim()}`],
  [/\bsaya tinggal di ([\p{L}][\p{L}' ,.-]{1,50})/iu, (m) => `the user lives in ${m[1].trim()}`],
  [/\bsaya (?:suka|senang) (.{2,60})/iu, (m) => `the user likes ${m[1].trim()}`],
];

function toThird(s) {
  return String(s || '').trim()
    .replace(/\bI am\b|\bI'm\b/gi, 'the user is').replace(/\bI have\b|\bI've\b/gi, 'the user has')
    .replace(/\bmy\b/gi, "the user's").replace(/\bme\b/gi, 'the user').replace(/\bmine\b/gi, "the user's").replace(/\bI\b/g, 'the user')
    .replace(/[.!]+$/, '');
}

function extractFacts(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 600) return [];
  const out = [];
  for (const sentence of t.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim().replace(/[.!]+$/, '');
    if (!s || /\b(if|would|could|imagine|pretend|suppose|maybe|kalau|seandainya)\b/i.test(s) || /\?/.test(s)) continue;
    for (const [re, make] of CAPTURE) {
      const m = re.exec(s);
      if (!m) continue;
      const fact = make(m).replace(/\s+/g, ' ').trim();
      if (fact.length >= 8 && fact.length <= 200 && !out.includes(fact)) out.push(fact);
      break; // one fact per sentence
    }
  }
  return out.slice(0, 4);
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
    this.conflicts = [];
    this.embedder = null; // async (texts) -> Float32Array[] | null
    for (const i of this.items) this._normalise(i);
  }

  // Older memories get the new fields.
  _normalise(i) {
    if (!i.kind) i.kind = kindOf(i.text, i.project);
    if (typeof i.confidence !== 'number') i.confidence = i.source && i.source.via === 'you' ? CONF.you : CONF.model;
    if (typeof i.hits !== 'number') i.hits = 0;
    return i;
  }

  setEmbedder(fn) { this.embedder = fn; this.embedMissing().catch(() => {}); }

  // Give every fact a vector once an embedding model is available.
  async embedMissing() {
    if (!this.embedder) return 0;
    const todo = this.items.filter((i) => !i.vec).slice(0, 64);
    if (!todo.length) return 0;
    const vecs = await this.embedder(todo.map((i) => i.text));
    if (!vecs) return 0;
    todo.forEach((i, k) => { if (vecs[k]) i.vec = vecToB64(vecs[k]); });
    this.save();
    return todo.length;
  }

  _embedOne(item) {
    if (!this.embedder) return;
    this.embedder([item.text]).then((v) => { if (v && v[0]) { item.vec = vecToB64(v[0]); this.save(); } }, () => {});
  }

  // Effective confidence: decays slowly with age unless pinned or recently used.
  effective(i, now = Date.now()) {
    if (i.pinned) return Math.max(i.confidence, 0.95);
    const days = (now - (i.lastUsed || i.updatedAt || i.ts)) / 86_400_000;
    return i.confidence * Math.max(0.5, 1 - (days / 365) * 0.3);
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
  remember(text, { source, confidence, kind } = {}) {
    const sp = splitProject(text);
    const t = sp.text.trim().replace(/\s+/g, ' ').slice(0, 300);
    if (t.length < 3) return null;
    const now = Date.now();
    const project = sp.project;
    const via = (source && source.via) || 'model';
    const conf = typeof confidence === 'number' ? confidence : (CONF[via] || CONF.model);
    const sameScope = (i) => (i.project || null) === project;
    const addSource = (i) => { if (source) { i.source = source; i.sources = [source, ...(i.sources || [])].slice(0, 5); } };
    const dup = this.items.find((i) => sameScope(i) && i.kind !== 'episode' && similar(i.text, t));
    if (dup) {
      // Said again: refreshed and more certain.
      dup.text = t.length >= dup.text.length || via === 'you' ? t : dup.text;
      dup.ts = now;
      dup.updatedAt = now;
      dup.confidence = Math.min(1, Math.max(dup.confidence || 0, conf) + 0.1);
      addSource(dup);
      this.save();
      return { item: dup, created: false, reinforced: true };
    }
    // Contradictions: the same one-value slot, or opposite feelings about the same thing.
    const slot = slotOf(t);
    const pol = polarity(t);
    const rival = this.items.find((i) => sameScope(i) && i.kind !== 'episode' && (
      (slot && slotOf(i.text) === slot)
      || (pol && pol.object && (() => { const q = polarity(i.text); return q && q.sign !== pol.sign && q.object && (q.object === pol.object || similar(q.object, pol.object)); })())));
    if (rival) {
      const replaced = rival.text;
      rival.history = [{ text: rival.text, ts: rival.updatedAt || rival.ts, reason: 'contradicted' }, ...(rival.history || [])].slice(0, 5);
      rival.text = t;
      rival.kind = kind || kindOf(t, project);
      rival.ts = now;
      rival.updatedAt = now;
      rival.confidence = Math.max(conf, 0.7);
      delete rival.vec;
      addSource(rival);
      this.conflicts = [{ id: rival.id, was: replaced, now: t, at: now }, ...this.conflicts].slice(0, 20);
      this._embedOne(rival);
      this.save();
      return { item: rival, created: false, replaced };
    }
    const item = { id: randomUUID(), text: t, kind: kind || kindOf(t, project), confidence: conf, hits: 0, ts: now, createdAt: now, ...(project ? { project } : {}), ...(source ? { source, sources: [source] } : {}) };
    this.items.push(item);
    this._trim();
    this._embedOne(item);
    this.save();
    return { item, created: true };
  }

  // Facts from the user's own message (automatic capture). Returns the results.
  capture(text, { via = 'auto', project = null } = {}) {
    return extractFacts(text).map((f) => this.remember(project ? `#${project} ${f}` : f, { source: { via, at: Date.now() }, confidence: CONF.auto })).filter(Boolean);
  }

  // Project history: what was done, kept as an episode.
  noteEpisode(text, { project = null, via = 'task' } = {}) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (t.length < 8) return null;
    const now = Date.now();
    const item = { id: randomUUID(), text: t, kind: 'episode', confidence: CONF.episode, hits: 0, ts: now, createdAt: now, ...(project ? { project } : {}), source: { via, at: now } };
    this.items.push(item);
    this._trim();
    this._embedOne(item);
    this.save();
    return item;
  }

  pin(id, on = true) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    item.pinned = !!on;
    this.save();
    return item;
  }

  _trim() {
    const eps = this.items.filter((i) => i.kind === 'episode');
    if (eps.length > MAX_EPISODES) {
      const drop = new Set(eps.filter((i) => !i.pinned).sort((a, b) => a.ts - b.ts).slice(0, eps.length - MAX_EPISODES).map((i) => i.id));
      this.items = this.items.filter((i) => !drop.has(i.id));
    }
    if (this.items.length > MAX_ITEMS) {
      const keep = this.items.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || this.effective(b) - this.effective(a)).slice(0, MAX_ITEMS);
      const ids = new Set(keep.map((i) => i.id));
      this.items = this.items.filter((i) => ids.has(i.id));
    }
  }

  // Merge near-duplicates and retire stale, unused, uncertain episodes.
  consolidate(now = Date.now()) {
    let merged = 0;
    let retired = 0;
    const out = [];
    for (const i of this.items.slice().sort((a, b) => b.ts - a.ts)) {
      const twin = i.kind !== 'episode' && out.find((o) => o.kind !== 'episode' && (o.project || null) === (i.project || null) && similar(o.text, i.text));
      if (twin) {
        twin.confidence = Math.min(1, Math.max(twin.confidence, i.confidence) + 0.05);
        twin.hits = (twin.hits || 0) + (i.hits || 0);
        twin.pinned = twin.pinned || i.pinned;
        twin.sources = [...(twin.sources || []), ...(i.sources || [])].slice(0, 5);
        twin.history = [...(twin.history || []), { text: i.text, ts: i.ts, reason: 'merged' }].slice(0, 5);
        merged++;
        continue;
      }
      const days = (now - (i.lastUsed || i.ts)) / 86_400_000;
      if (i.kind === 'episode' && !i.pinned && !i.hits && days > 180) { retired++; continue; }
      out.push(i);
    }
    if (merged || retired) { this.items = out.sort((a, b) => a.ts - b.ts); this.save(); }
    return { merged, retired, total: this.items.length };
  }

  stats() {
    const by = {};
    for (const i of this.items) by[i.kind] = (by[i.kind] || 0) + 1;
    return { total: this.items.length, byKind: by, pinned: this.items.filter((i) => i.pinned).length, embedded: this.items.filter((i) => i.vec).length, conflicts: this.conflicts.length };
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
    item.confidence = CONF.you;
    item.kind = kindOf(t, item.project);
    delete item.vec;
    this._embedOne(item);
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

  // Hybrid ranking. qvec: the query's embedding (optional).
  search(query, k = 6, { qvec = null, kinds = null } = {}) {
    const q = tokens(query);
    const pool = kinds ? this.items.filter((i) => kinds.includes(i.kind)) : this.items;
    if (!pool.length) return [];
    const N = pool.length;
    const docs = pool.map((i) => tokens(i.text));
    const df = new Map();
    for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
    const avg = docs.reduce((n, d) => n + d.length, 0) / N || 1;
    const now = Date.now();
    const qtri = trigrams(query);
    const scored = pool.map((item, i) => {
      const d = docs[i];
      let s = 0;
      for (const t of new Set(q)) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
      }
      const fuzzy = jaccard(qtri, trigrams(item.text));
      if (fuzzy > 0.18) s += fuzzy * 1.2;
      const sem = qvec && item.vec ? cosine(qvec, b64ToVec(item.vec)) : 0;
      if (sem > 0.3) s += (sem - 0.3) * 6;
      const days = (now - item.ts) / 86_400_000;
      const proj = item.project && q.includes(item.project.toLowerCase()) ? 1.5 : 0;
      const relevant = s > 0;
      return { ...item, vec: undefined, semantic: sem, score: relevant ? s + proj + 0.3 / (1 + days) + 0.4 * this.effective(item, now) + (item.pinned ? 0.3 : 0) : proj };
    });
    return scored.filter((x) => x.score > 0.31).sort((a, b) => b.score - a.score).slice(0, k);
  }

  async searchAsync(query, k = 6, opts = {}) {
    let qvec = null;
    if (this.embedder) { try { const v = await this.embedder([String(query).slice(0, 500)]); qvec = v && v[0]; } catch {} }
    return this.search(query, k, { ...opts, qvec });
  }

  _used(ids) {
    const now = Date.now();
    for (const i of this.items) if (ids.has(i.id)) { i.hits = (i.hits || 0) + 1; i.lastUsed = now; }
  }

  // Context block for a message: the most relevant facts plus the newest few
  // (identity facts like the user's name stay in play).
  contextFor(query, k = 6, qvec = null) {
    if (!this.items.length) return '';
    const picked = new Map();
    // Who the user is stays in play; then what's relevant to this message.
    for (const i of this.items.filter((x) => x.kind === 'profile' || x.pinned).sort((a, b) => this.effective(b) - this.effective(a)).slice(0, 5)) picked.set(i.id, i);
    for (const i of this.search(query, k, { qvec, kinds: ['profile', 'preference', 'project', 'fact'] })) picked.set(i.id, i);
    for (const i of this.list().filter((x) => x.kind !== 'episode').slice(0, 2)) if (picked.size < k + 4) picked.set(i.id, i);
    const eps = this.search(query, 3, { qvec, kinds: ['episode'] });
    this._used(new Set([...picked.keys(), ...eps.map((e) => e.id)]));
    const unsure = (i) => (this.effective(i) < 0.6 ? ' (not sure)' : '');
    const lines = [...picked.values()].map((i) => `- ${i.project ? `[${i.project}] ` : ''}${i.text}${unsure(i)}`);
    const hist = eps.map((e) => `- ${new Date(e.ts).toISOString().slice(0, 10)}${e.project ? ` [${e.project}]` : ''}: ${e.text}`);
    const blocks = [];
    if (lines.length) blocks.push(`[Memory] Things you know about the user:\n${lines.join('\n')}`);
    if (hist.length) blocks.push(`[History] Earlier work that may be relevant:\n${hist.join('\n')}`);
    return blocks.join('\n\n');
  }

  async contextForAsync(query, k = 6) {
    let qvec = null;
    if (this.embedder) { try { const v = await this.embedder([String(query).slice(0, 500)]); qvec = v && v[0]; } catch {} }
    return this.contextFor(query, k, qvec);
  }
}

module.exports = { Memory, tokens, similar, slotOf, splitProject, extractFacts, polarity, kindOf, CONF, vecToB64 };
