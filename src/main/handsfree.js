'use strict';

// Hands-free helpers: recognising the wake phrase in a short transcript.
// Whisper hears "Hey COre" in many ways ("Hey Core.", "Hey, Kor", "Okay Cora",
// "Hey Corey"), so the match is deliberately forgiving about the name and
// strict about it being at the start of what was said.

const NAME = '(?:core|kor|korr|kore|cor|corr|cora|corey|cori|coré|coar|caw|khor|qor)';
const CALL = '(?:hey|hi|hay|hei|ok|okay|o\\.k\\.|yo|ey)';
const WAKE_RE = new RegExp(`^\\s*(?:${CALL}[\\s,.!-]*)?${NAME}\\b[\\s,.!?-]*`, 'i');
const STRICT_RE = new RegExp(`^\\s*${CALL}[\\s,.!-]*${NAME}\\b[\\s,.!?-]*`, 'i');

// Returns null when the transcript doesn't start with the wake phrase, or
// { rest } with whatever was said after it ("Hey COre, what time is it?" ->
// rest "what time is it?"). A bare name only counts when nothing else was
// said, so ordinary sentences that start with "core" don't wake it.
function matchWake(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const strict = STRICT_RE.exec(t);
  if (strict) return { rest: t.slice(strict[0].length).trim() };
  const loose = WAKE_RE.exec(t);
  if (loose && !t.slice(loose[0].length).trim()) return { rest: '' };
  return null;
}

module.exports = { matchWake };
