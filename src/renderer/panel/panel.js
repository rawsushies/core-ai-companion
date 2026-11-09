(function () {
  'use strict';

  const api = window.panel;
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const screenBox = document.getElementById('screen');
  const statusEl = document.getElementById('status');
  const menu = document.getElementById('menu');
  const hints = document.getElementById('hints');
  let brain = { primary: '', fallback: null };
  let statusTimer = null;

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function add(entry) {
    const el = document.createElement('div');
    el.className = `msg ${entry.role}`;
    el.textContent = entry.text;
    if (entry.role === 'user' || entry.role === 'core' || entry.role === 'notice') {
      const t = document.createElement('time');
      t.textContent = fmtTime(entry.ts);
      el.appendChild(t);
    }
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.appendChild(el);
    while (log.children.length > 300) log.removeChild(log.firstChild);
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.title = text;
  }

  function baseStatus() {
    setStatus(`Brain: ${brain.primary}${brain.fallback ? `  ·  fallback: ${brain.fallback}` : ''}`);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }

  document.getElementById('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    api.ask(text, screenBox.checked);
    input.value = '';
    screenBox.checked = false;
    autosize();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      document.getElementById('composer').requestSubmit();
    }
    if (e.key === 'Escape') api.hide();
  });
  input.addEventListener('input', autosize);
  document.getElementById('stop').addEventListener('click', () => api.stop());
  document.getElementById('close-btn').addEventListener('click', () => api.hide());
  document.getElementById('menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'reset') api.reset();
    if (act === 'config') api.openConfig();
    if (act === 'reload') api.reload();
    if (act === 'token') api.copyToken();
    menu.hidden = true;
  });

  api.onTranscript(add);
  api.onTranscriptReset(() => { log.textContent = ''; });
  api.onFocusInput(() => input.focus());
  api.onStatus((s) => {
    if (s.kind === 'brain') { brain = s; baseStatus(); }
    else if (s.kind === 'provider') setStatus(`Thinking with ${s.label}…`);
    else if (s.kind === 'tool') setStatus(s.name === 'Read' ? 'Looking at your screen…' : `Using ${s.name}…`);
    else if (s.kind === 'fallback') setStatus(`Switched to ${s.to}`);
    else if (s.kind === 'download') setStatus(`Downloading speech model ${s.pct}%`);
    clearTimeout(statusTimer);
    if (s.kind !== 'brain') statusTimer = setTimeout(baseStatus, 6000);
  });

  api.init().then((d) => {
    if (!d) return;
    brain = d.brain;
    baseStatus();
    d.transcript.forEach(add);
    const hk = d.hotkeys;
    hints.textContent = `${hk.listen} talk  ·  ${hk.listenWithScreen} talk about screen  ·  ${hk.panel} chat under the orb`;
    log.scrollTop = log.scrollHeight;
  });
})();
