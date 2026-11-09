'use strict';

// COre's memory in your Google Drive (optional): a single file in Drive's
// private app-data folder, which only COre can see (scope drive.appdata; it
// can't read anything else in your Drive). Sign-in is Google's flow for
// desktop apps: your browser opens Google's page, and Google sends a one-time
// code back to a local address on this PC (PKCE, S256). COre keeps only the
// refresh token, encrypted with your OS account.
//
// You need your own OAuth client (Google Cloud Console → Credentials → OAuth
// client ID → Desktop app); paste its ID and secret in Settings → Cloud.

const http = require('http');
const crypto = require('crypto');

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'core-memory.json';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authUrl({ clientId, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  });
  return `${AUTH}?${q}`;
}

// Wait for Google to redirect back to 127.0.0.1 with the code. Resolves
// { code, redirectUri }; the caller opens `url(redirectUri)` in the browser.
function listenForCode({ state, timeoutMs = 5 * 60e3, onReady }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>COre</title><body style="background:#05070a;color:#e8fff1;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>${ok ? 'COre is connected to your Google account. You can close this tab.' : 'Something went wrong. Try again from COre Settings.'}</p>`);
      clearTimeout(timer);
      server.close();
      if (ok) resolve({ code: u.searchParams.get('code'), redirectUri });
      else reject(new Error(u.searchParams.get('error') || 'Google sign-in was cancelled.'));
    });
    let redirectUri = '';
    const timer = setTimeout(() => { server.close(); reject(new Error('Google sign-in timed out.')); }, timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      onReady(redirectUri);
    });
  });
}

async function postForm(fetchImpl, url, form) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error_description || j.error || `Google answered ${res.status}`);
  return j;
}

class GoogleDrive {
  // opts: { clientId, clientSecret, refreshToken, fetch, openBrowser(url), saveRefreshToken(t) }
  constructor(opts) {
    this.o = opts;
    this.access = null; // { token, until }
  }

  get connected() { return !!this.o.refreshToken; }

  async connect() {
    if (!this.o.clientId) throw new Error('Add your Google OAuth client ID first (Settings, Cloud).');
    const { verifier, challenge } = pkce();
    const state = b64url(crypto.randomBytes(16));
    const { code, redirectUri } = await listenForCode({ state, onReady: (redirectUri) => this.o.openBrowser(authUrl({ clientId: this.o.clientId, redirectUri, challenge, state })) });
    const t = await postForm(this.o.fetch, TOKEN, { client_id: this.o.clientId, client_secret: this.o.clientSecret || '', code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' });
    if (!t.refresh_token) throw new Error('Google did not grant offline access. Try again.');
    this.o.refreshToken = t.refresh_token;
    this.o.saveRefreshToken(t.refresh_token);
    this.access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60e3 };
  }

  async token() {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    if (!this.o.refreshToken) throw new Error('Not connected to Google.');
    const t = await postForm(this.o.fetch, TOKEN, { client_id: this.o.clientId, client_secret: this.o.clientSecret || '', refresh_token: this.o.refreshToken, grant_type: 'refresh_token' });
    this.access = { token: t.access_token, until: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60e3 };
    return this.access.token;
  }

  async _api(url, init = {}) {
    const res = await this.o.fetch(url, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401) { this.access = null; }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j.error && j.error.message) || `Drive answered ${res.status}`); }
    return res;
  }

  async _fileId() {
    const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name = '${FILE_NAME}'`, fields: 'files(id,modifiedTime)', pageSize: '1' });
    const j = await (await this._api(`${FILES}?${q}`)).json();
    return j.files && j.files[0] ? j.files[0].id : null;
  }

  // -> { items, updated } or null when there's no file yet
  async read() {
    const id = await this._fileId();
    if (!id) return null;
    return (await this._api(`${FILES}/${id}?alt=media`)).json();
  }

  async write(data) {
    const body = JSON.stringify(data);
    const id = await this._fileId();
    if (id) {
      await this._api(`${UPLOAD}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
      return id;
    }
    const boundary = `core${crypto.randomBytes(8).toString('hex')}`;
    const multipart = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const j = await (await this._api(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart })).json();
    return j.id;
  }

  async disconnect() {
    const t = this.o.refreshToken;
    this.o.refreshToken = '';
    this.access = null;
    this.o.saveRefreshToken('');
    if (t) await this.o.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t)}`, { method: 'POST' }).catch(() => {});
  }
}

// Merge local and cloud memory: union by normalised text; a fact deleted on one
// side stays deleted (removed list, kept for 90 days).
function mergeMemory(local, cloud, now = Date.now()) {
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const removed = new Map();
  for (const r of [...((cloud && cloud.removed) || []), ...((local && local.removed) || [])]) {
    if (r && r.text && now - (r.at || 0) < 90 * 864e5) removed.set(norm(r.text), Math.max(removed.get(norm(r.text)) || 0, r.at || 0));
  }
  const out = new Map();
  for (const it of [...((cloud && cloud.items) || []), ...((local && local.items) || [])]) {
    const k = norm(it.text);
    if (!k) continue;
    const gone = removed.get(k);
    if (gone && gone >= (it.at || 0)) continue;
    const prev = out.get(k);
    if (!prev || (it.at || 0) > (prev.at || 0)) out.set(k, { text: String(it.text).slice(0, 300), at: it.at || 0 });
  }
  return { items: [...out.values()].slice(-500), removed: [...removed].map(([text, at]) => ({ text, at })), updated: now };
}

module.exports = { GoogleDrive, mergeMemory, pkce, authUrl, listenForCode, SCOPE, FILE_NAME };
