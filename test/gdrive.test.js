'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const GD = require('../src/main/gdrive');

// A tiny fake of Google's token and Drive endpoints.
function fakeGoogle() {
  const g = { files: new Map(), tokens: 0, challenge: null, lastAuth: null, nextId: 1 };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const f = new URLSearchParams(init.body);
      if (f.get('grant_type') === 'authorization_code') {
        const ok = crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') === g.challenge && f.get('code') === 'CODE';
        return ok ? json(200, { access_token: `AT${++g.tokens}`, refresh_token: 'RT', expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
      }
      if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === 'RT' ? json(200, { access_token: `AT${++g.tokens}`, expires_in: 3600 }) : json(400, { error: 'invalid_grant' });
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    assert.match(init.headers.authorization, /^Bearer AT\d+$/);
    if (u.pathname === '/drive/v3/files' && (!init.method || init.method === 'GET')) {
      assert.strictEqual(u.searchParams.get('spaces'), 'appDataFolder');
      const f = [...g.files.entries()].map(([id, v]) => ({ id, name: v.name }));
      return json(200, { files: f.filter((x) => x.name === GD.FILE_NAME) });
    }
    if (/^\/drive\/v3\/files\/\w+$/.test(u.pathname)) return json(200, JSON.parse(g.files.get(u.pathname.split('/').pop()).body));
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(init.body)[1]);
      assert.deepStrictEqual(meta.parents, ['appDataFolder']);
      const body = init.body.split('\r\n\r\n')[2].split('\r\n--')[0];
      const id = `f${g.nextId++}`;
      g.files.set(id, { name: meta.name, body });
      return json(200, { id });
    }
    if (/^\/upload\/drive\/v3\/files\/\w+$/.test(u.pathname) && init.method === 'PATCH') {
      const id = u.pathname.split('/').pop();
      g.files.get(id).body = init.body;
      return json(200, { id });
    }
    return json(404, {});
  };
  return g;
}

test('sign-in: PKCE, local callback, offline token; then create and update the app-folder file', async () => {
  const g = fakeGoogle();
  let saved = null;
  const d = new GD.GoogleDrive({
    clientId: 'x.apps.googleusercontent.com', clientSecret: 's', refreshToken: '', fetch: g.fetch,
    saveRefreshToken: (t) => { saved = t; },
    openBrowser: async (url) => {
      const u = new URL(url);
      assert.strictEqual(u.searchParams.get('scope'), GD.SCOPE, 'only the private app folder');
      assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
      g.challenge = u.searchParams.get('code_challenge');
      // The browser comes back to COre's local address with the code.
      const cb = new URL(u.searchParams.get('redirect_uri'));
      assert.strictEqual(cb.hostname, '127.0.0.1');
      cb.searchParams.set('code', 'CODE');
      cb.searchParams.set('state', u.searchParams.get('state'));
      setTimeout(() => fetch(cb).catch(() => {}), 10);
    },
  });
  await d.connect();
  assert.strictEqual(saved, 'RT');
  assert.strictEqual(await d.read(), null, 'no file yet');
  await d.write({ items: [{ text: 'likes tea', at: 1 }] });
  await d.write({ items: [{ text: 'likes coffee', at: 2 }] });
  assert.strictEqual(g.files.size, 1, 'updated, not duplicated');
  assert.deepStrictEqual((await d.read()).items, [{ text: 'likes coffee', at: 2 }]);
});

test('a wrong state is refused at the callback', async () => {
  const d = new GD.GoogleDrive({
    clientId: 'x.apps.googleusercontent.com', fetch: async () => ({ ok: true, json: async () => ({}) }), saveRefreshToken: () => {},
    openBrowser: async (url) => {
      const cb = new URL(new URL(url).searchParams.get('redirect_uri'));
      cb.searchParams.set('code', 'CODE'); cb.searchParams.set('state', 'forged');
      setTimeout(() => fetch(cb).catch(() => {}), 10);
    },
  });
  await assert.rejects(d.connect(), /cancelled|access_denied|wrong|Google/);
});

test('access tokens are refreshed from the stored refresh token', async () => {
  const g = fakeGoogle();
  const d = new GD.GoogleDrive({ clientId: 'x', refreshToken: 'RT', fetch: g.fetch, saveRefreshToken: () => {}, openBrowser: () => {} });
  await d.write({ items: [] });
  assert.strictEqual(g.tokens, 1);
  await d.read();
  assert.strictEqual(g.tokens, 1, 'cached until it expires');
});

test('memory merge: union, newest wins, deletions stick on both sides', () => {
  const now = 1_000_000;
  const local = { items: [{ text: 'Likes tea', at: 10 }, { text: 'works at a studio', at: 5 }], removed: [{ text: 'old fact', at: 50 }] };
  const cloud = { items: [{ text: 'likes  tea', at: 20 }, { text: 'old fact', at: 40 }, { text: 'has a cat', at: 30 }], removed: [] };
  const m = GD.mergeMemory(local, cloud, now);
  const texts = m.items.map((i) => i.text).sort();
  assert.deepStrictEqual(texts, ['has a cat', 'likes  tea', 'works at a studio']);
  assert.ok(m.removed.some((r) => r.text === 'old fact'));
  // a fact re-added after its deletion comes back
  const again = GD.mergeMemory({ items: [{ text: 'old fact', at: 60 }], removed: m.removed }, null, now);
  assert.deepStrictEqual(again.items.map((i) => i.text), ['old fact']);
});

test('the sign-in URL asks for offline access with PKCE only', () => {
  const { verifier, challenge } = GD.pkce();
  assert.ok(verifier.length >= 43);
  const u = new URL(GD.authUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', challenge, state: 's' }));
  assert.strictEqual(u.searchParams.get('access_type'), 'offline');
  assert.strictEqual(u.searchParams.get('code_challenge'), challenge);
});
