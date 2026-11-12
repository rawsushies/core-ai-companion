(function () {
  'use strict';

  const api = window.settingsApi;
  const nav = document.getElementById('nav');
  const content = document.getElementById('content');
  const restartBar = document.getElementById('restart-bar');
  let data = null;
  let current = 'general';

  const get = (key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data.values);

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((x) => x.remove()); // one message at a time
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  async function save(field, value) {
    const r = await api.set(field.key, value);
    if (!r || !r.ok) { toast(r && r.error ? r.error : 'That value is not allowed.'); render(); return; }
    data.values = r.values;
    if (r.secrets) { data.secrets = r.secrets; if (field.secret) { render(); toast(r.secrets[field.key] ? 'Saved, encrypted on this PC.' : 'Removed.'); } }
    if (field.restart) restartBar.hidden = false;
  }

  function fmt(field, v) {
    if (field.unit === '%') return `${Math.round(v * 100)}%`;
    if (field.unit === 'st') return `${v > 0 ? '+' : ''}${v}`;
    if (field.unit === '×') return `${Number(v).toFixed(2)}×`;
    return `${v}${field.unit ? ` ${field.unit}` : ''}`;
  }

  function prettyKey(acc) {
    return String(acc || '').replace(/CommandOrControl|CmdOrCtrl/g, navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl');
  }

  function control(field) {
    const v = get(field.key);
    const id = `f-${field.key}`;
    if (field.type === 'toggle') {
      const wrap = document.createElement('span');
      wrap.className = 'switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.role = 'switch';
      input.checked = !!v;
      input.addEventListener('change', () => save(field, input.checked));
      wrap.append(input, document.createElement('span'));
      return wrap;
    }
    if (field.type === 'select') {
      const sel = document.createElement('select');
      sel.id = id;
      for (const [val, label] of field.options) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = label;
        sel.append(o);
      }
      sel.value = v == null ? '' : String(v);
      sel.addEventListener('change', () => save(field, sel.value));
      return sel;
    }
    if (field.type === 'range') {
      const wrap = document.createElement('div');
      wrap.className = 'range';
      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.min = field.min; input.max = field.max; input.step = field.step;
      input.value = v;
      const out = document.createElement('output');
      out.textContent = fmt(field, Number(v));
      input.addEventListener('input', () => { out.textContent = fmt(field, Number(input.value)); });
      input.addEventListener('change', () => save(field, Number(input.value)));
      wrap.append(input, out);
      return wrap;
    }
    if (field.type === 'devices') {
      const list = document.createElement('div');
      list.className = 'devices';
      list.id = 'device-list';
      list.textContent = 'Loading…';
      api.action('phoneDevices').then((r) => renderDevices((r && r.devices) || []));
      return list;
    }
    if (field.type === 'actions') {
      const wrap = document.createElement('span');
      wrap.className = 'secret folder buttons';
      for (const [name, text] of field.items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ghost';
        b.textContent = text;
        b.addEventListener('click', async () => {
          if (name === 'restoreBackup' && !confirm('Restore a backup? Your current settings, memories and notes are saved first, then replaced, and COre restarts.')) return;
          b.disabled = true;
          const r = await api.action(name);
          b.disabled = false;
          if (r && r.values) { data.values = r.values; if (r.secrets) data.secrets = r.secrets; render(); }
          if (r && r.pair) showPair(r.pair);
          if (r && r.devices) renderDevices(r.devices);
          if (r && r.message) toast(r.message);
        });
        wrap.append(b);
      }
      return wrap;
    }
    if (field.type === 'folder') {
      // Folders are chosen with the system picker (in the main process).
      const wrap = document.createElement('span');
      wrap.className = 'secret folder';
      const p = document.createElement('span');
      p.className = 'path';
      p.textContent = v ? String(v).split(/[\\/]/).filter(Boolean).pop() : (field.action ? 'Not set' : 'Not shared');
      p.title = v || '';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'ghost';
      pick.textContent = v ? 'Change…' : 'Choose…';
      pick.addEventListener('click', async () => {
        const r = await api.action(field.action || 'pickProjectFolder');
        if (r && r.values) { data.values = r.values; render(); }
        if (r && r.message) toast(r.message);
      });
      wrap.append(p, pick);
      if (v) {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'ghost';
        stop.textContent = field.action ? 'Clear' : 'Stop sharing';
        stop.addEventListener('click', async () => { await save(field, ''); render(); });
        wrap.append(stop);
      }
      return wrap;
    }
    if (field.type === 'text' && field.secret) {
      // Secret: never shown back. Paste to replace, Remove to clear.
      const wrap = document.createElement('span');
      wrap.className = 'secret';
      const input = document.createElement('input');
      input.type = 'password';
      input.id = id;
      input.autocomplete = 'off';
      input.maxLength = field.maxLength || 200;
      const saved = data.secrets && data.secrets[field.key];
      input.placeholder = saved ? 'Saved (hidden)' : 'Paste it here';
      input.title = saved ? 'Saved and encrypted on this PC. Paste a new one to replace it.' : 'Stored encrypted on this PC, never shown again.';
      input.addEventListener('change', () => { if (input.value.trim()) save(field, input.value); });
      wrap.append(input);
      if (saved) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ghost';
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => save(field, ''));
        wrap.append(rm);
      }
      return wrap;
    }
    if (field.type === 'text') {
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.value = v || '';
      input.maxLength = field.maxLength || 200;
      input.addEventListener('change', () => save(field, input.value));
      return input;
    }
    if (field.type === 'hotkey') {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      b.className = 'hotkey';
      b.textContent = prettyKey(v);
      b.addEventListener('click', () => {
        b.classList.add('listening');
        b.textContent = 'Press the new keys…';
        const onKey = (e) => {
          e.preventDefault();
          if (e.key === 'Escape') { done(); return; }
          if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
          const mods = [];
          if (e.ctrlKey) mods.push('CommandOrControl');
          if (e.altKey) mods.push('Alt');
          if (e.shiftKey) mods.push('Shift');
          if (e.metaKey) mods.push('Super');
          if (!mods.length) { b.textContent = 'Use at least one of Ctrl / Alt / Shift'; return; }
          let k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
          if (k === ' ') k = 'Space';
          if (k.startsWith('Arrow')) k = k.slice(5);
          save(field, `${mods.join('+')}+${k}`).then(done);
        };
        const done = () => { b.classList.remove('listening'); window.removeEventListener('keydown', onKey, true); b.textContent = prettyKey(get(field.key)); };
        window.addEventListener('keydown', onKey, true);
      });
      return b;
    }
    return document.createElement('span');
  }

  function renderMaintenance() {
    const h = document.createElement('h2');
    h.textContent = 'Maintenance';
    const box = document.createElement('div');
    box.className = 'actions';
    const items = [
      ['update', 'Check for updates', 'Download the newest COre now.', 'ghost'],
      ['diagnostics', 'Copy diagnostics', 'GPU, display and brain details for troubleshooting.', 'ghost'],
      ['openData', 'Open data folder', 'Where your settings, memory and models live.', 'ghost'],
      ['logs', 'Open crash logs', 'Problems are logged on this PC only, never uploaded.', 'ghost'],
      ['tour', 'Replay the tour', 'COre shows you around again.', 'ghost'],
      ['restart', 'Restart COre', 'Close and reopen COre.', 'ghost'],
      ['reset', 'Reset COre', 'Forget settings, memory, notes, reminders and chat history. Downloaded models are kept.', 'ghost danger'],
      ['uninstall', 'Uninstall COre', 'Remove COre from this PC.', 'ghost danger'],
    ];
    for (const [name, label, note, cls] of items) {
      const row = document.createElement('div');
      row.className = 'action';
      const txt = document.createElement('div');
      const t = document.createElement('div');
      t.textContent = label;
      const p = document.createElement('p');
      p.textContent = note;
      txt.append(t, p);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', async () => {
        if ((name === 'reset' || name === 'uninstall') && !confirm(name === 'reset' ? 'Reset COre? This forgets your settings, memory, reminders and chat.' : 'Uninstall COre from this PC?')) return;
        const r = await api.action(name);
        if (r && r.message) toast(r.message);
      });
      row.append(txt, b);
      box.append(row);
    }
    content.append(h, box);
  }

  function renderDevices(devices) {
    const list = document.getElementById('device-list');
    if (!list) return;
    list.textContent = '';
    if (!devices.length) { const p = document.createElement('span'); p.className = 'muted'; p.textContent = 'None yet.'; list.append(p); return; }
    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'device';
      const t = document.createElement('span');
      t.textContent = d.name;
      const seen = document.createElement('span');
      seen.className = 'muted';
      seen.textContent = d.lastSeen ? `seen ${new Date(d.lastSeen).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ghost danger';
      x.textContent = 'Remove';
      x.addEventListener('click', async () => {
        const r = await api.action(`revokePhone:${d.id}`);
        if (r && r.devices) renderDevices(r.devices);
        if (r && r.message) toast(r.message);
      });
      row.append(t, seen, x);
      list.append(row);
    }
  }

  // The pairing QR code, over the settings window until paired or closed.
  function showPair(p) {
    document.querySelectorAll('.pair-modal').forEach((m) => m.remove());
    const m = document.createElement('div');
    m.className = 'pair-modal';
    const card = document.createElement('div');
    card.className = 'pair-card';
    const h = document.createElement('h3');
    h.textContent = 'Scan with your phone';
    const qr = document.createElement('div');
    qr.className = 'qr';
    qr.innerHTML = p.svg; // generated in the main process from COre's own URL
    const note = document.createElement('p');
    note.textContent = 'Use the phone camera, on the same Wi-Fi as this PC. COre then asks you to compare a 6-digit code. This code works once, for 5 minutes.';
    const url = document.createElement('code');
    url.textContent = p.url.replace(/#.*/, '');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ghost';
    close.textContent = 'Close';
    close.addEventListener('click', () => m.remove());
    card.append(h, qr, note, url, close);
    m.append(card);
    document.body.append(m);
    setTimeout(() => m.remove(), Math.max(0, p.expires - Date.now()));
  }
  if (api.onPhone) api.onPhone((v) => {
    document.querySelectorAll('.pair-modal').forEach((m) => m.remove());
    if (v && v.paired) toast(`Paired with ${v.paired}.`);
    api.action('phoneDevices').then((r) => renderDevices((r && r.devices) || []));
  });

  function render() {
    content.textContent = '';
    nav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === current)));
    if (current === 'maintenance') return renderMaintenance();
    const sec = data.sections.find((s) => s.id === current);
    const h = document.createElement('h2');
    h.textContent = sec.title;
    content.append(h);
    for (const f of sec.fields) {
      const row = document.createElement('div');
      row.className = 'field';
      const label = document.createElement('label');
      label.htmlFor = `f-${f.key}`;
      label.textContent = f.label;
      if (f.restart) { const n = document.createElement('span'); n.className = 'note'; n.textContent = 'Applies after a restart'; label.append(n); }
      row.append(label, control(f));
      content.append(row);
    }
  }

  document.getElementById('close').addEventListener('click', () => api.close());
  document.getElementById('restart').addEventListener('click', () => api.action('restart'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.hotkey.listening')) api.close(); });

  // Built ahead of time and kept hidden: reload the values each time it is shown.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && data) api.load().then((d) => { data = d; render(); }).catch(() => {});
  });
  api.load().then((d) => {
    data = d;
    document.getElementById('version').textContent = `v${d.version}`;
    for (const s of [...d.sections, { id: 'maintenance', title: 'Maintenance' }]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = s.id;
      b.textContent = s.title;
      b.addEventListener('click', () => { current = s.id; render(); });
      nav.append(b);
    }
    render();
  });
})();
