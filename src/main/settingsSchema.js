'use strict';

// Every user-facing setting, described once: the settings window renders from
// this, and the main process validates every change against it.
//   type: 'toggle' | 'select' | 'range' | 'text' | 'hotkey'
//   restart: true when the change only applies after restarting COre

const SECTIONS = [
  {
    id: 'general',
    title: 'General',
    fields: [
      { key: 'app.startWithWindows', label: 'Start COre when I sign in', type: 'toggle' },
      { key: 'personality.greeting', label: 'Greet me on the first launch of the day', type: 'toggle' },
      { key: 'personality.tone', label: 'Personality', type: 'select', options: [['sarcastic', 'Sarcastic'], ['dramatic', 'Dramatic'], ['calm', 'Calm'], ['cheerful', 'Cheerful'], ['professional', 'Professional']] },
      { key: 'presence.chitchat', label: 'Chat with me when things are quiet', type: 'toggle' },
      { key: 'presence.minutes', label: 'Quiet time before COre speaks up', type: 'range', min: 5, max: 120, step: 5, unit: 'min' },
      { key: 'presence.quietFrom', label: 'Quiet hours start', type: 'range', min: 0, max: 23, step: 1, unit: 'h' },
      { key: 'presence.quietTo', label: 'Quiet hours end', type: 'range', min: 0, max: 23, step: 1, unit: 'h' },
      { key: 'presence.reactions', label: 'Talk back when petted, poked or tossed', type: 'toggle' },
      { key: 'hotkeys.listen', label: 'Talk', type: 'hotkey' },
      { key: 'hotkeys.listenWithScreen', label: 'Talk about my screen', type: 'hotkey' },
      { key: 'hotkeys.panel', label: 'Show / hide chat', type: 'hotkey' },
      { key: 'hotkeys.hide', label: 'Hide / show COre', type: 'hotkey' },
    ],
  },
  {
    id: 'look',
    title: 'Look',
    fields: [
      { key: 'orb.style', label: 'Style', type: 'select', options: [['smoke', 'Smoke sphere'], ['liquid', 'Liquid blob']], restart: true },
      { key: 'orb.radius', label: 'Size', type: 'range', min: 36, max: 120, step: 2, unit: 'px' },
      { key: 'orb.particles', label: 'Smoke density', type: 'range', min: 6000, max: 60000, step: 2000, restart: true },
      { key: 'orb.renderScale', label: 'Render quality', type: 'range', min: 0.5, max: 1, step: 0.05, restart: true },
      { key: 'orb.idleFps', label: 'Idle frame rate', type: 'range', min: 15, max: 60, step: 5, unit: 'fps' },
      { key: 'orb.backdrop', label: 'Backdrop', type: 'select', options: [['auto', 'Follow Windows theme'], ['dark', 'Dark wallpaper look'], ['light', 'Light wallpaper look']] },
      { key: 'orb.graphics', label: 'Graphics mode', type: 'select', options: [['auto', 'Automatic'], ['software', 'Safe mode (fixes black boxes)'], ['gpu', 'Force GPU']], restart: true },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    fields: [
      { key: 'voice.tts', label: 'Speak replies', type: 'toggle' },
      { key: 'voice.speakTyped', label: 'Also speak replies to typed messages', type: 'toggle' },
      { key: 'voice.kokoroVoice', label: 'Voice', type: 'select', options: [['am_onyx', 'Onyx (deep)'], ['am_fenrir', 'Fenrir (gravelly)'], ['am_michael', 'Michael (warm)'], ['am_adam', 'Adam'], ['am_eric', 'Eric'], ['bm_george', 'George (British)'], ['bm_lewis', 'Lewis (British, deep)']] },
      { key: 'voice.engine', label: 'Voice engine', type: 'select', options: [['kokoro', 'COre voice (neural, robotic)'], ['system', 'Windows voices']] },
      { key: 'voice.semitones', label: 'Pitch', type: 'range', min: -7, max: 3, step: 0.5, unit: 'st' },
      { key: 'voice.robot', label: 'Robot effect', type: 'range', min: 0, max: 1, step: 0.05, unit: '%' },
      { key: 'voice.speed', label: 'Speaking speed', type: 'range', min: 0.7, max: 1.4, step: 0.05, unit: '×' },
      { key: 'voice.quality', label: 'Voice quality', type: 'select', options: [['fast', 'Fast (recommended)'], ['best', 'Best (slower)']], restart: true },
      { key: 'voice.sttLanguage', label: 'I speak', type: 'select', options: [['', 'Detect automatically'], ['english', 'English'], ['indonesian', 'Indonesian'], ['malay', 'Malay'], ['spanish', 'Spanish'], ['french', 'French'], ['german', 'German'], ['japanese', 'Japanese'], ['chinese', 'Chinese']], restart: true },
    ],
  },
  {
    id: 'brain',
    title: 'Brain',
    fields: [
      { key: 'brain.claude.model', label: 'Claude model', type: 'select', options: [['haiku', 'Haiku (fastest)'], ['sonnet', 'Sonnet (smarter)'], ['opus', 'Opus (smartest, slowest)']] },
      { key: 'brain.provider', label: 'Main brain', type: 'select', options: [['claude-cli', 'Claude (Claude Code login)'], ['gemini', 'Google Gemini'], ['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['ollama', 'Local model (Ollama)']] },
      { key: 'brain.ollama.model', label: 'Local model name', type: 'text', maxLength: 80 },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    fields: [
      { key: 'memory.enabled', label: 'Remember things about me', type: 'toggle' },
      { key: 'screen.autoShareOnDeixis', label: 'Look at my screen when I say "look at this"', type: 'toggle' },
      { key: 'orb.hideFromCaptures', label: 'Hide COre from its own screenshots', type: 'toggle' },
      { key: 'notify.enabled', label: 'Accept notifications from other programs', type: 'toggle', restart: true },
      { key: 'update.enabled', label: 'Update automatically', type: 'toggle', restart: true },
    ],
  },
];

const FIELDS = new Map(SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f])));

const HOTKEY_RE = /^((CommandOrControl|CmdOrCtrl|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta|Command|Cmd)\+)+([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc|Plus|[`\-=[\];',./\\])$/;

// Returns the cleaned value, or undefined when the value isn't allowed.
function validate(key, value) {
  const f = FIELDS.get(key);
  if (!f) return undefined;
  if (f.type === 'toggle') return typeof value === 'boolean' ? value : undefined;
  if (f.type === 'select') return f.options.some(([v]) => v === value) ? value : undefined;
  if (f.type === 'range') {
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    const stepped = Math.round((Math.min(f.max, Math.max(f.min, n)) - f.min) / f.step) * f.step + f.min;
    return Number(stepped.toFixed(4));
  }
  if (f.type === 'text') {
    const t = String(value || '').trim();
    return t.length && t.length <= (f.maxLength || 200) && !/[\u0000-\u001f]/.test(t) ? t : undefined;
  }
  if (f.type === 'hotkey') return HOTKEY_RE.test(String(value)) ? String(value) : undefined;
  return undefined;
}

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!o[p] || typeof o[p] !== 'object') o[p] = {};
    o = o[p];
  }
  o[parts[parts.length - 1]] = value;
}

module.exports = { SECTIONS, FIELDS, validate, getPath, setPath };
