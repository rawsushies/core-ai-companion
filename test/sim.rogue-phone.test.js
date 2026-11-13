'use strict';

// Simulation (T2, real companion server over HTTP, no phone): a paired phone and a hostile
// device on the same network. The attacker replays captured traffic (also across a PC
// restart), sends garbage, forged and oversized bodies, out-of-order counters and approvals
// for the wrong request or without the fingerprint. Invariants:
//   1. no handler runs for anything that is not a fresh, correctly sealed message
//   2. the server never crashes or returns 5xx
//   3. the real phone keeps working afterwards
// Seeded (SIM_SEED, SIM_N).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const nacl = require('tweetnacl');
const C = require('../src/main/companion');

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const b64 = (u8) => Buffer.from(u8).toString('base64');
const SEED = Number(process.env.SIM_SEED) || 2323;
const N = Number(process.env.SIM_N) || 300;

let clock = Date.now();
const now = () => clock;
function server(devices, calls) {
  let saved = devices;
  const c = new C.Companion({
    port: 0,
    now,
    staticDir: path.join(__dirname, '..', 'src', 'renderer', 'phone'),
    naclFile: require.resolve('tweetnacl/nacl-fast.min.js'),
    iconFile: path.join(__dirname, '..', 'assets', 'brand', 'icon-128.png'),
    devices,
    saveDevices: (l) => { saved = l.map((d) => ({ ...d })); },
    confirmPair: async () => true,
    onMessage: (text) => calls.push(['send', text]),
    onStop: () => calls.push(['stop']),
    onMissionStop: () => calls.push(['missionStop']),
    onApprove: (a) => { calls.push(['approve', a]); return { ok: a.id === 'req-00000001' && a.hash === 'a'.repeat(64) && (a.answer === 'no' || a.bio) }; },
    getFeed: () => ({ events: [], status: {} }),
  });
  return { c, saved: () => saved };
}

async function post(port, body, raw = false) {
  const res = await fetch(`http://127.0.0.1:${port}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
  return res.status;
}

test(`rogue phone: ${N} hostile messages never reach a handler; the server never fails; the real phone keeps working (seed ${SEED})`, async () => {
  const r = rng(SEED);
  const calls = [];
  const key = nacl.randomBytes(32);
  const id = Buffer.from(nacl.randomBytes(18)).toString('base64url');
  let { c, saved } = server([{ id, name: 'Phone', key, ctr: 0, created: now(), lastSeen: now() }], calls);
  await c.start();
  let port = c.port();
  let ctr = 1;
  const genuine = async (m) => { const msg = { ctr: ctr++, ts: now(), ...m }; const body = { d: id, ...C.seal(msg, key) }; return { body, status: await post(port, body) }; };
  const captured = [];
  for (let i = 0; i < 5; i++) captured.push((await genuine({ op: 'send', text: `hello ${i}` })).body);
  assert.strictEqual(calls.length, 5);

  // A restart: the PC comes back with the counters it saved. Replays must still fail.
  c.stop();
  ({ c } = server(saved().map((d) => ({ ...d })), calls));
  await c.start();
  port = c.port();

  const before = calls.length;
  const failures = [];
  const evilKey = nacl.randomBytes(32);
  for (let i = 0; i < N; i++) {
    const kind = Math.floor(r() * 9);
    clock += 300; // ~33 requests per 10 s: under the rate limit, so every request is really judged
    let status;
    try {
      if (kind === 0) status = await post(port, captured[Math.floor(r() * captured.length)]); // replay (after restart)
      else if (kind === 1) status = await post(port, { d: id, ...C.seal({ op: 'send', text: 'forged', ctr: ctr + 1000, ts: now() }, evilKey) }); // wrong key
      else if (kind === 2) status = await post(port, { d: 'x'.repeat(24), ...C.seal({ op: 'stop', ctr: 1, ts: now() }, evilKey) }); // unpaired device
      else if (kind === 3) status = await post(port, '{"d":', true); // broken JSON
      else if (kind === 4) status = await post(port, JSON.stringify({ d: id, n: 'A'.repeat(1 << 21) }), true); // oversized
      else if (kind === 5) status = await post(port, { d: id, ...C.seal({ op: 'send', text: 'stale', ctr: 1, ts: now() }, key) }); // old counter, real key (a captured older message)
      else if (kind === 6) status = await post(port, { d: id, ...C.seal({ op: 'send', text: 'clock', ctr: ctr + 5000 + i, ts: now() - 600000 }, key) }); // stale timestamp
      else if (kind === 7) status = await post(port, { d: id, nonce: b64(nacl.randomBytes(24)), box: b64(nacl.randomBytes(80)) }); // random bytes
      else status = await post(port, { d: [id], nonce: {}, box: null }); // wrong types
    } catch (err) { failures.push(`kind ${kind}: request failed: ${err.message}`); continue; }
    if (status >= 500) failures.push(`kind ${kind}: server error ${status}`);
  }
  if (calls.length !== before) failures.push(`${calls.length - before} hostile message(s) reached a handler: ${JSON.stringify(calls.slice(before, before + 3))}`);

  // Approvals: a yes without the fingerprint and a yes for another request are refused by the
  // app; a decline needs no fingerprint. The real phone still works after the attack.
  const n0 = calls.length;
  assert.strictEqual((await genuine({ op: 'approve', id: 'req-00000001', hash: 'a'.repeat(64), answer: 'yes' })).status, 200);
  assert.strictEqual((await genuine({ op: 'approve', id: 'req-00000001', hash: 'b'.repeat(64), answer: 'yes', bio: true })).status, 200);
  await genuine({ op: 'approve', id: '../../etc', hash: 'a'.repeat(64), answer: 'yes', bio: true }); // bad id never reaches the app
  assert.strictEqual(calls.length - n0, 2, 'the malformed approval id is refused before the app sees it');
  assert.strictEqual(calls[n0][1].bio, false, 'a yes without the fingerprint arrives as such (the app refuses it)');
  assert.strictEqual((await genuine({ op: 'send', text: 'still works' })).status, 200);
  assert.deepStrictEqual(calls[calls.length - 1], ['send', 'still works']);
  c.stop();
  assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length} failures`);
});
