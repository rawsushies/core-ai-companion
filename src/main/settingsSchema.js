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
      { key: 'personality.language', label: 'Reply language', type: 'select', options: [['', 'Same as I speak'], ['English', 'English'], ['Bahasa Indonesia', 'Bahasa Indonesia'], ['Malay', 'Malay'], ['Spanish', 'Spanish'], ['French', 'French'], ['German', 'German'], ['Japanese', 'Japanese'], ['Chinese', 'Chinese'], ['Portuguese', 'Portuguese'], ['Arabic', 'Arabic']] },
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
      { key: 'hotkeys.emergency', label: 'Emergency stop (stops everything at once)', type: 'hotkey' },
    ],
  },
  {
    id: 'look',
    title: 'Look',
    fields: [
      { key: 'orb.style', label: 'Style', type: 'select', options: [['smoke', 'Smoke sphere'], ['liquid', 'Liquid blob']], restart: true },
      { key: 'orb.theme', label: 'Colour', type: 'select', options: [['emerald', 'Emerald (classic)'], ['ice', 'Ice'], ['ember', 'Ember'], ['violet', 'Violet'], ['gold', 'Gold'], ['rose', 'Rose'], ['mono', 'Moonlight']] },
      { key: 'orb.profile', label: 'Performance', type: 'select', options: [['battery', 'Battery saver (lightest)'], ['balanced', 'Balanced'], ['quality', 'Best quality']], restart: true },
      { key: 'orb.radius', label: 'Size', type: 'range', min: 36, max: 120, step: 2, unit: 'px' },
      { key: 'orb.particles', label: 'Smoke density', type: 'range', min: 6000, max: 60000, step: 2000, restart: true },
      { key: 'orb.renderScale', label: 'Render quality', type: 'range', min: 0.5, max: 1, step: 0.05, restart: true },
      { key: 'orb.idleFps', label: 'Idle frame rate', type: 'range', min: 15, max: 60, step: 5, unit: 'fps' },
      { key: 'orb.backdrop', label: 'Backdrop', type: 'select', options: [['auto', 'Follow Windows theme'], ['dark', 'Dark wallpaper look'], ['light', 'Light wallpaper look']] },
      { key: 'orb.followDisplay', label: 'Move to the screen I\'m using when I call COre', type: 'toggle' },
      { key: 'orb.graphics', label: 'Graphics mode', type: 'select', options: [['auto', 'Automatic'], ['software', 'Safe mode (fixes black boxes)'], ['gpu', 'Force GPU']], restart: true },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    fields: [
      { key: 'voice.tts', label: 'Speak replies', type: 'toggle' },
      { key: 'voice.wakeWord', label: 'Hands-free: wake me with "Hey COre" (on this PC, mic stays open)', type: 'toggle' },
      { key: 'voice.bargeIn', label: 'Hands-free: talk over COre to interrupt', type: 'toggle' },
      { key: 'voice.followUp', label: 'Conversation mode: listen again after each spoken reply', type: 'toggle' },
      { key: 'voice.talkMode', label: 'Talk hotkey', type: 'select', options: [['auto', 'Stops when I pause'], ['toggle', 'Press again to send']] },
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
      { key: 'brain.mode', label: 'Choosing a brain', type: 'select', options: [['auto', 'Automatic: the best healthy brain for each request (recommended)'], ['manual', 'Manual: always try them in my order']] },
      { key: 'brain.jev.enabled', label: 'Jev decision layer: classify each request and pick the model in milliseconds (uses an OpenRouter or TypeSafe key; a local classifier works without one)', type: 'toggle' },
      { key: 'brain.jevKey', label: 'TypeSafe key for Jev (optional; your OpenRouter key also works)', type: 'text', maxLength: 300, optional: true, secret: 'jev' },
      { key: 'brain.routing', label: 'Smart routing', type: 'select', options: [['auto', 'Chat on the model above; agent and specialists on the stronger one'], ['off', 'Use the model above for everything']] },
      { key: 'brain.claude.strongModel', label: 'Stronger Claude model (for routing)', type: 'select', options: [['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku (same as fast)']] },
      { key: 'brain.provider', label: 'Preferred brain', type: 'select', options: [['claude-cli', 'Claude (Claude Code login)'], ['gemini', 'Google Gemini'], ['groq', 'Groq'], ['openrouter', 'OpenRouter'], ['ollama', 'Local model (Ollama)']] },
      { key: 'brain.ollama.model', label: 'Local model name', type: 'text', maxLength: 80 },
    ],
  },
  {
    id: 'access',
    title: 'Accessibility',
    fields: [
      { key: 'a11y.reduceMotion', label: 'Reduce motion', type: 'select', options: [['auto', 'Follow Windows'], ['on', 'On (calmer, no fidgets)'], ['off', 'Off']] },
      { key: 'a11y.largeText', label: 'Larger chat text', type: 'toggle' },
      { key: 'a11y.captions', label: 'Show captions under COre', type: 'toggle' },
    ],
  },
  {
    id: 'projects',
    title: 'Projects',
    fields: [
      { key: 'tools.projectRoot', label: 'Project folder COre may read (never change)', type: 'folder', optional: true },
      { key: 'tools.enabled', label: 'Let COre and its cores read it', type: 'toggle' },
      { key: 'tools.allowWrites', label: 'Let cores propose changes (you review a diff and approve each one)', type: 'toggle' },
      { key: 'meiosis.autoReview', label: 'Sentinel reviews every change Forge proposes before you apply it', type: 'toggle' },
    ],
  },
  {
    id: 'skills',
    title: 'Skills',
    fields: [
      { key: 'skills.playbooks', label: 'Playbooks: use my saved SKILL.md how-tos when they fit, and run scheduled ones (/skills lists them)', type: 'toggle' },
      { key: 'skills.weather', label: 'Weather (free Open-Meteo service)', type: 'toggle' },
      { key: 'skills.city', label: 'My city (for weather)', type: 'text', maxLength: 80, optional: true },
      { key: 'skills.music', label: 'Control music (play, pause, next, volume)', type: 'toggle' },
      { key: 'skills.apps', label: 'Open apps from a safe list', type: 'toggle' },
      { key: 'skills.calendar', label: 'Read my calendar', type: 'toggle' },
      { key: 'skills.archicad', label: 'Read my open Archicad project (count elements; never changes it)', type: 'toggle' },
      { key: 'skills.glance', label: 'Show cards beside COre (now playing, lyrics, short lists)', type: 'toggle' },
      { key: 'skills.lyrics', label: 'Look up lyrics on lrclib.net when I ask (sends the song title and artist)', type: 'toggle' },
      { key: 'skills.quick', label: 'Answer short requests instantly, without the brain (time, music keys)', type: 'toggle' },
      // secret: stored encrypted (like API keys), never shown back or logged.
      { key: 'skills.calendarUrl', label: 'Private calendar feed link (ICS, from Google / Outlook calendar settings)', type: 'text', maxLength: 500, optional: true, pattern: '^(https|webcal)://\\S+$', secret: 'calendar' },
    ],
  },
  {
    id: 'cloud',
    title: 'Cloud',
    fields: [
      { key: 'cloud.googleClientId', label: 'Google OAuth client ID (Desktop app, from your Google Cloud Console)', type: 'text', maxLength: 200, optional: true, pattern: '^[\\w.-]+\\.apps\\.googleusercontent\\.com$' },
      { key: 'cloud.googleClientSecret', label: 'Client secret', type: 'text', maxLength: 200, optional: true, secret: 'googleClientSecret' },
      { key: 'cloud.actions', label: "COre's memory in your Google Drive's private app folder (COre can't see anything else)", type: 'actions', items: [['connectGoogle', 'Connect Google'], ['syncGoogle', 'Sync now'], ['disconnectGoogle', 'Disconnect']] },
      { key: 'cloud.autoSync', label: 'Sync memory automatically', type: 'toggle' },
    ],
  },
  {
    id: 'agent',
    title: 'Agent',
    fields: [
      { key: 'agent.enabled', label: 'Let COre operate this PC for tasks I start with /do (it clicks and types; Esc stops it)', type: 'toggle' },
      { key: 'agent.approve', label: 'Approval', type: 'select', options: [['every', 'Ask me before every click, key or typing (recommended)'], ['plan', 'Show me the plan once; if I approve, carry it out (commands still ask)'], ['task-auto', 'Never ask (only for tasks you watch)']] },
      { key: 'agent.maxSteps', label: 'Most steps per task', type: 'range', min: 5, max: 50, step: 5 },
      { key: 'agent.background', label: 'Let scheduled desktop playbooks start the agent on their own (approvals still apply)', type: 'toggle' },
      { key: 'agent.autoResume', label: 'Resume an interrupted desktop task by itself after a restart (needs the option above)', type: 'toggle' },
      { key: 'events.files', label: 'Automations may watch my shared folders for new or changed files (rules: /automations)', type: 'toggle' },
      { key: 'events.windows', label: 'Automations may watch for new window titles (titles only, no screenshots)', type: 'toggle' },
      { key: 'agent.tools', label: 'Also let it run commands, edit files in the project folder and read web pages (commands always ask; file changes can be undone with /do undo)', type: 'toggle' },
    ],
  },
  {
    id: 'phone',
    title: 'Phone',
    fields: [
      { key: 'phone.enabled', label: 'Let paired phones talk to COre over this Wi-Fi (end-to-end encrypted, never through the internet)', type: 'toggle' },
      { key: 'phone.actions', label: 'Scan a QR code with your phone camera. Both screens show a code to compare.', type: 'actions', items: [['pairPhone', 'Pair a phone'], ['revokeAllPhones', 'Remove all phones']] },
      { key: 'phone.devices', label: 'Paired phones', type: 'devices' },
    ],
  },
  {
    id: 'backup',
    title: 'Backup',
    fields: [
      { key: 'backup.folder', label: 'Backup folder (pick one OneDrive, Google Drive or Dropbox syncs for cloud backups)', type: 'folder', optional: true, action: 'pickBackupFolder' },
      { key: 'backup.actions', label: 'Settings, memories, notes, reminders and plugins. Never API keys.', type: 'actions', items: [['useCloudFolder', 'Use my cloud folder'], ['backupNow', 'Back up now'], ['restoreBackup', 'Restore…']] },
      { key: 'backup.auto', label: 'Back up automatically', type: 'select', options: [['0', 'Never'], ['24', 'Every day'], ['168', 'Every week']] },
      { key: 'backup.keep', label: 'Backups to keep', type: 'range', min: 3, max: 30, step: 1 },
      // secret: stored encrypted with this PC's account, never written into a backup.
      { key: 'backup.passphrase', label: 'Passphrase to encrypt backups (recommended for cloud folders; you need it to restore them)', type: 'text', maxLength: 200, optional: true, secret: 'backup' },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy',
    fields: [
      { key: 'memory.enabled', label: 'Remember things about me', type: 'toggle' },
      { key: 'memory.cortex.enabled', label: 'Connect my Cortex knowledge vault (long-term notes, project decisions, lessons) through its MCP server', type: 'toggle' },
      { key: 'memory.cortex.command', label: 'Cortex program (python, python3, or the path to Cortex.exe)', type: 'text', maxLength: 300, optional: true },
      { key: 'memory.cortex.script', label: "Cortex run.py path (leave empty for Cortex.exe)", type: 'text', maxLength: 400, optional: true },
      { key: 'memory.cortex.vault', label: 'Cortex vault folder', type: 'text', maxLength: 400, optional: true },
      { key: 'memory.autoCapture', label: 'Pick up facts I mention ("my name is…", "I prefer…"), shown in the chat', type: 'toggle' },
      { key: 'memory.semantic', label: 'Smarter memory search with a small local model (downloads about 23 MB once)', type: 'toggle', restart: true },
      { key: 'watch.enabled', label: 'Notice error pop-ups and offer help (reads window titles only)', type: 'toggle' },
      { key: 'watch.speak', label: 'Say it out loud when something pops up', type: 'toggle' },
      { key: 'screen.autoShareOnDeixis', label: 'Look at my screen when I say "look at this"', type: 'toggle' },
      { key: 'orb.hideFromCaptures', label: 'Hide COre from its own screenshots', type: 'toggle' },
      { key: 'notify.enabled', label: 'Accept notifications from other programs', type: 'toggle', restart: true },
      { key: 'update.enabled', label: 'Update automatically', type: 'toggle', restart: true },
      { key: 'update.channel', label: 'Update from', type: 'select', options: [['release', 'Published releases (recommended)'], ['main', 'Latest development code (may be unstable)']] },
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
    const t = String(value == null ? '' : value).trim();
    if (!t) return f.optional ? '' : undefined;
    if (f.pattern && !new RegExp(f.pattern, 'i').test(t)) return undefined;
    return t.length <= (f.maxLength || 200) && !/[\u0000-\u001f]/.test(t) ? t : undefined;
  }
  if (f.type === 'folder') {
    const t = String(value == null ? '' : value).trim();
    if (!t) return f.optional ? '' : undefined;
    try { return require('fs').statSync(t).isDirectory() && require('path').isAbsolute(t) ? t : undefined; } catch { return undefined; }
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
