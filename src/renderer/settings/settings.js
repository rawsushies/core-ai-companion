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
      ['reset', 'Reset COre', 'Forget settings, memory, reminders and chat history. Downloaded models are kept.', 'ghost danger'],
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
