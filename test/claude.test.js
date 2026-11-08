const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseClaudeLine, friendlyError, ClaudeCliBrain: RealBrain } = require('../src/main/brain/claudeCli');

// Track every brain so a failing assertion can't leave a warm process alive
// (which would keep the test runner from exiting).
const live = new Set();
class ClaudeCliBrain extends RealBrain {
  constructor(o) { super(o); live.add(this); }
}
test.afterEach(() => { for (const b of live) b.dispose(); live.clear(); });
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
  const lim = friendlyError("You've hit your 5-hour limit · resets 9pm (UTC)");
  assert.match(lim, /usage limit is reached \(resets 9pm \(UTC\)\)/);
  assert.match(lim, /Gemini or Groq/);
});

test('screenshot prompt points Claude at a relative path inside its workspace', () => {
  const p = { id: 'claude-cli', workDir: path.join('/tmp', 'ws') };
  const s = buildPrompt(p, 'what is this', { path: path.join('/tmp', 'ws', 'shots', 'a.png'), width: 1280, height: 720 });
  assert.match(s, /\.\/shots\/a\.png, 1280x720 pixels/);
});

test('ClaudeCliBrain keeps one warm process across turns and only enables Read', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const argsLog = path.join(dir, 'args.log');
  process.env.FAKE_CLAUDE_ARGS = argsLog;
  delete process.env.FAKE_CLAUDE_MODE;
  const state = memState();
  const brain = new ClaudeCliBrain({ config: { command: FAKE, model: 'haiku' }, workDir: dir, state });

  let streamed = '';
  const r1 = await brain.ask({ prompt: 'hello', tone: 'sarcastic', onDelta: (d) => { streamed += d; } });
  assert.equal(r1.text, 'You said: hello. [[explain]] Done.');
  assert.equal(streamed, r1.text);
  const sid = state.m.claudeSessionId;
  assert.match(sid, /^[0-9a-f-]{36}$/);
  const r2 = await brain.ask({ prompt: 'again', tone: 'sarcastic', onDelta: () => {} });
  assert.match(r2.text, /again/);

  let calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 1, 'both turns used the same process');
  const a = calls[0];
  assert.equal(a[a.indexOf('--session-id') + 1], sid);
  assert.equal(a[a.indexOf('--tools') + 1], '', 'persistent sessions get screenshots inline: no tools at all');
  assert.ok(!a.includes('Read'));
  assert.ok(a.includes('--restricted') && a.includes('--input-format'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));

  // A tone change restarts the process but keeps the conversation (--resume).
  await brain.ask({ prompt: 'tone', tone: 'calm', onDelta: () => {} });
  calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], sid);
  brain.dispose();
});

test('ClaudeCliBrain falls back to one process per message on older CLIs', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const argsLog = path.join(dir, 'args.log');
  process.env.FAKE_CLAUDE_ARGS = argsLog;
  process.env.FAKE_CLAUDE_NO_STREAM_INPUT = '1';
  const state = memState();
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state });
  await brain.ask({ prompt: 'one', onDelta: () => {} });
  await brain.ask({ prompt: 'two', onDelta: () => {} });
  const calls = fs.readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(calls.length, 2);
  assert.ok(!calls[0].includes('--input-format'));
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], state.m.claudeSessionId);
  delete process.env.FAKE_CLAUDE_NO_STREAM_INPUT;
  brain.dispose();
});

test('Stop during a reply restarts the warm process and the next turn works', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_DELAY = '30';
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  const ac = new AbortController();
  const p = brain.ask({ prompt: 'a long one', signal: ac.signal, onDelta: () => ac.abort() });
  await assert.rejects(p, (e) => e.aborted === true);
  delete process.env.FAKE_CLAUDE_DELAY;
  const r = await brain.ask({ prompt: 'after stop', onDelta: () => {} });
  assert.match(r.text, /after stop/);
  brain.dispose();
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
  brain.dispose();
});

test('ClaudeCliBrain reports login problems clearly', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_MODE = 'auth';
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  await assert.rejects(brain.ask({ prompt: 'hi', onDelta: () => {} }), /not logged in/);
  delete process.env.FAKE_CLAUDE_MODE;
  brain.dispose();
});

test('ClaudeCliBrain can be aborted mid-turn', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(brain.ask({ prompt: 'hi', signal: ac.signal, onDelta: () => {} }), (e) => e.aborted === true);
  brain.dispose();
});

test('a logged-out Claude Code is detected before any request is sent', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  process.env.FAKE_CLAUDE_MODE = 'loggedout';
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  await assert.rejects(brain.ask({ prompt: 'hi', onDelta: () => {} }), (e) => e.notLoggedIn === true && /not logged in/.test(e.message));
  assert.deepEqual(await brain.authStatus(), { known: true, loggedIn: false });
  delete process.env.FAKE_CLAUDE_MODE;
  assert.deepEqual(await brain.authStatus(), { known: true, loggedIn: true });
  brain.dispose();
});

test('a persistent session sends screenshots inline as an image block', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-test-'));
  const brain = new ClaudeCliBrain({ config: { command: FAKE }, workDir: dir, state: memState() });
  const r = await brain.ask({ prompt: 'what is this', image: { base64: 'AAAA', mediaType: 'image/jpeg' }, onDelta: () => {} });
  assert.match(r.text, /\[image\] what is this/);
});

test('screen context lists open windows and disables pointing on other monitors', () => {
  const { screenContext } = require('../src/main/brain');
  const c = screenContext({ windows: ['Chrome', 'Discord'], canPoint: false });
  assert.match(c, /Open windows: Chrome \| Discord/);
  assert.match(c, /do not use \[\[point\]\]/);
});
