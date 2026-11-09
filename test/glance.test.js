'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GL = require('../src/main/glance');
const SK = require('../src/main/skills');

test('LRC lyrics parse with several stamps, offsets and sorting', () => {
  const lines = GL.parseLrc('[ar:Someone]\n[offset:+500]\n[00:12.50]Second\n[00:01.00][00:20.00]First and again\n[00:30]Plain stamp\nno stamp here');
  assert.deepStrictEqual(lines.map((l) => l.t), [500, 12000, 19500, 29500]);
  assert.strictEqual(lines[0].text, 'First and again');
  assert.strictEqual(lines[1].text, 'Second');
});

test('lineIndex finds the line being sung', () => {
  const lines = [{ t: 1000 }, { t: 5000 }, { t: 9000 }];
  assert.strictEqual(GL.lineIndex(lines, 0), -1);
  assert.strictEqual(GL.lineIndex(lines, 1000), 0);
  assert.strictEqual(GL.lineIndex(lines, 8999), 1);
  assert.strictEqual(GL.lineIndex(lines, 60000), 2);
  assert.strictEqual(GL.lineIndex([], 10), -1);
});

test('titles and artists are cleaned for the lyrics search', () => {
  assert.strictEqual(GL.cleanTitle('Hey Jude (Remastered 2015) [Official Video]'), 'Hey Jude');
  assert.strictEqual(GL.cleanTitle('Song Name - Remastered 2011'), 'Song Name');
  assert.strictEqual(GL.cleanTitle('Track (feat. Other) (Official Audio)'), 'Track');
  assert.strictEqual(GL.cleanArtist('Main Artist, Guest'), 'Main Artist');
  assert.strictEqual(GL.cleanArtist('Band - Topic'), 'Band');
});

test('lyrics come from LRCLIB get, fall back to search, and are cached', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push(url);
    assert.ok(/COre/.test(opts.headers['user-agent']));
    if (url.includes('/api/get')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ([{ plainLyrics: 'a\nb' }, { syncedLyrics: '[00:01.00]hello' }]) };
  };
  const r = await GL.fetchLyrics({ title: 'Unique Song One', artist: 'Tester', durMs: 200000 }, fake);
  assert.strictEqual(r.synced[0].text, 'hello');
  assert.ok(calls[0].includes('duration=200'));
  const n = calls.length;
  await GL.fetchLyrics({ title: 'Unique Song One', artist: 'Tester' }, fake);
  assert.strictEqual(calls.length, n, 'second lookup is cached');
});

test('cards are plain text, capped, with ; or | between parts', () => {
  assert.deepStrictEqual(GL.parseCard('Shopping; milk; <b>eggs</b> | bread'), { title: 'Shopping', lines: ['milk', 'b eggs /b', 'bread'] });
  assert.strictEqual(GL.parseCard('  '), null);
  assert.strictEqual(GL.parseCard('T;1;2;3;4;5;6;7;8').lines.length, 6);
});

test('quick intents catch short requests only', () => {
  assert.deepStrictEqual(GL.quickIntent('What time is it?'), { kind: 'time' });
  assert.deepStrictEqual(GL.quickIntent('hey core, what day is it today'), { kind: 'date' });
  assert.deepStrictEqual(GL.quickIntent('show me the lyrics'), { kind: 'glance', what: 'lyrics' });
  assert.deepStrictEqual(GL.quickIntent("what's playing"), { kind: 'glance', what: 'music' });
  assert.deepStrictEqual(GL.quickIntent('hide that'), { kind: 'glance', what: 'off' });
  assert.deepStrictEqual(GL.quickIntent('next song please'), { kind: 'music', action: 'next' });
  assert.deepStrictEqual(GL.quickIntent('pause'), { kind: 'music', action: 'pause' });
  assert.deepStrictEqual(GL.quickIntent('stop the music'), { kind: 'music', action: 'pause' });
  assert.strictEqual(GL.quickIntent('stop'), null, 'bare stop means stop talking, not the music');
  assert.strictEqual(GL.quickIntent('what time is it in Tokyo when it is noon in Paris'), null);
  assert.strictEqual(GL.quickIntent('play a song about the time I was in Paris'), null);
  assert.strictEqual(GL.quickIntent('explain the lyrics of this song to me'), null);
});

test('media readings move on to now while playing and never pass the end', () => {
  const m = GL.normalise({ title: 'T', artist: 'A', pos: 10000, dur: 12000, upd: 1000, playing: true }, 4000);
  assert.strictEqual(m.posMs, 12000);
  const p = GL.normalise({ title: 'T', pos: 5000, dur: 60000, upd: 1000, playing: false }, 9000);
  assert.strictEqual(p.posMs, 5000);
  assert.strictEqual(GL.normalise({ none: true }), null);
  assert.strictEqual(GL.normalise({ title: '' }), null);
});

test('the glance skill maps words to cards and respects the switch', async () => {
  const ctx = { config: {} };
  assert.deepStrictEqual((await SK.runSkill('glance', 'lyrics', ctx)).glance, { what: 'lyrics' });
  assert.deepStrictEqual((await SK.runSkill('glance', 'music', ctx)).glance, { what: 'music' });
  assert.deepStrictEqual((await SK.runSkill('glance', 'off', ctx)).glance, { what: 'off' });
  assert.strictEqual((await SK.runSkill('glance', 'Today; standup 10:00', ctx)).glance.card.lines[0], 'standup 10:00');
  assert.ok((await SK.runSkill('glance', 'lyrics', { config: { glance: false } })).error);
});

test('the Windows media script is fixed text', () => {
  assert.ok(GL.WIN_SCRIPT.includes('GlobalSystemMediaTransportControlsSessionManager'));
  assert.ok(GL.WIN_SCRIPT.includes("'IAsyncOperation`1'"));
  assert.ok(!/\$\{/.test(GL.WIN_SCRIPT));
});
