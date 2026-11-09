'use strict';

// COre on your phone: pairs once from the QR code, then talks to COre on your
// PC with every message sealed by this phone's own key (tweetnacl secretbox).
// The pairing secret travels in the URL fragment, which browsers never send.

(function () {
  const nacl = window.nacl;
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const store = {
    get: (k) => { try { return localStorage.getItem(`core.${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`core.${k}`, v); } catch {} },
    del: (k) => { try { localStorage.removeItem(`core.${k}`); } catch {} },
  };

  function seal(obj, key) {
    const nonce = nacl.randomBytes(24);
    return { n: b64(nonce), b: b64(nacl.secretbox(enc.encode(JSON.stringify(obj)), nonce, key)) };
  }
  function open(msg, key) {
    if (!msg || !msg.n || !msg.b) return null;
    const p = nacl.secretbox.open(unb64(msg.b), unb64(msg.n), key);
    if (!p) return null;
    try { return JSON.parse(dec.decode(p)); } catch { return null; }
  }
  function pairCode(secret, deviceId, key) {
    const all = new Uint8Array(secret.length + deviceId.length + key.length);
    all.set(secret, 0); all.set(enc.encode(deviceId), secret.length); all.set(key, secret.length + deviceId.length);
    const h = nacl.hash(all);
    const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    return String(n % 1000000).padStart(6, '0');
  }

  function show(which) {
    for (const id of ['pair', 'unpaired', 'log', 'composer', 'media']) $(id).hidden = true;
    for (const id of which) $(id).hidden = false;
    $('stop').hidden = !which.includes('log');
  }
  function status(text, cls = '') {
    $('status').textContent = text;
    $('status').className = `status ${cls}`;
  }

  // ------------------------------------------------------------ pairing
  async function pair(pairId, secret) {
    show(['pair']);
    const deviceId = b64url(nacl.randomBytes(18));
    const key = nacl.randomBytes(32);
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Phone';
    $('code').textContent = pairCode(secret, deviceId, key);
    $('code').hidden = false;
    $('pair-text').textContent = 'Waiting for you to allow this phone on your PC…';
    status('Pairing…', 'busy');
    try {
      const res = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairId, deviceId, ...seal({ key: b64(key), name }, secret) }) });
      const body = await res.json();
      const r = res.ok ? open(body, secret) : null;
      if (!r || !r.ok) {
        $('code').hidden = true;
        $('pair-text').textContent = (r && r.error) || body.error || 'Pairing failed. Ask COre for a new QR code.';
        status('Not paired', 'off');
        return;
      }
      store.set('device', deviceId);
      store.set('key', b64(key));
      store.set('ctr', '0');
      history.replaceState(null, '', '/'); // drop the one-time secret from the address bar
      start();
    } catch {
      $('pair-text').textContent = "Couldn't reach COre. Is this phone on the same Wi-Fi as your PC?";
      status('Offline', 'off');
    }
  }

  // ------------------------------------------------------------ paired
  let deviceId = null;
  let key = null;
  let since = 0;
  let timer = 0;
  let failures = 0;

  function nextCtr() {
    const c = Math.max(Number(store.get('ctr') || 0) + 1, Date.now());
    store.set('ctr', String(c));
    return c;
  }

  let clockOffset = 0; // PC time minus phone time, learned when the PC says our clock is off

  async function call(op, extra = {}, retried = false) {
    const res = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ d: deviceId, ...seal({ op, ctr: nextCtr(), ts: Date.now() + clockOffset, ...extra }, key) }) });
    if (res.status === 401) {
      store.del('device'); store.del('key');
      show(['unpaired']);
      status('Not paired', 'off');
      throw new Error('unpaired');
    }
    const r = open(await res.json(), key);
    if (res.status === 409 && r) {
      if (retried) throw new Error('refused');
      if (r.error === 'clock' && Number.isFinite(r.now)) clockOffset = r.now - Date.now();
      if (Number(r.ctr) >= Number(store.get('ctr') || 0)) store.set('ctr', String(r.ctr));
      return call(op, extra, true);
    }
    if (!r) throw new Error('unreadable');
    return r;
  }

  function addMsg(e) {
    const log = $('log');
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const el = document.createElement('div');
    const role = e.role === 'notice' ? 'system' : e.role;
    el.className = `msg ${role}`;
    if (role === 'core' && e.author && e.author !== 'prime' && e.name) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = e.name;
      if (/^#[0-9a-f]{6}$/i.test(e.color || '')) w.style.color = e.color;
      el.append(w);
    }
    el.append(document.createTextNode(String(e.text || '')));
    log.append(el);
    while (log.children.length > 200) log.firstChild.remove();
    if (near) log.scrollTop = log.scrollHeight;
  }

  async function sync() {
    clearTimeout(timer);
    try {
      const r = await call('sync', { since });
      failures = 0;
      for (const e of r.events || []) { addMsg(e); since = Math.max(since, e.seq || 0); }
      const s = r.status || {};
      status(s.busy ? 'Thinking…' : s.speaking ? 'Speaking' : 'Online', s.busy || s.speaking ? 'busy' : '');
    } catch (err) {
      if (err.message === 'unpaired') return;
      failures++;
      status('Offline', 'off');
    }
    const visible = document.visibilityState === 'visible';
    timer = setTimeout(sync, !visible ? 15000 : failures ? Math.min(15000, 2000 * failures) : 1500);
  }

  function start() {
    deviceId = store.get('device');
    const k = store.get('key');
    if (!deviceId || !k) { show(['unpaired']); status('Not paired', 'off'); return; }
    key = unb64(k);
    show(['log', 'media', 'composer']);
    sync();
  }

  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    try { await call('send', { text }); setTimeout(sync, 300); } catch { status('Not sent: offline', 'off'); $('input').value = text; }
  });
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); } });
  $('stop').addEventListener('click', () => call('stop').catch(() => {}));
  for (const b of document.querySelectorAll('[data-media]')) {
    b.addEventListener('click', () => { b.disabled = true; call('media', { action: b.dataset.media }).catch(() => {}).finally(() => { b.disabled = false; }); });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && key) sync(); });

  const m = /#pair=([\w-]+)\.([\w-]+)/.exec(location.hash);
  if (m) pair(m[1], unb64url(m[2]));
  else start();
})();
