'use strict';

// Screen partner "watch mode": notices error dialogs, crash reports and
// frozen apps from window TITLES only (cheap, and no screenshot is taken or
// sent). COre then offers to take a look; the screenshot happens only if you
// click "Take a look".

const PROBLEM_RE = /\b(error|errors|exception|failed|failure|fatal|crash(ed|es)?|not responding|unhandled|traceback|problem|access denied|permission denied|cannot|can't|couldn't|unable to|stopped working|blue ?screen|bsod|segmentation fault|panic)\b/i;
// Titles that mention errors without being one (search results, articles, chats).
const IGNORE_RE = /(google search|bing|duckduckgo|stack ?overflow|youtube|reddit|wikipedia|github|chatgpt|claude|- mail|inbox|COre)/i;

function isProblemTitle(title) {
  const t = String(title || '').trim();
  return t.length > 2 && t.length <= 90 && PROBLEM_RE.test(t) && !IGNORE_RE.test(t);
}

class ScreenWatch {
  // listTitles() -> Promise<string[]>; onProblem(title) offers help;
  // getConfig() -> { enabled }; isQuiet() -> true when COre may interrupt.
  constructor({ listTitles, onProblem, getConfig, isQuiet, now = () => Date.now() }) {
    this.listTitles = listTitles;
    this.onProblem = onProblem;
    this.getConfig = getConfig;
    this.isQuiet = isQuiet;
    this.now = now;
    this.seen = null; // titles from the previous scan
    this.offered = new Map(); // title -> when we last offered
    this.lastOffer = -Infinity;
    this.timer = null;
  }

  async scan() {
    const c = this.getConfig() || {};
    if (c.enabled === false) { this.seen = null; return null; }
    let titles;
    try { titles = await this.listTitles(); } catch { return null; }
    const now = this.now();
    const prev = this.seen;
    this.seen = new Set(titles);
    if (!prev) return null; // first scan: learn what was already open
    for (const t of titles) {
      if (prev.has(t) || !isProblemTitle(t)) continue;
      if (this.offered.has(t) && now - this.offered.get(t) < 10 * 60_000) continue; // same thing: once per 10 min
      if (now - this.lastOffer < 60_000 || !this.isQuiet()) continue; // at most one offer a minute
      this.offered.set(t, now);
      if (this.offered.size > 200) this.offered.delete(this.offered.keys().next().value); // runs for weeks
      this.lastOffer = now;
      this.onProblem(t);
      return t;
    }
    return null;
  }

  start(everyMs = 8000) {
    this.stop();
    this.timer = setInterval(() => { this.scan(); }, everyMs);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

module.exports = { ScreenWatch, isProblemTitle };
