'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Decider, local, confidenceOf } = require('../src/main/brain/decide');
const { Router } = require('../src/main/brain/router');
const { Brain, routeHints } = require('../src/main/brain');

test('local classifier: task, complexity, effort, specialist, acting on the system', () => {
  assert.deepStrictEqual(local('hey!'), { task: 'chat', complexity: 'trivial', effort: 'minimal', specialist: 'none', actsOnSystem: 0.1, underspecified: 0.15 });
  const d = local('open the browser and go to my bank statements page');
  assert.strictEqual(d.task, 'desktop');
  assert.strictEqual(d.specialist, 'navigator');
  assert.ok(d.actsOnSystem >= 0.6);
  assert.strictEqual(local('review this login handler for security bugs').specialist, 'sentinel');
  assert.strictEqual(local('what do you remember about my diet').task, 'memory');
  const hard = local('design the architecture for a distributed job queue with retries, idempotency and exactly-once delivery across three regions, and explain the migration plan step by step');
  assert.strictEqual(hard.complexity, 'complex');
  assert.strictEqual(hard.effort, 'high');
  assert.strictEqual(local('summarize this', { hasFiles: true }).task, 'files');
  assert.ok(local('fix it').underspecified >= 0.6);
});

test('confidence needs a clear margin, or an explicit confidence without a near tie', () => {
  assert.strictEqual(confidenceOf({ choice: 'a', probabilities: { a: 0.8, b: 0.15, c: 0.05 } }).toFixed(2), '0.65');
  assert.ok(confidenceOf({ choice: 'a', probabilities: { a: 0.45, b: 0.4 } }) < 0.1, 'near tie');
  assert.strictEqual(confidenceOf({ choice: 'a', confidence: 0.9, probabilities: { a: 0.46, b: 0.44 } }) < 0.2, true, 'explicit confidence cannot hide a tie');
  assert.strictEqual(confidenceOf(null), 0);
});

function fakeFetch(answers, { status = 200, delayMs = 0, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (delayMs) await new Promise((r, j) => { const t = setTimeout(r, delayMs); init.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')); }); });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ model: 'jev-1.13', answers }) };
  };
}
const sure = (choice, others) => ({ type: 'choice', choice, probabilities: { [choice]: 0.86, ...Object.fromEntries(others.map((o) => [o, 0.14 / others.length])) } });
const keys = (o) => (id) => o[id] || '';

test('Jev: one batched request through OpenRouter with the existing key; confident answers win, weak ones fall back', async () => {
  const calls = [];
  const answers = {
    task: sure('build', ['chat', 'question']),
    complexity: sure('complex', ['simple']),
    effort: { type: 'choice', choice: 'low', probabilities: { low: 0.4, high: 0.38 } }, // a tie: not trusted
    specialist: sure('forge', ['none']),
    acts_on_system: { type: 'noul', noul: 0.12 },
    underspecified: { type: 'noul', noul: 0.08 },
    model: sure('m1', ['m0']),
  };
  const d = new Decider({ cfg: { minConfidence: 0.35 }, getKey: keys({ openrouter: 'sk-or' }), fetchImpl: fakeFetch(answers, { calls }) });
  const out = await d.decide('write a full parser for this config format with tests', { candidates: [{ id: 'groq', description: 'fast' }, { id: 'claude-cli', description: 'strong' }] });
  assert.strictEqual(calls.length, 1, 'one round trip for every question');
  assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer sk-or');
  assert.strictEqual(calls[0].body.model, 'typesafe/jev-1.13');
  assert.deepStrictEqual(Object.keys(calls[0].body.questions).sort(), ['acts_on_system', 'complexity', 'effort', 'model', 'specialist', 'task', 'underspecified']);
  assert.deepStrictEqual(calls[0].body.questions.model.criteria, { m0: 'fast', m1: 'strong' });
  assert.strictEqual(out.task, 'build');
  assert.strictEqual(out.complexity, 'complex');
  assert.strictEqual(out.effort, 'medium', 'tie rejected; local said low, and complex work gets at least medium');
  assert.strictEqual(out.specialist, 'forge');
  assert.strictEqual(out.modelIndex, 1);
  assert.strictEqual(out.source, 'mixed');
});

test('Jev fails open: no key, timeouts and errors fall back to the local classifier and back off', async () => {
  const none = new Decider({ getKey: keys({}) });
  assert.strictEqual((await none.decide('compare postgres and sqlite for a desktop app')).source, 'local');
  assert.strictEqual(none.status().on, false);

  let now = 0;
  const calls = [];
  const slow = new Decider({ cfg: { timeoutMs: 500 }, getKey: keys({ jev: 'ts-key' }), fetchImpl: fakeFetch({}, { delayMs: 5000, calls }), now: () => now });
  const t0 = Date.now();
  const r = await slow.decide('compare postgres and sqlite for a desktop app');
  assert.ok(Date.now() - t0 < 2000, 'bounded by the timeout');
  assert.strictEqual(r.source, 'local');
  assert.strictEqual(calls[0].url, 'https://api.typesafe.ai/v1/systemone', 'a TypeSafe key goes to TypeSafe');
  assert.strictEqual(slow.status().lastError, 'timed out');
  await slow.decide('another long question about databases please');
  assert.strictEqual(calls.length, 1, 'backing off: no second call');
  now += 61e3;
  assert.ok(slow.available());

  const denied = new Decider({ getKey: keys({ jev: 'bad' }), fetchImpl: fakeFetch({}, { status: 401 }), now: () => now });
  await denied.decide('compare postgres and sqlite for a desktop app');
  now += 61e3;
  assert.ok(!denied.available(), 'a rejected key rests longer');
});

test('trivial chat skips the remote call entirely', async () => {
  const calls = [];
  const d = new Decider({ getKey: keys({ openrouter: 'k' }), fetchImpl: fakeFetch({}, { calls }) });
  assert.strictEqual((await d.decide('thanks!')).task, 'chat');
  assert.strictEqual(calls.length, 0);
});

test('failure advisor: Jev can make the agent more careful, never less', async () => {
  const say = (choice) => new Decider({ getKey: keys({ openrouter: 'k' }), fetchImpl: fakeFetch({ next: sure(choice, ['retry_same', 'abort']) }) });
  assert.strictEqual(await say('ask_human').adviseFailure({ goal: 'g', step: 'Click', error: 'element not found', attempts: 2 }), 'ask_human');
  assert.strictEqual(await say('retry_same').adviseFailure({ goal: 'g', step: 'Run', error: 'permission denied', attempts: 2 }), 'ask_human', 'permission errors always go to the user');
  assert.strictEqual(await new Decider({ getKey: keys({}) }).adviseFailure({ goal: 'g', step: 'x', error: 'timed out', attempts: 1 }), 'retry_same');
  assert.strictEqual(await new Decider({ getKey: keys({}) }).adviseFailure({ goal: 'g', step: 'x', error: 'nope', attempts: 3 }), 'ask_human');
});

function brainOver(behaviours, { decider = null, router = new Router(), claude = { model: 'haiku', strongModel: 'sonnet' } } = {}) {
  const config = { brain: { provider: 'claude-cli', mode: 'auto', routing: 'auto', claude, gemini: { vision: true }, groq: {} }, personality: {} };
  const b = new Brain({ config, workDir: '/tmp', state: { get() {}, set() {} }, router, decider });
  const seen = [];
  b.chain = Object.entries(behaviours).map(([id, fn]) => ({
    id, name: id, label: id, cfg: config.brain[id === 'claude-cli' ? 'claude' : id], available: () => true, resetConversation() {},
    ask: async (args) => { seen.push({ id, model: args.model, prompt: args.prompt }); const t = await fn(args); args.onDelta(t); return { text: t }; },
  }));
  return { b, seen };
}

test('decisions steer the brain: complex work escalates Claude to its strong model, hints reach the prompt', async () => {
  const { b, seen } = brainOver({ 'claude-cli': async () => 'done' }, { decider: new Decider({ getKey: keys({}) }) });
  const r = await b.ask({ text: 'design the architecture for a distributed job queue with retries and exactly-once delivery, step by step in detail please', decide: true });
  assert.strictEqual(r.decision.complexity, 'complex');
  assert.strictEqual(seen[0].model, 'sonnet', 'one request on the strong model');
  assert.match(seen[0].prompt, /\[Route\][^\n]*plan briefly/);
  await b.ask({ text: 'cool, thanks', decide: true });
  assert.strictEqual(seen[1].model, undefined, 'easy turns stay on the fast model');
  assert.strictEqual(routeHints({ specialist: 'none', actsOnSystem: 0, underspecified: 0, complexity: 'simple', task: 'question' }), '');
});

test('the decision layer can pick the model among eligible ones', async () => {
  const answers = { task: sure('question', ['chat']), model: sure('m1', ['m0']) };
  const d = new Decider({ getKey: keys({ openrouter: 'k' }), fetchImpl: fakeFetch(answers) });
  const { b, seen } = brainOver({ 'claude-cli': async () => 'claude', groq: async () => 'groq' }, { decider: d });
  const r = await b.ask({ text: 'explain in detail why the capital of australia is canberra and not sydney or melbourne, with the history of that compromise', decide: true });
  assert.strictEqual(r.reply, 'groq');
  assert.strictEqual(seen[0].id, 'groq');
});

test('plain conversation is decided locally at once: no remote call on the critical path', async () => {
  let calls = 0;
  const d = new Decider({ getKey: keys({ openrouter: 'k' }), fetchImpl: async (...a) => { calls++; return fakeFetch({ task: sure('question', ['chat']) })(...a); } });
  for (const t of ['hey there', 'what did the tower client decide about the facade?', 'why is the sky blue?']) {
    const r = await d.decide(t, {});
    assert.ok(r.fast && r.source === 'local', t);
    assert.ok(['minimal', 'low'].includes(r.effort), `${t}: low effort for a quick turn`);
  }
  assert.strictEqual(calls, 0);
  await d.decide('please open notepad and type hello world into it', { agentEnabled: true });
  assert.strictEqual(calls, 1, 'requests that act on the desktop still ask Jev');
});

test('continuity: a model taking over gets a recap of the turns it missed, once', async () => {
  const router = new Router();
  let claudeUp = true;
  const { b, seen } = brainOver({
    'claude-cli': async () => { if (!claudeUp) throw new Error("Claude's usage limit is reached"); return 'Your budget is 4,200.'; },
    gemini: async () => 'It is 4,200, as I said.',
  }, { router });
  await b.ask({ text: 'my budget for the trip is 4200 dollars' });
  claudeUp = false;
  await b.ask({ text: 'what was my budget again?' });
  const g = seen.filter((s) => s.id === 'gemini');
  assert.strictEqual(g.length, 1);
  assert.match(g[0].prompt, /\[Earlier in this conversation\][\s\S]*User: my budget for the trip is 4200 dollars[\s\S]*COre: Your budget is 4,200\./);
  assert.ok(g[0].prompt.indexOf('[Earlier in this conversation]') < g[0].prompt.indexOf('what was my budget again?'), 'the recap comes before the new message, never after it');
  assert.doesNotMatch(g[0].prompt.trim(), /COre: [^\n]*$/, 'the prompt does not end on an earlier COre line for the model to continue');
  await b.ask({ text: 'and in euros?' });
  const g2 = seen.filter((s) => s.id === 'gemini')[1];
  assert.doesNotMatch(g2.prompt, /Earlier in this conversation/, 'no recap when nothing was missed');
  b.resetConversation();
  assert.strictEqual(b.turns.length, 0);
});

test('continuity: a turn answered only with an action is not redone by the model taking over', async () => {
  const router = new Router();
  let claudeUp = true;
  const { b, seen } = brainOver({
    'claude-cli': async () => { if (!claudeUp) throw new Error("Claude's usage limit is reached"); return '[[forget Aina birthday]]'; },
    gemini: async () => 'I do not know.',
  }, { router });
  await b.ask({ text: "forget Aina's birthday" });
  claudeUp = false;
  await b.ask({ text: "when is Aina's birthday?" });
  const g = seen.find((s) => s.id === 'gemini');
  assert.match(g.prompt, /User: forget Aina's birthday\nCOre: \(done with an action; nothing left to do\)/);
  assert.match(g.prompt, /do not redo anything/);
});

test('hard limits: a long request skips brains whose context is too small', async () => {
  const { b, seen } = brainOver({ ollama: async () => 'ollama', 'claude-cli': async () => 'claude' });
  b.ctx.config.brain.provider = 'ollama';
  b.ctx.config.brain.ollama = {};
  b.chain[0].cfg = {};
  await b.ask({ text: 'x '.repeat(30000) });
  assert.strictEqual(seen[0].id, 'claude-cli', '60k characters do not fit a small local model');
});
