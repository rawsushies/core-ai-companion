'use strict';

// COre on Android. Two ways to talk:
//  - With your PC (same Wi-Fi): paired with the desktop app; every message is
//    sealed with this phone's own key (tweetnacl), exactly like the phone page.
//  - Away: Gemini, straight from the phone with your own key, using what COre
//    knows about you (copied from the PC whenever you're connected).
// Everything stays on this phone (local storage of the app).

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
    get: (k, d = null) => { try { const v = localStorage.getItem(`core.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`core.${k}`, JSON.stringify(v)); } catch {} },
    del: (k) => { try { localStorage.removeItem(`core.${k}`); } catch {} },
  };

  const seal = (obj, key) => { const n = nacl.randomBytes(24); return { n: b64(n), b: b64(nacl.secretbox(enc.encode(JSON.stringify(obj)), n, key)) }; };
  const open = (msg, key) => {
    if (!msg || !msg.n || !msg.b) return null;
    const p = nacl.secretbox.open(unb64(msg.b), unb64(msg.n), key);
    if (!p) return null;
    try { return JSON.parse(dec.decode(p)); } catch { return null; }
  };
  function pairCode(secret, deviceId, key) {
    const all = new Uint8Array(secret.length + deviceId.length + key.length);
    all.set(secret, 0); all.set(enc.encode(deviceId), secret.length); all.set(key, secret.length + deviceId.length);
    const h = nacl.hash(all);
    return String((((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0) % 1000000).padStart(6, '0');
  }

  // ------------------------------------------------------------ orb
  const tierSetting = store.get('tier', 'auto');
  const orb = new window.PhoneOrb($('orb'), { tier: tierSetting === 'auto' ? window.deviceTier() : tierSetting });
  orb.start();
  window.__orb = orb; // test hook

  // ------------------------------------------------------------ chat log
  const log = $('log');
  function addMsg(role, text, extra = {}) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (extra.name) {
      const w = document.createElement('span');
      w.className = 'who';
      w.textContent = extra.name;
      if (/^#[0-9a-f]{6}$/i.test(extra.color || '')) w.style.color = extra.color;
      el.append(w);
    }
    el.append(document.createTextNode(String(text || '')));
    if (extra.via) { const v = document.createElement('span'); v.className = 'via'; v.textContent = extra.via; el.append(v); }
    log.append(el);
    while (log.children.length > 200) log.firstChild.remove();
    if (near) log.scrollTop = log.scrollHeight;
    return el;
  }

  function setStatus(text, cls, mode) {
    $('status').textContent = text;
    $('status').className = `status ${cls || ''}`;
    orb.mode = mode || 'idle';
  }

  // ------------------------------------------------------------ the PC link
  let pc = store.get('pc'); // { base, deviceId, key, ctr }
  let pcKey = pc ? unb64(pc.key) : null;
  let since = 0;
  let pcOnline = false;
  let clockOffset = 0;
  let syncTimer = 0;
  let failures = 0;

  function nextCtr() {
    pc.ctr = Math.max((pc.ctr || 0) + 1, Date.now());
    store.set('pc', pc);
    return pc.ctr;
  }

  async function call(op, extra = {}, retried = false) {
    const res = await fetch(`${pc.base}/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ d: pc.deviceId, ...seal({ op, ctr: nextCtr(), ts: Date.now() + clockOffset, ...extra }, pcKey) }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) { forgetPc('Your PC removed this phone. Pair again in Settings.'); throw new Error('unpaired'); }
    const r = open(await res.json(), pcKey);
    if (res.status === 409 && r && !retried) {
      if (r.error === 'clock' && Number.isFinite(r.now)) clockOffset = r.now - Date.now();
      if (r.ctr > (pc.ctr || 0)) { pc.ctr = r.ctr; store.set('pc', pc); }
      return call(op, extra, true);
    }
    if (!r) throw new Error('unreadable');
    return r;
  }

  async function syncPc() {
    clearTimeout(syncTimer);
    if (!pc) { updateStatus(); return; }
    try {
      const r = await call('sync', { since });
      pcOnline = true;
      failures = 0;
      for (const e of r.events || []) {
        since = Math.max(since, e.seq || 0);
        addMsg(e.role === 'notice' ? 'system' : e.role, e.text, e.role === 'core' && e.author && e.author !== 'prime' ? { name: e.name, color: e.color } : {});
      }
      renderMission(r);
      notifyNew(r.notices);
      const s = r.status || {};
      setStatus(s.busy ? 'Thinking…' : s.speaking ? 'Speaking' : 'With your PC', '', s.busy ? 'thinking' : s.speaking ? 'speaking' : 'idle');
      if (Date.now() - (store.get('memoryAt', 0)) > 10 * 60e3) pullMemory();
    } catch (err) {
      if (err.message === 'unpaired') return;
      pcOnline = false;
      failures++;
      updateStatus();
    }
    $('media').hidden = !pcOnline;
    const visible = document.visibilityState === 'visible';
    syncTimer = setTimeout(syncPc, !visible ? 30000 : pcOnline ? 2000 : Math.min(30000, 3000 * failures));
  }

  // Notifications (13.0 P3): the PC sends a short list of notices with every sync; each id is
  // raised once, only while the app is in the background, on a private channel (the lock screen
  // shows "COre", not the text). Off until Android's permission is granted; the switch turns it off.
  const LN = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  const noticeInt = (id) => { let h = 7; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h) % 2000000000 + 1; };
  let notifyOk = false;
  async function notifySetup(ask) {
    const ln = LN();
    notifyOk = false;
    if (!ln || store.get('notify', true) === false) return renderNotify();
    try {
      await ln.createChannel({ id: 'core-alerts', name: 'COre', description: 'Requests waiting for you and missions that ended', importance: 4, visibility: 0 });
      let p = await ln.checkPermissions();
      if (p.display !== 'granted' && ask) p = await ln.requestPermissions();
      notifyOk = p.display === 'granted';
    } catch { notifyOk = false; }
    renderNotify();
  }
  function renderNotify() {
    $('notify').checked = store.get('notify', true) !== false;
    $('notify').disabled = !LN();
    $('notify-state').textContent = !LN() ? 'Notifications need the COre app (not the web page).'
      : store.get('notify', true) === false ? 'Off.'
        : notifyOk ? 'On. Only while COre is open or in the background on this phone. The lock screen shows "COre", not the details.'
          : 'Android has not allowed notifications for COre yet. Turn this on again to ask, or allow it in Android settings.';
  }
  function notifyNew(list) {
    const seen = store.get('noticesSeen', null);
    const fresh = (list || []).filter((n) => n && typeof n.id === 'string' && !(seen || []).includes(n.id));
    if (!fresh.length) return;
    store.set('noticesSeen', [...(seen || []), ...fresh.map((n) => n.id)].slice(-80));
    // The first sync after pairing or reinstalling only learns what is already there.
    if (seen === null || !notifyOk || !document.hidden || !LN()) return;
    LN().schedule({ notifications: fresh.slice(-3).map((n) => ({ id: noticeInt(n.id), title: n.title, body: n.body || 'Open COre to see more.', channelId: 'core-alerts', autoCancel: true })) }).catch(() => {});
  }
  $('notify').addEventListener('change', () => { store.set('notify', $('notify').checked); notifySetup(true); });

  // Missions (13.0): the plan as a checklist, requests waiting for an answer, and Stop.
  // Approving needs the phone's fingerprint/face (native BiometricConfirm); declining and
  // stopping never do.
  const bio = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BiometricConfirm) || null;
  const answered = new Set();
  function renderMission(r) {
    const box = $('mission');
    const m = r.mission;
    const asks = (r.approvals || []).filter((a) => !answered.has(a.id));
    box.hidden = !m && !asks.length && !r.agentRunning;
    $('mission-stop').hidden = !r.agentRunning;
    $('mission-goal').textContent = m ? m.goal : 'Desktop task';
    $('mission-status').textContent = m ? (m.status === 'ask' ? 'needs you' : m.status) : r.agentRunning ? 'running' : '';
    const ul = $('mission-steps');
    ul.textContent = '';
    const icon = { done: '✓', failed: '✗', running: '…', pending: '·', waiting: '?' };
    for (const sg of (m && m.subgoals) || []) {
      const li = document.createElement('li');
      li.className = `step ${sg.status}`;
      li.textContent = `${icon[sg.status] || '·'} ${sg.text}${sg.verified === 'deterministic' ? ' (checked)' : sg.verified === 'judged' ? ' (judged)' : ''}`;
      ul.append(li);
    }
    const ap = $('approvals');
    ap.textContent = '';
    for (const a of asks) {
      const card = document.createElement('div');
      card.className = 'approval';
      const t = document.createElement('div'); t.className = 'approval-label'; t.textContent = a.label;
      const w = document.createElement('div'); w.className = 'approval-why'; w.textContent = a.why;
      const row = document.createElement('div'); row.className = 'row';
      const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'primary'; yes.textContent = bio() ? 'Approve' : 'Approve (needs fingerprint support)';
      yes.disabled = !bio();
      const no = document.createElement('button'); no.type = 'button'; no.className = 'ghost'; no.textContent = 'Decline';
      const send = async (answer) => {
        let ok = answer === 'no';
        if (answer === 'yes') { try { const v = await bio().confirm({ title: 'Approve on your PC', subtitle: a.label.slice(0, 80) }); ok = !!(v && v.ok); } catch { ok = false; } }
        if (!ok) return;
        try { const res = await call('approve', { id: a.id, hash: a.hash, answer, bio: answer === 'yes' }); if (res.ok) { answered.add(a.id); card.remove(); } else addMsg('system', res.error || 'Not accepted'); } catch (err) { addMsg('system', `Not sent: ${err.message}`); }
      };
      yes.addEventListener('click', () => send('yes'));
      no.addEventListener('click', () => send('no'));
      row.append(yes, no);
      card.append(t, w, row);
      ap.append(card);
    }
  }
  $('mission-stop').addEventListener('click', () => call('missionStop').catch(() => {}));

  async function pullMemory() {
    try {
      const r = await call('memory');
      if (Array.isArray(r.memory)) { store.set('memory', r.memory.slice(-200)); store.set('memoryAt', Date.now()); renderSettings(); }
    } catch {}
  }

  function updateStatus() {
    if (pc && pcOnline) return;
    if (store.get('geminiKey')) setStatus('Away: Gemini', 'away', 'idle');
    else setStatus(pc ? 'PC not reachable' : 'Not connected', 'off', 'offline');
  }

  function forgetPc(msg) {
    pc = null; pcKey = null; pcOnline = false;
    store.del('pc');
    $('media').hidden = true;
    if (msg) addMsg('system', msg);
    renderSettings();
    updateStatus();
  }

  // Pair from a link like http://192.168.1.20:47330/#pair=ID.SECRET
  async function pairWith(link) {
    const m = /^(https?:\/\/[^/#]+)\/?#pair=([\w-]+)\.([\w-]+)$/.exec(String(link || '').trim());
    if (!m) { addMsg('system', "That isn't a COre pairing link."); return; }
    const [, base, pairId, secretS] = m;
    const secret = unb64url(secretS);
    const deviceId = b64url(nacl.randomBytes(18));
    const key = nacl.randomBytes(32);
    $('code').textContent = pairCode(secret, deviceId, key);
    $('code').hidden = false;
    $('pc-state').textContent = 'Check that your PC shows the same code, then click Allow there.';
    try {
      const res = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairId, deviceId, ...seal({ key: b64(key), name: 'COre app' }, secret) }), signal: AbortSignal.timeout(90000) });
      const body = await res.json();
      const r = res.ok ? open(body, secret) : null;
      $('code').hidden = true;
      if (!r || !r.ok) { $('pc-state').textContent = (r && r.error) || body.error || 'Pairing failed.'; return; }
      pc = { base, deviceId, key: b64(key), ctr: 0 };
      pcKey = key;
      store.set('pc', pc);
      $('pair-link').value = '';
      addMsg('system', 'Paired with your PC.');
      store.del('noticesSeen'); // a new PC: learn its notices first, raise only new ones
      notifySetup(true);
      renderSettings();
      syncPc();
      pullMemory();
    } catch {
      $('code').hidden = true;
      $('pc-state').textContent = "Couldn't reach your PC. Is this phone on the same Wi-Fi?";
    }
  }

  // ------------------------------------------------------------ away: Gemini
  const history = store.get('awayHistory', []);
  async function askGemini(text) {
    const key = store.get('geminiKey');
    const model = store.get('geminiModel', 'gemini-2.5-flash');
    const memory = store.get('memory', []);
    const system = [
      'You are COre, a desktop companion made of glowing smoke, now talking through the user\'s phone while their PC is away.',
      'Your tone is dry and a little sarcastic, never mean, and you always actually help. Answer briefly: this is a phone screen.',
      memory.length ? `What you know about the user:\n${memory.map((m) => `- ${m.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    history.push({ role: 'user', parts: [{ text }] });
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: history.slice(-20) };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((j.error && j.error.message) || `Gemini answered ${res.status}`);
    const reply = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((p) => p.text || '').join('').trim();
    if (!reply) throw new Error('Gemini sent an empty answer.');
    history.push({ role: 'model', parts: [{ text: reply }] });
    store.set('awayHistory', history.slice(-30));
    return reply;
  }

  // ------------------------------------------------------------ sending
  $('composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('input').value.trim();
    if (!text) return;
    $('input').value = '';
    if (pc && pcOnline) {
      try { await call('send', { text }); setTimeout(syncPc, 300); return; } catch {}
    }
    if (!store.get('geminiKey')) {
      addMsg('user', text);
      addMsg('system', pc ? "Your PC isn't reachable, and there's no Gemini key for away mode (Settings)." : 'Pair with your PC or add a Gemini key in Settings.');
      return;
    }
    addMsg('user', text);
    setStatus('Thinking…', 'away', 'thinking');
    try {
      const reply = await askGemini(text);
      addMsg('core', reply, { via: 'via Gemini' });
    } catch (err) {
      addMsg('system', `Gemini: ${err.message}`);
    }
    updateStatus();
  });
  $('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); } });
  for (const b of document.querySelectorAll('[data-media]')) b.addEventListener('click', () => call('media', { action: b.dataset.media }).catch(() => {}));
  $('stop').addEventListener('click', () => call('stop').catch(() => {}));

  // ------------------------------------------------------------ settings
  function renderSettings() {
    $('pc-state').textContent = pc ? `Paired with ${pc.base.replace(/^https?:\/\//, '')}.` : 'Not paired. On your PC: Settings → Phone → Pair a phone.';
    $('unpair').hidden = !pc;
    $('gemini-key').value = store.get('geminiKey', '') ? '••••••••' : '';
    $('gemini-model').value = store.get('geminiModel', 'gemini-2.5-flash');
    const mem = store.get('memory', []);
    $('memory-state').textContent = mem.length ? `${mem.length} things COre knows about you are on this phone (synced ${new Date(store.get('memoryAt', 0)).toLocaleString()}).` : 'Nothing synced from your PC yet.';
    $('tier').value = store.get('tier', 'auto');
    $('tier-state').textContent = `Using ${orb.tier}: ${window.ORB_TIERS[orb.tier].particles} particles at ${orb.fps} fps. The orb stops when the app is in the background.`;
  }
  $('open-settings').addEventListener('click', () => { renderSettings(); $('sheet').hidden = false; });
  $('close-settings').addEventListener('click', () => { $('sheet').hidden = true; });
  $('pair').addEventListener('click', () => pairWith($('pair-link').value));
  $('unpair').addEventListener('click', () => { if (confirm('Forget this PC? You can pair again any time.')) forgetPc('Forgot your PC.'); });
  $('gemini-key').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v && !/^•+$/.test(v)) store.set('geminiKey', v); if (!v) store.del('geminiKey'); renderSettings(); updateStatus(); });
  $('gemini-model').addEventListener('change', (e) => { store.set('geminiModel', e.target.value.trim().replace(/[^\w.-]/g, '') || 'gemini-2.5-flash'); renderSettings(); });
  $('tier').addEventListener('change', (e) => { store.set('tier', e.target.value); orb.setTier(e.target.value === 'auto' ? window.deviceTier() : e.target.value); renderSettings(); });

  // QR scanning where the WebView offers it (BarcodeDetector); otherwise paste the link.
  $('scan').addEventListener('click', async () => {
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices) { addMsg('system', 'Scanning is not available here: open the QR link with the camera app and paste it.'); return; }
    const video = $('camera');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { addMsg('system', 'No camera permission.'); return; }
    video.srcObject = stream; video.hidden = false; await video.play();
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    const started = Date.now();
    const tick = async () => {
      const codes = await det.detect(video).catch(() => []);
      const hit = codes.find((c) => /#pair=/.test(c.rawValue));
      if (hit || Date.now() - started > 60000) {
        for (const t of stream.getTracks()) t.stop();
        video.hidden = true;
        if (hit) pairWith(hit.rawValue);
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && pc) syncPc(); });
  window.addEventListener('resize', () => orb.resize());

  for (const h of history.slice(-10)) addMsg(h.role === 'model' ? 'core' : 'user', h.parts[0].text, h.role === 'model' ? { via: 'via Gemini' } : {});
  updateStatus();
  notifySetup(!!pc); // asks Android once, only on a paired phone
  if (pc) syncPc();
})();
