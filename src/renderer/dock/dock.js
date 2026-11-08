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

  function add(role, text) {
    stickToBottom(() => {
      const el = document.createElement('div');
      el.className = `msg ${role}`;
      if (role === 'core') el.appendChild(window.renderMarkdown(text));
      else el.textContent = text;
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
  document.getElementById('gear').addEventListener('click', () => { settings.hidden = !settings.hidden; reportSize(); });
  document.getElementById('open-panel').addEventListener('click', () => api.openPanel());
  document.getElementById('updates').addEventListener('click', () => api.checkUpdates());
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
  document.getElementById('banner-more').addEventListener('click', () => { settings.hidden = false; reportSize(); });
  api.onBrain(renderBrain);
  document.getElementById('gear').addEventListener('click', () => { if (!settings.hidden) api.brainStatus().then(renderBrain); });

  api.onMessage(({ role, text }) => {
    if (role === 'core-start') { startStream(); return; }
    add(role, text);
  });
  api.onDelta((d) => {
    if (!streaming) startStream();
    streaming.text += d;
    renderStream();
  });
  api.onDone(({ text }) => {
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

  api.init().then((d) => {
    if (!d) return;
    api.brainStatus().then(renderBrain);
    applySettings(d.settings);
    for (const m of d.recent) add(m.role, m.text);
    log.scrollTop = log.scrollHeight;
    reportSize();
  });
})();
