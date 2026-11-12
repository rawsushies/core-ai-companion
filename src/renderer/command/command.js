'use strict';

// Command center: polls COre's state every 2 seconds while open. Everything
// shown comes from data (textContent only, never HTML).
(() => {
  const api = window.center;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ago = (t) => {
    if (!t) return 'never';
    const ms = Date.now() - (typeof t === 'string' ? Date.parse(t) : t);
    if (!Number.isFinite(ms)) return '';
    if (ms < 60e3) return 'just now';
    if (ms < 3600e3) return `${Math.round(ms / 60e3)} min ago`;
    if (ms < 86400e3) return `${Math.round(ms / 3600e3)} h ago`;
    return `${Math.round(ms / 86400e3)} d ago`;
  };
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  let last = null;
  let filter = '';

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  async function act(name, arg, done) {
    const r = await api.action(name, arg);
    if (r && r.message) toast(r.message); else if (r && r.error) toast(r.error); else if (done) toast(done);
    refresh();
  }
  const button = (label, onClick, cls = 'btn') => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', onClick); return b; };

  function renderAgent(a) {
    const box = $('agent');
    box.textContent = '';
    if (!a.enabled) box.append(el('div', 'muted', 'Off. Turn it on in Settings, Agent, then start a task with /do in the chat.'));
    if (!a.task) { if (a.enabled) box.append(el('div', 'muted', a.running ? 'Starting…' : 'No task yet. Start one with /do in the chat.')); return; }
    const t = a.task;
    const head = el('div', 'list');
    const li = el('li');
    li.append(el('span', 'grow muted', `Step ${t.step || 0} · ${ago(t.at)}`), el('span', `pill ${a.running ? 'running' : t.status}`, a.running ? 'running' : t.status));
    head.append(li);
    box.append(el('div', 'goal', t.goal), head);
    const row = el('div', 'row');
    if (a.running) row.append(button('Stop', () => act('agentStop', null, 'Stopping'), 'btn danger'));
    else if (t.status !== 'done' && a.enabled) row.append(button('Resume', () => act('agentResume', null, 'Resuming')));
    if (!a.running && t.changed) row.append(button(`Undo file changes (${t.changed})`, () => act('agentUndo', null, 'Undone')));
    if (row.childNodes.length) box.append(row);
  }

  function renderBrains(r) {
    const ul = $('brains');
    ul.textContent = '';
    if (!r) return;
    $('route-mode').textContent = r.mode === 'auto' ? '· automatic' : '· manual order';
    for (const p of r.providers) {
      const li = el('li');
      const g = el('div', 'grow');
      const caps = [p.caps.vision ? 'sees images' : '', p.caps.local ? 'local' : '', p.firstTokenMs != null ? `${(p.firstTokenMs / 1000).toFixed(1)} s to first word` : ''].filter(Boolean).join(' · ');
      g.append(el('div', '', `${p.name}${p.model ? ` (${p.model})` : ''}`), el('div', 'muted', p.state === 'cooling' || p.state === 'needs-login' ? `${p.reason} · retry at ${new Date(p.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : caps || `${p.ok} answers`));
      const label = { ready: 'ready', cooling: 'resting', 'needs-login': 'needs setup', 'no-key': 'no key' }[p.state] || p.state;
      li.append(g, el('span', `pill ${p.state === 'ready' ? 'ok' : p.state === 'no-key' ? '' : 'error'}`, label));
      ul.append(li);
    }
    if (r.last) ul.append(el('li', 'muted', `Last answer: ${r.last.provider}${r.last.model ? ` (${r.last.model})` : ''}${r.last.need && r.last.need.vision ? ' · needed vision' : ''}${r.last.need && r.last.need.depth === 'strong' ? ' · deep work' : ''}`));
    const j = r.jev;
    if (j) {
      const d = j.last;
      const li = el('li');
      const g = el('div', 'grow');
      g.append(el('div', '', `Decision layer: ${j.on ? `Jev (${j.model})` : 'local classifier'}`), el('div', 'muted', d ? `${d.task} · ${d.complexity} · effort ${d.effort}${d.specialist !== 'none' ? ` · ${d.specialist}` : ''} · by ${d.source}${d.ms ? ` in ${d.ms} ms` : ''}` : 'no decision yet'));
      li.append(g, el('span', `pill ${j.on && !j.backingOff ? 'ok' : ''}`, j.on ? (j.backingOff ? 'resting' : 'on') : 'local'));
      ul.append(li);
    }
  }

  function renderCores(list) {
    const ul = $('cores');
    ul.textContent = '';
    for (const c of list) {
      const li = el('li', c.active ? 'active' : '');
      const orb = el('span', 'orb');
      orb.style.setProperty('--c', c.color);
      const txt = el('div', 'grow');
      txt.append(el('div', '', c.name), el('div', 'role', `${c.role}${c.busy ? ' · working' : c.active && c.id !== 'prime' ? ' · on screen' : ''}`));
      li.append(orb, txt);
      ul.append(li);
    }
  }

  function renderTasks(list) {
    const ul = $('tasks');
    ul.textContent = '';
    if (!list.length) { ul.append(el('li', 'muted', 'None yet. Mention two or more cores, e.g. "@Scout @Sentinel compare…"')); return; }
    for (const t of list) {
      const li = el('li');
      const g = el('div', 'grow');
      g.append(el('div', '', t.text), el('div', 'muted', `${t.steps.map((s) => `${s.core} ${s.status}`).join(' · ')} · ${ago(t.at)}`));
      li.append(g, el('span', `pill ${t.status}`, t.status));
      ul.append(li);
    }
  }

  function renderPlaybooks(s) {
    const ul = $('playbooks');
    ul.textContent = '';
    const next = new Map(s.workflows.map((w) => [w.name, w]));
    if (!s.playbooksOn) ul.append(el('li', 'muted', 'Playbooks are off (Settings, Skills).'));
    if (!s.playbooks.length) { ul.append(el('li', 'muted', 'No playbooks yet. Save one from a chat with /skill save NAME.')); return; }
    for (const p of s.playbooks) {
      const li = el('li');
      const g = el('div', 'grow');
      const w = next.get(p.name);
      g.append(el('div', '', `${p.name}${p.core !== 'COre' ? ` → ${p.core}` : ''}`), el('div', 'muted', w ? `${p.schedule} · next ${when(w.at)}` : p.schedule ? `${p.schedule}${p.enabled ? '' : ' (off)'}` : p.description));
      li.append(g);
      if (!p.enabled) li.append(el('span', 'pill', 'off'));
      else li.append(button('Run', () => act('runWorkflow', p.name, `Running ${p.name}`)));
      ul.append(li);
    }
  }

  function renderMemory(m) {
    const box = $('memory');
    box.textContent = '';
    if (!m) { box.append(el('div', 'muted', 'Memory is not loaded.')); return; }
    const stats = el('div', 'stats');
    for (const [n, label] of [[m.total, 'memories'], [m.pinned, 'pinned'], [m.conflicts, 'replaced']]) { const s = el('div', 'stat'); s.append(el('b', '', String(n)), el('span', '', label)); stats.append(s); }
    box.append(stats);
    const kinds = Object.entries(m.byKind || {}).map(([k, n]) => `${k} ${n}`).join(' · ');
    box.append(el('div', 'muted', `${kinds || 'empty'}${m.embedded ? ` · ${m.embedded} with meaning search` : ''}${m.enabled ? '' : ' · memory is off'}`));
    for (const c of m.recent || []) {
      const d = el('div', 'conflict');
      d.append(el('s', '', c.was), document.createTextNode(' → '), el('span', '', c.now));
      box.append(d);
    }
  }

  function renderDevices(d, files) {
    const ul = $('devices');
    ul.textContent = '';
    const row = (label, value, ok) => { const li = el('li'); li.append(el('span', 'grow', label), el('span', `pill ${ok ? 'ok' : ''}`, value)); ul.append(li); };
    row('Phone companion', d.phone.enabled ? `${d.phone.paired} paired` : 'off', d.phone.enabled && d.phone.paired);
    row('Google Drive memory sync', d.drive.connected ? `synced ${ago(d.drive.syncedAt)}` : 'not connected', d.drive.connected);
    row('Backups', d.backup.folder ? `last ${ago(d.backup.last)}` : 'no folder', d.backup.folder && d.backup.last);
    const fb = $('files');
    fb.textContent = '';
    fb.append(el('div', 'muted', files.total ? `${files.ready} ready${files.errors ? `, ${files.errors} could not be read` : ''} · drop more on the chat` : 'No files yet. Drop files on the chat to read them.'));
    if (files.recent.length) {
      const l = el('ul', 'list');
      for (const f of files.recent) { const li = el('li'); li.append(el('span', 'grow', f.name), el('span', `pill ${f.status}`, f.status === 'ready' ? (f.info || f.kind) : f.status)); l.append(li); }
      fb.append(l);
    }
  }

  function renderAudit(list) {
    const ol = $('audit');
    ol.textContent = '';
    const q = filter.toLowerCase();
    const rows = list.filter((a) => !q || `${a.what} ${a.detail}`.toLowerCase().includes(q));
    if (!rows.length) { ol.append(el('li', 'muted', q ? 'Nothing matches.' : 'Nothing logged yet.')); return; }
    for (const a of rows) {
      const li = el('li');
      const t = el('time', '', new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      t.dateTime = a.at;
      t.title = new Date(a.at).toLocaleString();
      li.append(t, el('span', `what${/injection|emergency|refused|failed|denied/i.test(`${a.what} ${a.detail}`) ? ' warn' : ''}`, a.what), el('span', 'detail', a.detail));
      li.title = a.detail;
      ol.append(li);
    }
  }

  function render(s) {
    last = s;
    $('version').textContent = `v${s.version}`;
    const b = s.brain || {};
    $('brain').textContent = `Brain: ${b.primary || 'not configured'}${b.fallback ? ` · then ${b.fallback}` : ''}`;
    renderAgent(s.agent);
    renderBrains(s.route);
    renderCores(s.cores);
    renderTasks(s.tasks);
    renderPlaybooks(s);
    renderMemory(s.memory);
    renderDevices(s.devices, s.files);
    renderAudit(s.audit);
  }

  let busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try { const s = await api.state(); if (s) render(s); } catch {} finally { busy = false; }
  }

  $('stop-all').addEventListener('click', () => act('emergency', null, 'Everything stopped'));
  $('close').addEventListener('click', () => api.close());
  $('open-skills').addEventListener('click', () => act('openSkills'));
  $('open-logs').addEventListener('click', () => act('openLogs'));
  $('consolidate').addEventListener('click', () => act('consolidate'));
  $('filter').addEventListener('input', (e) => { filter = e.target.value; if (last) renderAudit(last.audit); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement !== $('filter')) api.close(); });
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 2000);
  window.__centerReady = true;
})();
