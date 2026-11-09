'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nacl = require('tweetnacl');
const C = require('../src/main/companion');

const b64 = (u8) => Buffer.from(u8).toString('base64');

function companion(extra = {}) {
  const saved = [];
  const sent = [];
  const c = new C.Companion({
    port: 0,
    staticDir: path.join(__dirname, '..', 'src', 'renderer', 'phone'),
    naclFile: require.resolve('tweetnacl/nacl-fast.min.js'),
    iconFile: path.join(__dirname, '..', 'assets', 'brand', 'icon-128.png'),
    devices: [],
    saveDevices: (l) => saved.push(l),
    confirmPair: async () => true,
    onMessage: (text, d) => sent.push([text, d.name]),
    onStop: () => sent.push(['STOP']),
    onMedia: (a) => sent.push(['MEDIA', a]),
    getFeed: (since) => ({ events: [{ seq: since + 1, role: 'core', text: 'hello from COre' }], status: { busy: false } }),
    ...extra,
  });
  return { c, saved, sent };
}

async function post(port, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function pairPhone(c, port, invite = c.startPairing()) {
  const p = c.pairing;
  const deviceId = Buffer.from(nacl.randomBytes(18)).toString('base64url');
  const key = nacl.randomBytes(32);
  const r = await post(port, '/pair', { pairId: p.id, deviceId, ...C.seal({ key: b64(key), name: 'Test phone' }, p.secret) });
  return { r, deviceId, key, secret: p.secret, invite };
}

test('pair, sync, send and stop, all sealed with the device key', async () => {
  const { c, saved, sent } = companion();
  const port = await c.start();
  try {
    const { r, deviceId, key, secret } = await pairPhone(c, port);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(C.open(r.body, secret).ok, true);
    assert.strictEqual(c.list()[0].name, 'Test phone');
    assert.ok(saved.length);
    let ctr = 1;
    const api = (op, extra = {}) => post(port, '/api', { d: deviceId, ...C.seal({ op, ctr: ctr++, ts: Date.now(), ...extra }, key) });
    const s = await api('sync', { since: 4 });
    const feed = C.open(s.body, key);
    assert.strictEqual(feed.events[0].text, 'hello from COre');
    assert.ok(!JSON.stringify(s.body).includes('hello'), 'answers are encrypted');
    await api('send', { text: 'hi from the phone' });
    await api('stop');
    await api('media', { action: 'next' });
    const bad = C.open((await api('media', { action: 'rm -rf' })).body, key);
    assert.strictEqual(bad.ok, false, 'only the fixed media keys');
    assert.deepStrictEqual(sent, [['hi from the phone', 'Test phone'], ['STOP'], ['MEDIA', 'next']]);
  } finally { c.stop(); }
});

test('replays, wrong keys and stale timestamps are refused', async () => {
  const { c, sent } = companion();
  const port = await c.start();
  try {
    const { deviceId, key } = await pairPhone(c, port);
    const msg = { d: deviceId, ...C.seal({ op: 'send', ctr: 10, ts: Date.now(), text: 'once' }, key) };
    assert.strictEqual((await post(port, '/api', msg)).status, 200);
    assert.strictEqual((await post(port, '/api', msg)).status, 409, 'same message twice');
    const old = { d: deviceId, ...C.seal({ op: 'send', ctr: 11, ts: Date.now() - 10 * 60e3, text: 'old' }, key) };
    assert.strictEqual((await post(port, '/api', old)).status, 409);
    const forged = { d: deviceId, ...C.seal({ op: 'send', ctr: 12, ts: Date.now(), text: 'forged' }, nacl.randomBytes(32)) };
    assert.strictEqual((await post(port, '/api', forged)).status, 401);
    assert.deepStrictEqual(sent, [['once', 'Test phone']]);
  } finally { c.stop(); }
});

test('an invitation works once, expires, and can be refused', async () => {
  let now = Date.now();
  const { c } = companion({ now: () => now, confirmPair: async () => false });
  const port = await c.start();
  try {
    const first = await pairPhone(c, port);
    assert.strictEqual(C.open(first.r.body, first.secret).ok, false, 'refused on the PC');
    assert.strictEqual(c.list().length, 0);
    const p = c.pairing;
    const again = await post(port, '/pair', { pairId: p.id, deviceId: 'x'.repeat(20), ...C.seal({ key: b64(nacl.randomBytes(32)) }, p.secret) });
    assert.strictEqual(again.status, 403, 'used invitations stay used');
    c.startPairing();
    now += 6 * 60e3;
    const late = await pairPhone(c, port, null);
    assert.strictEqual(late.r.status, 403, 'expired');
  } finally { c.stop(); }
});

test('revoking a phone locks it out at once', async () => {
  const { c } = companion();
  const port = await c.start();
  try {
    const { deviceId, key } = await pairPhone(c, port);
    assert.ok(c.revoke(deviceId));
    const r = await post(port, '/api', { d: deviceId, ...C.seal({ op: 'sync', ctr: 1, ts: Date.now() }, key) });
    assert.strictEqual(r.status, 401);
  } finally { c.stop(); }
});

test('the phone app and its files are served with a strict policy; nothing else is', async () => {
  const { c } = companion();
  const port = await c.start();
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok((await page.text()).includes('/nacl.js'));
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/nacl.js`)).status, 200);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/../package.json`)).status, 404);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/config.json`)).status, 404);
  } finally { c.stop(); }
});

test('only private network addresses count as local', () => {
  for (const a of ['192.168.1.4', '10.0.0.2', '172.20.1.1', '127.0.0.1', '::1', '::ffff:192.168.0.9', 'fe80::1']) assert.ok(C.isPrivate(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:4860::1']) assert.ok(!C.isPrivate(a), a);
  assert.strictEqual(C.lanAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }] }), '192.168.1.20');
});

test('both sides compute the same pairing code', () => {
  const secret = nacl.randomBytes(32);
  const key = nacl.randomBytes(32);
  const code = C.pairCode(secret, 'device-abc', key);
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(C.pairCode(secret, 'device-abc', key), code);
  assert.notStrictEqual(C.pairCode(secret, 'device-abd', key), code);
});

test('a phone whose clock is off learns the PC time instead of looping', async () => {
  const { c } = companion();
  const port = await c.start();
  try {
    const { deviceId, key } = await pairPhone(c, port);
    const skewed = { d: deviceId, ...C.seal({ op: 'sync', ctr: 5, ts: Date.now() - 10 * 60e3 }, key) };
    const r = await post(port, '/api', skewed);
    assert.strictEqual(r.status, 409);
    const body = C.open(r.body, key);
    assert.strictEqual(body.error, 'clock');
    assert.ok(Math.abs(body.now - Date.now()) < 5000);
    const fixed = { d: deviceId, ...C.seal({ op: 'sync', ctr: 6, ts: body.now }, key) };
    assert.strictEqual((await post(port, '/api', fixed)).status, 200, 'with the corrected clock it works');
  } finally { c.stop(); }
});
