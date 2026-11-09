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

function quickIntent(text) {
  const t = String(text || '').toLowerCase().replace(/^(?:hey |ok |okay )?core[,\s]+/, '').replace(/\b(?:please|pls|now|for me)\b/g, '')
    .replace(/[?!.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 7) return null;
  if (/^(?:what(?:'s| is) the time|what time is it|time|tell me the time)$/.test(t)) return { kind: 'time' };
  if (/^(?:what(?:'s| is) the date(?: today)?|what day is it(?: today)?|what(?:'s| is) today(?:'s date)?|date)$/.test(t)) return { kind: 'date' };
  if (/^(?:show|open|display|give me)(?: me)?(?: the)? (?:lyrics|lyric)(?: of this song| for this song)?$|^lyrics$|^sing along$/.test(t)) return { kind: 'glance', what: 'lyrics' };
  if (/^(?:what(?:'s| is) (?:playing|this song)|what song is (?:this|playing)|now playing|show (?:me )?(?:what's playing|now playing|the song|the music))$/.test(t)) return { kind: 'glance', what: 'music' };
  if (/^(?:hide|close|dismiss)(?: (?:the|that|it|this))?(?: (?:lyrics|card|glance|song))?$/.test(t)) return { kind: 'glance', what: 'off' };
  if (/^(?:how (?:long|much time) (?:is )?left|show (?:me )?(?:my |the )?timers?|my timers?|timer status)$/.test(t)) return { kind: 'timers' };
  for (const [re, action] of MUSIC) if (re.test(t)) return { kind: 'music', action };
  return null;
}

// ------------------------------------------------------------------ media session

// Windows: one long-lived PowerShell reads the system media session
// (GlobalSystemMediaTransportControls) once a second and prints a JSON line.
// Fixed script, nothing from the model goes into it.
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(5000); $t.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
while ($true) {
  $o = @{ none = $true }
  $s = $null; if ($mgr) { $s = $mgr.GetCurrentSession() }
  if ($s) {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $tl = $s.GetTimelineProperties(); $pi = $s.GetPlaybackInfo()
    $o = @{ title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; pos = [int64]$tl.Position.TotalMilliseconds; dur = [int64]$tl.EndTime.TotalMilliseconds; upd = $tl.LastUpdatedTime.ToUnixTimeMilliseconds(); playing = ([int]$pi.PlaybackStatus -eq 4); app = $s.SourceAppUserModelId }
  }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;

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
  return { title: String(raw.title).slice(0, 200), artist: String(raw.artist || '').slice(0, 200), album: String(raw.album || '').slice(0, 200), posMs: Math.round(pos), durMs: Math.round(dur), playing, at: now };
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
      const enc = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
      const poll = () => execFile('playerctl', ['metadata', '--format', '{{status}}\t{{position}}\t{{mpris:length}}\t{{artist}}\t{{album}}\t{{title}}'], { timeout: 1500 }, (err, out) => {
        if (err) return this._emit(null);
        const [status, pos, len, artist, album, ...title] = String(out).trim().split('\t');
        this._emit(normalise({ title: title.join('\t'), artist, album, pos: Number(pos) / 1000, dur: Number(len) / 1000, playing: status === 'Playing' }));
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

module.exports = { parseLrc, lineIndex, cleanTitle, cleanArtist, fetchLyrics, parseCard, quickIntent, normalise, MediaReader, WIN_SCRIPT };
