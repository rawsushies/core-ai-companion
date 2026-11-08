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
    applySettings(d.settings);
    for (const m of d.recent) add(m.role, m.text);
    log.scrollTop = log.scrollHeight;
    reportSize();
  });
})();
