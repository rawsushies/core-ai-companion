const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaudeLine, friendlyError, ClaudeCliBrain } = require('../src/main/brain/claudeCli');
const { buildPrompt } = require('../src/main/brain');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');

function memState() {
  const m = {};
  return { get: (k) => m[k], set: (k, v) => { m[k] = v; }, m };
}

test('parses the stream-json lines Claude Code emits', () => {
  assert.deepEqual(
    parseClaudeLine('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}'),
    { kind: 'delta', text: 'Hello' },
  );
  assert.deepEqual(
    parseClaudeLine('{"type":"system","subtype":"init","session_id":"abc","model":"m"}'),
    { kind: 'init', sessionId: 'abc', model: 'm' },
  );
  const r = parseClaudeLine('{"type":"result","subtype":"success","is_error":false,"result":"Hi","session_id":"abc"}');
  assert.equal(r.kind, 'result');
  assert.equal(r.ok, true);
  assert.equal(parseClaudeLine('{"type":"rate_limit_event"}'), null);
  assert.equal(parseClaudeLine('not json'), null);
  assert.equal(parseClaudeLine('{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}}').name, 'Read');
});

test('friendly errors for common failures', () => {
  assert.match(friendlyError('spawn claude ENOENT'), /not installed/);
  assert.match(friendlyError('Invalid API key · Please run /login'), /not logged in/);
  assert.match(friendlyError('429 rate limit'), /usage limit/);
});

test('screenshot prompt points Claude at a relative path inside its workspace', () => {
  const p = { id: 'claude-cli', workDir: path.join('/tmp', 'ws') };
  const s = buildPrompt(p, 'what is this', { path: path.join('/tmp', 'ws', 'shots', 'a.png'), width: 1280, height: 720 });
  assert.match(s, /\.\/shots\/a\.png, 1280x720 pixels/);
});

test('ClaudeCliBrain streams, keeps the session, and only enables Read', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const argsLog = path.join(dir, 'args.log');
  process.env.FAKE_CLAUDE_ARGS = argsLog;
  delete process.env.FAKE_CLAUDE_MODE;
  const state = memState();
  const brain = new ClaudeCliBrain({ config: { command: FAKE, model: 'haiku' }, workDir: dir, state });

  let streamed = '';
  const r1 = await brain.ask({ prompt: 'hello', onDelta: (d) => { streamed += d; } });
  assert.equal(r1.text, 'You said: hello. [[explain]] Done.');
  assert.equal(streamed, r1.text);
  const sid = state.m.claudeSessionId;
  assert.match(sid, /^[0-9a-f-]{36}$/);

  await brain.ask({ prompt: 'again', onDelta: () => {} });
  const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf('--session-id') + 1], sid);
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], sid);
  for (const a of calls) {
    assert.equal(a[a.indexOf('--tools') + 1], 'Read');
    assert.ok(a.includes('--restricted'));
    assert.ok(!a.includes('--dangerously-skip-permissions'));
  }
});

test('ClaudeCliBrain recovers from a stale session id', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_MODE = 'stale';
  const state = memState();
  state.set('claudeSessionId', '00000000-0000-4000-8000-000000000000');
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state });
  const r = await brain.ask({ prompt: 'hi', onDelta: () => {} });
  assert.match(r.text, /You said: hi/);
  assert.notEqual(state.m.claudeSessionId, '00000000-0000-4000-8000-000000000000');
  delete process.env.FAKE_CLAUDE_MODE;
});

test('ClaudeCliBrain reports login problems clearly', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_MODE = 'auth';
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  await assert.rejects(brain.ask({ prompt: 'hi', onDelta: () => {} }), /not logged in/);
  delete process.env.FAKE_CLAUDE_MODE;
});

test('ClaudeCliBrain can be aborted mid-turn', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(brain.ask({ prompt: 'hi', signal: ac.signal, onDelta: () => {} }), (e) => e.aborted === true);
});

test('a logged-out Claude Code is detected before any request is sent', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_MODE = 'loggedout';
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  await assert.rejects(brain.ask({ prompt: 'hi', onDelta: () => {} }), (e) => e.notLoggedIn === true && /not logged in/.test(e.message));
  assert.deepEqual(await brain.authStatus(), { known: true, loggedIn: false });
  delete process.env.FAKE_CLAUDE_MODE;
  assert.deepEqual(await brain.authStatus(), { known: true, loggedIn: true });
});
