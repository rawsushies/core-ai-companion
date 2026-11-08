const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { OpenAICompatBrain } = require('../src/main/brain/httpModels');

// A tiny OpenAI-compatible server: knows only "model-new", like a provider
// that renamed its models.
function fakeProvider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'text-embedding-1' }, { id: 'model-old-mini' }, { id: 'model-new-flash' }] }));
      }
      const { model } = JSON.parse(body || '{}');
      if (model !== 'model-new-flash') { res.writeHead(404); return res.end(`model ${model} not found`); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"there."}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

function memState() { const m = {}; return { get: (k) => m[k], set: (k, v) => { m[k] = v; } }; }

test('a renamed model is replaced automatically and remembered', async () => {
  const { server, seen, url } = await fakeProvider();
  try {
    const changes = [];
    const cfg = { baseUrl: url, model: 'model-gone', prefer: 'flash' };
    const p = new OpenAICompatBrain({ config: cfg, state: memState(), id: 'gemini', name: 'Gemini', getKey: () => 'k-123', onModelChange: (id, m) => changes.push([id, m]) });
    assert.equal(p.available(), true);
    let out = '';
    const r = await p.ask({ prompt: 'hi', onDelta: (d) => { out += d; } });
    assert.equal(r.text, 'Hello there.');
    assert.equal(out, 'Hello there.');
    assert.equal(cfg.model, 'model-new-flash');
    assert.deepEqual(changes, [['gemini', 'model-new-flash']]);
    assert.ok(seen.every((s) => s.auth === 'Bearer k-123'));
  } finally {
    server.close();
  }
});

test('providers without a key report unavailable (and are skipped)', () => {
  const p = new OpenAICompatBrain({ config: { baseUrl: 'https://x' }, state: memState(), id: 'groq', getKey: () => '' });
  assert.equal(p.available(), false);
});
