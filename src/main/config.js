'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const DEFAULTS = {
  app: {
    startWithWindows: false, // launch COre when you sign in
  },
  brain: {
    // COre tries the primary first, then each fallback in order. Brains that
    // aren't connected (no key) are skipped.
    //   'claude-cli'    Claude through your Claude Code login (no API key)
    //   'gemini'        Google Gemini, free key from aistudio.google.com/apikey
    //   'groq'          Groq, free key from console.groq.com/keys
    //   'openrouter'    OpenRouter (free ":free" models), key from openrouter.ai/keys
    //   'ollama'        free local model (https://ollama.com)
    //   'openai-compat' any OpenAI-style endpoint (DeepSeek, LM Studio...)
    provider: 'claude-cli',
    fallbacks: ['gemini', 'groq', 'openrouter', 'openai-compat', 'ollama'],
    claude: { command: 'claude', model: 'haiku', effort: '' },
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', prefer: 'flash', vision: true },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', prefer: 'versatile|70b|llama', vision: false },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', prefer: ':free$', vision: false },
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b', visionModel: '' },
    openaiCompat: { baseUrl: '', model: '', apiKey: '', vision: false },
    secrets: {}, // API keys, encrypted with your OS account (set them in the chat's ⚙ → Brain)
  },
  a11y: {
    reduceMotion: 'auto', // 'auto' follows Windows' animation setting; 'on' / 'off'
    largeText: false, // bigger chat text
    captions: true, // show what COre says under the orb
  },
  personality: {
    language: '', // reply language ('' = whatever language you speak)
    tone: 'sarcastic', // 'sarcastic' | 'dramatic' | 'calm' | 'cheerful' | 'professional'
    greeting: true, // a short built-in greeting on the first launch of the day
  },
  presence: {
    chitchat: true, // after a quiet while COre starts a short conversation on its own
    minutes: 25, // quiet minutes before it does (doubles each time it's ignored)
    quietFrom: 22, // no chit-chat from this hour...
    quietTo: 8, // ...until this hour
    maxPerDay: 6,
    reactions: true, // say something now and then when petted, poked or tossed
  },
  memory: {
    enabled: true, // COre remembers facts about you across conversations (⚙ → Memory)
  },
  voice: {
    tts: true, // speak replies
    engine: 'kokoro', // 'kokoro' = local neural voice with robot effects; 'system' = OS voices
    kokoroVoice: 'am_onyx', // deep male; also am_fenrir, am_michael, bm_george, bm_lewis...
    semitones: -3, // voice pitch shift (negative = deeper)
    robot: 0.45, // 0 = clean voice, 1 = full machine
    speed: 1.0,
    quality: 'fast', // 'fast' (4-bit voice model, ~3x quicker) or 'best' (8-bit)
    speakTyped: true, // read the opening of typed-chat replies aloud
    wakeWord: false, // hands-free: say "Hey COre" (detected on this PC; keeps the mic open)
    bargeIn: true, // with hands-free on: talk over COre to interrupt it
    followUp: false, // conversation mode: keep listening briefly after each spoken reply
    talkMode: 'auto', // 'auto' = stop when you pause; 'toggle' = press the hotkey again to send
    voiceName: '', // part of a voice name, e.g. "David" or "Indonesia"; empty = auto by language
    lang: '', // e.g. "en-US", "id-ID"; empty = system default
    rate: 1.05, // system voice only
    pitch: 0.85, // system voice only
    sttModel: 'onnx-community/whisper-base', // local speech recognition, downloaded once
    sttLanguage: '', // '' = auto-detect, or e.g. 'english', 'indonesian'
  },
  orb: {
    style: 'smoke', // 'smoke' (glowing particle sphere) or 'liquid' (black glossy blob)
    theme: 'emerald', // smoke colour: emerald, ice, ember, violet, gold, rose, mono
    profile: 'balanced', // performance: battery, balanced, quality (sets particles / quality / idle fps)
    radius: 60, // px
    particles: 24000, // smoke style: more = denser filaments, heavier on the GPU
    renderScale: 1, // lower (0.6-0.8) on slow GPUs
    idleFps: 30, // frame rate when nothing is happening (moving/talking always runs at full rate)
    graphics: 'auto', // 'auto' | 'software' (safe mode: fixes black boxes on some drivers) | 'gpu'
    backdrop: 'auto', // 'auto' follows your Windows/macOS light or dark theme; or 'light' / 'dark'
    followDisplay: true, // move to the monitor you're using when you summon COre
    hideFromCaptures: true, // hide the orb for a moment while COre takes a screenshot
    home: null, // {x, y} remembered after you drag it
  },
  tools: {
    projectRoot: '', // a folder the user shared with COre's cores, read-only ('' = none)
    enabled: true, // let the cores read it
    allowWrites: false, // let cores PROPOSE file changes; each one is applied only when you click Apply
  },
  skills: {
    weather: true,
    city: '', // used when you ask for the weather without a place
    music: true,
    apps: true,
    calendar: true,
    calendarUrl: '', // secret-ish ICS link from your calendar's settings
    archicad: false, // read-only access to a running Archicad on this PC (local JSON API)
  },
  watch: {
    enabled: true, // notice error pop-ups / frozen apps from window titles and offer help (no screenshots)
    speak: true, // say so out loud (otherwise just the chat and a colour)
  },
  screen: {
    autoShareOnDeixis: true, // phrases like "look at this" / "what's on my screen" attach a screenshot
  },
  hotkeys: {
    listen: 'CommandOrControl+Alt+Space',
    listenWithScreen: 'CommandOrControl+Alt+S',
    panel: 'CommandOrControl+Alt+C',
    hide: 'CommandOrControl+Alt+H',
  },
  update: {
    enabled: true,
    source: 'rawsushies/core-ai-companion', // GitHub "owner/repo" that hosts COre; '' = updates off
    channel: 'release', // 'release' = published releases only (gated); 'main' = latest development code
    branch: 'main',
    checkHours: 6,
  },
  notify: {
    enabled: true,
    port: 47321,
    token: '', // generated on first run
    speak: false, // read notification titles aloud
  },
};

// A JSON file that won't parse is moved aside (never overwritten), so the
// user's settings, keys or memories can be recovered from it. Returns the
// quarantine path, or null.
function quarantine(file) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const to = `${file}.corrupt-${stamp}`;
    fs.renameSync(file, to);
    return to;
  } catch {
    return null;
  }
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.recovered = null; // path of a damaged file that was set aside
    this.data = this._load();
  }
  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[core] could not read ${this.file}: ${err.message}`);
      return deepMerge(this.defaults, {});
    }
    try {
      const parsed = JSON.parse(text);
      if (!isObj(parsed)) throw new Error('not a JSON object');
      return deepMerge(this.defaults, parsed);
    } catch (err) {
      // Damaged (hand edit, disk problem): keep it for recovery, start fresh.
      this.recovered = quarantine(this.file);
      console.error(`[core] ${this.file} is damaged (${err.message}); kept as ${this.recovered}`);
      return deepMerge(this.defaults, {});
    }
  }
  reload() {
    this.data = this._load();
    return this.data;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

function loadConfig(dir) {
  const cfg = new JsonFile(path.join(dir, 'config.json'), DEFAULTS);
  if (!cfg.data.notify.token) {
    cfg.data.notify.token = randomBytes(18).toString('base64url');
  }
  cfg.save(); // writes defaults on first run so the user has a file to edit
  return cfg;
}

function loadState(dir) {
  const st = new JsonFile(path.join(dir, 'state.json'), {});
  let timer = null;
  return {
    recovered: st.recovered,
    get: (k) => st.data[k],
    set: (k, v) => {
      st.data[k] = v;
      clearTimeout(timer);
      timer = setTimeout(() => st.save(), 300);
    },
    flush: () => { clearTimeout(timer); st.save(); },
  };
}

module.exports = { loadConfig, loadState, deepMerge, DEFAULTS, quarantine };
