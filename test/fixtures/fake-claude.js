#!/usr/bin/env node
// Stand-in for the Claude Code CLI used by tests. Mimics `claude -p
// --output-format stream-json --include-partial-messages`.
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  process.stdout.write('Usage: claude [options]\n --print --output-format --include-partial-messages --resume --session-id --restricted --strict-mcp-config --tools --allowedTools --model --system-prompt\n');
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_ARGS) fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(args) + '\n');
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const sid = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (process.env.FAKE_CLAUDE_MODE === 'stale' && args.includes('--resume')) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${sid}`, session_id: sid });
    return;
  }
  if (process.env.FAKE_CLAUDE_MODE === 'auth') {
    process.stderr.write('Invalid API key · Please run /login\n');
    process.exit(1);
  }
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'fake' });
  const reply = `You said: ${input.trim()}. [[explain]] Done.`;
  for (const piece of reply.match(/.{1,7}/g)) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, session_id: sid });
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, session_id: sid });
});
