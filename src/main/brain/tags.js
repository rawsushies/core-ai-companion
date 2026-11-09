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
//   [[form laugh]]           smoke forms a shape: emoji, symbol, or up to 3 letters/digits
//   [[gesture wave]]         body language from the gesture library (count takes a number)
//   [[remember TEXT]]        save a fact about the user
//   [[forget TEXT]]          drop a remembered fact
//   [[remind WHEN TEXT]]     reminder / timer, WHEN = 10m, 90s, 1h30m, 18:30, 7pm
//   [[open URL]]             offer a website (the user confirms with a click)
//   [[copy TEXT]]            offer to copy text to the clipboard (one click)
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
  return null;
}

class TagStreamParser {
  constructor() {
    this.buf = '';
  }

  // Returns an array of {type:'text', text} | {type:'tag', tag}.
  feed(chunk) {
    this.buf += chunk;
    const out = [];
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
    // An unclosed run is plain text, unless it's clearly a cut-off tag.
    const cutTag = /^\[\[\s*(point|explain|gesture|form|mood|remember|forget|remind|open|copy)\b/i.test(this.buf);
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
  return text.replace(/\[\[[^\]]{0,48}\]\]/g, '').replace(/\s{2,}/g, ' ').trim();
}

module.exports = { TagStreamParser, parseTag, stripTags };
