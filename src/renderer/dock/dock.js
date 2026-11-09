(function () {
  'use strict';

  const api = window.dock;
  const shell = document.getElementById('shell');
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const settings = document.getElementById('settings');
  const send = document.getElementById('send');
  const MAX_MESSAGES = 30;
  let streaming = null; // { el, text }
  let busy = false;

  function trim() {
    while (log.children.length > MAX_MESSAGES) log.removeChild(log.firstChild);
  }

  function stickToBottom(fn) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    fn();
    if (near) log.scrollTop = log.scrollHeight;
  }

  function add(role, text, extra) {
    stickToBottom(() => {
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      if (role === 'core') el.appendChild(window.renderMarkdown(text));
      else el.textContent = text;
      if (extra && extra.label) {
        el.className = 'msg core helper';
        el.textContent = '';
        const head = document.createElement('div');
        head.className = 'helper-head';
        head.textContent = extra.label;
        if (extra.color) el.style.setProperty('--helper', extra.color);
        el.append(head, window.renderMarkdown(text));
      }
      log.appendChild(el);
      trim();
    });
    reportSize();
  }

  function startStream() {
    const el = document.createElement('div');
    el.className = 'msg core streaming';
    log.appendChild(el);
    streaming = { el, text: '' };
    trim();
  }

  function renderStream() {
    if (!streaming) return;
    stickToBottom(() => {
      streaming.el.textContent = '';
      streaming.el.appendChild(window.renderMarkdown(streaming.text));
    });
    reportSize();
  }

  let sizeRaf = 0;
  function reportSize() {
    cancelAnimationFrame(sizeRaf);
    sizeRaf = requestAnimationFrame(() => api.resize(Math.ceil(shell.getBoundingClientRect().height) + 2));
  }
  new ResizeObserver(reportSize).observe(shell);

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(110, input.scrollHeight)}px`;
    input.classList.toggle('scroll', input.scrollHeight > 110);
  }

  function setBusy(b) {
    busy = b;
    send.classList.toggle('busy', b);
    send.title = b ? 'Stop' : 'Send';
    send.setAttribute('aria-label', send.title);
  }

  document.getElementById('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy && !input.value.trim()) { api.stop(); return; }
    const text = input.value.trim();
    if (!text) return;
    api.ask(text);
    input.value = '';
    autosize();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('composer').requestSubmit(); }
    if (e.key === 'Escape') { if (busy) api.stop(); else api.hide(); }
  });
  input.addEventListener('input', autosize);
  document.getElementById('mic').addEventListener('click', () => api.listen());
  document.getElementById('hide').addEventListener('click', () => api.hide());
  function setSettingsOpen(open) {
    settings.hidden = !open;
    shell.classList.toggle('settings-open', open);
    if (open) {
      api.brainStatus().then(renderBrain);
      api.memory().then(renderMemory);
      api.reminders().then(renderReminders);
    }
    else input.focus();
    reportSize();
  }
  document.getElementById('gear').addEventListener('click', () => setSettingsOpen(settings.hidden));
  document.getElementById('settings-back').addEventListener('click', () => setSettingsOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settings.hidden) { e.stopPropagation(); setSettingsOpen(false); }
  }, true);
  document.getElementById('open-panel').addEventListener('click', () => api.openPanel());
  document.getElementById('updates').addEventListener('click', () => api.checkUpdates());
  document.getElementById('all-settings').addEventListener('click', () => api.openSettings());
  document.getElementById('new-chat').addEventListener('click', () => api.newChat());
  const graphics = document.getElementById('graphics');
  api.graphicsMode().then((g) => { if (g) graphics.value = g.mode; });
  graphics.addEventListener('change', () => api.setGraphics(graphics.value)); // restarts COre
  document.getElementById('diag').addEventListener('click', () => api.diagnostics());

  // Settings controls write straight to config.
  const tone = document.getElementById('tone');
  const kvoice = document.getElementById('kvoice');
  const pitch = document.getElementById('pitch');
  const robot = document.getElementById('robot');
  const speakTyped = document.getElementById('speak-typed');
  const pitchV = document.getElementById('pitch-v');
  const robotV = document.getElementById('robot-v');
  const showVals = () => {
    pitchV.textContent = `${Number(pitch.value) > 0 ? '+' : ''}${pitch.value} st`;
    robotV.textContent = `${Math.round(Number(robot.value) * 100)}%`;
  };
  tone.addEventListener('change', () => api.setSetting('personality.tone', tone.value));
  kvoice.addEventListener('change', () => api.setSetting('voice.kokoroVoice', kvoice.value));
  pitch.addEventListener('input', showVals);
  pitch.addEventListener('change', () => api.setSetting('voice.semitones', Number(pitch.value)));
  robot.addEventListener('input', showVals);
  robot.addEventListener('change', () => api.setSetting('voice.robot', Number(robot.value)));
  speakTyped.addEventListener('change', () => api.setSetting('voice.speakTyped', speakTyped.checked));

  function applySettings(s) {
    if (!s) return;
    tone.value = s.tone;
    kvoice.value = s.engine === 'system' ? 'system' : s.kokoroVoice;
    pitch.value = s.semitones;
    robot.value = s.robot;
    speakTyped.checked = s.speakTyped;
    document.body.classList.toggle('large-text', !!s.largeText);
    showVals();
  }

  // ---------------------------------------------------------- brain
  const brainList = document.getElementById('brain-list');
  const banner = document.getElementById('brain-banner');
  const STATE_TEXT = {
    connected: 'connected', login: 'needs login', missing: 'not installed', checking: 'checking…',
    'no-key': 'add a free key', 'no-model': 'model not downloaded', 'not-installed': 'Ollama not installed',
  };
  const KEY_HELP = { gemini: 'Get a free key', groq: 'Get a free key', openrouter: 'Get a key' };

  function button(label, cls, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function renderBrain(list) {
    if (!Array.isArray(list)) return;
    brainList.textContent = '';
    for (const p of list) {
      const row = document.createElement('div');
      row.className = 'brain-row';
      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = p.model && p.state === 'connected' ? `${p.name} · ${p.model}` : p.name;
      const st = document.createElement('div');
      st.className = `st ${p.state}`;
      st.textContent = STATE_TEXT[p.state] || p.state;
      row.append(nm, st);
      if (p.id === 'claude-cli' && p.state !== 'connected') {
        const r = document.createElement('div');
        r.className = 'keyrow';
        r.append(button('Log in to Claude', 'primary-sm', () => api.loginClaude()));
        row.append(r);
      } else if (p.id === 'ollama' && p.state !== 'connected') {
        const r = document.createElement('div');
        r.className = 'keyrow';
        r.append(button(p.state === 'not-installed' ? 'Install Ollama' : 'Download model', 'ghost', () => api.setupLocal()));
        row.append(r);
      } else if (p.keyable) {
        const r = document.createElement('div');
        r.className = 'keyrow';
        const inp = document.createElement('input');
        inp.type = 'password';
        inp.placeholder = p.state === 'connected' ? 'key saved — paste to replace' : 'paste API key';
        inp.setAttribute('aria-label', `${p.name} API key`);
        inp.autocomplete = 'off';
        r.append(inp, button('Save', 'ghost', () => { api.setKey(p.id, inp.value); inp.value = ''; }));
        if (p.state === 'connected') r.append(button('Remove', 'ghost', () => api.setKey(p.id, '')));
        else r.append(button(KEY_HELP[p.id] || 'Get key', 'linkbtn', () => api.openLink(p.id)));
        row.append(r);
      }
      brainList.append(row);
    }
    const anyConnected = list.some((p) => p.state === 'connected');
    banner.hidden = anyConnected;
    reportSize();
  }
  document.getElementById('banner-login').addEventListener('click', () => api.loginClaude());
  document.getElementById('banner-more').addEventListener('click', () => setSettingsOpen(true));
  api.onBrain(renderBrain);

  // ---------------------------------------------------------- reminders & memory
  const reminderList = document.getElementById('reminder-list');
  const memoryList = document.getElementById('memory-list');
  const memoryCount = document.getElementById('memory-count');

  function itemRow(text, when, onRemove, label) {
    const row = document.createElement('div');
    row.className = 'item';
    if (when) { const w = document.createElement('span'); w.className = 'when'; w.textContent = when; row.append(w); }
    const t = document.createElement('span');
    t.textContent = text;
    const x = button('✕', 'x', onRemove);
    x.title = label;
    x.setAttribute('aria-label', `${label}: ${text}`);
    row.append(t, x);
    return row;
  }

  function empty(msg) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = msg;
    return e;
  }

  function fmtWhen(ts) {
    const d = new Date(ts);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
  }

  function renderReminders(list) {
    reminderList.textContent = '';
    if (!list || !list.length) { reminderList.append(empty('None. Ask me: "remind me in 20 minutes to stretch".')); return reportSize(); }
    for (const r of list) reminderList.append(itemRow(r.text, fmtWhen(r.at), () => api.reminderCancel(r.id), 'Cancel reminder'));
    reportSize();
  }

  function renderMemory(list) {
    memoryList.textContent = '';
    memoryCount.textContent = list && list.length ? `${list.length} saved` : '';
    if (!list || !list.length) { memoryList.append(empty('Nothing yet. Tell me about yourself and I will remember.')); return reportSize(); }
    for (const m of list) memoryList.append(itemRow(m.text, '', () => api.memoryForget(m.id), 'Forget'));
    reportSize();
  }

  document.getElementById('memory-clear').addEventListener('click', () => {
    if (confirm('Forget everything COre remembers about you?')) api.memoryClear();
  });
  api.onMemory(renderMemory);
  api.onReminders(renderReminders);

  // One-click actions COre offers (open a site, copy text). Nothing happens
  // until the user clicks.
  api.onAction(({ id, label }) => {
    stickToBottom(() => {
      const wrap = document.createElement('div');
      wrap.className = 'action';
      const b = button(label, '', () => { api.runAction(id); b.disabled = true; b.textContent = `${label} ✓`; });
      wrap.append(b);
      log.appendChild(wrap);
      trim();
    });
    reportSize();
  });

  api.onMessage(({ role, text, label, color }) => {
    if (role === 'core-start') { startStream(); return; }
    if (role === 'helper') { add('core', text, { label, color }); return; }
    add(role, text);
  });
  api.onDelta((d) => {
    if (!streaming) startStream();
    streaming.text += d;
    renderStream();
  });

  // Voice harmony: reveal a spoken sentence word by word over its audio
  // length, so the text never runs ahead of COre's voice.
  let karaoke = null; // { words, shown, start, ms, timer }
  function finishKaraoke() {
    if (!karaoke) return;
    clearInterval(karaoke.timer);
    if (streaming) { streaming.text += karaoke.words.slice(karaoke.shown).join(''); renderStream(); }
    karaoke = null;
  }
  api.onSpeak(({ text, ms }) => {
    finishKaraoke();
    if (!streaming) startStream();
    const words = text.match(/\s*\S+/g) || [];
    const total = words.reduce((n, w) => n + w.length, 0) || 1;
    karaoke = { words, shown: 0, start: performance.now(), ms, timer: 0 };
    const k = karaoke;
    k.timer = setInterval(() => {
      if (karaoke !== k || !streaming) return clearInterval(k.timer);
      const frac = Math.min(1, (performance.now() - k.start) / k.ms);
      let chars = 0;
      let n = 0;
      while (n < k.words.length && chars + k.words[n].length <= frac * total + 0.5) chars += k.words[n++].length;
      if (frac >= 1) n = k.words.length;
      if (n > k.shown) {
        streaming.text += k.words.slice(k.shown, n).join('');
        k.shown = n;
        renderStream();
      }
      if (n >= k.words.length) { clearInterval(k.timer); karaoke = null; }
    }, 60);
  });
  api.onDone(({ text }) => {
    finishKaraoke();
    if (streaming) {
      if (text) streaming.text = text;
      renderStream();
      streaming.el.classList.remove('streaming');
      if (!streaming.text.trim()) streaming.el.remove();
      streaming = null;
    }
    reportSize();
  });
  api.onReset(() => { log.textContent = ''; streaming = null; reportSize(); });
  api.onFocus(() => input.focus());
  api.onSettings(applySettings);
  api.onBusy(setBusy);

  // ---------------------------------------------------------- glass behaviour
  const historyBtn = document.getElementById('history-toggle');
  historyBtn.addEventListener('click', () => {
    const on = shell.classList.toggle('expanded');
    historyBtn.textContent = on ? '⌄' : '⌃';
    historyBtn.title = on ? 'Hide history' : 'Show history';
    log.scrollTop = log.scrollHeight;
    reportSize();
  });
  let lastActivity = performance.now();
  let hovering = false;
  const wake = () => { lastActivity = performance.now(); shell.classList.remove('faded'); };
  shell.addEventListener('mouseenter', () => { hovering = true; wake(); });
  shell.addEventListener('mouseleave', () => { hovering = false; lastActivity = performance.now(); });
  for (const ev of ['keydown', 'pointerdown', 'focusin']) document.addEventListener(ev, wake, true);
  new MutationObserver(wake).observe(log, { childList: true, subtree: true, characterData: true });
  setInterval(() => {
    const idle = performance.now() - lastActivity > 7000;
    const typing = document.activeElement === input && input.value.trim();
    shell.classList.toggle('faded', idle && !hovering && !busy && !typing && settings.hidden);
  }, 500);

  api.init().then((d) => {
    if (!d) return;
    api.brainStatus().then(renderBrain);
    applySettings(d.settings);
    for (const m of d.recent) add(m.role, m.text);
    log.scrollTop = log.scrollHeight;
    reportSize();
  });
})();
