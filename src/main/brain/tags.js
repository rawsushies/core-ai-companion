'use strict';

// Streaming parser for COre's silent gesture tags.
//
// The model writes plain spoken text with optional tags such as
//   "[[point 812,440]] That button saves your file. [[explain]] Here is why..."
// Tokens arrive in arbitrary fragments ("[[po", "int 81", "2,440]]"), so the
// parser holds back anything that could still turn into a tag and only
// releases it once it is clearly a tag or clearly plain text.

const MAX_TAG_LEN = 48;

function parseTag(body) {
  const raw = body.trim();
  const m = /^([a-z]+)\s*(.*)$/i.exec(raw);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();
  if (name === 'point') {
    const nums = rest.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    return { name, x: Number(nums[0]), y: Number(nums[1]) };
  }
  if (name === 'explain') return { name };
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
    const rest = this.buf.startsWith('[[') ? '' : this.buf;
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
