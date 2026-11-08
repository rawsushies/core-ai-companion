const test = require('node:test');
const assert = require('node:assert/strict');
const { startNotifyServer, normalize } = require('../src/main/notifyServer');

test('notify endpoint requires the token and validates input', async () => {
  const got = [];
  const server = await startNotifyServer({ port: 0, token: 'secret-token', onNotify: (n) => got.push(n) });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const post = (headers, body) => fetch(`${url}/notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    assert.equal((await post({}, '{"title":"x"}')).status, 401);
    assert.equal((await post({ authorization: 'Bearer wrong-token!' }, '{"title":"x"}')).status, 401);
    assert.equal((await post({ authorization: 'Bearer secret-token' }, 'nope')).status, 400);
    assert.equal((await post({ authorization: 'Bearer secret-token' }, '{}')).status, 400);
    const ok = await post({ 'x-core-token': 'secret-token' }, JSON.stringify({ title: 'Build done', level: 'success' }));
    assert.equal(ok.status, 200);
    assert.deepEqual(got, [{ title: 'Build done', body: '', level: 'success', speak: false }]);
  } finally {
    server.close();
  }
});

test('normalize clamps unknown levels to info', () => {
  assert.equal(normalize({ title: 't', level: 'party' }).level, 'info');
  assert.equal(normalize({ title: '   ' }), null);
});
