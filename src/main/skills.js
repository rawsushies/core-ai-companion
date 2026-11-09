'use strict';

// COre's skills: small, safe abilities the brain can use with
// [[do NAME ARGS]]. Safety rules:
//  - Nothing runs a command built from the model's words. Apps come from a
//    fixed list; music keys are fixed codes.
//  - Anything that opens something new (search results, plugin links) is a
//    button the user clicks, like [[open URL]].
//  - Network skills only call free public APIs (Open-Meteo) or the calendar
//    feed URL the user typed into Settings.
//  - User plugins are declarative JSON (a name and an https URL template),
//    never code.
// Skills that look something up return a `result`; main then lets COre speak
// about it in a short follow-up turn.

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ apps

// name -> how to open it, per platform. URIs go through shell.openExternal,
// executables through a fixed spawn with no arguments.
const APPS = {
  notepad: { win: { exe: 'notepad.exe' } },
  calculator: { win: { exe: 'calc.exe' }, mac: { uri: 'file:///System/Applications/Calculator.app' } },
  explorer: { win: { exe: 'explorer.exe' } },
  files: { win: { exe: 'explorer.exe' } },
  settings: { win: { uri: 'ms-settings:' } },
  paint: { win: { exe: 'mspaint.exe' } },
  'task manager': { win: { exe: 'taskmgr.exe' } },
  terminal: { win: { exe: 'wt.exe' } },
  spotify: { all: { uri: 'spotify:' } },
  'vs code': { all: { uri: 'vscode:' } },
  vscode: { all: { uri: 'vscode:' } },
  browser: { all: { uri: 'https://' } },
  mail: { all: { uri: 'mailto:' } },
  discord: { all: { uri: 'discord://' } },
  steam: { all: { uri: 'steam://open/main' } },
  calendar: { win: { uri: 'outlookcal:' } },
  camera: { win: { uri: 'microsoft.windows.camera:' } },
  store: { win: { uri: 'ms-windows-store:' } },
};

function appFor(name, platform) {
  const n = String(name || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const a = APPS[n] || APPS[n.replace(/\s+/g, '')];
  if (!a) return null;
  const key = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  return a[key] || a.all || null;
}

// ------------------------------------------------------------------ music

// Windows virtual-key codes sent through WScript.Shell (fixed strings only).
const MEDIA_WIN = { play: 179, pause: 179, toggle: 179, next: 176, previous: 177, prev: 177, mute: 173, volup: 175, voldown: 174 };
const MEDIA_LINUX = { play: 'play', pause: 'pause', toggle: 'play-pause', next: 'next', previous: 'previous', prev: 'previous' };

function musicCommand(action, platform) {
  const a = String(action || '').toLowerCase().replace(/[^a-z]/g, '');
  const norm = { louder: 'volup', up: 'volup', quieter: 'voldown', down: 'voldown', skip: 'next', back: 'previous', resume: 'play', stop: 'pause' }[a] || a;
  if (platform === 'win32' && MEDIA_WIN[norm]) {
    const n = norm.startsWith('vol') ? 5 : 1; // volume steps
    const presses = Array(n).fill(`$w.SendKeys([char]${MEDIA_WIN[norm]})`).join(';');
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `$w=New-Object -ComObject WScript.Shell;${presses}`] };
  }
  if (platform === 'linux' && MEDIA_LINUX[norm]) return { file: 'playerctl', args: [MEDIA_LINUX[norm]] };
  return null;
}

// ------------------------------------------------------------------ weather

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

// Returns { text, card } (card: a short glance card for the orb), or { text } when
// the place is unknown.
async function weatherReport(city, fetchImpl) {
  const q = encodeURIComponent(String(city).slice(0, 80));
  const g = await (await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=1&format=json`)).json();
  const place = g && g.results && g.results[0];
  if (!place) return { text: `No place called ${city} was found.` };
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
    + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2';
  const w = await (await fetchImpl(url)).json();
  const c = w.current || {};
  const d = w.daily || {};
  const rain = (i) => (d.precipitation_probability_max ? d.precipitation_probability_max[i] : 0);
  const day = (i) => `${WMO[d.weather_code && d.weather_code[i]] || 'mixed'}, ${Math.round(d.temperature_2m_min[i])} to ${Math.round(d.temperature_2m_max[i])} C, ${rain(i)} percent chance of rain`;
  const name = `${place.name}${place.country ? `, ${place.country}` : ''}`;
  const text = `${name}: now ${Math.round(c.temperature_2m)} C (feels ${Math.round(c.apparent_temperature)} C), ${WMO[c.weather_code] || 'mixed'}, wind ${Math.round(c.wind_speed_10m)} km/h. Today: ${day(0)}. Tomorrow: ${day(1)}.`;
  const short = (i) => `${Math.round(d.temperature_2m_min[i])}–${Math.round(d.temperature_2m_max[i])} °C · ${rain(i)}% rain · ${WMO[d.weather_code && d.weather_code[i]] || 'mixed'}`;
  const card = {
    title: `${place.name} · ${Math.round(c.temperature_2m)} °C`,
    lines: [`${WMO[c.weather_code] || 'Mixed'}, feels ${Math.round(c.apparent_temperature)} °C, wind ${Math.round(c.wind_speed_10m)} km/h`, `Today: ${short(0)}`, `Tomorrow: ${short(1)}`],
  };
  return { text, card };
}

async function weather(city, fetchImpl) {
  return (await weatherReport(city, fetchImpl)).text;
}

// ------------------------------------------------------------------ calendar (ICS)

const CAL = require('./calendar');

// ------------------------------------------------------------------ notes

class Notes {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.recovered = null;
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch {}
    if (text !== null) {
      try {
        const v = JSON.parse(text);
        if (!Array.isArray(v)) throw new Error('not a list');
        this.items = v;
      } catch {
        this.recovered = require('./config').quarantine(file); // never overwrite unreadable notes
      }
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`; // atomic: a crash mid-write can't corrupt the notes
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  add(text) {
    const t = String(text || '').trim().slice(0, 500);
    if (!t) return null;
    const n = { id: Date.now().toString(36), text: t, at: Date.now() };
    this.items.push(n);
    if (this.items.length > 500) this.items.shift();
    this._save();
    return n;
  }

  find(query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const list = words.length ? this.items.filter((n) => words.every((w) => n.text.toLowerCase().includes(w))) : this.items;
    return list.slice(-10);
  }
}

// ------------------------------------------------------------------ plugins

// userData/skills/*.json: { "name": "wiki", "description": "...", "url": "https://en.wikipedia.org/wiki/Special:Search?search={q}" }
function loadPlugins(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const list = [].concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      for (const p of list) {
        const name = String(p.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!name || BUILTIN.includes(name)) continue;
        if (!/^https:\/\/[^\s]+\{q\}/.test(String(p.url || ''))) continue;
        out.push({ name, description: String(p.description || '').replace(/["&|<>^%!]/g, '').slice(0, 120), url: String(p.url) });
      }
    } catch {}
  }
  return out.slice(0, 30);
}

const BUILTIN = ['note', 'notes', 'timer', 'weather', 'music', 'open', 'search', 'calendar', 'archicad', 'glance'];

// ------------------------------------------------------------------ run

// ctx: { platform, config (skills section), notes, reminders, fetch, launch(app), runFixed(cmd), plugins }
// Returns { message?, result?, action?: { kind, label, value } } or { error }.
async function runSkill(name, args, ctx) {
  const n = String(name || '').toLowerCase();
  const a = String(args || '').trim();
  const cfg = ctx.config || {};
  const off = (key) => cfg[key] === false;
  switch (n) {
    case 'note': {
      const note = ctx.notes.add(a);
      return note ? { message: `Noted: ${note.text}` } : { error: 'Nothing to note.' };
    }
    case 'notes': {
      const list = ctx.notes.find(a);
      return { result: list.length ? list.map((x) => x.text).join(' | ') : 'No matching notes.' };
    }
    case 'timer': {
      const m = /^(\S+)\s*(.*)$/.exec(a);
      const r = m && ctx.reminders.add(m[1], m[2] || 'Timer');
      return r ? { message: `Timer set: ${r.text}`, glance: { what: 'timer', at: r.at, text: r.text } } : { error: `Could not understand the timer ${a}.` };
    }
    case 'weather': {
      if (off('weather')) return { error: 'The weather skill is turned off in Settings.' };
      const city = a || cfg.city;
      if (!city) return { result: 'No city is known. Ask the user which city they are in (they can also set it in Settings, Skills).' };
      const w = await weatherReport(city, ctx.fetch);
      return w.card ? { result: w.text, glance: { what: 'card', card: w.card } } : { result: w.text };
    }
    case 'music': {
      if (off('music')) return { error: 'The music skill is turned off in Settings.' };
      const cmd = musicCommand(a, ctx.platform);
      if (!cmd) return { error: `Music control ${a} is not available here.` };
      await ctx.runFixed(cmd);
      return { message: `Music: ${a}` };
    }
    case 'open': {
      if (off('apps')) return { error: 'Opening apps is turned off in Settings.' };
      const app = appFor(a, ctx.platform);
      if (!app) return { error: `I can only open apps from my list, and ${a} is not on it.` };
      await ctx.launch(app);
      return { message: `Opening ${a}` };
    }
    case 'search': {
      if (!a) return { error: 'Nothing to search for.' };
      return { action: { kind: 'open', label: `Search: ${a.slice(0, 40)}`, value: `https://duckduckgo.com/?q=${encodeURIComponent(a)}` } };
    }
    case 'calendar': {
      if (off('calendar') || !cfg.calendarUrl) return { result: 'No calendar is connected. The user can paste a calendar feed link (ICS) in Settings, Skills.' };
      const url = String(cfg.calendarUrl).replace(/^webcal:/i, 'https:');
      // The feed link is a password: never let it into chat, the brain or logs.
      let text;
      try {
        const res = await ctx.fetch(url);
        if (!res.ok) return { error: `The calendar feed answered with HTTP ${res.status}. The link may have expired; paste a new one in Settings, Skills.` };
        text = await res.text();
      } catch {
        return { error: 'Could not reach the calendar feed (offline, or the link is wrong).' };
      }
      const range = /tomorrow/i.test(a) ? 'tomorrow' : /week/i.test(a) ? 'week' : 'today';
      const [from, to] = CAL.rangeFor(range, ctx.now ? ctx.now() : new Date());
      const list = CAL.occurrences(CAL.parseIcs(text), from, to);
      const summary = CAL.describe(list, range);
      const title = range === 'week' ? 'This week' : range === 'tomorrow' ? 'Tomorrow' : 'Today';
      const lines = list.length ? summary.split('; ').filter(Boolean).slice(0, 6) : ['Nothing on the calendar.'];
      return { result: summary, glance: { what: 'card', card: { title, lines } } };
    }
    case 'glance': {
      // The card beside the orb: music, lyrics, off, or "Title | line | line".
      if (off('glance')) return { error: 'The glance card is turned off in Settings.' };
      const w = a.toLowerCase();
      if (/^(music|now playing|playing|song)$/.test(w)) return { glance: { what: 'music' } };
      if (/^lyrics?$/.test(w)) return { glance: { what: 'lyrics' } };
      if (/^(off|hide|close)$/.test(w)) return { glance: { what: 'off' } };
      const card = require('./glance').parseCard(a);
      return card ? { glance: { what: 'card', card } } : { error: 'Nothing to show.' };
    }
    case 'archicad': {
      // Read-only BIM proof of concept (local Archicad JSON API). Off by default.
      if (cfg.archicad !== true) return { result: 'Archicad access is off. The user can turn it on in Settings, Skills (read-only).' };
      try {
        return await require('./archicad').archicadSkill(a, ctx.fetch);
      } catch (err) {
        return { error: `Archicad did not answer: ${err.message}` };
      }
    }
    default: {
      const p = (ctx.plugins || []).find((x) => x.name === n);
      if (p) return { action: { kind: 'open', label: `${p.name}: ${a.slice(0, 40)}`, value: p.url.replace('{q}', encodeURIComponent(a)) } };
      return { error: `I do not have a skill called ${n}.` };
    }
  }
}

module.exports = { runSkill, appFor, musicCommand, Notes, loadPlugins, weather, weatherReport, BUILTIN };
