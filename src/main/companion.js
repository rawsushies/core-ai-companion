'use strict';

// Phone companion (off by default): your phone's browser talks to COre over
// your own Wi-Fi. It can see the chat and COre's status, send messages and
// stop COre talking. Nothing goes through the internet or a relay.
//
// Security model (see docs/dev/PHONE.md):
//  - Pairing: COre shows a QR code holding a one-time pairing secret in the
//    URL fragment (never sent over the network). The phone makes its own
//    device key, sends it sealed with the pairing secret, and both screens
//    show a 6-digit code you compare before COre accepts the phone.
//  - Every request and answer after that is sealed with the device key
//    (XSalsa20-Poly1305, tweetnacl), with a counter and timestamp so old
//    messages can't be replayed. Anyone on the Wi-Fi without that key gets
//    nothing; revoking a phone deletes its key.
//  - Only private-network addresses are answered; requests are size- and
//    rate-limited; the phone sends intents (a message, stop), never commands.
//  - Known limit: the page itself is served over plain HTTP, so someone who
//    controls your Wi-Fi at the moment you open it could tamper with the page.
//    Use it on networks you trust.

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const fromB64url = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64url'));

function seal(obj, key) {
  const nonce = nacl.randomBytes(24);
  const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(obj)), nonce, key);
  return { n: b64(nonce), b: b64(box) };
}

function open(msg, key) {
  if (!msg || typeof msg.n !== 'string' || typeof msg.b !== 'string') return null;
  const nonce = fromB64(msg.n);
  if (nonce.length !== 24) return null;
  const plain = nacl.secretbox.open(fromB64(msg.b), nonce, key);
  if (!plain) return null;
  try { return JSON.parse(new TextDecoder().decode(plain)); } catch { return null; }
}

// The 6-digit code both screens show while pairing (SHA-512 so the phone can
// compute it with tweetnacl too).
function pairCode(secret, deviceId, deviceKey) {
  const h = nacl.hash(Buffer.concat([Buffer.from(secret), Buffer.from(String(deviceId)), Buffer.from(deviceKey)]));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(n % 1000000).padStart(6, '0');
}

function isPrivate(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(a) || a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}

// The PC's address on the local network (first private IPv4).
function lanAddress(ifaces = os.networkInterfaces()) {
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && isPrivate(i.address)) return i.address;
    }
  }
  return null;
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/nacl.js': [null, 'text/javascript; charset=utf-8'],
  '/icon.png': [null, 'image/png'],
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
};

class Companion {
  // opts: { port, host (optional address override), staticDir, naclFile, iconFile, devices: [{ id, name, key: Uint8Array, ctr, created, lastSeen }],
  //         saveDevices(list), confirmPair({ name, code }) -> Promise<bool>, onMessage(text, device),
  //         onStop(device), getFeed(since) -> { events, status }, now() }
  constructor(opts) {
    this.o = opts;
    this.devices = new Map((opts.devices || []).map((d) => [d.id, { ...d }]));
    this.pairing = null;
    this.server = null;
    this.hits = new Map();
    this.now = opts.now || Date.now;
  }

  // A one-time pairing invitation, valid for 5 minutes.
  startPairing() {
    this.pairing = { id: b64url(nacl.randomBytes(8)), secret: nacl.randomBytes(32), expires: this.now() + 5 * 60e3, used: false };
    const host = this.o.host || lanAddress();
    const url = host ? `http://${host}:${this.port()}/#pair=${this.pairing.id}.${b64url(this.pairing.secret)}` : null;
    return { url, host, expires: this.pairing.expires };
  }

  port() { return (this.server && this.server.address() && this.server.address().port) || this.o.port; }

  list() {
    return [...this.devices.values()].map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen }));
  }

  revoke(id) {
    const had = this.devices.delete(id);
    if (had) this._save();
    return had;
  }

  revokeAll() {
    this.devices.clear();
    this._save();
  }

  _save() { if (this.o.saveDevices) this.o.saveDevices([...this.devices.values()]); }

  start() {
    if (this.server) return Promise.resolve(this.port());
    this.server = http.createServer((req, res) => this._handle(req, res).catch(() => this._send(res, 500, { error: 'failed' })));
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 15000;
    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => { this.server = null; reject(err); });
      this.server.listen(this.o.port, '0.0.0.0', () => resolve(this.port()));
    });
  }

  stop() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    this.server = null;
  }

  _limited(ip) {
    const t = this.now();
    const h = (this.hits.get(ip) || []).filter((x) => t - x < 10000);
    h.push(t);
    this.hits.set(ip, h);
    if (this.hits.size > 500) this.hits.clear();
    return h.length > 40;
  }

  _send(res, code, obj, type = 'application/json') {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  }

  async _body(req, max = 16384) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new Error('too big');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  }

  async _handle(req, res) {
    const ip = req.socket.remoteAddress;
    if (!isPrivate(ip)) { req.destroy(); return; }
    if (this._limited(ip)) return this._send(res, 429, { error: 'slow down' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const p = url.pathname === '/nacl.js' ? this.o.naclFile : url.pathname === '/icon.png' ? this.o.iconFile : path.join(this.o.staticDir, file);
      try { return this._send(res, 200, fs.readFileSync(p), type); } catch { return this._send(res, 404, { error: 'missing' }); }
    }
    if (req.method !== 'POST') return this._send(res, 404, { error: 'not found' });
    let body;
    try { body = await this._body(req); } catch { return this._send(res, 413, { error: 'too big' }); }
    if (!body) return this._send(res, 400, { error: 'bad request' });
    if (url.pathname === '/pair') return this._pair(res, body);
    if (url.pathname === '/api') return this._api(res, body);
    return this._send(res, 404, { error: 'not found' });
  }

  async _pair(res, body) {
    const p = this.pairing;
    if (!p || p.used || this.now() > p.expires || body.pairId !== p.id) return this._send(res, 403, { error: 'This pairing code has expired. Ask COre for a new one.' });
    const inner = open(body, p.secret);
    const deviceId = String(body.deviceId || '');
    if (!inner || !/^[\w-]{16,40}$/.test(deviceId)) return this._send(res, 403, { error: 'Pairing failed.' });
    const key = fromB64(inner.key);
    if (key.length !== 32) return this._send(res, 403, { error: 'Pairing failed.' });
    p.used = true; // one phone per invitation, even if this one is refused
    const name = String(inner.name || 'Phone').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40) || 'Phone';
    const code = pairCode(p.secret, deviceId, key);
    const ok = await this.o.confirmPair({ name, code });
    if (!ok) return this._send(res, 200, seal({ ok: false, error: 'COre said no.' }, p.secret));
    const d = { id: deviceId, name, key, ctr: 0, created: this.now(), lastSeen: this.now() };
    this.devices.set(deviceId, d);
    this._save();
    this.pairing = null;
    return this._send(res, 200, seal({ ok: true, name: 'COre' }, p.secret));
  }

  async _api(res, body) {
    const d = this.devices.get(String(body.d || ''));
    if (!d) return this._send(res, 401, { error: 'This phone is not paired (or was removed). Pair it again from COre Settings.' });
    const m = open(body, d.key);
    if (!m) return this._send(res, 401, { error: 'unreadable' });
    const t = this.now();
    // Old counter: a replay. Clock too far off: tell the phone our time so it can
    // correct itself (it retries once, never in a loop).
    if (!Number.isSafeInteger(m.ctr) || m.ctr <= d.ctr) return this._send(res, 409, seal({ error: 'replay', ctr: d.ctr, now: t }, d.key));
    if (Math.abs(t - Number(m.ts)) > 120000) return this._send(res, 409, seal({ error: 'clock', ctr: d.ctr, now: t }, d.key));
    d.ctr = m.ctr;
    const seenBefore = d.lastSeen;
    d.lastSeen = t;
    if (t - seenBefore > 60000) this._save(); // persist counters now and then, not on every poll
    let reply = { ok: true };
    if (m.op === 'sync') reply = { ok: true, ...this.o.getFeed(Number(m.since) || 0) };
    else if (m.op === 'send') {
      const text = String(m.text || '').trim().slice(0, 4000);
      if (!text) return this._send(res, 200, seal({ ok: false, error: 'empty' }, d.key));
      this.o.onMessage(text, { id: d.id, name: d.name });
    } else if (m.op === 'stop') this.o.onStop({ id: d.id, name: d.name });
    else reply = { ok: false, error: 'unknown' };
    return this._send(res, 200, seal({ ...reply, ctr: m.ctr }, d.key));
  }
}

module.exports = { Companion, seal, open, pairCode, isPrivate, lanAddress, b64url, fromB64url };
