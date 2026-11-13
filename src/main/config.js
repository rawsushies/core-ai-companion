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
    provider: 'claude-cli', // the preferred brain
    // 'auto': COre picks the brain per request (what it needs, which brains are
    // healthy and fast) and skips any that are down or rate limited.
    // 'manual': always the exact order above, skipping only brains cooling down.
    mode: 'auto',
    fallbacks: ['gemini', 'groq', 'openrouter', 'openai-compat', 'ollama'],
    claude: { command: 'claude', model: 'haiku', effort: '', strongModel: 'sonnet' },
    // Smart routing: conversation stays on the fast model; the desktop agent,
    // specialist cores and playbook writing use the strong model ('off' = all fast).
    routing: 'auto',
    // Jev, the fast decision layer (TypeSafe's decision model). It classifies
    // each request, estimates complexity and effort, suggests a specialist and
    // picks among eligible models. Uses your OpenRouter key, or a TypeSafe key
    // (Settings, Brain). Without a key a local classifier does the same job.
    // Advice only: it never approves actions.
    jev: { enabled: true, provider: 'auto', model: '', timeoutMs: 2500, minConfidence: 0.35 },
    jevKey: '', // TypeSafe key for Jev: stored as an encrypted secret instead
    gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', prefer: 'gemini-3-flash|flash-latest|gemini-3.*flash|flash', vision: true, reasoningEffort: true },
    groq: { baseUrl: 'https://api.groq.com/openai/v1', model: '', prefer: 'gpt-oss-120b|versatile|70b|qwen|gpt-oss|llama', vision: false, reasoningEffort: true }, // model picked from the live list (names change)
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: '', prefer: 'nemotron-3-ultra.*:free$|gemma-4-31b.*:free$|gpt-oss-120b.*:free$|deepseek.*:free$|llama.*70b.*:free$|qwen.*:free$|gemma.*:free$|:free$', vision: false }, // strongest free chat models first; tiny ones only as a last resort
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
    suggestions: true, // daily mention of unfinished work; only suggests, never acts
    chitchat: true, // after a quiet while COre starts a short conversation on its own
    minutes: 25, // quiet minutes before it does (doubles each time it's ignored)
    quietFrom: 22, // no chit-chat from this hour...
    quietTo: 8, // ...until this hour
    maxPerDay: 6,
    reactions: true, // say something now and then when petted, poked or tossed
  },
  memory: {
    maintenance: 'off', // 'weekly': prepare a knowledge-maintenance report each week; changes only after you approve (/memory maintain apply)
    // Cortex: your long-term knowledge vault (github.com/rawsushies/cortex-ai-brain),
    // reached through its MCP server. command: 'python' (or 'python3' / Cortex.exe),
    // script: path to Cortex's run.py (empty for Cortex.exe), vault: the vault folder.
    cortex: { enabled: false, command: '', script: '', vault: '', captureConversations: true }, // captureConversations: COre's chat is archived in Cortex (Conversations/COre)
    enabled: true, // COre remembers facts about you across conversations (⚙ → Memory)
    autoCapture: true, // save clear statements like "my name is…" / "I prefer…" from your messages (shown in the chat)
    semantic: true, // semantic search with a small local model (downloads ~23 MB once)
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
    idleFps: 20, // frame rate when nothing is happening (moving/talking runs faster)
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
    playbooks: true, // use saved SKILL.md playbooks (userData/skills) when they fit, and run scheduled ones
    weather: true,
    city: '', // used when you ask for the weather without a place
    music: true,
    apps: true,
    calendar: true,
    calendarUrl: '', // secret-ish ICS link from your calendar's settings
    archicad: false, // read-only access to a running Archicad on this PC (local JSON API)
    glance: true, // the card beside the orb (now playing, lyrics, short lists)
    lyrics: true, // look up lyrics on lrclib.net (sends the song title and artist) when you ask for them
    quick: true, // answer short requests (time, music keys, lyrics) on the spot, without the brain
  },
  cloud: {
    googleClientId: '', // your own OAuth client (Desktop app) from Google Cloud Console; the secret is stored encrypted
    googleClientSecret: '', // stored as an encrypted secret instead
    autoSync: true, // sync memory with your Google Drive's private app folder after changes and hourly
  },
  meiosis: {
    autoReview: true, // Sentinel checks Forge's proposed file changes
  },
  // Proactive automations: permitted event sources start playbooks. Sources are
  // off until the user turns them on. rules: [{ name, source: 'files'|'windows',
  // match: glob, on?: 'created'|'changed', playbook, mode: 'ask'|'auto', cooldownMin }]
  events: { files: false, windows: false, rules: [] },
  agent: {
    enabled: false, // the desktop agent: COre clicks and types to finish a task you start with /do
    approve: 'every', // 'every' = you OK each step that changes something; 'task-auto' = no questions (not recommended)
    maxSteps: 25,
    background: false, // let scheduled desktop playbooks (agent: true) start the agent on their own; approvals still apply
    sandbox: 'auto', // commands in an OS sandbox when available (Linux: bubblewrap; Windows: AppContainer + Job Object); 'required' refuses them otherwise; 'off'
    autoResume: false, // resume an interrupted desktop task by itself after a restart (needs background: true)
    sandboxWindows: 'appcontainer', // 'appcontainer' (no profile files, no network) or 'job' (limits only)
    uia: true, // Windows: read and operate controls by their real properties (UI Automation)
    tools: true, // commands, files and web pages (inside the project folder), on top of mouse and keyboard
    allowCommands: [], // commands that never ask, matched by their start, e.g. "git status", "npm test"
    commandTimeout: 60, // seconds
  },
  phone: {
    enabled: false, // the phone companion: chat with COre from your phone's browser on the same Wi-Fi
    port: 47330,
    host: '', // this PC's address for the QR code; empty = detect (set it if you have several networks or a VPN)
  },
  backup: {
    folder: '', // where backups go (a cloud-synced folder makes them cloud backups)
    auto: '24', // hours between automatic backups ('0' = never); runs only when a folder is set
    keep: 10,
    passphrase: '', // stored as an encrypted secret instead (Settings, Backup)
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
    emergency: 'CommandOrControl+Alt+Shift+X', // stop everything COre is doing (agent, replies, helpers, phone link)
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
