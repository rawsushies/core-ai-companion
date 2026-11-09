'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SK = require('../src/main/skills');
const { parseTag } = require('../src/main/brain/tags');
const { persona } = require('../src/main/brain/persona');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-sk-'));

function ctx(over = {}) {
  const launched = [];
  const ran = [];
  return {
    launched, ran,
    platform: 'win32',
    config: {},
    notes: new SK.Notes(path.join(tmp(), 'notes.json')),
    reminders: { add: (when, text) => (when === '10m' ? { text, at: 1 } : null) },
    fetch: async () => { throw new Error('offline'); },
    launch: async (a) => launched.push(a),
    runFixed: async (c) => ran.push(c),
    plugins: [],
    ...over,
  };
}

test('do tags parse', () => {
  assert.deepStrictEqual(parseTag('do weather Paris'), { name: 'do', skill: 'weather', args: 'Paris' });
  assert.deepStrictEqual(parseTag('do music next'), { name: 'do', skill: 'music', args: 'next' });
  assert.strictEqual(parseTag('do'), null);
  assert.ok(!/["&|<>^%!]/.test(persona({})));
});

test('apps only from the safe list', async () => {
  const c = ctx();
  assert.ok((await SK.runSkill('open', 'Spotify', c)).message);
  assert.deepStrictEqual(c.launched[0], { uri: 'spotify:' });
  assert.ok((await SK.runSkill('open', 'calculator', c)).message);
  assert.deepStrictEqual(c.launched[1], { exe: 'calc.exe' });
  const bad = await SK.runSkill('open', 'cmd /c del *', c);
  assert.ok(bad.error);
  assert.strictEqual(c.launched.length, 2);
  assert.ok((await SK.runSkill('open', 'notepad', ctx({ config: { apps: false } }))).error);
});

test('music uses fixed key codes only', async () => {
  const c = ctx();
  await SK.runSkill('music', 'next', c);
  assert.strictEqual(c.ran[0].file, 'powershell.exe');
  assert.match(c.ran[0].args[3], /^\$w=New-Object -ComObject WScript\.Shell;\$w\.SendKeys\(\[char\]176\)$/);
  const vol = SK.musicCommand('louder', 'win32');
  assert.strictEqual((vol.args[3].match(/SendKeys\(\[char\]175\)/g) || []).length, 5);
  assert.deepStrictEqual(SK.musicCommand('pause', 'linux'), { file: 'playerctl', args: ['pause'] });
  assert.strictEqual(SK.musicCommand('rm -rf', 'win32'), null);
});

test('search and plugins are click-to-open buttons', async () => {
  const s = await SK.runSkill('search', 'electron transparent window', ctx());
  assert.strictEqual(s.action.kind, 'open');
  assert.strictEqual(s.action.value, 'https://duckduckgo.com/?q=electron%20transparent%20window');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([
    { name: 'Wiki', description: 'Search "Wikipedia" & more', url: 'https://en.wikipedia.org/wiki/Special:Search?search={q}' },
    { name: 'evil', url: 'javascript:alert(1){q}' },
    { name: 'weather', url: 'https://x.com/{q}' },
  ]));
  const plugins = SK.loadPlugins(dir);
  assert.strictEqual(plugins.length, 1);
  assert.ok(!/["&]/.test(plugins[0].description));
  const r = await SK.runSkill('wiki', 'smoke', ctx({ plugins }));
  assert.strictEqual(r.action.value, 'https://en.wikipedia.org/wiki/Special:Search?search=smoke');
  assert.ok((await SK.runSkill('nope', '', ctx())).error);
});

test('notes and timers', async () => {
  const c = ctx();
  assert.match((await SK.runSkill('note', 'buy oat milk', c)).message, /oat milk/);
  await SK.runSkill('note', 'call the dentist', c);
  assert.strictEqual((await SK.runSkill('notes', 'milk', c)).result, 'buy oat milk');
  assert.match((await SK.runSkill('timer', '10m tea', c)).message, /tea/);
  assert.ok((await SK.runSkill('timer', 'soonish', c)).error);
});

test('weather asks for a city, then summarises Open-Meteo', async () => {
  assert.match((await SK.runSkill('weather', '', ctx())).result, /No city/);
  const fake = async (url) => ({
    json: async () => (url.includes('geocoding')
      ? { results: [{ name: 'Jakarta', country: 'Indonesia', latitude: -6.2, longitude: 106.8 }] }
      : { current: { temperature_2m: 30.4, apparent_temperature: 35, weather_code: 2, wind_speed_10m: 9 }, daily: { temperature_2m_min: [25, 24], temperature_2m_max: [32, 31], precipitation_probability_max: [60, 40], weather_code: [80, 3] } }),
  });
  const r = await SK.runSkill('weather', 'Jakarta', ctx({ fetch: fake }));
  assert.match(r.result, /Jakarta, Indonesia: now 30 C .*partly cloudy.*Today: rain showers, 25 to 32 C, 60 percent/);
});

