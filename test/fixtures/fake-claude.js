#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by tests. Mimics `claude -p
// --output-format stream-json --include-partial-messages`, both one prompt on
// stdin and the persistent `--input-format stream-json` mode.
const fs = require('fs');
const args = process.argv.slice(2);
const MODE = process.env.FAKE_CLAUDE_MODE || '';
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: MODE !== 'loggedout' }) + '\n');
  process.exit(0);
}
if (args.includes('--help')) {
  const extra = process.env.FAKE_CLAUDE_NO_STREAM_INPUT ? '' : ' --input-format';
  process.stdout.write(`Usage: claude [options]\nCommands:\n  auth   Manage authentication\n --print --output-format --include-partial-messages --resume --session-id --restricted --strict-mcp-config --tools --allowedTools --model --system-prompt --system-prompt-snapshot${extra}\n`);
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args) + '\n');
const flagValue = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const sid = flagValue('--session-id') || flagValue('--resume');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (MODE === 'stale' && args.includes('--resume')) {
  process.stderr.write(`No conversation found with session ID: ${sid}\n`);
  process.exit(1);
}
if (MODE === 'auth') {
  process.stderr.write('Invalid API key · Please run /login\n');
  process.exit(1);
}
let turns = 0;
function reply(text) {
  turns++;
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
  // FAKE_CLAUDE_REPLY: fixed reply for UI tests; {core} becomes the specialist's name.
  const core = (/\[core ([^\]]+)\]/.exec(text) || [])[1] || 'COre';
  // FAKE_CLAUDE_SCRIPT: a JSON file of [{ match: regex, reply }]; the first rule
  // whose regex matches the prompt wins, otherwise FAKE_CLAUDE_REPLY.
  let scripted = null;
  if (process.env.FAKE_CLAUDE_SCRIPT) {
    try {
      for (const rule of JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'))) {
        if (new RegExp(rule.match, 'i').test(text)) { scripted = rule.reply; break; }
      }
    } catch {}
  }
  const base = scripted || process.env.FAKE_CLAUDE_REPLY;
  const r = base ? base.replace(/\{core\}/g, core).replace(/\\n/g, '\n') : `You said: ${text.trim()}. [[explain]] Done.`;
  const pieces = r.match(/[\s\S]{1,7}/g) || [''];
  const delay = Number(process.env.FAKE_CLAUDE_DELAY || 0);
  let i = 0;
  const next = () => {
    if (i < pieces.length) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: pieces[i++] } }, session_id: sid });
      return delay ? setTimeout(next, delay) : next();
    }
    out({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: sid, num_turns: turns });
  };
  next();
}
if (args.includes('--input-format')) {
  let buf = '';
  process.stdin.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const c = msg.message.content;
      reply(Array.isArray(c) ? c.map((b) => (b.type === 'image' ? '[image]' : b.text)).join(' ') : c);
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => reply(input));
}
