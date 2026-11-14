'use strict';

// Streaming parser for COre's silent gesture tags.
//
// The model writes plain spoken text with optional tags such as
//   "[[point 812,440]] That button saves your file. [[explain]] Here is why..."
// Tokens arrive in arbitrary fragments ("[[po", "int 81", "2,440]]"), so the
// parser holds back anything that could still turn into a tag and only
// releases it once it is clearly a tag or clearly plain text.

// Long enough for a memory or reminder sentence; anything longer that never
// closes is released as plain text.
const MAX_TAG_LEN = 2100; // room for a [[copy ...]] snippet
const MOODS = new Set(['happy', 'amused', 'curious', 'annoyed', 'excited', 'sad', 'calm']);
const Gestures = require('../../renderer/overlay/gestures');
const Shapes = require('../../renderer/overlay/shapes');

// Tags (all silent):
//   [[point X,Y]]            reach a hand to a screenshot pixel
//   [[explain]]              open-hands gesture
//   [[mood happy]]           smoke reacts (happy|amused|curious|annoyed|excited|sad|calm)
//   [[do SKILL ARGS]]        use a skill (notes, timer, weather, music, open app, search, calendar, plugins)
//   [[clone TASK]]           split off a helper COre that works on TASK in parallel
//   [[form laugh]]           smoke forms a shape: emoji, symbol, or up to 3 letters/digits
//   [[gesture wave]]         body language from the gesture library (count takes a number)
//   [[remember TEXT]]        save a fact about the user
//   [[forget TEXT]]          drop a remembered fact
//   [[remind WHEN TEXT]]     reminder / timer, WHEN = 10m, 90s, 1h30m, 18:30, 7pm
//   [[open URL]]             offer a website (the user confirms with a click)
//   [[copy TEXT]]            offer to copy text to the clipboard (one click)
//   [[board TITLE; A; B]]    spread into a big board beside COre with a title and up to 4 points
function parseTag(body) {
  const raw = body.trim();
  const m = /^([a-z]+)\s*([\s\S]*)$/i.exec(raw);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();
  if (name === 'point') {
    const nums = rest.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    return { name, x: Number(nums[0]), y: Number(nums[1]) };
  }
  if (name === 'explain') return { name };
  if (name === 'do') {
    const m2 = /^([a-z][a-z0-9-]*)\s*([\s\S]*)$/i.exec(rest);
    return m2 ? { name, skill: m2[1].toLowerCase(), args: m2[2].trim().slice(0, 500) } : null;
  }
  // Read-only project tools (Phase 4): paths are validated by tools.js.
  if ((name === 'read' || name === 'list' || name === 'find') && (rest || name === 'list')) return { name: 'tool', tool: name, arg: (rest || '.').slice(0, 300) };
  if (name === 'delegate') {
    const m3 = /^([\p{L}][\p{L}\p{N}_-]*)\s+([\s\S]+)$/u.exec(rest);
    return m3 ? { name, core: m3[1], task: m3[2].trim().slice(0, 2000) } : null;
  }
  if (name === 'clone' && rest) return { name, task: rest.slice(0, 600) };
  if (name === 'form') {
    const shape = Shapes.resolve(rest);
    return shape ? { name, shape } : null;
  }
  if (name === 'gesture') {
    const n = /\b([1-5])\b/.exec(rest);
    const g = Gestures.resolve(rest.replace(/\b[1-5]\b/, '').trim());
    return g ? { name, gesture: g, ...(n ? { n: Number(n[1]) } : {}) } : null;
  }
  if (name === 'mood') {
    const mood = rest.toLowerCase().split(/\s+/)[0];
    return MOODS.has(mood) ? { name, mood } : null;
  }
  if ((name === 'remember' || name === 'forget') && rest) return { name, text: rest.slice(0, 300) };
  if (name === 'remind') {
    const r = /^((?:\d+\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\s*)+|(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+([\s\S]+)$/i.exec(rest);
    return r ? { name, when: r[1].trim(), text: r[2].trim().slice(0, 200) } : null;
  }
  if (name === 'open') {
    const url = rest.split(/\s+/)[0];
    return /^https?:\/\/[^\s]+$/i.test(url) ? { name, url } : null;
  }
  if (name === 'copy' && rest) return { name, text: rest.slice(0, 2000) };
  if (name === 'board' && rest) {
    const parts = rest.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    const b = Shapes.boardText(parts[0], parts.slice(1));
    return b.title && b.points.length ? { name, ...b } : null;
  }
  if (name === 'act' && rest) return { name, json: rest.slice(0, 2000) }; // desktop agent step (agent.js validates it)
  return null;
}

// COre marks typed messages "[typed]" for the model; models sometimes echo the marker at the start
// of their answer. It is input-only and never shown or spoken.
const ECHO = '[typed]';

class TagStreamParser {
  constructor() {
    this.buf = '';
    this.head = true; // still at the start of the reply (an echoed marker may be arriving)
  }

  // Returns an array of {type:'text', text} | {type:'tag', tag}.
  feed(chunk) {
    this.buf += chunk;
    const out = [];
    if (this.head) {
      const lead = this.buf.trimStart();
      if (lead.length < ECHO.length && ECHO.startsWith(lead.toLowerCase())) return out; // could still be the marker
      if (lead.toLowerCase().startsWith(ECHO)) this.buf = lead.slice(ECHO.length).replace(/^\s+/, '');
      this.head = false;
    }
    for (;;) {
      const open = this.buf.indexOf('[[');
      if (open === -1) {
        // A trailing single '[' may be the start of '[['; hold it back.
        if (this.buf.endsWith('[')) {
          pushText(out, this.buf.slice(0, -1));
          this.buf = '[';
        } else {
          pushText(out, this.buf);
          this.buf = '';
        }
        return out;
      }
      pushText(out, this.buf.slice(0, open));
      this.buf = this.buf.slice(open);
      const close = this.buf.indexOf(']]');
      if (close === -1) {
        if (this.buf.length > MAX_TAG_LEN) {
          // Not a tag after all: release the brackets as text.
          pushText(out, this.buf.slice(0, 2));
          this.buf = this.buf.slice(2);
          continue;
        }
        return out; // wait for more input
      }
      const tag = parseTag(this.buf.slice(2, close));
      if (tag) out.push({ type: 'tag', tag });
      // Unknown tags are dropped silently: they must never be spoken.
      this.buf = this.buf.slice(close + 2);
    }
  }

  // End of stream: whatever is left can only be text.
  flush() {
    const out = [];
    if (this.head && ECHO.startsWith(this.buf.trim().toLowerCase())) this.buf = '';
    this.head = false;
    // An unclosed run is plain text, unless it's clearly a cut-off tag.
    const cutTag = /^\[\[\s*(point|explain|gesture|form|clone|delegate|do|read|list|find|mood|remember|forget|remind|open|copy|board)\b/i.test(this.buf);
    const rest = cutTag ? '' : this.buf;
    pushText(out, rest);
    this.buf = '';
    return out;
  }
}

function pushText(out, text) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

function stripTags(text) {
  return text.replace(/^\s*\[typed\]\s*/i, '').replace(/\[\[[^\]]{0,48}\]\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { TagStreamParser, parseTag, stripTags };
