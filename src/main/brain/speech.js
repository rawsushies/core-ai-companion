'use strict';

const { TagStreamParser } = require('./tags');

// Turns a stream of model text into an ordered queue of things for the orb to
// do: speak a sentence, make a gesture. Sentences are released as soon as they
// are complete so the voice starts before the model has finished writing.

// A terminator only counts once whitespace follows it: a streamed "3." may
// still become "3.5". flush() releases whatever remains at end of stream.
// CJK terminators need no trailing space.
const SENTENCE_END = /[.!?]+["')\]]*\s+|[。！？]+|\n+/;
const MIN_CHUNK = 24;

class SentenceChunker {
  constructor(minChars = MIN_CHUNK) {
    this.minChars = minChars;
    this.buffer = '';
    this.pending = '';
  }

  feed(text) {
    const ready = [];
    this.buffer += text;
    let m;
    while ((m = SENTENCE_END.exec(this.buffer))) {
      const end = m.index + m[0].length;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (!sentence) continue;
      this.pending = this.pending ? `${this.pending} ${sentence}` : sentence;
      if (this.pending.length >= this.minChars) {
        ready.push(this.pending);
        this.pending = '';
      }
    }
    return ready;
  }

  flush() {
    const rest = [this.pending, this.buffer.trim()].filter(Boolean).join(' ');
    this.pending = '';
    this.buffer = '';
    return rest ? [rest] : [];
  }
}

// Strip markdown the model might still emit so the TTS voice doesn't read
// asterisks and hashes aloud.
function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/[*_#>]+/g, ' ')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

class SpeechPlanner {
  constructor(emit) {
    this.emit = emit; // (item) => void
    this.tags = new TagStreamParser();
    this.chunker = new SentenceChunker();
    this.fullText = '';
  }

  feed(delta) {
    for (const seg of this.tags.feed(delta)) this._segment(seg);
  }

  finish() {
    for (const seg of this.tags.flush()) this._segment(seg);
    for (const s of this.chunker.flush()) this._say(s);
    this.emit({ type: 'end' });
    return this.fullText.trim();
  }

  _segment(seg) {
    if (seg.type === 'text') {
      this.fullText += seg.text;
      for (const s of this.chunker.feed(seg.text)) this._say(s);
    } else {
      // Release text written before the tag first, so the gesture lands at
      // the moment in speech where the model placed it.
      for (const s of this.chunker.flush()) this._say(s);
      this.emit({ type: 'gesture', ...seg.tag });
    }
  }

  _say(text) {
    const clean = cleanForSpeech(text);
    if (clean) this.emit({ type: 'say', text: clean });
  }
}

module.exports = { SentenceChunker, SpeechPlanner, cleanForSpeech };
