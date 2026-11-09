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

  // ---------------------------------------------------------- Meiosis: cores
  // One timeline for every core. Each core reply carries its name and role in
  // text (colour is a second cue, never the only one).
  let cores = [{ id: 'prime', name: 'COre', role: 'Prime', color: '#3dff85', active: true }];
  const coreOf = (id) => cores.find((c) => c.id === (id || 'prime')) || cores[0];

  function speakerHead(author) {
    const c = coreOf(author);
    const head = document.createElement('div');
    head.className = 'who';
    head.style.setProperty('--core', c.color);
    const n = document.createElement('span');
    n.className = 'who-name';
    n.textContent = c.name;
    const r = document.createElement('span');
    r.className = 'who-role';
    r.textContent = c.role;
    head.append(n, r);
    return head;
  }

  // A small smoke-orb avatar in the core's colour.
  function avatar(id) {
    const c = coreOf(id);
    const a = document.createElement('span');
    a.className = 'avatar';
    a.style.setProperty('--core', c.color);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  // Core replies are bubbles with an avatar; consecutive replies from the
  // same core share one avatar and header.
  function coreRow(author) {
    const c = coreOf(author);
    const last = log.lastElementChild;
    const row = document.createElement('div');
    row.className = `row core by-${c.id}`;
    row.style.setProperty('--core', c.color);
    const cont = last && last.classList.contains(`by-${c.id}`) && last.classList.contains('row');
    if (cont) row.classList.add('cont');
    const bubble = document.createElement('div');
    bubble.className = 'msg core';
    row.append(cont ? document.createElement('span') : avatar(c.id), bubble);
    if (cont) row.firstChild.className = 'avatar-gap';
    return { row, bubble, head: !cont };
  }

  // m: { role: 'user'|'core'|'system', text, author?, kind?, to? }
  function add(role, text, m = {}) {
    stickToBottom(() => {
      if (role === 'core') {
        const { row, bubble, head } = coreRow(m.author);
        if (head) bubble.append(speakerHead(m.author));
        bubble.append(window.renderMarkdown(text));
        log.appendChild(row);
      } else {
        const el = document.createElement('div');
        el.className = `msg ${role}`;
        if (role === 'user' && m.to && m.to.length && !(m.to.length === 1 && m.to[0] === 'prime')) {
          const to = document.createElement('div');
          to.className = 'to-line';
          for (const id of m.to) { const chip = document.createElement('span'); chip.className = 'to-chip'; chip.style.setProperty('--core', coreOf(id).color); chip.textContent = coreOf(id).name; to.append(chip); }
          el.append(to, document.createTextNode(text.replace(/^(?:@[\p{L}\p{N}_-]+[\s,:]*)+/u, '')));
        } else if (role === 'system') {
          el.classList.add(m.kind || 'note');
          if (m.author) { el.style.setProperty('--core', coreOf(m.author).color); el.classList.add('has-core'); }
          el.textContent = text;
        } else el.textContent = text;
        log.appendChild(el);
      }
      trim();
    });
    reportSize();
  }

  function startStream() {
    const { row, bubble } = coreRow('prime');
    bubble.classList.add('streaming');
    log.appendChild(row);
    streaming = { el: bubble, row, text: '', head: !row.classList.contains('cont') };
    trim();
  }

  function renderStream() {
    if (!streaming) return;
    stickToBottom(() => {
      streaming.el.textContent = '';
      if (streaming.head) streaming.el.append(speakerHead('prime'));
      streaming.el.append(window.renderMarkdown(streaming.text));
    });
    reportSize();
  }

  // ---------------------------------------------------------- core wheel + @ chips
  // The recipient button is a mini orb of the current core. Clicking it opens
  // a ring of the four cores that rotates the chosen one to the top.
  const toBtn = document.getElementById('to');
  const toName = document.getElementById('to-name');
  const menu = document.getElementById('core-menu');
  let recipient = 'prime';
  let menuMode = null; // 'pick' (the wheel) | 'mention' (typing @)
  let menuItems = [];
  let menuIndex = 0;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setRecipient(id) {
    recipient = coreOf(id).id;
    const c = coreOf(recipient);
    toName.textContent = c.name;
    toBtn.style.setProperty('--core', c.color);
    toBtn.classList.toggle('specialist', recipient !== 'prime');
    toBtn.setAttribute('aria-label', `Recipient: ${c.name} (${c.role}). Change`);
    input.placeholder = 'Message…'; // the orb beside it names the recipient
    input.setAttribute('aria-label', `Message ${c.name}`);
  }

  function closeMenu() {
    menu.hidden = true;
    menu.className = 'core-menu';
    menuMode = null;
    toBtn.setAttribute('aria-expanded', 'false');
    shell.classList.remove('wheel-open');
    reportSize();
  }

  function option(c, i) {
    const o = document.createElement('div');
    o.className = 'core-opt';
    o.setAttribute('role', 'option');
    o.setAttribute('aria-label', `${c.name}, ${c.role}${c.active ? '' : ', splits off when chosen'}`);
    o.style.setProperty('--core', c.color);
    o.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
    // Hover highlights chips only: on the wheel, an orb sliding under a resting
    // pointer while the ring turns would fire mouseenter and turn it back.
    o.addEventListener('mouseenter', () => { if (menuMode === 'mention') highlight(i); });
    return o;
  }

  function openMenu(mode, list) {
    menuMode = mode;
    menuItems = list;
    menuIndex = mode === 'pick' ? Math.max(0, list.findIndex((c) => c.id === recipient)) : 0;
    menu.textContent = '';
    if (mode === 'pick') {
      menu.className = 'core-menu wheel';
      const ring = document.createElement('div');
      ring.className = 'ring';
      list.forEach((c, i) => {
        const o = option(c, i);
        o.classList.add('orb-opt');
        o.style.setProperty('--a', `${(360 / list.length) * i}deg`);
        o.append(avatar(c.id));
        ring.append(o);
      });
      const info = document.createElement('div');
      info.className = 'wheel-info';
            const nm = document.createElement('div'); nm.className = 'wheel-name';
      const rl = document.createElement('div'); rl.className = 'wheel-role';
      const hint = document.createElement('div'); hint.className = 'wheel-hint'; hint.textContent = '← → to turn · Enter to choose';
      info.append(nm, rl, hint);
      menu.append(ring, info);
      shell.classList.add('wheel-open');
      if (!reduceMotion) { ring.classList.add('spin-in'); setTimeout(() => ring.classList.remove('spin-in'), 450); }
    } else {
      menu.className = 'core-menu chips';
      list.forEach((c, i) => {
        const o = option(c, i);
        o.classList.add('chip-opt');
        const n = document.createElement('span'); n.className = 'who-name'; n.textContent = c.name;
        o.append(avatar(c.id), n);
        menu.append(o);
      });
    }
    menu.hidden = !list.length;
    toBtn.setAttribute('aria-expanded', String(!menu.hidden && mode === 'pick'));
    highlight(menuIndex);
    reportSize();
  }

  function highlight(i) {
    if (!menuItems.length) return;
    menuIndex = (i + menuItems.length) % menuItems.length;
    const opts = [...menu.querySelectorAll('.core-opt')];
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === menuIndex)));
    if (menuMode === 'pick') {
      // Turn the ring so the highlighted core sits at the top.
      const ring = menu.querySelector('.ring');
      ring.style.setProperty('--rot', `${-(360 / menuItems.length) * menuIndex}deg`);
      const c = menuItems[menuIndex];
      menu.querySelector('.wheel-name').textContent = c.name;
      menu.querySelector('.wheel-name').style.color = c.color;
      menu.querySelector('.wheel-role').textContent = `${c.role}${c.active ? '' : ' · splits off'}`;
    }
  }

  function choose(i) {
    const c = menuItems[i];
    if (!c) return closeMenu();
    if (menuMode === 'pick') setRecipient(c.id);
    else {
      // Replace the partial "@sc" with "@Scout ".
      const caret = input.selectionStart;
      const before = input.value.slice(0, caret).replace(/@([\p{L}\p{N}_-]*)$/u, `@${c.name} `);
      input.value = before + input.value.slice(caret);
      input.setSelectionRange(before.length, before.length);
      autosize();
    }
    closeMenu();
    input.focus();
  }

  toBtn.addEventListener('click', () => (menuMode === 'pick' ? closeMenu() : openMenu('pick', cores)));
  toBtn.addEventListener('keydown', (e) => {
    if (menuMode !== 'pick') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); highlight(menuIndex + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); highlight(menuIndex - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(menuIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
  });
  input.addEventListener('input', () => {
    // Only mentions at the start address cores, so only suggest there.
    const head = input.value.slice(0, input.selectionStart);
    const m = /^(?:@[\p{L}\p{N}_-]+[\s,:]*)*@([\p{L}\p{N}_-]*)$/u.exec(head);
    if (m) openMenu('mention', cores.filter((c) => c.name.toLowerCase().startsWith(m[1].toLowerCase()) || c.role.toLowerCase().startsWith(m[1].toLowerCase())));
    else if (menuMode === 'mention') closeMenu();
  });
  input.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    const next = menuMode === 'pick' ? ['ArrowRight', 'ArrowDown'] : ['ArrowRight', 'ArrowDown'];
    if (next.includes(e.key)) { e.preventDefault(); highlight(menuIndex + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); highlight(menuIndex - 1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); choose(menuIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  }, true);
  document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target) && e.target !== toBtn && !toBtn.contains(e.target)) closeMenu(); });

  api.onCores((list) => { if (Array.isArray(list) && list.length) { cores = list; setRecipient(recipient); } });
  api.onRecipient((id) => { setRecipient(id); input.focus(); });

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
    let text = input.value.trim();
    if (!text) return;
    // The picker addresses the message unless it already starts with @mentions.
    if (recipient !== 'prime' && !text.startsWith('@')) text = `@${coreOf(recipient).name} ${text}`;
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

  // A remembered fact: project tag, where it came from, what it replaced,
  // and inline editing (Electron has no prompt()).
  function memoryRow(m) {
    const row = document.createElement('div');
    row.className = 'item memory';
    if (m.project) { const p = document.createElement('span'); p.className = 'when tag'; p.textContent = m.project; row.append(p); }
    const t = document.createElement('span');
    t.textContent = m.text;
    const via = m.source && m.source.via ? `from ${m.source.via}` : '';
    const when = new Date(m.updatedAt || m.ts).toLocaleDateString();
    const was = m.history && m.history.length ? ` · was: ${m.history.map((h) => h.text).join(' → ')}` : '';
    t.title = `${when}${via ? ` · ${via}` : ''}${was}`;
    const edit = button('✎', 'x', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = m.text;
      input.maxLength = 300;
      input.className = 'mem-edit';
      let finished = false; // Enter then blur must not save twice
      const done = (save) => {
        if (finished) return;
        finished = true;
        const v = input.value.trim();
        if (save && v && v !== m.text) { t.textContent = v; api.memoryEdit(m.id, v); }
        input.replaceWith(t);
      };
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } });
      input.addEventListener('blur', () => done(true));
      t.replaceWith(input);
      input.focus();
      input.select();
    });
    edit.title = 'Edit';
    edit.setAttribute('aria-label', `Edit: ${m.text}`);
    const x = button('✕', 'x', () => api.memoryForget(m.id));
    x.title = 'Forget';
    x.setAttribute('aria-label', `Forget: ${m.text}`);
    row.append(t, edit, x);
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
    for (const m of list) memoryList.append(memoryRow(m));
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

  api.onMessage(({ role, text, author, kind, to }) => {
    if (role === 'core-start') { startStream(); return; }
    add(role, text, { author, kind, to });
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
      if (!streaming.text.trim()) (streaming.row || streaming.el).remove();
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
    if (Array.isArray(d.cores) && d.cores.length) { cores = d.cores; setRecipient('prime'); }
    for (const m of d.recent) add(m.role, m.text, m);
    log.scrollTop = log.scrollHeight;
    reportSize();
  });
})();
