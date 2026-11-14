'use strict';

// Glance: a small card beside the orb for what's playing, synced lyrics, or
// any short list COre wants to show ("show me the lyrics", "what's playing").
// Pure pieces live here so they can be tested; the window glue is in main.js.
//
// Cost rules: the media session is read only while a music or lyrics card is
// open (one long-lived reader, about one update a second), lyrics are fetched
// once per track, and the overlay redraws the card only when the line changes.

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

// ------------------------------------------------------------------ lyrics

// "[01:02.34] text" (several time stamps per line allowed) -> [{ t, text }]
function parseLrc(text) {
  const out = [];
  let offset = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
    if (off) { offset = Number(off[1]) || 0; continue; }
    const stamps = [];
    let rest = raw;
    let m;
    while ((m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest))) {
      const sec = Number(m[2].replace(':', '.'));
      stamps.push(Math.round((Number(m[1]) * 60 + sec) * 1000));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    const line = rest.trim();
    for (const t of stamps) out.push({ t: Math.max(0, t - offset), text: line });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Index of the line being sung at `ms` (-1 before the first line).
function lineIndex(lines, ms) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// "Song (Official Video) [HD] - Remastered 2011" -> "Song"
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[([](official|lyrics?|audio|video|hd|hq|4k|visuali[sz]er|live|explicit|clean|remaster(?:ed)?|\d{4} remaster)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+(\d{4}\s+)?remaster(ed)?(\s+\d{4})?.*$/i, '')
    .replace(/\s*\((feat|ft)\.?[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanArtist(a) {
  return String(a || '').replace(/\s*-\s*topic$/i, '').split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0].trim();
}

const UA = 'COre desktop companion (https://github.com/rawsushies/core-ai-companion)';
const lyricCache = new Map();

// LRCLIB (free, no key). Returns { synced: [{t,text}]|null, plain: string|null, instrumental }.
async function fetchLyrics({ title, artist, album, durMs }, fetchImpl) {
  const t = cleanTitle(title);
  const a = cleanArtist(artist);
  if (!t) return { synced: null, plain: null };
  const key = `${a}\u0000${t}`.toLowerCase();
  if (lyricCache.has(key)) return lyricCache.get(key);
  const pick = (j) => j && {
    synced: j.syncedLyrics ? parseLrc(j.syncedLyrics) : null,
    plain: j.plainLyrics ? String(j.plainLyrics).slice(0, 20000) : null,
    instrumental: !!j.instrumental,
  };
  const get = async (url) => {
    const res = await fetchImpl(url, { headers: { 'user-agent': UA, 'lrclib-client': UA }, signal: AbortSignal.timeout(6000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`lyrics service answered ${res.status}`);
    return res.json();
  };
  let r = null;
  const q = new URLSearchParams({ track_name: t, artist_name: a });
  if (album) q.set('album_name', String(album));
  if (durMs > 0) q.set('duration', String(Math.round(durMs / 1000)));
  try { r = pick(await get(`https://lrclib.net/api/get?${q}`)); } catch (err) { if (!/404/.test(err.message)) throw err; }
  if (!r || (!r.synced && !r.plain && !r.instrumental)) {
    const list = await get(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: t, artist_name: a })}`);
    const best = Array.isArray(list) ? (list.find((x) => x.syncedLyrics) || list[0]) : null;
    r = pick(best) || { synced: null, plain: null };
  }
  lyricCache.set(key, r);
  while (lyricCache.size > 50) lyricCache.delete(lyricCache.keys().next().value);
  return r;
}

// ------------------------------------------------------------------ album art

// A small data: URL for the card from a file:// or https:// art URL (Linux MPRIS).
// Images only, at most 600 KB.
async function artFromUrl(url, fetchImpl, readFile = require('fs').promises.readFile) {
  const u = String(url || '');
  const typeOf = (name, ct) => {
    const m = /^image\/(png|jpeg|webp|gif)/i.exec(ct || '') || /\.(png|jpe?g|webp|gif)$/i.exec(name);
    if (!m) return null;
    return `image/${m[1].toLowerCase().replace('jpg', 'jpeg')}`;
  };
  if (/^file:\/\//i.test(u)) {
    const p = require('url').fileURLToPath(u);
    const type = typeOf(p);
    if (!type) return null;
    const buf = await readFile(p);
    return buf.length && buf.length <= 600000 ? `data:${type};base64,${buf.toString('base64')}` : null;
  }
  if (/^https:\/\//i.test(u) && fetchImpl) {
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const type = typeOf(new URL(u).pathname, res.headers.get('content-type')) || (res.headers.get('content-type') || '').startsWith('image/') && 'image/jpeg';
    if (!type) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= 600000 ? `data:${type};base64,${buf.toString('base64')}` : null;
  }
  return null;
}

// ------------------------------------------------------------------ cards

// [[do glance Title; line; line]] (or | between parts) -> { title, lines } (plain text only).
function parseCard(args) {
  const parts = String(args || '').split(/[|;]/).map((s) => s.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return null;
  return { title: parts[0].slice(0, 60), lines: parts.slice(1, 7).map((l) => l.slice(0, 90)) };
}

// ------------------------------------------------------------------ quick intents

// Short, unambiguous requests COre answers on the spot, without the brain:
// no waiting, no usage. Anything longer or fuzzier still goes to the brain.
const MUSIC = [
  [/^(?:play|resume|unpause)(?: (?:the )?(?:music|song|track))?$/, 'play'],
  [/^pause(?: (?:the )?(?:music|song|track))?$|^stop (?:the )?(?:music|song|track)$/, 'pause'],
  [/^(?:next|skip)(?: (?:the )?(?:song|track|one))?$|^(?:skip|next) (?:this|it)$/, 'next'],
  [/^(?:previous|last|go back)(?: (?:song|track|one))?$/, 'previous'],
  [/^(?:louder|volume up|turn it up)$/, 'louder'],
  [/^(?:quieter|volume down|turn it down)$/, 'quieter'],
  [/^mute(?: (?:the )?(?:music|sound))?$/, 'mute'],
];

// The model has no clock: every turn gets the local date and time, so 'what time is it',
// 'how long until 5' or 'what day is Friday' are answered from the PC, not guessed.
function nowLine(now = new Date()) {
  let zone = '';
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  return `[Now] ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} local time${zone ? ` (${zone})` : ''}. Use this for any question about the time or date; never guess one.`;
}

// "set a timer for 90 seconds called pasta", "timer 5 minutes tea", "start a 25 minute timer for the eggs":
// done on the PC at once, with or without a brain (free tiers run out; a timer must not).
const DUR = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
function timerIntent(t) {
  t = t.replace(/(\d)-(?=[a-z])/g, '$1 '); // "5-minute timer"
  if (t.split(' ').length > 12 || !/\btimer\b/.test(t)) return null;
  const m = /^(?:(?:set|start|make)(?: me)? )?(?:a |an )?(?:timer (?:for )?(.+?)|(.+?) timer)(?: (?:called|named|labell?ed|for(?: the| my)?) (.{1,40}))?$/.exec(t);
  if (!m) return null;
  const spanText = (m[1] || m[2]).trim();
  const parts = [...spanText.matchAll(DUR)];
  // The whole span must be durations (and "and"): "timer for the meeting" is not a timer request.
  if (!parts.length || spanText.replace(DUR, '').replace(/\band\b|-/g, '').trim()) return null;
  const when = parts.map((p) => `${p[1]}${p[2][0] === 'h' ? 'h' : p[2].startsWith('m') ? 'm' : 's'}`).join('');
  return { kind: 'timer', when, label: (m[3] || 'Timer').replace(/^(the|my)\s+/, '').trim() };
}

function quickIntent(text) {
  const t = String(text || '').toLowerCase().replace(/^(?:hey |ok |okay )?core[,\s]+/, '').replace(/\b(?:please|pls|right now|now|for me|currently|at the moment|exactly|here|do you know|can you tell me|could you tell me)\b/g, '')
    .replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  { const tm = timerIntent(t); if (tm) return tm; }
  if (/^(?:how (?:long|much time) (?:is )?left(?: (?:on|for) (?:my |the )?timers?)?|show (?:me )?(?:my |the )?timers?|my timers?|timer status)$/.test(t)) return { kind: 'timers' };
  if (t.split(' ').length > 7) return null;
  // Weather comes from the weather service, never from a model's imagination.
  { const w = /^(?:(?:what(?:'s| is)|how(?:'s| is)) the )?weather(?: like| forecast)?(?: (?:in|at|for) ([a-z][a-z .'-]{1,40}?))?(?: (today|tomorrow))?$/.exec(t);
    if (w) return { kind: 'weather', city: (w[1] || '').trim(), day: w[2] || 'today' }; }
  if (/^(?:what(?:'s| is) the (?:current )?time|what time is it|what time it is|time|tell me the time|current time|the time)$/.test(t)) return { kind: 'time' };
  if (/^(?:what(?:'s| is) the date(?: today)?|what day is it(?: today)?|what(?:'s| is) today(?:'s date)?|date)$/.test(t)) return { kind: 'date' };
  if (/^(?:show|open|display|give me)(?: me)?(?: the)? (?:lyrics|lyric)(?: of this song| for this song)?$|^lyrics$|^sing along$/.test(t)) return { kind: 'glance', what: 'lyrics' };
  if (/^(?:what(?:'s| is) (?:playing|this song)|what song is (?:this|playing)|now playing|show (?:me )?(?:what's playing|now playing|the song|the music))$/.test(t)) return { kind: 'glance', what: 'music' };
  if (/^(?:hide|close|dismiss)(?: (?:the|that|it|this))?(?: (?:lyrics|card|glance|song))?$/.test(t)) return { kind: 'glance', what: 'off' };
  for (const [re, action] of MUSIC) if (re.test(t)) return { kind: 'music', action };

  return null;
}

// ------------------------------------------------------------------ media session

// Windows: one long-lived PowerShell reads the system media session
// (GlobalSystemMediaTransportControls) once a second and prints a JSON line.
// Fixed script, nothing from the model goes into it.
// The script is a plain file shipped with the app (src/main/ps/media-session.ps1), run
// with -File: no encoded commands and no execution-policy bypass, which antivirus
// heuristics rightly treat as suspicious.
const WIN_SCRIPT_FILE = require('path').join(__dirname, 'ps', 'media-session.ps1');
const WIN_SCRIPT = require('fs').readFileSync(WIN_SCRIPT_FILE, 'utf8');

// Normalise one reading into { title, artist, album, posMs, durMs, playing, at } or null.
function normalise(raw, now = Date.now()) {
  if (!raw || raw.none || !raw.title) return null;
  const playing = !!raw.playing;
  let pos = Math.max(0, Number(raw.pos) || 0);
  const upd = Number(raw.upd) || 0;
  // The session reports where playback was at `upd`; move it on to now
  // (some players update rarely). Never past the end.
  if (playing && upd > 0 && now > upd && now - upd < 6 * 3600e3) pos += now - upd;
  const dur = Math.max(0, Number(raw.dur) || 0);
  if (dur) pos = Math.min(pos, dur);
  const out = { title: String(raw.title).slice(0, 200), artist: String(raw.artist || '').slice(0, 200), album: String(raw.album || '').slice(0, 200), posMs: Math.round(pos), durMs: Math.round(dur), playing, at: now };
  if (typeof raw.art === 'string' && raw.art.length < 820000 && /^[A-Za-z0-9+/=]+$/.test(raw.art)) {
    const type = /^image\/(png|jpeg|jpg|webp|gif)$/i.test(raw.artType || '') ? raw.artType.toLowerCase() : 'image/jpeg';
    out.artData = `data:${type};base64,${raw.art}`;
  }
  if (typeof raw.artUrl === 'string' && /^(file|https):\/\//i.test(raw.artUrl) && raw.artUrl.length < 2000) out.artUrl = raw.artUrl;
  return out;
}

class MediaReader extends EventEmitter {
  constructor({ platform = process.platform } = {}) {
    super();
    this.platform = platform;
    this.proc = null;
    this.timer = null;
    this.last = null;
  }

  get supported() { return this.platform === 'win32' || this.platform === 'linux'; }

  start() {
    if (this.proc || this.timer || !this.supported) return;
    if (this.platform === 'win32') {
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', WIN_SCRIPT_FILE], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try { this._emit(normalise(JSON.parse(line))); } catch {}
        }
        if (buf.length > 65536) buf = '';
      });
      this.proc.on('exit', () => { this.proc = null; });
      this.proc.on('error', () => { this.proc = null; this._emit(null); });
    } else {
      // Linux: playerctl (MPRIS), polled while a card is open.
      const poll = () => execFile('playerctl', ['metadata', '--format', '{{status}}\t{{position}}\t{{mpris:length}}\t{{mpris:artUrl}}\t{{artist}}\t{{album}}\t{{title}}'], { timeout: 1500 }, (err, out) => {
        if (err) return this._emit(null);
        const [status, pos, len, artUrl, artist, album, ...title] = String(out).replace(/\r?\n$/, '').split('\t');
        this._emit(normalise({ title: title.join('\t'), artist, album, artUrl, pos: Number(pos) / 1000, dur: Number(len) / 1000, playing: status === 'Playing' }));
      });
      poll();
      this.timer = setInterval(poll, 1500);
    }
  }

  _emit(v) {
    this.last = v;
    this.emit('update', v);
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

module.exports = { nowLine, artFromUrl, parseLrc, lineIndex, cleanTitle, cleanArtist, fetchLyrics, parseCard, quickIntent, normalise, MediaReader, WIN_SCRIPT };
