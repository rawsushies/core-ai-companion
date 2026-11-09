'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { archicadSkill, call } = require('../src/main/archicad');
const SK = require('../src/main/skills');

// A fake Archicad listening on port 19725 only.
function fakeArchicad({ doors = 3 } = {}) {
  const calls = [];
  const f = async (url, init) => {
    const port = Number(new URL(url).port);
    const body = JSON.parse(init.body);
    calls.push({ port, command: body.command, host: new URL(url).hostname });
    if (port !== 19725) throw new Error('ECONNREFUSED');
    const ok = (result) => ({ json: async () => ({ succeeded: true, result }) });
    if (body.command === 'API.IsAlive') return ok({ isAlive: true });
    if (body.command === 'API.GetProductInfo') return ok({ version: 27, buildNumber: 4001, languageCode: 'INT' });
    if (body.command === 'API.GetElementsByType') return ok({ elements: Array.from({ length: body.parameters.elementType === 'Door' ? doors : 0 }, (_, i) => ({ elementId: { guid: String(i) } })) });
    return { json: async () => ({ succeeded: false, error: { message: 'unknown command' } }) };
  };
  return { f, calls };
}

test('finds Archicad on its port range and answers read-only questions', async () => {
  const { f, calls } = fakeArchicad({ doors: 12 });
  assert.match((await archicadSkill('status', f)).result, /Archicad 27 build 4001 .* port 19725/);
  assert.match((await archicadSkill('count doors', f)).result, /12 door elements/);
  assert.ok(calls.every((c) => c.host === '127.0.0.1'), 'localhost only');
  assert.match((await archicadSkill('count dragons', f)).error, /Unknown element type/);
  assert.match((await archicadSkill('delete Wall', f)).error, /never changes the model/);
});

test('no Archicad running, and write commands refused at the lowest level', async () => {
  const none = async () => { throw new Error('ECONNREFUSED'); };
  assert.match((await archicadSkill('status', none)).error, /No running Archicad/);
  await assert.rejects(call(fakeArchicad().f, 19725, 'API.DeleteElements', {}), /only read-only/);
});

test('the skill is off unless the user enables it', async () => {
  const { f } = fakeArchicad();
  const off = await SK.runSkill('archicad', 'status', { config: {}, fetch: f });
  assert.match(off.result, /off/);
  const on = await SK.runSkill('archicad', 'count Door', { config: { archicad: true }, fetch: f });
  assert.match(on.result, /3 door elements/);
});
